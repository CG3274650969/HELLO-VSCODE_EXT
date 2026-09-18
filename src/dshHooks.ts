/**
 * C1 事前审批：生成 DSH 侧需要的三个文件（全部落在扩展 globalStorage，绝不进仓库/工作区）。
 *
 *   1. `dsh-hooks/approval-hook.mjs` —— 真正的 hook 脚本（node 跑；见文件头注释）
 *   2. `dsh-hooks/hooks.json`        —— CC 方言 hook 配置，PreToolUse + matcher:bash|write|edit
 *      （C4：matcher 的主语是**工具名**，扩到 write/edit 就能在 fs 工具执行前拿到控制权）
 *   3. `dsh-config/cordis.yml`       —— **派生配置** = 用户那份 cordis.yml 原文 + 末尾追加
 *                                       一个 hooks-claude-code 插件块
 *
 * 为什么要派生配置：DSH 的 hooks 插件只能从 cordis.yml 里挂载，而用户那份配置是他们的
 * 东西（我们不该改）。扩展本来就拥有 `DSH_CORDIS_CONFIG` 的注入权，所以指向这份副本即可。
 * 追加前先确认根是**块状序列**（cordis.yml 的插件表就是顶层列表），不是就拒绝生成、
 * 由调用方降级 —— 绝不改写用户原文。
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { EffortPluginMount } from './effortPlugin';
import type { ToolPolicyMount } from './toolPolicyPlugin';

/** 生成结果：三个文件的绝对路径 + 实际下发的 hook 命令（自检也用它） */
export interface ApprovalHookFiles {
  /** 派生 cordis.yml（指向它当 DSH_CORDIS_CONFIG） */
  cordisPath: string;
  /** hooks.json（派生配置里 configPath 指它） */
  hooksPath: string;
  /** hook 脚本本体 */
  scriptPath: string;
  /** hooks.json 里那条 command（供自检/排错展示） */
  hookCommand: string;
}

/**
 * 跑 hook 的 shell 类型 —— 直接决定命令里路径该写成什么形态（实测差异很大）：
 * - `wsl`：Windows 路径**不能**当可执行文件（`D:\…\node.exe` → command not found），
 *   必须写成 `/mnt/d/…`；但传给 node.exe 的**脚本参数**又必须是 Windows 形式
 *   （`/mnt/c/…` 会被 node 当 Windows 路径解析而打不开）。→ 混着写。
 * - `posix`：Git Bash / MSYS / Cygwin 等，Windows 形式两边都能用。
 */
export type ShellKind = 'wsl' | 'posix';

export interface ApprovalHookOptions {
  /** 扩展 globalStorage 根 */
  storageDir: string;
  /** 跑 hook 脚本用的 node 绝对路径（取自 hello.dsh.nodePath） */
  nodePath: string;
  /** 由 probeShell 探到的 shell 类型（决定路径形态） */
  shellKind: ShellKind;
  /** 审批服务地址（http://127.0.0.1:PORT）与令牌 */
  url: string;
  token: string;
  /** 脚本等答复的上限（毫秒）——应略大于扩展侧的用户等待上限，让扩展先超时 */
  scriptTimeoutMs: number;
  /** DSH 侧这条 hook 的超时（秒，写进 hooks.json；DSH 到此会杀掉 hook 进程） */
  hookTimeoutSec: number;
  /** 用户的基础 cordis.yml **绝对路径**；空串 → 不派生配置（调用方据此判断本功能不可用） */
  baseConfigPath: string;
}

/**
 * 写出 hook 脚本 / hooks.json / 派生 cordis.yml。抛错 = 调用方降级（功能不启用，行为回到现状）。
 * 每次都重写：hook 脚本与 hooks.json 幂等，派生配置紧跟用户当前的基础配置。
 */
export function writeApprovalHookFiles(opts: ApprovalHookOptions): ApprovalHookFiles {
  const hooksDir = path.join(opts.storageDir, 'dsh-hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const scriptPath = path.join(hooksDir, 'approval-hook.mjs');
  fs.writeFileSync(scriptPath, HOOK_SCRIPT, 'utf8');

  const hooksPath = path.join(hooksDir, 'hooks.json');
  const hookCommand = buildHookCommand(
    opts.nodePath,
    scriptPath,
    opts.url,
    opts.token,
    opts.scriptTimeoutMs,
    opts.shellKind
  );
  const hooksJson = {
    hooks: {
      PreToolUse: [
        {
          // C1 管 bash；C4 起同一条通路也管 fs 工具（越出工作区的写才问，见 chatViewProvider）
          matcher: 'bash|write|edit',
          hooks: [
            {
              type: 'command',
              command: hookCommand,
              // 秒；与扩展侧等待/脚本 socket 超时形成 600 > 560 > 540 的梯度，
              // 保证任何一种超时都是"扩展先放弃并拒绝"，而不是进程被砍在半路
              timeout: opts.hookTimeoutSec,
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(hooksPath, JSON.stringify(hooksJson, null, 2) + '\n', 'utf8');

  if (!opts.baseConfigPath) throw new Error('未配置基础 cordis.yml（hello.dsh.config）');
  // C10：派生文件的合成（原文 → [可选]改比例 → [可选]追加 hooks 块）**只有这一个写手**。
  // 这里不带 compaction —— 审批只负责"把 hooks 块挂上去"，比例覆盖由 _refreshDerivedConfig
  // 统一处理（它会在本函数之后用同一份底本再写一次，覆盖掉这份）。分开的理由见那边的注释。
  const { cordisPath } = writeDerivedConfig({
    storageDir: opts.storageDir,
    baseConfigPath: opts.baseConfigPath,
    hooksPath,
  });

  return { cordisPath, hooksPath, scriptPath, hookCommand };
}

// ---------------- C10：压缩阈值覆盖（派生配置的第二件事） ----------------
//
// DSH 的 `@deepseek-ai/dsh-compaction-basic` 在 `agent/pre-step` 压力超过
// `floor(contextWindow × thresholdRatio)` 时，把旧事件摘要成一个 checkpoint —— **它本来就在跑**
// （`runtime/cordis.default.yml` 里 compose 了，auto 默认 true），只是默认线是 0.8 × 1M = 80 万
// token，正经用法一辈子碰不到。C10 给用户一个旋钮把它压低，让压缩真的会发生。
//
// 为什么要改文件而不是像 `DSH_CWD` 那样走环境变量：底本是**盘上那份** `<runtimeDir>/cordis.yml`
// （构建期从 `runtime/cordis.default.yml` 拷出来的快照），不是仓库里那份原文 —— 改仓库的东西对
// 用户已建好的运行时目录无效。锚点补丁对**任意**底本都管用，所以它是唯一完备的路子。

/** 压缩比例覆盖（比例形态；`retainTokens` 那种绝对值形态一律不支持，见 patchCompactionRatios）。 */
export interface CompactionRatios {
  thresholdRatio: number;
  retainRatio: number;
}

/**
 * DSH 自带的阈值。**等于它 = 不需要覆盖**（不派生、不写文件、行为与没有这个功能时逐字节相同）。
 * 与 `runtime/cordis.default.yml` 里那个数一字不差，改上游时要同步。
 */
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;

/**
 * 保留比例相对阈值的倍率 —— 原配置 `0.16 / 0.8` 就是这个 0.2。
 *
 * **它不是"风格选择"，是硬约束**：插件在**加载期**就断言 `retainRatio < thresholdRatio`
 * （`dsh-compaction-basic/lib/index.js` 的 `validateRatioRetention`），违反 = 插件加载失败。
 * 只把 thresholdRatio 调低而不同步调低 retainRatio，正好会踩中 —— 这是这一项最容易踩的坑。
 * 按固定倍率缩放则 `0.2t < t` 恒成立，**不需要为 floor 留余量**（两个 floor 比较同理）。
 */
export const RETAIN_RATIO_OF_THRESHOLD = 0.2;

/**
 * 设置值 → 覆盖对象。**未设 / 不是数 / 越界 / 等于默认 → undefined（= 不派生）**。
 *
 * 范围取插件的 `assertRatio` 同款 `(0, 1]`：0 与 >1 都是**加载期 throw**，不能放到界面上去让人试。
 * 下限刻意放得很低（设置项 `minimum` 是 0.001）—— 1M 窗口下 0.001 才是 1000 token，
 * 而实测的日常压力只有 2K–6K token，**想亲眼看见压缩发生就必须能压到这个量级**。
 */
export function compactionOverride(thresholdRatio: unknown): CompactionRatios | undefined {
  if (typeof thresholdRatio !== 'number' || !Number.isFinite(thresholdRatio)) return undefined;
  if (thresholdRatio <= 0 || thresholdRatio > 1) return undefined;
  if (thresholdRatio === DEFAULT_COMPACTION_THRESHOLD_RATIO) return undefined;
  // 乘完再四舍五入到 6 位：否则 0.3 × 0.2 = 0.06000000000000001 这种噪声会写进 YAML
  return { thresholdRatio, retainRatio: Math.round(thresholdRatio * RETAIN_RATIO_OF_THRESHOLD * 1e6) / 1e6 };
}

export interface DerivedConfigOptions {
  /** 扩展 globalStorage 根（派生文件落在 `<storageDir>/dsh-config/cordis.yml`，与 C1 同一处） */
  storageDir: string;
  /** 底本：用户/runtime 的基础 cordis.yml **绝对路径** */
  baseConfigPath: string;
  /** hooks.json 的路径；**空串 = 不追加审批块**（只做比例覆盖时就是空串） */
  hooksPath: string;
  /** 比例覆盖；undefined = 原样不动 */
  compaction?: CompactionRatios;
  /** C11：会话级推理档位插件块；undefined = 不追加（行为与没有这个功能时逐字节相同） */
  effort?: EffortPluginMount;
  /** C12：工具白名单插件块；undefined = 不追加（同上） */
  toolPolicy?: ToolPolicyMount;
}

export interface DerivedConfigResult {
  cordisPath: string;
  /** 比例覆盖没落上的原因。**有值 = 写出去的是「原文(+hooks 块)」，覆盖未生效，必须报给用户** */
  warning?: string;
  /** C11：档位块没落上的原因（根不是块状序列）。与 `warning` **分开** —— 挂不上的东西不同，
   *  提示话术也不同，混成一条会让用户照着"压缩阈值"去查一个档位问题 */
  effortWarning?: string;
  /** C11：档位块**真的写进这份文件了吗**。调用方据此判断"改档位要不要重连一次" */
  effortMounted: boolean;
  /** C12：工具白名单块没落上的原因（根不是块状序列）。同 `effortWarning`，独立一条不让两件事共用一句提示 */
  toolPolicyWarning?: string;
}

/**
 * 派生配置的**唯一写手**。合成链：原文 →（可选）改 compaction 两行 →（可选）追加 hooks 块
 * →（可选）追加 C11 档位插件块。三个可选项**互相独立**：各自要不要，由调用方按当下状态给。
 *
 * 只有两种失败是致命的（throw，调用方据此降级）：
 *   · 底本读不出来；
 *   · **要追加 hooks 块**但根不是块状序列 —— C1 的既有语义，绝不改写用户原文。
 *
 * 「改不动 compaction 那两行」与「C11 档位块挂不上」**都只回落到 warning，绝不 throw** —— 这不是随手的取舍：
 * `_setupApproval()` 对 throw 的反应是 `server.dispose()` + 不启用审批，也就是说
 * **throw 等于拿 C1 整个主功能去换一个可选的性能旋钮**。比例改不动时写出去的就是
 * 「原文 + hooks 块」，与没有这个功能时逐字节相同 —— 审批照常，只是旋钮没拧上，并且会被告知。
 */
export function writeDerivedConfig(opts: DerivedConfigOptions): DerivedConfigResult {
  const base = fs.readFileSync(opts.baseConfigPath, 'utf8');
  const blockRoot = isBlockSequenceRoot(base);
  if (opts.hooksPath && !blockRoot) {
    throw new Error('基础 cordis.yml 的根不是块状列表，无法安全追加（不改写用户原文）');
  }
  let text = base;
  let warning: string | undefined;
  if (opts.compaction) {
    try {
      text = patchCompactionRatios(base, opts.compaction);
    } catch (err) {
      text = base;
      warning = err instanceof Error ? err.message : String(err);
    }
  }
  // C11：档位块排在 hooks 块之后。挂不上**只 warning，绝不 throw** —— 同比例补丁那条纪律：
  // 一个可选旋钮不能拿 C1 的主功能去换（throw 在 `_setupApproval` 那边等于整个审批不启用）。
  let effortWarning: string | undefined;
  let effortMounted = false;
  let appended = opts.hooksPath ? derivedBlock(opts.hooksPath) : '';
  if (opts.effort) {
    if (blockRoot) {
      appended += effortBlock(opts.effort);
      effortMounted = true;
    } else {
      effortWarning = '基础 cordis.yml 的根不是块状列表，推理档位块无法追加（档位功能不生效，其余一切照旧）';
    }
  }
  // C12：工具白名单块排在档位块之后。同样是"挂不上只 warning 不 throw"那条纪律。
  let toolPolicyWarning: string | undefined;
  if (opts.toolPolicy) {
    if (blockRoot) {
      appended += toolPolicyBlock(opts.toolPolicy);
    } else {
      toolPolicyWarning = '基础 cordis.yml 的根不是块状列表，工具白名单块无法追加（工具开关不生效，其余一切照旧）';
    }
  }
  const configDir = path.join(opts.storageDir, 'dsh-config');
  fs.mkdirSync(configDir, { recursive: true });
  const cordisPath = path.join(configDir, 'cordis.yml');
  fs.writeFileSync(cordisPath, text + appended, 'utf8');
  return { cordisPath, warning, effortWarning, effortMounted, toolPolicyWarning };
}

/**
 * 纯函数：把 `- id: compaction-basic` 块里 `config:` 直属那两行的**值**换掉，其余字节逐字节原样返回。
 *
 * 三条纪律（与 `scripts/runtime-patch.mjs` 同款）：唯一锚点、唯一键行、纯数字字面量 ——
 * 任何一条不成立就 **throw**（不猜、不部分应用）。宁可旋钮不生效并被明确告知，也不要改错一行
 * 把用户的配置写坏。
 *
 * **只认 `config:` 的直属子键**（缩进相等）。这条限定是必须的，不是保险：
 * 插件支持 `modelPolicies[].thresholdRatio` 这种 per-model 覆盖，缩进更深，
 * 越界改写会把用户按模型设的策略一起打掉。
 */
export function patchCompactionRatios(base: string, ratios: CompactionRatios): string {
  // 逐行连行尾一起切，join('') 必须能逐字节还原原文 —— split('\n') 会把 CRLF 洗成 LF，
  // 那样「只差那两行」就永远不可能成立（探针正是这么钉的）。
  const lines = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const body = (l: string): string => l.replace(/\r?\n$/, '');
  const indentOf = (b: string): number => b.length - b.replace(/^\s*/, '').length;

  // --- 1. 锚点：`- id: compaction-basic`，必须恰好一处
  const anchors: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*-\s+id\s*:\s*['"]?compaction-basic['"]?\s*$/.test(body(l))) anchors.push(i);
  });
  if (anchors.length !== 1) {
    throw new Error(
      `cordis.yml 里 \`- id: compaction-basic\` 出现 ${anchors.length} 次（期望恰好 1 次）—— ` +
        '基础配置里没有这个插件块时无法覆盖它的阈值'
    );
  }
  const anchor = anchors[0];
  const anchorIndent = indentOf(body(lines[anchor]));

  // --- 2. 块范围：缩进比锚点深的那些行；空行与注释行一律算在内（它们永不被改写）
  let end = anchor + 1;
  while (end < lines.length) {
    const b = body(lines[end]);
    const t = b.trim();
    if (t && !t.startsWith('#') && indentOf(b) <= anchorIndent) break;
    end += 1;
  }

  // --- 3. `config:` 的直属缩进
  const cfgRe = /^(\s*)config\s*:\s*$/;
  const cfgHits: Array<{ i: number; indent: number }> = [];
  for (let i = anchor; i < end; i += 1) {
    const m = cfgRe.exec(body(lines[i]));
    if (m) cfgHits.push({ i, indent: m[1].length });
  }
  if (cfgHits.length !== 1) {
    throw new Error(
      `cordis.yml 的 compaction-basic 块里 \`config:\` 出现 ${cfgHits.length} 次（期望恰好 1 次）—— ` +
        '本功能只改已有两行的值，不新增结构'
    );
  }
  const cfgIndent = cfgHits[0].indent;

  // --- 3b. `config:` 的**直属子键**缩进：取它下面第一条实义行的缩进。
  // 这个基准不能拿 cfgIndent 顶替 —— `config:` 在 2 格、它的键在 4 格是常态。
  let keyIndent = -1;
  for (let i = cfgHits[0].i + 1; i < end; i += 1) {
    const b = body(lines[i]);
    if (!b.trim() || b.trim().startsWith('#')) continue;
    const ind = indentOf(b);
    if (ind <= cfgIndent) break; // 缩进回到 config 同级 = 它的子键区已经结束
    keyIndent = ind;
    break;
  }
  if (keyIndent < 0) {
    throw new Error('cordis.yml 的 compaction-basic 块里 `config:` 下面没有任何键，无可改写');
  }

  // --- 4. 抓两行（只认 config 的直属子键，排除注释行）
  const keyRe = /^(\s*)(thresholdRatio|retainRatio)(\s*:\s*)([^#]*?)(\s*)(#.*)?$/;
  // 每行拆成 缩进 / 键 / `:` 及其两侧空白 / 值 / 值后空白 / 行内注释 六段，
  // 改写时只换「值」那一段，其余原样拼回 —— 行内注释与行尾空格因此天然保住。
  const found = new Map<
    'thresholdRatio' | 'retainRatio',
    { i: number; indent: string; mid: string; value: string; rest: string }
  >();
  let hasRetainTokens = false;
  for (let i = cfgHits[0].i + 1; i < end; i += 1) {
    const b = body(lines[i]);
    if (!b.trim() || b.trim().startsWith('#')) continue;
    if (indentOf(b) !== keyIndent) continue;
    if (/^\s*retainTokens\s*:/.test(b)) hasRetainTokens = true;
    const m = keyRe.exec(b);
    if (!m) continue;
    const key = m[2] as 'thresholdRatio' | 'retainRatio';
    if (found.has(key)) {
      throw new Error(`cordis.yml 的 compaction-basic 块里 \`${key}:\` 出现了不止一次，无法判断该改哪一行`);
    }
    found.set(key, { i, indent: m[1], mid: m[3], value: m[4].trim(), rest: m[5] + (m[6] ?? '') });
  }

  const threshold = found.get('thresholdRatio');
  if (!threshold) {
    throw new Error('cordis.yml 的 compaction-basic 块里没有 `thresholdRatio:` 这一行');
  }
  // retainTokens 与 retainRatio **互斥**（插件加载期就断言）。底本用绝对值定保留量时，
  // 我们无法保证 floor(cw × 新阈值) 仍大于它 —— 与其赌，不如明说做不到。
  if (hasRetainTokens) {
    throw new Error(
      'cordis.yml 的 compaction-basic 块用的是 `retainTokens`（绝对值）而不是 `retainRatio` —— ' +
        '两者互斥，压低阈值可能与它冲突，故不改写'
    );
  }
  // 值为纯数字字面量才动。`"0.8"` / `8e-1` / `!!js …` 一律拒：它们在 YAML 里不是数字
  // （1.1 core 里 `8e-1` 是字符串），插件加载期就会拒，我们不该悄悄把它"修好"成别的意思
  const numRe = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
  const fmt = (value: number): string => {
    const s = String(Math.round(value * 1e4) / 1e4);
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`比例 ${value} 写不成 YAML 数字字面量`);
    return s;
  };
  const eolOf = (l: string): string => l.slice(body(l).length);

  const out = lines.slice();
  const emit = (
    key: 'thresholdRatio' | 'retainRatio',
    f: { i: number; indent: string; mid: string; value: string; rest: string },
    value: number
  ): string => {
    if (!numRe.test(f.value)) {
      throw new Error(
        `cordis.yml 的 compaction-basic 块里 \`${key}:\` 的值不是数字字面量（读到 \`${f.value}\`），拒绝改写`
      );
    }
    return f.indent + key + f.mid + fmt(value) + f.rest + eolOf(lines[f.i]);
  };

  const retain = found.get('retainRatio');
  out[threshold.i] = emit('thresholdRatio', threshold, ratios.thresholdRatio);
  if (retain) {
    out[retain.i] = emit('retainRatio', retain, ratios.retainRatio);
  } else {
    // 底本**没有** retainRatio 时**必须补一行**，不能拒改：插件对缺省的 retainRatio 有内置默认
    // （0.16），而 0.16 ≥ 我们压低后的阈值 —— 补上才满足加载期那条 `retainRatio < thresholdRatio`
    // 断言，不补就是插件加载失败。补是安全的：改的是**我们自己的派生副本**，用户原文一个字没动。
    // 那一行正好是文件最后一行且没有尾换行时，得先补一个换行，否则会把新键拼到同一行上。
    // 用文件自身的主流行尾（CRLF/LF）而不是写死 \n —— 混行文件里我们不该偷偷改行尾风格。
    const ownEol = eolOf(lines[threshold.i]) || (base.includes('\r\n') ? '\r\n' : '\n');
    out[threshold.i] +=
      (eolOf(lines[threshold.i]) ? '' : ownEol) +
      threshold.indent + 'retainRatio' + threshold.mid + fmt(ratios.retainRatio) + ownEol;
  }
  return out.join('');
}

/** 自检结论。`retriable` 见 `nextShellCheck` 的长注释；它**不是**「可以重试看看」，而是「这次失败没说明任何事」。 */
export interface HookSelfCheck {
  ok: boolean;
  detail: string;
  /** 结论**不可判**：超时、或 shell 启动器空手退出 —— 只说明那一刻 shell 还没起来，不说明形态写错了 */
  retriable: boolean;
}

/**
 * 自检：用**同一个 shell**（DSH 的 hook 也是 `bash -c <command>`）跑一遍这条 hook 命令，
 * 喂一个非 bash 工具的合成载荷（脚本会立刻 exit 0，无副作用）。
 * 失败说明 hook 起不来（典型：node 路径在 bash 里不可达）→ 审批**不会生效**，必须让用户知道，
 * 而不是安静地"看起来配好了"。
 *
 * `timeoutMs` 只为探针而留（钉住超时那条分支不必真等 15 s）；扩展侧一律用默认值。
 */
export function testApprovalHook(hookCommand: string, cwd: string, timeoutMs = 15000): Promise<HookSelfCheck> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, detail: string, retriable = false): void => {
      if (done) return;
      done = true;
      resolve({ ok, detail, retriable });
    };
    let child;
    try {
      child = spawn('bash', ['-c', hookCommand], { cwd, env: process.env, windowsHide: true });
    } catch (err) {
      // spawn 抛错（bash 根本不存在）与形态无关，重试也会一模一样地抛 → retriable 不置位
      finish(false, err instanceof Error ? err.message : String(err));
      return;
    }
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      // 超时是**不可判**的：能答的 bash 答得极快（实测 Git Bash 的 uname 约 130 ms），
      // 撞到十几秒只可能是 WSL 启动器正在冷启动 —— 它压根没跑到命令那一行，形态对不对还没验。
      finish(false, `自检超时（${Math.round(timeoutMs / 1000)}s）`, true);
    }, timeoutMs);
    child.stdout?.on('data', (c) => (out += String(c)));
    child.stderr?.on('data', (c) => (errOut += String(c)));
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // stdout 也要报 —— bash/Windows shim 的失败话术并不总是走 stderr（WSL 起不来时
        // 它往往把话打在 stdout 上），只报 stderr 会得到一条「退出码 1」这种没法查的线索。
        const bits: string[] = [];
        if (errOut.trim()) bits.push(`stderr：${errOut.trim().slice(0, 300)}`);
        if (out.trim()) bits.push(`stdout：${out.trim().slice(0, 300)}`);
        // **两边都空**是第二种「不可判」：形态写错时 bash 会又快又响亮地报错（实测 79–183 ms，
        // 退出码 127 + `bash: line 1: …: No such file or directory` 打在 stderr 上），
        // 退出码 1 却一个字都不说，只可能是启动器半路熄火（WSL 还在开机）。
        finish(
          false,
          `bash 退出码 ${code}${bits.length ? '（' + bits.join('；') + '）' : '（stdout/stderr 都是空的）'}`,
          bits.length === 0
        );
        return;
      }
      if (out.trim()) {
        // 非 bash 工具本不该产生任何决策输出
        finish(false, `自检输出异常：${out.trim().slice(0, 200)}`);
        return;
      }
      finish(true, 'ok');
    });
    child.stdin?.end(JSON.stringify({ tool_name: 'read', tool_input: { file_path: 'x' } }) + '\n');
  });
}

// ---------- 内部 ----------

/**
 * `uname -s` 的输出来判形态（纯函数，探针钉的就是它）。
 * **认不出来就返回 undefined**，不假装认识 —— 旧的 `else → posix` 正是把「不知道」当成了「是 posix」。
 */
export function classifyShell(unameOut: string): ShellKind | undefined {
  const s = unameOut.trim();
  if (!s) return undefined;
  if (/linux/i.test(s)) return 'wsl'; // WSL 里 uname -s 就是 Linux
  if (/mingw|msys|cygwin/i.test(s)) return 'posix'; // Git Bash / MSYS / Cygwin
  return undefined;
}

/**
 * 探不到时的**平台先验**：Windows 上唯一「慢」的 bash 是 WSL 的启动器。
 *
 * 实测（2026-09-17，本机）：Git Bash 答 `uname -s` 约 **130 ms**，永远撞不到 8 s 超时；
 * `C:\Windows\System32\bash.exe` 即使在半热状态下也要 **5.1 s**，冷启动更久。
 * 所以**超时是 WSL 的正面证据**，不是「猜不出来」—— 而这正是重载那一刻的处境：
 * 旧代码在这里回落 `posix`，等于在一台 WSL 机器上把唯一跑不通的形态排在第一个去自检。
 * 非 Windows 只有 posix 一种可能。
 */
export function shellGuessOnTimeout(platform: NodeJS.Platform = process.platform): ShellKind {
  return platform === 'win32' ? 'wsl' : 'posix';
}

/**
 * 用与 DSH 完全相同的方式（`bash -c <command>`，从扩展进程 spawn）探一次 shell。
 * DSH 子进程的 env 继承自扩展，所以这里的 `bash` 解析结果就是 hook 将要用的那个。
 *
 * ⚠️ **这只是首猜，不是判据。** 它只采一次样（8 s 超时）。真正的判据是自检
 * （见 chatViewProvider 的 `_setupApproval`）。但**首猜的优先级仍然要紧**：自检是按顺序来的，
 * 把跑不通的形态排在第一个，就是白等一次它的超时。
 */
export function probeShell(cwd: string): Promise<ShellKind> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (kind: ShellKind): void => {
      if (done) return;
      done = true;
      resolve(kind);
    };
    let child;
    try {
      child = spawn('bash', ['-c', 'uname -s'], { cwd, env: process.env, windowsHide: true });
    } catch {
      finish(shellGuessOnTimeout());
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(shellGuessOnTimeout());
    }, 8000);
    child.stdout?.on('data', (c) => (out += String(c)));
    child.on('error', () => {
      clearTimeout(timer);
      finish(shellGuessOnTimeout());
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(classifyShell(out) ?? shellGuessOnTimeout());
    });
  });
}

/** 一次自检结果的**结论面**（`nextShellCheck` 只吃这些，不吃 detail） */
export interface ShellCheckAttempt {
  kind: ShellKind;
  /** 结论是否不可判（超时 / 启动器空手退出）—— 见 `HookSelfCheck.retriable` */
  retriable: boolean;
}

/**
 * 自检排程（纯函数）：下一次该验哪种形态；`undefined` = 验完了，两种都过不了。
 *
 * 规则：先按 `order` 逐个验一遍。**不可判**的失败不判形态死刑 —— 把它排到队尾再验一次：
 * 重载那一刻 WSL 正在冷启动，另一形态的自检恰好把这段冷启动时间花掉了，回头再验通常就过了
 * （实测：首轮不可判的失败之后，热起来的 wsl 形态自检 **359 ms** 通过）。
 *
 * **重试全局只给一次**（`retriesUsed`）：两种形态各自超时两遍 = 用户干等一分钟才看到「发不出去」，
 * 而冷启动只发生一次，一次足够。这条不是优化，是防止修法本身变成一个卡顿源。
 */
export function nextShellCheck(
  order: ShellKind[],
  done: ShellCheckAttempt[],
  retriesUsed: number
): ShellKind | undefined {
  const count = (k: ShellKind): number => done.filter((d) => d.kind === k).length;
  for (const k of order) if (count(k) === 0) return k;
  if (retriesUsed > 0) return undefined;
  // 重试给最后失败的那个（它的失败最新鲜，冷启动也走完了）；没别的候选就到此为止
  const retriable = new Set(done.filter((d) => d.retriable).map((d) => d.kind));
  for (const k of [...order].reverse()) if (retriable.has(k) && count(k) === 1) return k;
  return undefined;
}

/**
 * `D:\a\b` → `/mnt/d/a/b`（WSL 里可执行的形态）。盘符小写是 WSL 的默认挂载约定。
 * 非盘符路径（UNC 等）原样返回 —— 那种情况 WSL 下本来也不通，交给自检去喊。
 */
export function toWslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * 组装 hook 命令。令牌走参数不走 env（hook 的 env 会被 DSH 擦洗）。
 * 路径形态按 shell 而定：WSL 下 exe 必须 `/mnt/...` 才找得到，而给 node.exe 的脚本参数
 * 必须是 Windows 形式（`/mnt/...` 会被 node 当 Windows 路径解析而打不开）—— 混着写才对。
 */
function buildHookCommand(
  nodePath: string,
  scriptPath: string,
  url: string,
  token: string,
  scriptTimeoutMs: number,
  shellKind: ShellKind
): string {
  const exe = shellKind === 'wsl' ? toWslPath(nodePath) : nodePath;
  return [
    quote(exe),
    quote(scriptPath),
    '--url',
    quote(url),
    '--token',
    quote(token),
    '--timeout-ms',
    String(Math.round(scriptTimeoutMs)),
  ].join(' ');
}

/** bash 双引号包裹：里面的 `\` 只在 `$`/反引号/`"`/`\`/换行 前才是转义，Windows 路径安全。 */
function quote(s: string): string {
  return '"' + s.replace(/(["\\$`])/g, '\\$1') + '"';
}

/**
 * 派生配置追加块：只增不改。刻意用 `id` + `name` + `config` 的显式写法 ——
 * 与用户 cordis.yml 里其它条目的写法一致（README 也支持 `- dsh-hooks-claude-code:` 简写，
 * 但保持一致更不容易踩插件的解析差异）。
 * 不设 `projectDir`：默认即"会话 cwd"，也就是用户的工作区，正是 hook 该待的地方。
 */
function derivedBlock(hooksPath: string): string {
  return (
    '\n' +
    '# --- AlohaDSH 事前审批（C1）自动追加：由扩展生成，请勿手工编辑 ---\n' +
    '- id: hello-chat-approval-hooks\n' +
    "  name: '@deepseek-ai/dsh-hooks-claude-code'\n" +
    '  config:\n' +
    '    configPath: ' + yamlLiteral(hooksPath) + '\n'
  );
}

/**
 * C11 档位插件块：同样只增不改。
 *
 * `name:` 写的是**本机文件的 `file:///…` URL** —— `cordis-plugin-loader` 认这条分支
 * （`new URL(name, baseUrl)` 然后 `import()`），所以插件不必进仓库、不必发 npm。
 * `statePath` 交给插件，它每次请求现读（热生效的根据）。
 */
function effortBlock(mount: EffortPluginMount): string {
  return (
    '\n' +
    '# --- AlohaDSH 会话级推理档位（C11）自动追加：由扩展生成，请勿手工编辑 ---\n' +
    '- id: hello-chat-reasoning-effort\n' +
    '  name: ' + yamlLiteral(mount.pluginUrl) + '\n' +
    '  config:\n' +
    '    statePath: ' + yamlLiteral(mount.statePath) + '\n' +
    '    thinkingDisabled: ' + (mount.thinkingDisabled ? 'true' : 'false') + '\n'
  );
}

/**
 * C12 工具白名单块：同样只增不改，`name:` 同样是本机文件的 `file:///…` URL。
 *
 * 与档位块的**关键差异**：`deny` 是**写死在配置里的**，没有状态文件 —— 工具策略在
 * agent 创建期只读一次，只在切 profile（= 重连）时变，没有"现读才热"的需求。
 * 少一个文件、少一次读盘、少一类竞态。
 */
function toolPolicyBlock(mount: ToolPolicyMount): string {
  const deny = mount.deny.map((n) => '      - ' + yamlLiteral(n) + '\n').join('');
  return (
    '\n' +
    '# --- AlohaDSH 工具白名单（C12）自动追加：由扩展生成，请勿手工编辑 ---\n' +
    '- id: hello-chat-tool-policy\n' +
    '  name: ' + yamlLiteral(mount.pluginUrl) + '\n' +
    '  config:\n' +
    '    deny:\n' +
    deny
  );
}

/** YAML 单引号字面量（`\` 不是转义，只有 `'` 需写成 `''`）——直接放 Windows 路径最稳。 */
function yamlLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * 根是不是**块状序列**：跳过空行与注释后，第一行必须以 `-` 开头。
 * 形如 `plugins:\n  - …` 或流式 `[…]` 的根一律拒绝（我们只会在末尾追加整条列表项）。
 */
function isBlockSequenceRoot(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    return line.startsWith('-');
  }
  return false;
}

/**
 * hook 脚本本体。用 String.raw 是因为里面全是正则与 `\s`/`\b` 这类转义 ——
 * 普通模板串会把 `\s` 吃成 `s`，正则就全废了。脚本内不使用 `${}` 插值。
 */
const HOOK_SCRIPT = String.raw`#!/usr/bin/env node
/**
 * AlohaDSH · C1/C4 事前审批 hook（由扩展自动生成，请勿手工编辑）。
 *
 * DSH 的 hooks-claude-code 插件在每次 bash / write / edit 工具调用**之前**执行本脚本，
 * 把载荷（{tool_name, tool_input, tool_use_id, cwd}）从 stdin 递进来；脚本向本机的审批
 * 服务询问决策并**保持连接**，直到用户点了允许/拒绝 —— 所以 agent 那一轮真的暂停在这里。
 *
 * 输出约定（CC 风格）：
 *   放行 = 不输出任何东西、exit 0（不表态）
 *   拒绝 = stdout 输出 hookSpecificOutput.permissionDecision = 'deny' + 原因，exit 0
 *
 * 两条工具的兜底不一样，**这是有意的**：
 *   bash  —— 扩展不可达时按内置危险清单拒绝，其余放行（既不因扩展挂掉而 sha 掉所有 bash，
 *            也不会把 rm -rf 这种放过去）。
 *   write/edit —— 扩展不可达时**一律放行**。C4 那半是「越出工作区才问」，属于额外护栏 +
 *            可见性纯增益；护栏自己坏了不该把 agent 的正常写文件能力一起拖下水。
 */
import * as http from 'node:http'

const FALLBACK = [
  /\brm\b/,
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\bdd\b[^|]*\bof=/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bdiskpart\b/,
  /\bformat\s+[A-Za-z]:/,
  /:\s*\(\s*\)\s*\{/,
]

function argOf(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : ''
}

function readStdin() {
  return new Promise((resolve) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { s += c })
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', () => resolve(s))
  })
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n')
}

function ask(url, token, payload, timeoutMs) {
  return new Promise((resolve) => {
    let target
    try { target = new URL('/pre-tool-use', url) } catch { resolve(null); return }
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-hello-token': token,
      },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return }
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
    req.end(body)
  })
}

/** 顶层 catch 靠它区分：true = 本次是 fs 工具（异常时放行而不是拒绝） */
let fsTool = false

async function main() {
  const raw = await readStdin()
  let payload
  try { payload = JSON.parse(raw) } catch { deny('无法解析 hook 输入，已按拒绝处理。'); return }
  if (!payload || typeof payload !== 'object') return

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}
  const url = argOf('--url')
  const token = argOf('--token')
  const timeoutMs = Number(argOf('--timeout-ms')) || 540000

  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command) return
    const res = url
      ? await ask(url, token, { toolName: 'bash', command: command, toolUseId: payload.tool_use_id }, timeoutMs)
      : null
    if (res && typeof res.decision === 'string') {
      if (res.decision === 'deny') {
        deny(typeof res.reason === 'string' && res.reason ? res.reason : '未获批准，命令未执行。')
      }
      return
    }
    for (const re of FALLBACK) {
      if (re.test(command)) { deny('审批服务不可达，且该命令命中内置危险清单，已拒绝。'); return }
    }
    return
  }

  if (toolName === 'write' || toolName === 'edit') {
    fsTool = true
    const filePath = typeof input.file_path === 'string' ? input.file_path : ''
    if (!filePath) return
    // cwd 是 DSH 给的会话工作区 —— 相对 file_path 的解析基准，判「是否越界」全靠它
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
    const res = url
      ? await ask(url, token, {
          toolName: toolName, filePath: filePath, cwd: cwd, toolUseId: payload.tool_use_id,
        }, timeoutMs)
      : null
    // 拿不到决策（扩展不可达/超时/异常）→ 放行；只有明确 deny 才拦（见文件头说明）
    if (res && res.decision === 'deny') {
      deny(typeof res.reason === 'string' && res.reason ? res.reason : '未获批准，该写入未执行。')
    }
    return
  }

  // 其余工具（read/glob/…）：不表态，exit 0
}

main().catch(() => {
  // fs 工具放行 —— 脚本自身出问题时，宁可让 agent 正常写文件，也不要变成写不了
  if (fsTool) return
  deny('审批 hook 异常，已按拒绝处理。')
})
`;
