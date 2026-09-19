/**
 * C13 · Windows 上的 shell 诊断：**agent 的 bash 到底会命中谁、它能不能用**。
 *
 * **不 import vscode** —— 同 `contextWindow` / `runInspector` 的体例。判据必须能在扩展宿主之外
 * 加载（`scripts/probe-shell-diag.mjs`），因为这里全是**猜不出来只能量**的事实。
 * 2026-09-19 在本机用 `dist-runtime/node/node.exe -e` 逐条实测：
 *
 * - **F1** `spawn('bash', …, {env})` 用**传入 env 的 PATH** 解析可执行文件，不是调用进程的：
 *   `PATH=E:/Git/bin` → `MINGW64_NT`；`PATH=C:/Windows/System32` → `Linux`。
 *   ⇒ 「钉住 bash」这个开关**真能换掉 agent 的 shell** —— PATH 是活的（`scrubbedParentEnv`
 *   只擦敏感键与 `DSH_*`，`dsh-bash-local` 的 `ENV_OVERRIDES` 不含 PATH）。
 * - **F2** libuv **完全不看 `PATHEXT`**：喂 `PATHEXT='.COM;.BAT'` 照样命中 `bash.exe`。
 *   ⇒ ⚠️ **不许照抄** `dsh-subprocess-local` 的 `executableCandidates` —— 它认 PATHEXT，
 *   抄过来会算出**错的赢家**（在 PATH 项不含显式扩展名的机器上谎报「没有 bash」）。
 * - **F3** `PATH=''` → ENOENT，**不回退当前目录**；空项被跳过；相对项按**子进程 cwd** 解析；
 *   `Path` / `PATH` 并存时大写 `PATH` 胜；**env 里完全没有 PATH 键时会回退宿主真实环境**
 *   ⇒ 所以 `prependPathDir` **绝不能删了 PATH 不补**（那等于把用户的 PATH 静默换成宿主的）。
 * - **F4** WSL shim 起不来时的话是 **UTF-16LE 落在 stdout**、stderr 空、退出码 4294967295。
 *   按 utf8 读是一串乱码 —— **这就是「无 WSL 的机器上给用户一串 bash 报错」的成因**：
 *   话就在那儿（解出来是「不存在具有所提供名称的分发」+ `WSL_E_DISTRO_NOT_FOUND`），
 *   只是没人按对的编码读它。
 *
 * 依赖单向：本模块 → `dshHooks`（只拿 `classifyShell` / `ShellKind` / `RawProbe`），反向不引。
 */

import * as fs from 'fs';
import * as path from 'path';
import { classifyShell, type ShellKind } from './dshHooks';

/** `WSL_E_*` 是**语言无关**的令牌 —— shim 的话术会随系统语言变，这个不会。 */
const WSL_CODE_RE = /\bWSL_E_[A-Z0-9_]+\b/;

/**
 * F4 抓到的 shim 报错文本（解码后）。
 *
 * 夹具用它：`Buffer.from(WSL_SHIM_ERROR_TEXT, 'utf16le')` **就是原始那份乱码** ——
 * 实测（2026-09-19）**116 字节、奇数位 NUL 占比 0.690**，与抓到的样本逐字节同形。
 * 探针拿它钉住 `decodeShimOutput`，也钉住「broken 且能还原出 `WSL_E_DISTRO_NOT_FOUND`」——
 * 这正是那条验收（无 WSL 的机器上给可读引导而非一串 bash 报错）的机器可验形态。
 */
export const WSL_SHIM_ERROR_TEXT =
  '不存在具有所提供名称的分发。\r\n错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n';

// ---------------------------------------------------------------- PATH 解析

/** `path` 的对应实现：**显式按 platform 选**，探针在 Linux 上也能钉 win32 语义。 */
function pathImpl(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : (path.posix as typeof path.win32);
}

export function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * 取 PATH 的值，**大小写不敏感**，精确 `PATH` 优先（F3 第 4 条：`Path` / `PATH` 并存时大写胜）。
 * 返回 `undefined` 表示**env 里根本没有这个键** —— 与「值是空串」不是一回事：
 * 前者 spawn 会回退宿主环境，后者是 ENOENT。
 */
export function pathValue(env: NodeJS.ProcessEnv): string | undefined {
  const keys = Object.keys(env);
  if (keys.includes('PATH')) return env['PATH'];
  const k = keys.find((x) => x.toUpperCase() === 'PATH');
  return k === undefined ? undefined : env[k];
}

export interface PathIO {
  /** 该绝对路径是不是一个可执行文件。缺省走 fs —— 探针传假的，好喂假 PATH。 */
  isFile?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  /** 相对 PATH 项的解析基准（= 子进程 cwd，F3 第 3 条） */
  cwd?: string;
}

/** 沿 PATH 命中过的一个 bash（不止赢家 —— 用户可能想把被挡在后面的那个钉上来） */
export interface BashHit {
  /** 命中的完整路径（即 `bash` 会解析到的东西） */
  path: string;
  /** 所在目录（钉 pin 时前置的就是它） */
  dir: string;
}

export interface PathResolution {
  command: string;
  /** 赢家：按 PATH 顺序第一个命中的。没有则 undefined */
  path?: string;
  /** 命中的裸文件名（无扩展名时可能是 `bash.exe`） */
  name?: string;
  /** **实际看过**的每一个候选路径，按搜索顺序。全落空时依然非空 —— 用来证明「看过了」而非「没看」 */
  tried: string[];
  /** 沿 PATH 命中过的**全部** bash，按搜索顺序 */
  hits: BashHit[];
  /** env 里连 PATH 键都没有（F3 地雷：spawn 会回退宿主环境） */
  noPathKey: boolean;
}

/**
 * 按 libuv 的实际语义沿 PATH 解析一个可执行文件。
 *
 * 语义照 F2/F3：
 * - **不碰 `PATHEXT`**；无扩展名时先试精确名、再试 `.EXE`（F2：libuv 硬写 `.exe`）
 * - 空项**跳过**（F3：`''` 不是「当前目录」）
 * - 相对项按 `io.cwd` 解析（F3 第 3 条）
 * - `PATH=''` 或全落空 ⇒ `path` 为 undefined，**不回退 cwd**
 *
 * ⚠️ `noPathKey` 为真时返回空结果，而**真 spawn 在那种情况下会回退宿主真实环境** ——
 * 纯函数不模拟那个回退（那要看宿主，不是看 env）。所以调用方**必须**保证 env 自带 PATH 键，
 * 见 `prependPathDir`。
 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv, io: PathIO = {}): PathResolution {
  const platform = io.platform ?? process.platform;
  const p = pathImpl(platform);
  const raw = pathValue(env);
  const out: PathResolution = { command, tried: [], hits: [], noPathKey: raw === undefined };
  if (raw === undefined) return out;

  // 无扩展名时先精确名、再 `.EXE`（F2：libuv 硬写 `.exe`）；带了扩展名就只试它自己
  const base = command.slice(Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\')) + 1);
  const names = platform === 'win32' && !base.includes('.') ? [command, command + '.exe'] : [command];

  const isFile = io.isFile ?? defaultIsFile;
  const cwd = io.cwd ?? process.cwd();
  for (const entry of raw.split(pathDelimiter(platform))) {
    if (!entry.trim()) continue; // F3：空项跳过
    const dir = p.isAbsolute(entry) ? entry : p.resolve(cwd, entry);
    for (const name of names) {
      const full = p.join(dir, name);
      out.tried.push(full);
      if (!isFile(full)) continue;
      out.hits.push({ path: full, dir });
      if (out.path === undefined) {
        out.path = full;
        out.name = name;
      }
    }
  }
  return out;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 分类

/** bash 的**形状**（只看目录形状，不看行为）*/
export type BashShape = 'none' | 'wsl-shim' | 'git-bash' | 'other';

export interface BashClass {
  shape: BashShape;
  /** 触因（进了 UI 的 title，也进探针断言）—— 必须点名是**哪一段目录**触发的 */
  evidence: string;
}

/**
 * 按**目录形状**认 bash 是谁。
 *
 * ⚠️ **绝不硬编码本机绝对路径**（`E:\Git\bin` 那类只属于这台机器，进仓库就是脏数据）。
 * 判据只认厂商默认布局：`…\System32\` / `…\WindowsApps\` 是 WSL 的两个入口，
 * `…\Git\bin\` 与 `…\Git\usr\bin\` 是 Git for Windows 的两种布局。
 *
 * 形状只是**文案与提示**用的启发式，判定（能不能用）一律走实测 —— 便携版 Git 会落到
 * `other`，Cygwin/MSYS2 也会落到 `other`，这无害：它们只要真能跑就照常 usable。
 */
export function classifyBashPath(bashPath: string | undefined): BashClass {
  if (!bashPath || !bashPath.trim()) return { shape: 'none', evidence: 'PATH 上一个 bash 都没有' };
  const s = bashPath.replace(/\\/g, '/').toLowerCase();
  if (/\/system32\//.test(s)) {
    return { shape: 'wsl-shim', evidence: '命中的是 System32 下的 WSL 启动器' };
  }
  if (/\/windowsapps\//.test(s)) {
    return { shape: 'wsl-shim', evidence: '命中的是 WindowsApps 下的 WSL 应用执行别名' };
  }
  if (/\/git\/(usr\/)?bin\//.test(s)) {
    return { shape: 'git-bash', evidence: '命中的是 Git for Windows 自带的 MSYS bash' };
  }
  return { shape: 'other', evidence: '不是 WSL 的两个入口，也不是 Git for Windows 的两种布局' };
}

// ---------------------------------------------------------------- 三值判定

export type ShellUsability = 'usable' | 'broken' | 'indeterminate';

/** 判定只需要这几个字段 —— 显式列出，好让探针手搓事实而不必起进程。 */
export interface ShellFacts {
  /** 退出码 0 */
  ok: boolean;
  /** 「不可判」：超时、或退出≠0 却一个字都不说。**这是 `HookSelfCheck.retriable` 的同一条纪律** */
  retriable: boolean;
  /** spawn 层就失败了（ENOENT/EACCES…）—— 确定性的 */
  spawnError?: string;
  /** 沿 PATH 一个候选都没有（连 spawn 都不必试） */
  noCandidate?: boolean;
  stdout: string;
}

/**
 * 三值判定。**「不可判」必须与「坏」分开**，理由与 `nextShellCheck` 那段一样：
 * 重载那一刻 WSL 正在冷启动，超时**只说明它还没起来**，不说明这台机器不能用 ——
 * 判成 broken 就会当着用户的面报一个假警（这个错在 C1 上犯过两次，别再犯）。
 *
 * 判据表：
 * | 事实 | 结论 |
 * |---|---|
 * | 没有候选 | broken（确定：PATH 上就没有 bash） |
 * | spawnError | broken（确定：ENOENT/EACCES） |
 * | retriable（超时 / 非零却两流皆空） | **indeterminate** |
 * | 退出≠0 且说了话 | broken（F4 那条 shim 报错就长这样） |
 * | 退出 0 但认不出 uname | broken（那不是 bash，是别的东西冒充） |
 * | 退出 0 且 `Linux`/`MINGW64`… | usable |
 */
export function usabilityOf(facts: ShellFacts): ShellUsability {
  if (facts.noCandidate) return 'broken';
  if (facts.spawnError) return 'broken';
  if (facts.retriable) return 'indeterminate';
  if (!facts.ok) return 'broken';
  return classifyShell(facts.stdout) === undefined ? 'broken' : 'usable';
}

/** 从一段（已解码的）文本里捞 WSL 的错误令牌 —— 语言无关的判据。 */
export function wslCodeOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = WSL_CODE_RE.exec(text);
  return m ? m[0] : undefined;
}

// ---------------------------------------------------------------- 诊断结论

export interface ShellDiagnosis {
  platform: NodeJS.Platform;
  /** 本次会话 agent 真正会命中的那把 bash（沿 PATH 解析出来的赢家） */
  bashPath?: string;
  shape: BashShape;
  classEvidence: string;
  /** 沿 PATH 命中过的全部 bash，含被赢家挡在后面的 */
  hits: BashHit[];
  /** 看过但没命中的候选路径（全落空时非空） */
  tried: string[];
  usability: ShellUsability;
  /** 认出来的形态（usable 时才有意义） */
  kind?: ShellKind;
  /** `uname -s` 的原始输出（已解码），给文案引用 */
  unameRaw?: string;
  /** 探针的失败话术（broken / indeterminate 时非空） */
  detail?: string;
  /** 认出 WSL 错误令牌时才有 —— 语言无关 */
  wslCode?: string;
  /** 用户钉的 bash 路径不存在（`hello.dsh.bashPath` 指空） */
  pinMissing?: string;
  /** pin 生效且解析出来的赢家 */
  pinned?: string;
  /** 工具默认所在的 cwd（= `_dshRunCwd()`） */
  runCwd?: string;
  /** 工作区外的写操作是否被审批拦着（`hello.dsh.approval.outsideWorkspace`） */
  outsideGated?: boolean;
}

export type ShellAdviceKind =
  | 'pin-missing'
  | 'no-bash'
  | 'wsl-no-distro'
  | 'wsl-broken'
  | 'broken'
  | 'indeterminate'
  | 'wsl-usable'
  | 'ok';

export interface ShellAdvice {
  kind: ShellAdviceKind;
  /** 一句话说清「现在会怎样」 */
  headline: string;
  /** 一句话说清「怎么改」 */
  action: string;
}

/** 能装 bash 的**厂商默认位置** —— 产品默认值，不是本机发现值（`E:\Git\bin` 那种永不入库）。 */
export function gitBashCandidateDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [];
  const p = path.win32;
  const roots = [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'] ? p.join(env['LOCALAPPDATA'], 'Programs') : undefined,
    env['ProgramW6432'],
  ].filter((x): x is string => !!x && !!x.trim());
  const out: string[] = [];
  for (const root of roots) {
    for (const sub of [p.join('Git', 'bin'), p.join('Git', 'usr', 'bin')]) {
      const dir = p.join(root, sub);
      if (!out.some((d) => d.toLowerCase() === dir.toLowerCase())) out.push(dir);
    }
  }
  return out;
}

/**
 * 五种话术（外加 pin 指空那一种）。**只生成文本**：按钮由调用方加，本模块不碰 UI。
 *
 * `platform !== 'win32'` 时一切照旧（非 Windows 上 bash 是真的，推荐装 Git for Windows 是噪声）。
 */
export function adviceFor(diag: ShellDiagnosis): ShellAdvice {
  const where = diag.bashPath ?? '（PATH 上找不到 bash）';
  if (diag.pinMissing) {
    return {
      kind: 'pin-missing',
      headline: `设置里钉的 bash 路径不存在：${diag.pinMissing}。本次没有前置任何目录，agent 用的还是 PATH 上解析出来的那把（${where}）。`,
      action: '改成一个真实存在的 bash.exe，或清掉这项设置。',
    };
  }
  if (diag.shape === 'none') {
    return {
      kind: 'no-bash',
      headline: '这台机器的 PATH 上一个 bash 都没有，agent 的 bash 工具一次都跑不起来（每次调用只会回一句「找不到命令」）。',
      action: '装一个 Git for Windows（自带 bash），或把 hello.dsh.bashPath 指到已有的那把。',
    };
  }
  if (diag.usability === 'broken') {
    if (diag.shape === 'wsl-shim' && diag.wslCode) {
      return {
        kind: 'wsl-no-distro',
        headline: `agent 的 bash 命中的是 WSL 启动器（${where}），而 WSL 里没有可用的发行版：${diag.wslCode}。每次调用都只会回一段乱码报错。`,
        action: '装一个 WSL 发行版（wsl --install -d Ubuntu，装完要重启），或把 bash 钉到 Git for Windows 自带的那把 —— 后者起得快得多。',
      };
    }
    if (diag.shape === 'wsl-shim') {
      return {
        kind: 'wsl-broken',
        headline: `agent 的 bash 命中的是 WSL 启动器（${where}），但它起不来：${diag.detail ?? '原因不明'}`,
        action: '先在系统终端里跑一次 wsl -l -v 看发行版还在不在；也可以改用 Git for Windows 的 bash。',
      };
    }
    return {
      kind: 'broken',
      headline: `PATH 上找到的 bash（${where}）跑不起来：${diag.detail ?? '原因不明'}`,
      action: '换一把能用的 bash，或把它钉到设置 hello.dsh.bashPath 上。',
    };
  }
  if (diag.usability === 'indeterminate') {
    return {
      kind: 'indeterminate',
      headline: `agent 的 bash（${where}）这次没能探出结论：${diag.detail ?? '超时'}。`,
      action: '多半是 WSL 正在冷启动 —— 重连一次再探。',
    };
  }
  if (diag.shape === 'wsl-shim') {
    return {
      kind: 'wsl-usable',
      headline: `agent 的 bash 走的是 WSL（${where}）：能用，但每次调用都要先唤醒 WSL（冷启动实测约 5 s）。`,
      action: '想快就钉一把 Git for Windows 的 bash。',
    };
  }
  return {
    kind: 'ok',
    headline: `agent 的 bash：${where}（${diag.classEvidence}）。`,
    action: '',
  };
}

/**
 * 该不该弹告警（`undefined` = 不弹）。
 *
 * **只有两种情况给文本**，因为它们都不是「猜」：① `broken` —— 有探针实证；
 * ② `pinMissing` —— 用户亲手写的配置指空了。冷启动的 `indeterminate` **永不告警**，
 * 这是「不误报」的全部保证，探针用配对断言钉着它（usable/indeterminate ⇒ undefined）。
 */
export function shellWarnFor(diag: ShellDiagnosis): string | undefined {
  if (diag.usability !== 'broken' && !diag.pinMissing) return undefined;
  const a = adviceFor(diag);
  const lines = [a.headline, a.action];
  // 「工具将在哪个 cwd、能不能出工作区」—— 只在要用户动手时才值得占地方
  if (diag.runCwd) {
    lines.push(
      `工具默认在 ${diag.runCwd} 里跑；` +
        (diag.outsideGated ? '工作区外的写操作会被审批拦下。' : '⚠️ 工作区之外的写操作不会被审批拦（hello.dsh.approval.outsideWorkspace 关着）。')
    );
  }
  return lines.join('\n');
}

export interface ShellStatusSegment {
  label: string;
  level: 'wsl' | 'warn' | 'bad';
  title: string;
}

/**
 * 顶部状态条上那一小段（`undefined` = 整段不出现）。
 *
 * 三态：能用且不是 WSL ⇒ **不出现**（没话可说就别占地方）；能用但在 WSL ⇒ 琥珀 `bash=WSL`；
 * 不可判 ⇒ 琥珀 `bash=?`；坏 ⇒ 红 `bash=坏`。pin 指空时即使 bash 能用也现身（`bash=pin?`）——
 * 用户亲手设的东西静默失效是最坏的一种「安静」。
 */
export function shellStatusSegment(diag: ShellDiagnosis): ShellStatusSegment | undefined {
  // 非 Windows 上 bash 是真的，`System32\bash.exe` 那一整套坑不存在 —— 整段不出现（Remote-SSH 尤其）
  if (diag.platform !== 'win32') return undefined;
  const lines: string[] = [];
  if (diag.bashPath) lines.push(`agent 的 bash：${diag.bashPath}（${diag.classEvidence}）`);
  else lines.push(diag.classEvidence);
  lines.push(`沿 PATH 命中过 ${diag.hits.length} 个，看过 ${diag.tried.length} 个位置`);
  if (diag.pinMissing) lines.push(`⚠️ 设置里钉的 bash 不存在：${diag.pinMissing}`);
  if (diag.pinned) lines.push(`（已按设置前置：${diag.pinned}）`);
  if (diag.unameRaw) lines.push(`uname -s：${diag.unameRaw.trim()}`);
  if (diag.usability === 'indeterminate') lines.push('这次探针没能给出结论（超时或启动器空手退出）——不一定是坏，重连会再探一次。');
  if (diag.detail && diag.usability !== 'indeterminate') lines.push(diag.detail);
  if (diag.usability === 'usable' && diag.shape === 'wsl-shim') {
    lines.push(adviceFor(diag).action);
  }
  if (diag.runCwd) lines.push(`工具 cwd：${diag.runCwd}${diag.outsideGated ? '（工作区外会被审批拦）' : '（⚠️ 工作区外不受审批拦）'}`);
  const title = lines.join('\n');

  if (diag.pinMissing) return { label: 'bash=pin?', level: 'warn', title };
  if (diag.usability === 'broken') return { label: 'bash=坏', level: 'bad', title };
  if (diag.usability === 'indeterminate') return { label: 'bash=?', level: 'warn', title };
  if (diag.shape === 'wsl-shim') return { label: 'bash=WSL', level: 'wsl', title };
  return undefined;
}

// ---------------------------------------------------------------- PATH 注入

/** 平台感知的「这两个目录写的是不是一个地方」（Windows 上大小写不敏感） */
function sameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 把 `dir` 前置到 PATH 上 —— **唯一**的注入点（`_dshEnv()` 里那一次）。
 *
 * 五条硬规矩：
 * 1. `dir` 空（或全空白）⇒ **原样返回同一个对象**（「未设 pin = 逐字节相同」取最强形式）
 * 2. **永不删了 PATH 不补**（F3 地雷：env 没有 PATH 键时 spawn 会回退**宿主真实环境**，
 *    那时你精心准备的那个 PATH 被无声忽略）
 * 3. **幂等**：已经前置过就不再前置（设置变更后重连会再走一次这条路）
 * 4. **不改入参**，返回新对象
 * 5. 删掉**所有**大小写变体的 PATH 键，只补一个 `PATH` —— 否则 `Path` 与 `PATH` 并存时
 *    按 F3 大写胜，我们前置的那个可能被忽略
 */
export function prependPathDir(
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const trimmed = dir.trim();
  if (!trimmed) return env;
  const old = pathValue(env);
  const delim = pathDelimiter(platform);
  const first = old === undefined ? undefined : old.split(delim)[0];
  if (first !== undefined && sameDir(first.trim(), trimmed, platform)) return env; // 幂等

  const out: NodeJS.ProcessEnv = {};
  let placed = false;
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH') {
      if (!placed) {
        out['PATH'] = old === undefined || old === '' ? trimmed : trimmed + delim + old;
        placed = true;
      }
      continue;
    }
    out[k] = env[k];
  }
  if (!placed) out['PATH'] = trimmed; // 本来没有 PATH 键：补上，**不是**留空
  return out;
}

/** 设置值 → 可用路径。空白/非串 ⇒ `undefined`（体例同 `compactionOverride` 的取值函数）。 */
export function shellPin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s ? s : undefined;
}

// ---------------------------------------------------------------- POSIX 路径两读法

export interface PosixTarget {
  /** 模型原样递上来的 */
  raw: string;
  /** 模型想指的那个 Windows 路径（只认两种 POSIX 形态，认不出就 undefined） */
  intended?: string;
  /** **按 DSH 的解析方式**会落到哪（`path.win32.resolve(cwd, raw)`）—— 预测，不是事实 */
  actual: string;
}

/**
 * 同一个字符串的两种读法（**只显示，不改写** —— 路径归一化是本次明确不做的事）。
 *
 * 由来是 `docs/backlog.md` 里那次真事故：agent 在 WSL 里读到 `PWD=/mnt/d/…`，随后调 `write`
 * 递上 `/mnt/d/…`；DSH 的 fs 工具把它当 **Windows 相对路径**解析，落到 `D:\mnt\d\…`。
 * 审批条（fail-safe）确实弹了，但**没抓快照** ⇒ 那次改动对审阅是隐形的。
 *
 * - `intended` 只认 `/mnt/<盘>/…` 与 `/<盘>/…`；**其余一律 undefined**（`/etc/passwd` 不猜）
 * - `actual` 用**显式 `path.win32`**：跨宿主结果一致，探针在 Linux 上也能钉
 * - `cwd` 缺失或不是 POSIX 形态 ⇒ 整条 `undefined`。⚠️ 盘符来自 cwd，
 *   缺了会自信地印一个错位置 —— 比不说更糟
 * - `//…`（UNC）也整条 `undefined`：它压根不是「模型把 `D:\x` 写成了 POSIX」，
 *   没有「想指的」可言。这条**不是顺手加的**：它让本函数的准入集合**恰好等于**
 *   `_fsTargetAbs` 里 `raw.startsWith('/') && !raw.startsWith('//')` 那一句的集合 ——
 *   也就是说，**会印出这段话的路径，正好就是不会抓轮前快照的那些**。
 *   两处若各写各的，就会出现「提示说这次改动不在审阅里，实际却抓了快照」那种自相矛盾。
 */
export function readPosixTarget(raw: string, cwd: string): PosixTarget | undefined {
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  if (!cwd || !cwd.trim()) return undefined;
  const mounted = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
  const drive = mounted ?? /^\/([A-Za-z])(?:\/(.*))?$/.exec(raw);
  const intended =
    drive === null
      ? undefined
      : drive[1].toUpperCase() + ':' + (drive[2] === undefined ? '\\' : '\\' + drive[2].replace(/\//g, '\\'));
  return { raw, intended, actual: path.win32.resolve(cwd, raw) };
}
