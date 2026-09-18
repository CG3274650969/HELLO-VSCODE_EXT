/**
 * C11 会话级推理档位（reasoningEffort）—— 判据 + 我们自己的那一小段 cordis 插件。
 *
 * **不 import vscode** —— 同 `contextWindow` / `runInspector` / `turnState` 的体例，
 * 探针要在扩展宿主之外加载它（`scripts/probe-effort-plugin.mjs` 还把下面的
 * `EFFORT_PLUGIN_SCRIPT` 当纯模块直接载入，喂假 ctx 抓它的监听器）。
 *
 * 为什么走「自己挂一个插件」这条路（调研结论，均已实测，见 docs/backlog.md 的 C11 一节的四问四答）：
 *   · wire 下不去：`initialize` 只认 cwd/provider/model/maxTokens，多余参数静默忽略；
 *     `dsh-agent` 里那个 `installModelSelection` 正是留给"入口"的覆盖者，但 JSON-RPC 服务端没调它。
 *   · `dsh-llm-deepseek` **本来就按请求解析档位**（`resolveThinking(options, defaults)`）：
 *     `options.reasoningEffort` 一旦给到就盖过插件配置并落到出网的 `reasoning_effort`。
 *   · `dsh-agent-loop` 每步都跑 `dispatch.waterfall('agent/request', …)`，**返回值就是这次请求的 config**
 *     —— 这正是我们插手的口子。
 *   · `ctx.settings` 那条热改路子走不通：闭包里没有 `settings` 服务的具体实现，`inject` 永不激活。
 *
 * 于是本模块提供三件事：档位取值（`normalizeEffort`）、插件文件与状态表的写手、
 * 以及一个纯函数判据 `thinkingDisabledInConfig`。
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

/** provider 认的四个档位（`dsh-llm-deepseek` 的 schema，别的值它会抛 UNSUPPORTED_REASONING_EFFORT） */
export const EFFORT_VALUES = ['off', 'low', 'high', 'max'] as const;

export type ReasoningEffort = (typeof EFFORT_VALUES)[number];

/**
 * 设置/会话字段/消息 → 档位。**认不出来一律 undefined = 不覆盖，绝不猜**：
 * undefined / null / 空串 / `'跟随配置'` / `'LOW'` / 数字 全都不是档位。
 * （webview 的「跟随配置」项就发 null，正好落进这一条。）
 */
export function normalizeEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : undefined;
}

/** 挂进派生配置的三样东西（`writeDerivedConfig` 的 `effort` 入参） */
export interface EffortPluginMount {
  /** 插件文件的 `file:///…` URL —— 派生配置里 `name:` 直接写它 */
  pluginUrl: string;
  /** 档位表（`{dsh会话id: 档位}`）的路径，插件每次请求现读它 */
  statePath: string;
  /** 底本 llm-deepseek 是不是 `thinking: disabled` —— 那时只有 `off` 合法，见下面的守卫 */
  thinkingDisabled: boolean;
}

export interface EffortPluginFiles {
  /** 插件本体（生成的） */
  scriptPath: string;
  /** 档位表（每次改档位重写） */
  statePath: string;
  /** 派生配置里 `name:` 要写的值 */
  pluginUrl: string;
}

/**
 * 写出插件文件，返回三个路径。落在 `<storageDir>/dsh-plugins/`（与 C1 的 `dsh-hooks/` 并列，
 * 都在扩展 globalStorage 里，绝不进仓库/工作区）。
 *
 * `pluginUrl` 用 `pathToFileURL().href` 而不是手拼 `file:///` + 路径：盘符大小写、空格、
 * 非 ASCII 目录名（本机用户目录就是中文）全靠它，手拼必错。
 */
export function writeEffortPluginFiles(opts: { storageDir: string }): EffortPluginFiles {
  const dir = path.join(opts.storageDir, 'dsh-plugins');
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'reasoning-effort.mjs');
  fs.writeFileSync(scriptPath, EFFORT_PLUGIN_SCRIPT, 'utf8');
  const statePath = path.join(dir, 'reasoning-effort-state.json');
  return { scriptPath, statePath, pluginUrl: pathToFileURL(scriptPath).href };
}

/**
 * 写档位表。**每次都整份重写**，不是增量更新 —— 一个 DSH 进程服务多个会话、切会话不重启，
 * 所以表里必须同时有所有会话的档位（调用方给的是全量）。
 *
 * 写盘用 tmp + rename（同 `SessionStore.persist` 的体例）：插件在**每次请求**都读这个文件，
 * 读到半截 JSON 就会静默不覆盖 —— 那不是崩溃，是"档位偶尔不生效"，最难查的那种。
 * 非法的键值一律丢掉，绝不写进文件（插件那边也有一道，但那道是兜底）。
 */
export function writeEffortState(statePath: string, byId: Record<string, unknown>): void {
  const clean: Record<string, ReasoningEffort> = {};
  for (const [id, value] of Object.entries(byId ?? {})) {
    const effort = normalizeEffort(value);
    if (typeof id === 'string' && id && effort) clean[id] = effort;
  }
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath);
}

/**
 * 底本里 llm-deepseek 的 `thinking` 是不是 `disabled`。
 *
 * **为什么这条判据非有不可**：provider 的 `resolveThinking` 里，
 * `defaults.thinking === 'disabled'` 且档位既不是 undefined 也不是 `off` 时**直接抛**
 * `UNSUPPORTED_REASONING_EFFORT` —— 也就是说 `low/high/max` 三档属于「单独看合法、
 * 跟配置里另一行组合就非法」的值（同 C10 `retainRatio` 那个坑）。界面据此把三档置灰，
 * 插件在请求期也照这条拦一道。
 *
 * 锚点纪律同 `patchCompactionRatios`：只看 `- id: llm-deepseek` 那个块里的 `thinking:` 行。
 * **锚点不唯一就返回 false（= 认为没禁用）** —— 代价不对称：判成 true 会让三档白白不可选，
 * 判成 false 顶多是用户在 disabled 配置下选了非 off 档，provider 会**响亮地报错**。
 * 响亮的错比安静地少给功能好。
 */
export function thinkingDisabledInConfig(base: string): boolean {
  const lines = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const body = (l: string): string => l.replace(/\r?\n$/, '');
  const indentOf = (b: string): number => b.length - b.replace(/^\s*/, '').length;

  const anchors: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*-\s+id\s*:\s*['"]?llm-deepseek['"]?\s*$/.test(body(l))) anchors.push(i);
  });
  if (anchors.length !== 1) return false;
  const anchor = anchors[0];
  const anchorIndent = indentOf(body(lines[anchor]));

  const re = /^\s*thinking\s*:\s*['"]?([A-Za-z_]+)['"]?\s*(?:#.*)?$/;
  for (let i = anchor + 1; i < lines.length; i += 1) {
    const b = body(lines[i]);
    const t = b.trim();
    if (t && !t.startsWith('#') && indentOf(b) <= anchorIndent) break; // 块结束
    const m = re.exec(b);
    if (m) return m[1].toLowerCase() === 'disabled';
  }
  return false;
}

/**
 * 插件本体。用 `String.raw` 是因为里面全是 `\s` 这类转义（体例同 dshHooks.ts 的 HOOK_SCRIPT），
 * 脚本内不使用 `${}` 插值 —— 有需要的东西一律从 `config` 里读。
 *
 * 三条纪律，每一条都是"坏了会很难查"换来的：
 *  ① `next()` 调用**不在** try 里：我们自己的失败只该退化成"不覆盖"，而请求链自身的异常
 *     必须原样抛出去（吞掉它等于把整轮静默换成另一种行为）。
 *  ② 读表/查表整段 try/catch，任何异常都原样返回上游结果 —— 插件里抛一下就是整轮挂掉。
 *  ③ 表里没有这个会话 ⇒ 一个字节都不改（惰性）。"按需挂载能保持零回归"的根据就是它。
 */
export const EFFORT_PLUGIN_SCRIPT = String.raw`/**
 * AlohaDSH · C11 会话级推理档位插件（由扩展自动生成，请勿手工编辑）。
 *
 * 这是个被 import 的插件模块，不是可执行脚本 —— 所以没有 shebang。
 *
 * 挂进派生 cordis.yml（id: hello-chat-reasoning-effort）。每步请求都经过
 * 'agent/request' 这个瀑布，**返回值就是这次请求的 config** —— 我们据此按会话覆盖
 * reasoningEffort（provider 侧 resolveThinking 会认它并落到出网的 reasoning_effort）。
 *
 * 档位表由扩展写在 statePath，**每次请求现读** —— 所以改档位是热生效的（下一步就变），
 * 不需要重启 DSH 进程。
 *
 * ⚠️ 本插件是纯增益：任何异常、任何读不到，唯一可接受的行为都是「什么都不做」。
 */
import { readFileSync } from 'node:fs'

export const name = 'hello-chat-reasoning-effort'

const EFFORT = new Set(['off', 'low', 'high', 'max'])

/** 现读档位表；坏 JSON / 文件不在 / 任何异常 → 空表（= 不覆盖） */
function readState(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function apply(ctx, config) {
  const statePath = config && typeof config.statePath === 'string' ? config.statePath : ''
  const thinkingDisabled = !!(config && config.thinkingDisabled === true)
  if (!statePath) return

  ctx.on('agent/request', async (payload, next) => {
    // ① next() 不在 try 里：请求链自己的错必须原样抛出去
    const resolved = await next()
    try {
      if (!resolved || typeof resolved !== 'object') return resolved
      // 会话 id 就是 agent.id（session/prompt 校验时拿它比的就是这个）
      const id = payload && payload.agent ? payload.agent.id : undefined
      if (typeof id !== 'string' || !id) return resolved
      const hit = readState(statePath)[id]
      if (typeof hit !== 'string' || !EFFORT.has(hit)) return resolved
      // 底本 thinking: disabled 时 provider 只接受 off —— 其余三档会抛
      // UNSUPPORTED_REASONING_EFFORT 把整轮打死。宁可这一步不覆盖。
      if (thinkingDisabled && hit !== 'off') return resolved
      return { ...resolved, reasoningEffort: hit }
    } catch {
      return resolved
    }
  })
}
`;
