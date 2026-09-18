/**
 * C12 工具白名单（工具开关）—— 我们自己的那一小段 cordis 插件。
 *
 * **不 import vscode** —— 同 `effortPlugin` 的体例，`scripts/probe-agent-profile.mjs`
 * 把下面的 `TOOL_POLICY_PLUGIN_SCRIPT` 当纯模块直接载入，喂假 ctx 抓它的监听器。
 *
 * 为什么是「自己挂插件」而不是改配置（调研结论，见 docs/backlog.md 的 C12 一节）：
 *   · 运行时的**工具集不是一份配置清单** —— 每个模型可见的工具都是一个
 *     `ctx.tools.register(...)` 的插件，可用性 = cordis.yml 里挂了哪些。
 *   · `dsh-tools` 的 `ToolRuntime.Config` 只有 `{ mode, maxParallelSubCalls }`，
 *     **没有** allow / deny / enabled 任何一个键。
 *   · 但运行期有一个 API：`ToolRuntime.restrict({allow, deny})`（`dsh-tools/lib/index.js`，
 *     "Restrict global tools for the calling agent scope"）。它要求**agent 作用域的 ctx**，
 *     并且**名字不在已知集合里会抛**（且是整批校验 —— 一个坏名字废掉整张表）。
 *     ⇒ 这正是"wire 没这个方法 ≠ 做不到"的又一条：配置面没有，运行期 API 有。
 *
 * 与 C11 档位插件的**结构差异**（不是风格差异，是机制差异）：
 *   · 档位是**每次请求**现读状态表 ⇒ 热生效、需要状态文件；
 *   · 工具策略在 **agent 创建期**只读一次，只在切 profile（= 重连）时变
 *     ⇒ 直接把 deny 写进派生配置块的 `config` 里。少一个文件、少一次读盘、少一类竞态。
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

/** 挂进派生配置的两样东西（`writeDerivedConfig` 的 `toolPolicy` 入参） */
export interface ToolPolicyMount {
  /** 插件文件的 `file:///…` URL —— 派生配置里 `name:` 直接写它 */
  pluginUrl: string;
  /** 要禁掉的工具名（调用方已按 `KNOWN_TOOL_NAMES` 过滤过） */
  deny: string[];
}

export interface ToolPolicyPluginFiles {
  /** 插件本体（生成的） */
  scriptPath: string;
  /** 派生配置里 `name:` 要写的值 */
  pluginUrl: string;
}

/**
 * 写出插件文件，返回路径。落在 `<storageDir>/dsh-plugins/`（与 C11 的档位插件并列，
 * 都在扩展 globalStorage 里，绝不进仓库/工作区）。
 *
 * `pluginUrl` 用 `pathToFileURL().href` 而不是手拼 `file:///` + 路径：盘符大小写、空格、
 * 非 ASCII 目录名（本机用户目录就是中文）全靠它，手拼必错。
 */
export function writeToolPolicyPluginFiles(opts: { storageDir: string }): ToolPolicyPluginFiles {
  const dir = path.join(opts.storageDir, 'dsh-plugins');
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'tool-policy.mjs');
  fs.writeFileSync(scriptPath, TOOL_POLICY_PLUGIN_SCRIPT, 'utf8');
  return { scriptPath, pluginUrl: pathToFileURL(scriptPath).href };
}

/**
 * 插件本体。用 `String.raw`（体例同 `dshHooks.ts` 的 `HOOK_SCRIPT` / `effortPlugin.ts`），
 * 脚本内不使用 `${}` 插值 —— 要的东西一律从 `config` 里读。
 *
 * 三条纪律：
 *  ① `deny` 为空 ⇒ **一个字节都不动**（惰性）。"按需挂载能保持零回归"的根据就是它 ——
 *     没配工具策略的进程里，这个插件等于不存在。
 *  ② 整段 try/catch：插件里抛一下就是整个会话起不来。`restrict` 抛了只该退化成"工具还在"。
 *  ③ 只挂 `agent/created`，**不挂 `agent/pre-step`**：`restrict` 是追加式的，
 *     每步调一次会让限制层层累加。agent 创建期一次就够，也只在那个时候语义是对的。
 */
export const TOOL_POLICY_PLUGIN_SCRIPT = String.raw`/**
 * AlohaDSH · C12 工具白名单插件（由扩展自动生成，请勿手工编辑）。
 *
 * 这是个被 import 的插件模块，不是可执行脚本 —— 所以没有 shebang。
 *
 * 挂进派生 cordis.yml（id: hello-chat-tool-policy）。每个 agent 创建时，对**它自己的
 * 作用域**调一次 tools.restrict({ deny })：被禁的工具从此**不在这个 agent 的视野里** ——
 * 不是"调用被拒"，是模型根本看不到它。
 *
 * 为什么非得是 agent 作用域：ToolRuntime.restrict() 明确拒绝上下文全局的限制
 * （"a context-global restriction would mask every agent"），所以只能挂在 agent.ctx 上。
 *
 * ⚠️ 本插件是纯增益：任何异常、任何读不到，唯一可接受的行为都是「什么都不做」。
 */

export const name = 'hello-chat-tool-policy'

export function apply(ctx, config) {
  const deny = config && Array.isArray(config.deny)
    ? config.deny.filter((n) => typeof n === 'string' && n)
    : []
  if (deny.length === 0) return

  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.ctx || !agent.ctx.tools) return
      // 追加到**这个 agent 自己的层**，随 agent 销毁一起解开（restrict 返回的 disposer 挂在它上面）
      agent.ctx.tools.restrict({ deny })
    } catch {
      // 降级：工具还在。激活 profile 时扩展已经就此说过一次，这里不再吵。
    }
  })
}
`;
