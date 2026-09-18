import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomBytes } from 'crypto';
import {
  Attachment,
  ChatMessage,
  DshConnState,
  ExtToWebview,
  FileRef,
  Mode,
  ReviewChange,
  SessionSummary,
  UsageBuckets,
  UsageReadout,
  WebviewToExt,
} from './protocol';
import { ApprovalAsk, ApprovalOutcome, ApprovalServer, matchesAnyPattern } from './approvalServer';
import { contextStateOf, resolveContextWindow } from './contextWindow';
import {
  ApprovalHookFiles,
  CompactionRatios,
  compactionOverride,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  nextShellCheck,
  probeShell,
  ShellCheckAttempt,
  ShellKind,
  testApprovalHook,
  writeApprovalHookFiles,
  writeDerivedConfig,
} from './dshHooks';
import { isAbortError, streamMockReply } from './mockAssistant';
import {
  capToolInput,
  dshStillReferenced,
  LoadReport,
  RETENTION_DAY_MS,
  SessionStore,
  StoredSession,
  titleFromText,
} from './sessionStore';
import { removeDshSessionDir } from './dshPaths';
import { searchSessions } from './sessionSearch';
import { sessionToJson, sessionToMarkdown, suggestedFileName } from './sessionExport';
import {
  applyRevert,
  compareTrees,
  FsSnapshot,
  lineDiff,
  snapshotSingleFile,
  snapshotTree,
  TreeChange,
} from './fileSnapshot';
import {
  ContentBlock,
  DshEventData,
  DshEventFrame,
  DshRuntime,
  DshSpawnRequest,
  DshStatusFrame,
  DshTokenUsage,
  isDshTimeout,
} from './dshRuntime';
// C8：轮次状态判据（纯模块，零 vscode 依赖，scripts/probe-turn-state.mjs 直接加载编译产物自检）
import { needsContinue, TurnStatus } from './turnState';
import { readCompactionEvent } from './compactionNotice';
// C9：运行时间线累积器 + 配对/成败判据（纯模块，零 vscode 依赖，
// scripts/probe-run-inspector.mjs 直接加载编译产物自检）。后两个导出是**唯一的一份实现** ——
// 本文件里 `_toolKey` 与 `tool/result` 的三态判定（ok / error / **unknown**）都改成调用它们，
// 免得检查器与转写对同一件事各说一套。
import { RunInspector, toolKeyFrom, toolResultVerdict, type RunReadout } from './runInspector';

/** 附件内容上限：超过这个字节数的文件不读；超过这个字符数的内容截断。 */
const MAX_FILE_BYTES = 10 * 1024; // 单文件最多 10KB
const MAX_CONTENT_CHARS = 200 * 1024;

/** globalState 里记住上次用的模式 */
const MODE_KEY = 'hello.chat.mode';

/** harness 模式独立的历史文件名（chat 沿用 sessions.json，互不串） */
const HARNESS_FILE = 'sessions-harness.json';

/** live 后端配置里 provider/model 的兜底默认（用户可在设置里改） */
const DEFAULT_DSH_PROVIDER = 'deepseek-official';
const DEFAULT_DSH_MODEL = 'deepseek-v4-flash';

/** SecretStorage 里存 DEEPSEEK_API_KEY 的键名 */
const API_KEY_SECRET_KEY = 'DEEPSEEK_API_KEY';

/** globalState 里记住配置条里选中的模型（覆盖 hello.dsh.model 的默认值） */
const LIVE_MODEL_KEY = 'hello.harness.liveModel';

/** 配置条"模型"下拉的预设型号（选了不在列的可用"自定义…"输入任意 id） */
const PRESET_MODELS = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'];

/**
 * C1 事前审批的默认策略（正则，命中即需用户确认）。保守清单：删/格盘/强推/关机这类
 * 一旦执行就很难看回来的命令。与 package.json 里 hello.chat.approval.patterns 的默认值一致。
 */
const DEFAULT_APPROVAL_PATTERNS = [
  '\\brm\\b', // 任何 rm（rm -rf / rm -f / rm <文件> 都算；`git rm`、`docker rm` 也一并拦）
  '\\brmdir\\b',
  '\\bmkfs(\\.|\\s|$)',
  '\\bdd\\b[^|]*\\bof=',
  '\\bdiskpart\\b',
  '\\bformat\\s+[A-Za-z]:',
  '\\bgit\\s+push\\b[^|]*--force',
  '\\bgit\\s+reset\\s+--hard\\b',
  '\\b(shutdown|reboot|poweroff)\\b',
  ':\\s*\\(\\s*\\)\\s*\\{', // fork bomb
];

/**
 * C4 一个审阅根。`tree` = 工作区整棵树（2.1 老行为）；`file` = 工作区外单个文件，
 * 快照的 root 是它的父目录、条目 rel 是 basename —— 于是对比/还原与树根完全同构。
 */
interface ReviewRoot {
  kind: 'tree' | 'file';
  /** 快照的根（tree = 工作区根；file = 目标文件的父目录） */
  root: string;
  snap: FsSnapshot;
  /** 仅 kind==='file'：目标文件的绝对路径，也是它在 map 里的键 */
  target?: string;
  /** 仅 kind==='file'：展示给用户的所在目录（就是 root，留个语义名免得读混） */
  outside?: string;
}

/** 已算出、等待 keep/revert 的一条：带上它所属的根，还原时才找得回磁盘位置。 */
interface PendingReview {
  /** 动作主键（`rv1`、`rv2`…），跨根唯一 */
  id: string;
  root: ReviewRoot;
  change: TreeChange;
}

/** C4 区外审阅的根数上限：满了就不再新增（**不做淘汰** —— 淘汰会丢已有可还原项）。 */
const MAX_OUTSIDE_REVIEW_ROOTS = 20;

/** `hello.chat.approval.outsideWorkspace` 的默认值（只 gate「问」，不 gate「看」） */
const DEFAULT_APPROVAL_OUTSIDE = true;

/** 用户等待上限（秒）的默认值；与 hook 超时形成 540 < 560 < 580 的梯度 */
const DEFAULT_APPROVAL_TIMEOUT_SEC = 540;
/** 等待上限的可用区间（秒）：下限防误设成 0 变成"永远拒绝"，上限别把侧栏挂太久 */
const APPROVAL_TIMEOUT_MIN_SEC = 10;
const APPROVAL_TIMEOUT_MAX_SEC = 1800;

/** 把可能多行的命令压成一行短摘要（确认条/状态栏/留痕用；换行会撑坏单行布局）。 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** 单条工具输出在转写里最多展示的字符数（超出截断 + 提示） */
const MAX_TOOL_OUTPUT_CHARS = 4000;
/** 1.1 选区注入的兜底摘录护栏（正常走 @临时文件，只在写盘失败时用）：行数/字符双上限，防整段大选区刷爆对话。 */
const SNIPPET_LINE_CAP = 100;
const SNIPPET_CHAR_CAP = 8000;

/** 把任意值变成工具入参的小字展示文本（对象 → 缩进 JSON；JSON 字符串 → 也解析成缩进 JSON） */
function prettyValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') {
    if (!v) return v;
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v; // 非 JSON 的普通文本原样展示
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 便携运行时清单（`<runtimeDir>/runtime.json`，由 scripts/build-runtime.mjs 产出）。路径均为相对目录、正斜杠。 */
interface RuntimeManifest {
  formatVersion?: number;
  dshVersion?: string;
  platform?: string;
  nodeVersion?: string;
  node: string;
  entry: string;
  config: string;
  /** 我们对产物做过的改动清单（build-runtime.mjs 写；手搓/外部运行时通常没有本字段）。
   *  目前只有一个取值 `resume-first-session` —— 它就是「这个运行时能不能跨进程复用 DSH id」的判据。 */
  patches?: string[];
}

/**
 * 我们给便携运行时打的补丁名（与 scripts/runtime-patch.mjs 的 `PATCH_NAME` 一字不差）。
 * 构建期有一致性断言盯着这个字面量，改了一边忘了另一边会当场构建失败，而不是静默丢记忆。
 */
const DSH_RESUME_PATCH = 'resume-first-session';

/**
 * `hello.dsh.runtimeDir` 的解析结果。
 * - `undefined`：没配这个设置 → 走既有的手工 nodePath/entry 路径。
 * - `{ ok: false }`：配了但目录不可用 → **明确报错，不静默回落**。用户指了运行时目录却跑到旧路径上，
 *   比直接告诉他哪儿坏了更难查。
 */
type RuntimeResolution =
  | { ok: true; dir: string; node: string; entry: string; config: string; manifest: RuntimeManifest }
  | { ok: false; problem: string };

/**
 * 读一个便携运行时目录的清单，把三个相对路径解析成绝对路径并逐个验存在。
 * 不读设置 —— 向导里验的是"用户刚选中的目录"，那时还没写进设置。
 */
function readRuntimeDir(dir: string): RuntimeResolution {
  const manifestPath = path.join(dir, 'runtime.json');
  let manifest: RuntimeManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeManifest;
  } catch {
    return { ok: false, problem: `这个目录里读不到 runtime.json：${manifestPath}` };
  }

  const resolved: Record<'node' | 'entry' | 'config', string> = { node: '', entry: '', config: '' };
  for (const key of ['node', 'entry', 'config'] as const) {
    const rel = String(manifest[key] ?? '').trim();
    if (!rel) return { ok: false, problem: `runtime.json 缺少 "${key}" 字段：${manifestPath}` };
    const abs = path.resolve(dir, rel);
    try {
      fs.accessSync(abs);
    } catch {
      return { ok: false, problem: `runtime.json 里的 ${key} 不存在：${abs}` };
    }
    resolved[key] = abs;
  }
  return { ok: true, dir, node: resolved.node, entry: resolved.entry, config: resolved.config, manifest };
}

/**
 * 侧边栏聊天视图的 Provider。
 *
 * 职责：把 media/chat.html 喂给 webview，转发前后端消息，编排回复
 *（内嵌聊天 = 假助手流；Harness = 连真实 DSH 子进程），并管理「多会话（历史）」。
 *
 * 两种顶部模式（chat / harness）各自拥有**完全独立**的会话与历史：两个 SessionStore
 * 各用一个 json 文件，两份 active 会话都常驻内存。当前处于哪个模式，由 `_mode` 决定，
 * `_store`/`_active` 两个 getter 映射到对应 workspace —— 因此既有方法几乎不用改，
 * 它们天然作用在"当前模式"上。切换模式时记住到 globalState，重启后自动回到该模式。
 *
 * 会话模型：
 * - SessionStore 负责把历史会话持久化到 globalStorage/sessions*.json。
 * - `_active` 是当前正在聊的会话对象；空的"新对话"也是一个会话对象，
 *   但**只有塞入消息后才入库/上列表**（空会话不产生垃圾历史）。
 * - 流式期间视图被隐藏/销毁 → 继续累积进 `_active.messages`，重新可见后靠
 *   snapshot 重建，消息不丢；因此 _post 不做 visible 过滤。
 *
 * 切换/新建/删除会话或模式时，若正在流式生成，会先安全中止（把半截回复标记为
 * interrupted、running 工具卡落成 error）再切换，避免残留"永远生成中"的状态把输入锁死。
 */
/**
 * 本轮的用量累计（C3a）。
 *
 * **必须按 (turn, step) 去重**：DSH 对同一步会报两次 usage —— `assistant/chunk` 的早样本
 * （躲过一次失败的请求也能留下计数）与 `assistant/message` 的终样本，两者值**逐字节相同**。
 * 实测三份抓帧里，天真累加的结果**恰好都是 2 倍**。故这里以 `${turn}:${step}` 为键、
 * **后到覆盖**（同 DSH 自己 token-meter 投影的语义），再对值求和。
 */
interface TurnUsage {
  /** 去重键 `${turn}:${step}` → 该步的计数（早样本被终样本覆盖） */
  byStep: Map<string, UsageBuckets>;
  /** 最近一次样本的 prompt 侧压力（未命中 + 缓存读 + [缓存写]），末次优先 */
  pressureTokens?: number;
  /** 已折进 `_active.usage`。折完**仍留着显示** —— 不然"本轮"会在轮尾突然归零，
   *  而人正是想在这一轮跑完后看它烧了多少。下一条样本到来时换一个新的。 */
  folded: boolean;
}

/** 线上字段可能缺省或非数字 → 一律折成非负数。 */
function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 三项计数互斥，逐项相加即可（outputTokens 已含 reasoningTokens，别再叠加）。 */
function addBuckets(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function zeroUsage(): UsageBuckets {
  return { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}

function isZeroUsage(b: UsageBuckets): boolean {
  return b.inputTokens === 0 && b.cacheReadTokens === 0 && b.outputTokens === 0;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  /** 每模式一个存储 / 一个"当前会话" */
  private readonly _stores: Record<Mode, SessionStore>;
  private readonly _actives: Record<Mode, StoredSession>;
  /** 当前活动模式；set-mode / 启动时从 globalState 读出 */
  private _mode: Mode;
  /** 正在流式产出的控制器；非空 = 忙（chat 的助手流 / harness 的整轮执行） */
  private _abort?: AbortController;
  /** 正在流式产出的那条助手消息（用于中止时标 interrupted） */
  private _runningMsg?: ChatMessage;
  private _msgSeq = 0;
  private _viewDisposables: vscode.Disposable[] = [];

  /** globalStorage 根目录（放 dsh-sessions 用） */
  private readonly _storageDir: string;

  // ---------- live（DSH 子进程）状态：harness 恒为 DSH 直播 ----------

  /** DSH 子进程连接状态（进程意外退出 → error） */
  private _backendState: DshConnState = 'offline';
  /** 在线时展示的模型名 */
  private _backendModel?: string;
  /** connecting 的进度文案 / error 的原因 */
  private _backendDetail?: string;
  /** 常驻 DSH 子进程客户端：懒创建；被杀后置空、下次自动重建 */
  private _dsh?: DshRuntime;
  /** UI 会话 id → DSH sessionId。**纯缓存**：真相在 `StoredSession.dsh`（跨重启），
   *  这里只是省掉「每轮都去问一遍运行时能不能续」；重连/重载后可从盘上重新推导。 */
  private readonly _dshSessions = new Map<string, string>();
  /** 「不能安全续上」时给临时 id 加的盐（见 _dshIdentityReusable）：每 activation 随机一次，
   *  于是每次激活铸出的 id 都不同，绝不会撞上旧进程留在盘上的会话日志。 */
  private readonly _dshHostRand = randomBytes(4).toString('hex');
  /** live 正在跑一轮（busy / 输入锁定的扩展侧真相） */
  private _liveRunning = false;
  /** live 轮里"当前开着的"助手文字气泡（工具前文字先收尾成独立气泡的依据） */
  private _openAssistant?: ChatMessage;
  /** 当前 live 轮对应的 DSH 会话 id（事件按它过滤） */
  private _currentDshId?: string;
  /**
   * C8：DSH 侧「这个会话还在跑吗」（session.status 通知喂出来的）。
   *
   * 只有一个用途：**放宽**判断 —— 已知还在跑就别把长轮误判成失败。`session.status` 只在状态
   * 翻转时发、wire 上没有查询方法，漏一条就补不回来，所以**绝不能**用它认定「跑完了」。
   * 与 `_currentDshId` 必须同步 reset（换会话 / 进程一死，一切都不可信）。
   */
  private readonly _turnStatus = new TurnStatus();
  /** 已知 DSH 侧还在跑（见 _turnStatus 的说明）。 */
  private get _dshRunning(): boolean {
    return this._turnStatus.running;
  }
  /** 进行中的连接握手（_connectLive 幂等/共享用；并发调用都等同一个） */
  private _connectPromise?: Promise<void>;
  /** 本轮结束时 resolve（_finishTurn / 出错路径用来唤醒 _runLive 的 await） */
  private _endTurnResolve?: () => void;
  /** DSH tool/call 的 `callId`（无则 `turn:step`）→ 我们的工具卡消息 id */
  private readonly _toolIds = new Map<string, string>();
  /** 从 SecretStorage / 回退文件解析出的 DEEPSEEK_API_KEY（只进子进程 env，绝不落日志） */
  private _apiKeyCache?: string;
  /** _sendUser 入列本条 user 消息前，该会话是否已有历史（live"失忆"note 的判断依据） */
  private _hadHistoryBeforeSend = false;
  /** media/dsh-live 构建产物是否齐全（决定 webview 能否进入真 DSH 组件画面） */
  private _hasDshBundle = false;

  // ---------- 2.1 改动审阅（每轮 DSH 结束后对工作区根 Keep/Revert）状态 ----------

  /** 本轮是否正常走完（idle → done）。interrupted/error/abort 恒 false → 收尾清掉审阅 */
  private _turnNormalDone = false;
  /**
   * 本轮审阅快照的根（C4 起多根）。键 = 根自身的标识：
   * 工作区根用它的绝对路径，工作区外目标用**该文件的绝对路径**（不是父目录 —— 同目录
   * 两个目标会撞键）。值为轮首快照，diff 之后仍保留供 keep/revert 还原用。
   * 空 map = 本轮不审。
   */
  private _reviewRoots = new Map<string, ReviewRoot>();
  /** token：新一轮 / 导航清理时自增，让迟到的异步对比失效（防两轮 diff 交错）。
   *  配套的 `_reviewRoots` 判代靠**引用相等**：轮首/清理一律换一个新 Map，从不原地 clear。 */
  private _reviewSeq = 0;
  /** 已算出、尚未被 keep/revert 处理的改动（rich 版 + 动作主键 id，还原时知道回哪个根） */
  private _pendingReview: PendingReview[] = [];
  /** 审阅项 id 递增源（`rv1`、`rv2`…），只在对比时分配一次 */
  private _reviewIdSeq = 0;

  // ---------- C1 事前审批（破坏性 bash 命令确认条）状态 ----------

  /** 本机审批服务（引用非空 = 功能在跑） */
  private _approval?: ApprovalServer;
  /** 已生成并生效的 hook 三件套（引用非空 = spawn 时改用派生配置） */
  private _approvalFiles?: ApprovalHookFiles;
  /** 进行中的准备（幂等：并发调用共享同一个 promise） */
  private _approvalSetup?: Promise<void>;
  /** 挂起审批的命令原文（id → 命令），结算时写留痕用 */
  private readonly _approvalCmds = new Map<string, string>();
  /** 审批相关告警是否已弹过（每次 activation 最多烦用户一次） */
  private _approvalWarned = false;
  /**
   * 「不可判的失败」那次重试是否已用掉（每次 activation 一次）。冷启动只发生一次，
   * 重试也只该给一次 —— 否则每发一条消息都要先干等两轮自检超时。
   */
  private _approvalRetried = false;
  /** C8c：存储相关告警是否已弹过。**独立旗标** —— 与审批共用一个的话，先到的那个会把后到的整条吞掉 */
  private _storageWarned = false;
  /** 与视图无关的订阅（全局配置变更监听），dispose 时统一清 */
  private readonly _globalDisposables: vscode.Disposable[] = [];

  // ---------- C10 派生配置（压缩阈值覆盖）状态 ----------

  /**
   * 真正下发的 cordis.yml（`DSH_CORDIS_CONFIG` 指它）。**非空 = 用派生文件，空 = 用底本**。
   *
   * 与 `_approvalFiles` 分开是因为**它们的生命周期不同**：审批关掉时 `_approvalFiles` 会被清空，
   * 而压缩阈值覆盖必须继续生效 —— 它跟审批没有任何关系（详见 `_refreshDerivedConfig`）。
   */
  private _overlayConfigPath?: string;
  /** C10：压缩阈值覆盖相关告警是否已弹过。**独立旗标**，理由同 `_storageWarned` */
  private _compactionWarned = false;

  // ---------- C3a 用量读数（每轮/每会话 token + 上下文占用率）状态 ----------

  /** 本轮累计；一轮跑着才有值。轮尾折进 `_active.usage` 后置空（单点折叠 → 不可能双计） */
  private _turnUsage?: TurnUsage;
  /**
   * 本次连接里收到的上下文窗口（占用率分母），来自 `request/context`。
   *
   * ⚠️ **它不是唯一来源、也不是常有的**：续聊时那个事件一条都不发（C10b），所以分母要靠
   * `StoredSession.contextWindow` 兜底 —— 一律走 `_effectiveContextWindow()`，别直接用它。
   */
  private _contextWindow?: number;

  // ---------- C9 运行检查器（本轮帧时间线）状态 ----------

  /**
   * 运行时间线累积器。**纯内存、最近 20 轮、不落盘**（用户 2026-09-17 的决策）——
   * 所以它**不需要**跟着 `_resetTurnUsage()` 的五个调用点走：模块里没有「当前会话」这个状态，
   * 会话身份是 `apply(frame, this._active.id)` 的**入参**，永远取当下的值。
   */
  private readonly _runs = new RunInspector();
  /** 运行浮层是否开着。开着才把 `details` 随 `runs` 一起下发（体积控制） */
  private _runsPanelOpen = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    storageDir: string,
    private readonly _globalState: vscode.Memento,
    private readonly _secrets: vscode.SecretStorage
  ) {
    this._storageDir = storageDir;
    const saved = this._globalState.get<Mode>(MODE_KEY);
    // 默认 = harness（主线）：只有用户上次明确选过「内嵌聊天」才回 chat；从未选过则进 harness。
    // harness 恒为 DSH 直播：懒 spawn，但视图每次就绪会预热连接（见 'ready' 处理）。
    this._mode = saved === 'chat' ? 'chat' : 'harness';

    // 两套存储：chat 用老文件（兼容既有历史），harness 用独立文件
    this._stores = {
      chat: new SessionStore(storageDir),
      harness: new SessionStore(storageDir, HARNESS_FILE),
    };
    // 各自开个空的新会话，等第一条消息再入库
    this._actives = {
      chat: this._stores.chat.create(),
      harness: this._stores.harness.create(),
    };

    // C1：审批开关翻转 → 重建审批服务/派生配置，并重连让子进程带上（策略正则是每次现读，改策略即时生效）。
    // **只认 enabled**：hook 的 matcher 是生成期定的，非得重连才生效；而 patterns /
    // timeoutSec / C4 的 outsideWorkspace 都是每次现读的，跟着重启一次 DSH 子进程纯属白搭
    // （还会打断正在跑的会话）。
    this._globalDisposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('hello.chat.approval.enabled')) return;
        if (this._abort || this._liveRunning) return; // 跑着的时候不动，下次连接自然带上
        void this._ensureApproval().then(() => this._restartLiveProcess());
      })
    );
    // C10：压缩阈值同样**只在插件构造期读**（cordis 没有插件配置热加载），所以改了要重连一次。
    // 独立一条而不是并进上面那条：上面那条认的是 approval.enabled，混在一起会让
    // 「改了审批开关」与「改了阈值」共用一个早退判断，将来任何一边加条件都会误伤另一边。
    this._globalDisposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('hello.chat.compaction.thresholdRatio')) return;
        if (this._abort || this._liveRunning) return; // 同审批：跑着不动，下次连接带上
        this._overlayConfigPath = undefined; // 先作废旧指向，防重连失败时还留着上一份派生文件
        void this._ensureApproval().then(() => this._restartLiveProcess());
      })
    );
  }

  /** 当前模式的存储（getter：把"当前模式"映射到对应 workspace） */
  private get _store(): SessionStore {
    return this._stores[this._mode];
  }

  /** 当前模式的"正在聊"会话 */
  private get _active(): StoredSession {
    return this._actives[this._mode];
  }

  /**
   * react-live：harness 模式（恒为 DSH 直播）+ media/dsh-live 产物齐全。
   * 为真时 webview 揭示真 DSH 对话组件（ChatView）；扩展据此把原始帧转给 webview，
   * 而不是只发 DOM 气泡（DOM 气泡仍照发，让 SessionStore 转写保持完整）。
   */
  private get _reactLive(): boolean {
    return this._mode === 'harness' && this._hasDshBundle;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    // 每次 resolve 前先清掉旧监听，防止同一 view 上重复挂载导致消息翻倍
    this._disposeViewListeners();

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    this._viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((msg) => {
        this._onMessage(msg);
      }),
      webviewView.onDidDispose(() => {
        if (this._view === webviewView) {
          this._view = undefined;
        }
        this._disposeViewListeners();
      })
    );
  }

  // ---------- 对外命令 ----------

  /** 「新建对话」：归档当前模式的会话（若有内容）并开一个空的新会话。 */
  startNewSession(): void {
    this._cancelActiveRun();
    this._dropReview(true); // 新建对话 → 清掉上一轮遗留的审阅
    this._resetTurnUsage(); // C3a：本轮读数不跨会话
    if (this._active.messages.length > 0) {
      this._store.replace(this._active);
      this._store.persist();
    }
    this._actives[this._mode] = this._store.create();
    this._postSnapshot();
    this._sendHistory();
  }

  dispose(): void {
    this._abort?.abort();
    // 杀掉常驻的 DSH 子进程（kill 内部置 dead，缓冲中迟到的行不再分发）
    this._dsh?.kill();
    this._dsh = undefined;
    this._approval?.dispose(); // C1：关掉本机审批服务，挂起的按取消结算
    this._approval = undefined;
    this._dropReview(false); // 清掉本轮审阅内存（视图已销毁，不必再发 clear）
    this._runs.reset(); // C9：运行时间线是纯内存的，随视图一起还回去
    this._runsPanelOpen = false;
    this._disposeViewListeners();
    for (const d of this._globalDisposables) d.dispose();
    this._globalDisposables.length = 0;
    this._view = undefined;
  }

  // ---------- 消息路由（webview → 扩展） ----------

  private _onMessage(msg: WebviewToExt): void {
    switch (msg.type) {
      case 'ready':
        // 先告诉本帧当前处于哪个模式，再下发内容 → webview 据此恢复草稿/待发附件
        this._post({ type: 'mode-set', mode: this._mode });
        // 运行在途时把 run-busy 放到 snapshot 之前：chat.js 据此不把半截会话
        // 中继给 React 回放（重挂 webview 恰逢直播中途 → 只播挂载后的帧，避免
        // 已播文本与前缀重复）；空闲态无此消息，回放照常。
        if (this._liveRunning) {
          this._post({ type: 'run-busy', busy: true });
        }
        this._postSnapshot();
        this._sendHistory();
        // webview 每次显示都重建：harness 状态点/运行锁一律以扩展侧为真相重放一遍
        this._postBackendStatus();
        // 2.1 ready 重放：已算出未处理的本轮审阅补推（新一轮开始时已发 review-clear 隐去）
        if (this._pendingReview.length > 0 && this._reviewRoots.size > 0 && !this._liveRunning) {
          this._postReviewSet();
        }
        // harness 默认模式：视图每次就绪都预热到「在线/未配置」可读状态
        //（幂等；未配置时 _getRuntime 在 spawn 前抛错 → 红点显示「DSH 未配置」引导）
        if (this._mode === 'harness' && !this._liveRunning) {
          void this._connectLive();
        }
        // 尝试解析一次 API key（有则缓存），让配置条的 API 灯如实点亮
        void this._refreshApiKeyStatus();
        // C8c：转写加载异常要让人看见。挂这儿而不是构造函数 —— 那时面板还没开，弹窗没人看。
        this._checkStorageHealth();
        break;
      case 'set-model': {
        const model = String(msg.model ?? '').trim();
        if (model) this._setLiveModel(model);
        break;
      }
      case 'configure-key':
        void this._promptAndStoreApiKey();
        break;
      case 'configure-dsh':
        void this._configureDsh();
        break;
      case 'set-mode':
        this._setMode(msg.mode);
        break;
      case 'user-message':
        this._sendUser(msg.text, msg.attachments);
        break;
      case 'retry-last':
        this._retryLast();
        break;
      case 'pick-files':
        void this._pickFiles();
        break;
      case 'stop':
        // C1：本轮被停 → 挂起的审批立刻按取消结算（否则 hook 进程会一直等答复）
        this._approval?.cancelAll();
        this._abort?.abort();
        break;
      case 'approval-answer':
        // C1：确认条上的允许/拒绝；对已失效的 id 静默忽略（超时/已答过）
        this._approval?.answer(msg.id, msg.allow);
        break;
      case 'run-panel':
        // C9：浮层开着才把详情随读数一起发（关掉时不必回发 —— 前端自己就把面板收了）
        this._runsPanelOpen = msg.open;
        if (msg.open) this._postRuns();
        break;
      case 'clear':
        this.startNewSession();
        break;
      case 'fork-session':
        this._forkSession();
        break;
      case 'list-sessions':
        this._sendHistory();
        break;
      case 'open-session':
        this._openSession(msg.sessionId);
        break;
      // --- C6：删除/恢复/彻底删/导出/检索 ---
      case 'trash-session':
        this._trashSession(msg.sessionId);
        break;
      case 'restore-session':
        this._restoreSession(msg.sessionId);
        break;
      case 'purge-session':
        void this._purgeSession(msg.sessionId);
        break;
      case 'purge-trash':
        void this._purgeTrash();
        break;
      case 'purge-expired':
        void this._purgeExpired();
        break;
      case 'export-session':
        void this._exportSession(msg.sessionId);
        break;
      case 'search-sessions':
        // **同步作答**：不 await 才能保证 postMessage 的 FIFO 顺序 = 请求顺序，
        // webview 那套 seq 丢弃过期响应才成立（这里一旦异步，seq 就只是装饰）。
        this._searchSessions(msg.query, msg.seq);
        break;
      case 'rename-session':
        this._renameSession(msg.title);
        break;
      case 'review-keep':
        this._reviewAction('keep', msg.id);
        break;
      case 'review-revert':
        this._reviewAction('revert', msg.id);
        break;
      case 'review-keep-all':
        this._reviewAction('keep-all');
        break;
      case 'review-revert-all':
        this._reviewAction('revert-all');
        break;
    }
  }

  /** 顶部模式切换：归档旧模式活动会话 → 换 workspace → 记住 → 下发新模式内容。 */
  private _setMode(mode: Mode): void {
    if (mode === this._mode) return; // 点的还是当前模式，无事可做
    this._cancelActiveRun();
    this._dropReview(true); // 切换模式 → 清掉审阅（harness 独有功能）
    this._resetTurnUsage(); // C3a：本轮读数不跨模式
    this._persistActiveSession();
    this._mode = mode;
    void this._globalState.update(MODE_KEY, mode);
    this._post({ type: 'mode-set', mode });
    this._postSnapshot();
    this._sendHistory();
    this._postBackendStatus();
    // 切进 harness（恒为 DSH 直播）→ 预热到"在线"（spawn+initialize），状态点即时可见
    if (this._mode === 'harness' && !this._liveRunning) {
      void this._connectLive();
    }
  }

  /** 把当前活动会话写盘（有内容才写）。切换模式/会话前归档用。 */
  private _persistActiveSession(): void {
    if (this._active.messages.length === 0) return;
    this._active.updatedAt = Date.now();
    this._store.replace(this._active);
    this._store.persist();
  }

  // ---------- 发送一条用户消息 & 编排回复 ----------

  private _sendUser(rawText: string, refs: FileRef[] = [], opts: { replay?: boolean } = {}): void {
    if (this._abort) {
      vscode.window.showInformationMessage('上一条回复还在生成中，先等它结束或点「停止」。');
      return;
    }
    // C8：上一轮还在 DSH 侧跑着（回执超时那种情况 —— 界面已经不忙了，但进程还在执行工具）。
    // 这条闸拦的就是那个窗口：此时再发就是往 inbox 里塞一条排队轮，用户以为新开了话头、
    // 实际排在一个他看不见的长轮后面。停止是唯一的出路（wire 没有 cancel）。
    if (this._dshRunning) {
      vscode.window.showInformationMessage('上一轮还在运行（DSH 侧仍在执行），先点「停止」再发。');
      return;
    }

    const fileRefs = refs.slice();
    let text: string;
    if (opts.replay) {
      // C8 重发（「继续」按钮）：**逐字复现上一轮**。所以两处「取此刻」的处理都要跳过 ——
      // 选区自动附加会拿现在这个光标位置的内容，行→路径提升会重新解释一遍文本，
      // 都不是上一轮真正发出去的东西。附件与正文一律用入参原样。
      text = rawText.trim();
    } else {
      // 1) 「整行=文件路径」的行自动提升为附件（支持绝对路径 + 相对工作区根目录），
      //    其余内容保留为正文 —— 这样在输入框直接贴一行路径也能加文件。
      // 1.1：harness 轮发送时若活动编辑器有非空选区，自动把选中文本作为附件带上（内容取自
      // 编辑器缓冲，dirty 未保存也包含）。先压入 → 下方"整行=路径"提升按 path 去重，同一文件不会再提一份。
      const selectionRef = this._activeSelectionRef();
      if (selectionRef && !fileRefs.some((r) => r.path === selectionRef.path)) {
        fileRefs.push(selectionRef);
      }
      const keptLines: string[] = [];
      for (const line of rawText.split('\n')) {
        const resolved = this._pathFromLine(line);
        if (resolved) {
          if (!fileRefs.some((r) => r.path === resolved)) {
            fileRefs.push({ name: path.basename(resolved), path: resolved });
          }
        } else {
          keptLines.push(line);
        }
      }
      text = keptLines.join('\n').trim();
    }

    // 2) 解析每个引用为最终附件（缺内容的按路径从磁盘读，带大小保护）
    const attachments = this._resolveAttachments(fileRefs);
    if (!text && attachments.length === 0) return;

    // 3) 附件里含读取失败/过大 → 整条拒发（绝不让坏文件搭着消息发出去）；
    //    发 user-message-rejected 让 webview 恢复输入，已写的文字/附件不丢
    const badAttachments = attachments.filter((a) => a.readError);
    if (badAttachments.length > 0) {
      const names = badAttachments.map((a) => `「${a.name}」`).join('、');
      vscode.window.showWarningMessage(`以下文件无法读取或过大，已取消发送：${names}`);
      this._post({ type: 'user-message-rejected', reason: `${names} 读取失败或过大，请移除后重发` });
      return;
    }

    // 4) 两模式共用的首条默认标题 + 入库
    const isFirst = this._active.messages.length === 0;
    this._hadHistoryBeforeSend = !isFirst; // live 首轮判断要不要插"失忆"note（须在 user 消息入列后插）
    if (isFirst) {
      if (!this._active.title) {
        const titleSource = text || (attachments[0] ? attachments[0].name : '');
        if (titleSource) {
          this._active.title = titleFromText(titleSource);
        }
      }
      this._store.add(this._active); // 首次说话 → 会话上列表
    }

    const userMsg: ChatMessage = { id: this._nextMsgId(), role: 'user', text, status: 'done' };
    if (attachments.length > 0) {
      userMsg.attachments = attachments;
    }
    this._active.messages.push(userMsg);
    // C8：发了新消息 → 上一轮的异常终态翻篇，「继续」按钮随之消失（判据见此字段本身）。
    delete this._active.lastTurn;
    this._post({ type: 'user-message', message: userMsg });
    this._sendTurnState();
    if (isFirst) {
      this._sendHistory(); // 列表出现了新会话
    }

    const ctrl = new AbortController();
    this._abort = ctrl;
    this._runningMsg = undefined;

    // 5) 按模式走不同的「产出编排」：chat = 一段假助手流；harness = 连真实 DSH 整轮执行
    if (this._mode === 'harness') {
      void this._runLive(text, attachments, ctrl);
    } else {
      const prompt = this._buildPrompt(text, attachments);
      const assistantMsg: ChatMessage = {
        id: this._nextMsgId(),
        role: 'assistant',
        text: '',
        status: 'streaming',
      };
      this._active.messages.push(assistantMsg);
      this._runningMsg = assistantMsg;
      this._post({ type: 'assistant-start', message: assistantMsg });
      void this._runAssistant(assistantMsg, prompt, ctrl);
    }
  }

  // ---------- chat 模式：一段普通助手流 ----------

  /** 消费 mock 产出器，把每个块追加进 active 会话并增量推给界面。 */
  private async _runAssistant(
    assistantMsg: ChatMessage,
    prompt: string,
    ctrl: AbortController
  ): Promise<void> {
    try {
      for await (const chunk of streamMockReply(prompt, {}, ctrl.signal)) {
        assistantMsg.text += chunk;
        this._post({ type: 'assistant-delta', id: assistantMsg.id, delta: chunk });
      }
      assistantMsg.status = 'done';
      this._post({ type: 'assistant-done', id: assistantMsg.id });
    } catch (err) {
      if (isAbortError(err)) {
        assistantMsg.status = 'interrupted';
        this._post({ type: 'assistant-done', id: assistantMsg.id, interrupted: true });
      } else {
        assistantMsg.status = 'error';
        const message = err instanceof Error ? err.message : String(err);
        this._post({ type: 'assistant-error', id: assistantMsg.id, message });
      }
    } finally {
      if (this._abort === ctrl) {
        this._abort = undefined;
        this._runningMsg = undefined;
      }
      this._afterTurn();
    }
  }

  // harness 恒为 DSH 直播：整轮执行由 _sendUser 在 harness 分支直接调 _runLive（见下方 live 区），
  // 不再有 harness 侧的编排壳 / mock 分支。

  // ---------- harness = DSH 直播：连接真实 DSH（DeepSeek Harness）子进程 ----------

  /**
   * DSH 整轮执行（harness 唯一路径，由 _sendUser 直接调进来）；
   * 本方法自带 try/catch/finally 收尾（输入锁定契约不变）。
   *
   * DSH 会话内的事件是**异步**推上来的（session.status / session.event），跑完一整轮才回到这里：
   * 提交 prompt 拿到"回执"后，就挂起等 _finishTurn / _surfaceLiveError resolve 掉 `_endTurnResolve`；
   * abort（停止/切会话/切模式）时杀掉子进程 + 收尾，然后按 AbortError 安静退出（不把"停止"当错误上浮）。
   */
  private async _runLive(
    text: string,
    attachments: Attachment[],
    ctrl: AbortController
  ): Promise<void> {
    this._liveRunning = true;
    this._turnNormalDone = false; // 每轮开头复位；idle → done 时 _finishTurn 再置 true
    this._post({ type: 'run-busy', busy: true });
    this._postBackendStatus();

    const onAbort = () => {
      // 停止：杀掉子进程并收尾本轮；下一个 live 轮再重新 spawn（新进程要重新 initialize）
      this._dsh?.kill();
      this._dsh = undefined;
      // C8：进程没了 → 线上状态一概不可信（下一个 live 轮 _ensureDshSession 会重新认领）。
      // 不清的话，一条迟到的 running 能把用户永久挡在 _sendUser 的闸外。
      this._turnStatus.reset();
      this._backendState = 'offline';
      this._backendModel = undefined;
      this._backendDetail = undefined;
      this._finishTurn('interrupted');
      this._postBackendStatus();
    };
    ctrl.signal.addEventListener('abort', onAbort, { once: true });
    if (ctrl.signal.aborted) onAbort();

    try {
      // 0) 2.1：本轮开始前先快照工作区根（一切 await 之前同步取盘）—— 轮末对比出 agent 的改动
      this._captureBaselineAtTurnStart();
      // 1) 拿本 UI 会话对应的 DSH 会话；首次续聊"旧对话"会插一行"失忆"note
      const dshId = this._ensureDshSession();

      // 2) 组 contentBlocks：正文在前，附件按 <file> 包裹（与 mock 观感一致）
      const parts: string[] = [];
      if (text) parts.push(text);
      for (const a of attachments) {
        if (a.readError) {
          // 附件读取失败：不进正文（_sendUser 已整条拒发），防御性跳过
          continue;
        }
        if (a.selection) {
          // 1.1 选区：原生 DSH 组件「所见即所发」——气泡里显示的＝发给 agent 的全部内容。
          // 想气泡干净只有 chip，就必须让 agent 通过文件读内容：先把选中文本（编辑器缓冲原文，
          // dirty 未保存也准）落成一个只读临时文件，只发 `@"临时文件"` 引用（投影成文件 chip）。
          // 临时文件写盘失败才兜底回退内联摘录（仍保证 agent 拿到内容，代价是气泡会露出代码块）。
          const tmp = a.path ? this._writeSelectionTmp(a) : undefined;
          if (tmp) {
            parts.push(`@"${tmp}"`);
          } else if (a.path) {
            parts.push(`@"${a.path}"`);
            parts.push(this._selectionExcerpt(a));
          } else {
            parts.push(this._selectionExcerpt(a));
          }
          continue;
        }
        const loc = a.path ? ` path="${a.path}"` : '';
        const body = a.content ?? '';
        const tail = a.truncated ? '\n…（内容过长，已截断）' : '';
        parts.push(`<file name="${a.name}"${loc}>\n${body}${tail}\n</file>`);
      }
      const blocks: ContentBlock[] = parts.length
        ? [{ type: 'text', text: parts.join('\n\n') }]
        : [];

      // 3) 确保子进程在线（幂等，多个调用共享同一个握手）；失败 → 上浮可读错误
      await this._connectLive();
      if (ctrl.signal.aborted) return;
      if (this._backendState !== 'online') {
        throw new Error(this._backendDetail ?? 'DSH 未就绪');
      }

      // 4) 提交本轮：等"回执"即通过，之后的流式事件由 _onDshEvent 转成气泡
      const runtime = this._dsh as DshRuntime;
      await runtime.prompt(dshId, blocks, ctrl.signal);

      // 5) 挂起等本轮真正结束（session.status idle → _finishTurn 会 resolve 这里）
      await this._waitEndOfTurn(ctrl);
    } catch (err) {
      // abort：onAbort 已收尾，安静退出即可；其余错误（含进程意外退出）才上浮
      if (!isAbortError(err) && this._liveRunning) {
        // C8 ②：「回执超时」**不等于本轮失败** —— 回执只是服务端收下的收条，本轮何时结束看
        // idle。长轮（跑一堆工具）本来就可能迟迟不给回执。若此刻已知 DSH 侧还在跑，就继续
        // 等下去；否则会把一个还在执行工具的长轮标成 error、同时丢掉后续事件，界面与 DSH
        // 记忆就此失配（用户看不见那份工作，但 DSH 记得）。
        if (isDshTimeout(err) && this._dshRunning) {
          await this._waitEndOfTurn(ctrl);
        } else {
          this._surfaceLiveError(err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      if (this._abort === ctrl) {
        this._abort = undefined;
        this._runningMsg = undefined;
      }
      this._liveRunning = false;
      this._post({ type: 'run-busy', busy: false });
      this._postBackendStatus();
      // C3a：折账兜底（正路已在 _finishTurn 里同步折过，幂等）。剩下唯一会走到这里的
      // 是"没经过 _finishTurn 的出错轮"——那些 token 是真的，同样计入。
      // 必须在 _afterTurn 之前：由它落盘。
      this._foldTurnUsage();
      // C9：兜底（正路已在 _finishTurn / _surfaceLiveError 里收过，幂等）。剩下唯一会走到
      // 这里的是「没经过那两处的轮」。**必须在 _afterTurn 之前还是之后都行** —— 它不落盘、
      // 不读 `_active.messages`，只是把时间线封口。
      if (this._runs.endRun(this._turnNormalDone ? 'done' : 'interrupted', this._active.id)) {
        this._postRuns();
      }
      this._afterTurn();
      // 2.1：正常走完（done）→ 退栈后异步对比工作区、算 diff 推审阅条；
      // interrupted / error / abort → 清掉本轮的 baseline（不做审阅）
      if (this._turnNormalDone) {
        this._scheduleReviewAfterTurn();
      } else {
        this._dropReview(true);
      }
    }
  }

  /** 等本轮 DSH 会话真正结束（_finishTurn / _surfaceLiveError 里 resolve）。 */
  private _waitEndOfTurn(ctrl: AbortController): Promise<void> {
    return new Promise<void>((resolve) => {
      this._endTurnResolve = resolve;
      // 极端时序：resolve 注册之前本轮已被 abort/收尾 → 立即放行，别死等
      if (!this._liveRunning || ctrl.signal.aborted) {
        resolve();
      }
    });
  }

  /** 本轮收尾（done：正常 idle / interrupted：被停止）。幂等。 */
  private _finishTurn(outcome: 'done' | 'interrupted'): void {
    if (!this._liveRunning) return;
    // C1：本轮收尾时不该还留着待确认（正常路径下 hook 阻塞期间 idle 不会到达，这里是兜底）
    this._approval?.cancelAll();
    if (outcome === 'done') {
      this._turnNormalDone = true; // 2.1：正常走完 → finally 里排异步改动对比
    }
    this._liveRunning = false;
    // C3a：在这里折账，**不能**只靠 _runLive 的 finally —— 那是微任务，而「运行中切会话」
    // 那条路上（_cancelActiveRun → _actives[_mode] = 新会话 → 落盘）全是同步的，
    // finally 跑到时 _active 已经换人了，半轮的 token 会记到新会话头上。
    // 此处是同步的、_active 还是本轮那个。_foldTurnUsage 自带幂等，finally 里那次只作兜底。
    this._foldTurnUsage();
    // C9：本轮时间线收尾。与折账同一个理由放在这里 —— 同步、`_active` 还是本轮那个
    // （「运行中切会话」那条路上 `_cancelActiveRun` 会先同步走到这儿）。
    if (this._runs.endRun(outcome === 'done' ? 'done' : 'interrupted', this._active.id)) this._postRuns();
    this._finalizeOpenAssistant(outcome);
    if (outcome === 'interrupted') {
      // 停止时还挂着的 running 工具卡 → **unknown**，不留转圈残留。
      // ⚠️ 2026-09-17 由 'error' 改过来：运行时对同一件事的措辞是「Its outcome is unknown」，
      // 而 C8 插的那行 note 本来也写着「结果未知」—— 卡上画红叉、note 说未知，是自相矛盾。
      // 未知 ≠ 失败：判成失败会让人去重试一个可能有副作用的命令。
      for (const m of this._active.messages) {
        if (m.role === 'tool' && m.toolState === 'running') {
          m.toolState = 'unknown';
          this._post({ type: 'tool-result', id: m.id, toolState: 'unknown' });
        }
      }
    }
    // C8：记下这一轮的终态（「继续」按钮的判据，随 _afterTurn 落盘 → 重载窗口后按钮还在）。
    // 正常跑完一律删掉：判据就在「有没有值」，不在消息的形状（理由见 turnState.ts）。
    if (outcome === 'interrupted') {
      this._active.lastTurn = 'interrupted';
      // 说清楚「接着跑」的代价：DSH 侧记忆保留（下一轮仍记得前文），但被杀掉那次工具调用的
      // 结果**未知** —— 与运行时补平悬空 turn 时给模型的措辞（TOOL_OUTCOME_UNKNOWN：
      // 「结果未知，别盲重试」）对齐，别让用户以为可以无脑重放。工具卡已在上方落成 error，
      // 所以这里只说编辑/命令类操作可能有副作用。复用 note：它会被持久化，重开也还在。
      this._pushNote(
        '本轮已中断。DSH 侧记忆保留（下一轮仍记得此前的对话），但被中断的工具调用结果未知 —— ' +
          '如果它会写文件或执行命令，请自行确认现场再继续。点下方「继续」会重发上一条消息接着这个会话跑。'
      );
    } else {
      delete this._active.lastTurn;
    }
    this._sendTurnState();
    const resolve = this._endTurnResolve;
    this._endTurnResolve = undefined;
    resolve?.();
  }

  /** 把"当前开着的"助手文字气泡收成终态。开着的才处理，重复调用安全。 */
  private _finalizeOpenAssistant(outcome: 'done' | 'interrupted'): void {
    const m = this._openAssistant;
    if (!m) return;
    this._openAssistant = undefined;
    if (m.status === 'streaming') {
      m.status = outcome === 'done' ? 'done' : 'interrupted';
      this._post({
        type: 'assistant-done',
        id: m.id,
        interrupted: outcome === 'interrupted',
      });
    }
  }

  /** 收到一段文字（text-delta）时开一个"流式中的"助手气泡。 */
  private _openAssistantBubble(): void {
    const msg: ChatMessage = {
      id: this._nextMsgId(),
      role: 'assistant',
      text: '',
      status: 'streaming',
    };
    this._active.messages.push(msg);
    this._openAssistant = msg;
    this._post({ type: 'assistant-start', message: msg });
  }

  /**
   * 本轮以"错误"收尾：开着文字气泡 → 落成 error；没有 → 开一个新 error 气泡；
   * running 工具卡 → error；后端状态 → error；最后放行 _runLive 的等待。
   */
  private _surfaceLiveError(message: string): void {
    const errText = `DSH 出错：${message}`;
    if (this._openAssistant) {
      const m = this._openAssistant;
      this._openAssistant = undefined;
      m.status = 'error';
      this._post({ type: 'assistant-error', id: m.id, message: errText });
    } else {
      const errMsg: ChatMessage = {
        id: this._nextMsgId(),
        role: 'assistant',
        text: '',
        status: 'error',
      };
      this._active.messages.push(errMsg);
      this._post({ type: 'assistant-start', message: errMsg });
      this._post({ type: 'assistant-error', id: errMsg.id, message: errText });
    }
    for (const m of this._active.messages) {
      if (m.role === 'tool' && m.toolState === 'running') {
        // 进程被杀 → 那次调用到底跑没跑完**无法区分**（同 _finishTurn 那条，见那里的注释）
        m.toolState = 'unknown';
        this._post({ type: 'tool-result', id: m.id, toolState: 'unknown' });
      }
    }
    this._backendState = 'error';
    this._backendModel = undefined;
    this._backendDetail = message;
    this._liveRunning = false;
    // C8 ② 的核心：**出错就真停**。界面说 error 却留着一个还在执行工具的子进程，是 C7 之前
    // 就存在的问题 —— 用户以为停了，工具还在写盘，而后续事件被 `_onDshEvent` 的
    // `if (!this._liveRunning)` 全丢掉（看不见，但 DSH 记得）。kill 之后那个悬空的 turn
    // 交给运行时的 interruptedTurnClosers 在下次 resume 时补平。
    // 三处调用点：子进程意外退出（`this._dsh` 早已置空 → no-op）、`_runLive` 的 catch、
    // `turn/end` 报错。**后两处进程是活的**，会被真的杀掉 —— 这是刻意的：wire 上没有状态
    // 查询，既然这一轮已经失败，就没法确认那个进程还在干什么，与其留着一个状态不可知的
    // 子进程，不如让它死掉、下一轮重来（补丁在，resume 照常接回同一份记忆）。
    this._dsh?.kill();
    this._dsh = undefined;
    this._turnStatus.reset(); // 进程没了 → 线上状态不可信（同 onAbort）
    this._active.lastTurn = 'error';
    // C9：本轮时间线的错误**只在这里写**（`turn/end` 那条 case 刻意不写 —— 非白名单 kind
    // 会走到这儿来，两边都写就是每条错误在面板里显示两遍）。没有开着的轮时（spawn 失败、
    // prompt RPC 失败：一帧都没来过）它会补一条记录，那种失败恰恰最需要被看见。
    if (this._runs.endRun('error', this._active.id, message)) this._postRuns();
    this._sendTurnState();
    this._postBackendStatus();
    const resolve = this._endTurnResolve;
    this._endTurnResolve = undefined;
    resolve?.();
  }

  /** C8「继续」按钮的显隐：判据只有 `lastTurn` 一条（见 turnState.ts）。 */
  private _sendTurnState(): void {
    this._post({ type: 'retry-offer', on: needsContinue(this._active) });
  }

  /**
   * C8「继续」：重发**上一条用户消息**，接着同一个 DSH 会话再跑一轮。
   *
   * 为什么不新开一轮「请继续」：那会凭空造一条用户消息、还得让模型自己猜「继续」指什么；
   * 重发原文则逐字复现上一轮 —— 加上 DSH 侧的记忆本就在，模型看到的是「同一句话又说了一遍
   * ＋上次那半截上下文」，接得上。附件也逐字复现（用存下来的内容，不重读磁盘：重读会拿到
   * 此刻的版本，那就不是「上一轮发出去的东西」了）。
   */
  private _retryLast(): void {
    // 运行中不给发 —— 但**不在这里判**：`_sendUser` 的两道闸已经有各自的提示文案，
    // 在这里再拦一次只会让用户点了没反应。
    let last: ChatMessage | undefined;
    for (const m of this._active.messages) {
      if (m.role === 'user') last = m;
    }
    if (!last || (!last.text && !last.attachments?.length)) return;
    // 已经是 Attachment（含内容）；结构上兼容 FileRef，直接当引用喂回去。
    this._sendUser(last.text, last.attachments ?? [], { replay: true });
    // 发成了 → _sendUser 已把条收掉；被两道闸挡下（上一轮还在跑）→ 这里把状态重发一遍，
    // 前端据此把点击时置灰的按钮回正，用户还能再点。
    this._sendTurnState();
  }

  /**
   * C5 这个运行时**允不允许**跨进程复用 DSH 会话 id。
   *
   * 只有经 scripts/build-runtime.mjs 打过 resume-first 补丁的便携运行时才允许：DSH 的 wire 上
   * 没有 resume 方法，把已落盘的 id 硬塞给 `session/prompt` 会在第一次 checkpoint 上以
   * `id collision` 炸掉（见 docs/backlog.md 的 C5）。补丁把它换成了先 resume、只对确实没有
   * 磁盘工件的 id 才 create。
   *
   * 开发者路径（手配 nodePath/entry）与 `hello.dsh.command` 走的是**用户自己的 DSH**，没有我们的
   * 补丁 → 那里必须维持「每 activation 新铸」的老行为，否则就是把上面那条炸路递给用户。
   */
  private _dshIdentityReusable(): boolean {
    const rt = this._runtime();
    return rt?.ok === true && rt.manifest.patches?.includes(DSH_RESUME_PATCH) === true;
  }

  /**
   * UI 会话 → DSH 会话 id 的（首次）映射，并在"续聊旧历史"时插一行 note。
   * 必须在 _sendUser 把本条 user 消息入列**之后**调用（保证 note 排在其后，
   * 不会劫持 isFirst / 默认标题逻辑）。
   *
   * 三条出路：
   *   ① 能安全续上（运行时带补丁 + 盘上那套身份属于当前工作区）→ 复用旧 id，记忆接上；
   *   ② 不能续（开发者路径 / 换了工作区 / 旧数据没这个字段）→ 本 activation 内一次性临时 id；
   *   ③ 本 activation 内已经映射过 → 直接取缓存。
   */
  private _ensureDshSession(): string {
    const uiId = this._active.id;
    const existing = this._dshSessions.get(uiId);
    if (existing) {
      this._currentDshId = existing;
      // 状态归零但认领 id：上一个会话（或上一轮的迟到的）running 与新会话无关，继承过来
      // 会让 _sendUser 把用户挡在门外（见 TurnStatus.reset 的说明）。
      this._turnStatus.reset(existing);
      return existing;
    }

    const cwd = this._dshCwd();
    const stored = this._active.dsh;
    const patched = this._dshIdentityReusable();
    // 续上的前提是两件事同时成立：运行时能 resume，**且**盘上那份身份是当前工作区铸的
    // （DSH 的会话日志按 cwd 归属，换工作区就对不上）。
    const resumeId = patched && stored?.cwd === cwd ? stored.id : undefined;
    const dshId = resumeId ?? `${uiId}::${this._dshHostRand}`;

    // 只有「补丁可用 + 这个会话还没有身份」才把新铸的 id 记账（随 _afterTurn 落盘）。
    // 另两种**绝不写盘**：
    //   · 补丁不可用（开发者路径 / hello.dsh.command）—— 硬复用会撞 id collision；
    //   · 指针属于别的工作区 —— 覆盖它等于把原工作区那份记忆的指针永久丢掉。
    // 两者都退回「本 activation 内一次性的临时 id」：每次激活互不相同，撞不上旧日志。
    if (resumeId === undefined && patched && stored === undefined) {
      this._active.dsh = { id: dshId, cwd };
    }

    this._dshSessions.set(uiId, dshId);
    this._currentDshId = dshId;
    this._turnStatus.reset(dshId);
    // 该 UI 会话在**这个 activation**里首次发消息，且此前已有人类历史（典型：host 重启后继续旧对话）。
    // 说清楚模型到底记不记得之前的内容 —— 这个 note 是用户唯一能看到的判据，别含糊。
    if (this._hadHistoryBeforeSend) {
      this._pushNote(
        resumeId !== undefined
          ? '已恢复此前的 DSH 会话记忆 —— 模型仍记得本条消息之前的对话。'
          : '已开启全新 DSH 会话 —— 模型只记得本条消息之后的内容，不再拥有此前对话的记忆。'
      );
    }
    return dshId;
  }

  /** 杀掉子进程 + 清空 live 相关状态（重启换模型 / key / 路径、视图销毁时共用）。 */
  private _teardownLive(): void {
    this._dsh?.kill();
    this._dsh = undefined;
    this._approval?.cancelAll(); // C1：子进程一杀，hook 连接就断了；先把挂起的收干净
    this._connectPromise = undefined;
    // 只清缓存、不动 _active.dsh：下一次发送会从盘上的身份重新推导 ——
    // 于是换模型/换 key/换路径之后，会话记忆仍在（C5）。
    this._dshSessions.clear();
    this._currentDshId = undefined;
    this._turnStatus.reset(); // 进程没了 → 线上状态一概不可信
    this._backendState = 'offline';
    this._backendModel = undefined;
    this._backendDetail = undefined;
    // C3a：上下文上限是「这次请求」的属性，换子进程后要等新的 request/context 才有
    this._contextWindow = undefined;
  }

  /** 配置条里改模型：记住 → 重启 live 子进程（旧会话记忆清空，下一句插灰 note）。 */
  private _setLiveModel(model: string): void {
    if (this._abort) {
      vscode.window.showInformationMessage('当前有回复在生成中，先停止或等它结束，再切换模型。');
      return;
    }
    if (model === this._dshModel()) return;
    void this._globalState.update(LIVE_MODEL_KEY, model);
    this._restartLiveProcess();
  }

  /** API 按钮：弹密码式输入框写入 SecretStorage，随后重启 live 子进程让 key 生效。 */
  private async _promptAndStoreApiKey(): Promise<void> {
    if (this._abort) {
      vscode.window.showInformationMessage('当前有回复在生成中，先停止或等它结束，再配置 API。');
      return;
    }
    // 已有 key 时先问：换新 / 清除（清除后可回退读 ~/.dsh/.credentials.yaml）
    if (this._apiKeyCache !== undefined && this._apiKeyCache !== '') {
      const action = await vscode.window.showQuickPick(
        [
          { label: '换一个新的 API Key', detail: '保存到 VS Code SecretStorage（覆盖现有）' },
          { label: '清除已存 Key', detail: '删除 SecretStorage 里的 DEEPSEEK_API_KEY，改用 ~/.dsh/.credentials.yaml' },
        ],
        { placeHolder: '已配置过 API Key，想怎么处理？', ignoreFocusOut: true }
      );
      if (!action) return;
      if (action.label.startsWith('清除')) {
        try {
          await this._secrets.delete(API_KEY_SECRET_KEY);
        } catch {
          /* 删除失败不阻断 */
        }
        this._apiKeyCache = undefined; // 清缓存 → 下次从文件回退解析
        this._restartLiveProcess();
        void this._refreshApiKeyStatus(); // 立刻从文件读回，点亮 API 灯
        return;
      }
    }
    const value = await vscode.window.showInputBox({
      prompt: '配置 DEEPSEEK_API_KEY（只存 VS Code SecretStorage，不进设置 / 日志 / 转写）',
      password: true,
      ignoreFocusOut: true,
      placeHolder: '输入 DeepSeek API Key，回车保存；Esc 取消',
      validateInput: (s) => (s.trim() ? undefined : 'API Key 不能为空'),
    });
    if (value === undefined) return; // 取消
    const key = value.trim();
    try {
      await this._secrets.store(API_KEY_SECRET_KEY, key);
    } catch (err) {
      vscode.window.showErrorMessage(`保存 API Key 失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this._apiKeyCache = key; // 立即生效：进下一个子进程 env
    this._restartLiveProcess();
  }

  /** 杀掉当前 DSH 子进程并按最新模型/key/路径重连（变更后调用；仅 harness 生效）。 */
  private _restartLiveProcess(): void {
    this._teardownLive();
    this._postBackendStatus();
    if (this._mode === 'harness' && !this._liveRunning) {
      void this._connectLive();
    }
  }

  /** palette 命令转发（hello.dsh.configure）：webview 按钮走的是 _onMessage 的 configure-dsh。 */
  public configureDsh(): Promise<void> {
    return this._configureDsh();
  }

  /**
   * 「配置 DSH」引导向导。先问一个岔路口：**便携运行时目录**（推荐；字节自带 node 与配置）
   * 还是**手工 node + 入口**（开发者路径，按入口所在 DSH 仓库根推导 runCwd / tsconfig / config）。
   * 最后 quickpick 确认、用 ConfigurationTarget.Global 写 hello.dsh.*
   * （machine-scope 设置只能落在用户设置文件，故用 Global target）。取消任一对话框即整段中止、零写入。
   * credentialsFile 绝不写入（它由 API 按钮 / 密钥库管理）。写盘只发生在用户选「保存并重启 live」那一刻。
   */
  private async _configureDsh(): Promise<void> {
    if (this._abort) {
      vscode.window.showInformationMessage('当前有回复在生成中，先停止或等它结束，再配置 DSH。');
      return;
    }

    // 开始时快照（trimmed）——决定哪些键「真的变了」，也避免向导期间重复读配置的歧义
    const conf = this._dshConfig();
    const cur = {
      runtimeDir: String(conf.get('runtimeDir') ?? '').trim(),
      nodePath: String(conf.get('nodePath') ?? '').trim(),
      entry: String(conf.get('entry') ?? '').trim(),
      runCwd: String(conf.get('runCwd') ?? '').trim(),
      tsconfig: String(conf.get('tsconfig') ?? '').trim(),
      config: String(conf.get('config') ?? '').trim(),
    };
    let runtimeDir = cur.runtimeDir;
    let nodePath = cur.nodePath;
    let entry = cur.entry;
    let runCwd = cur.runCwd;
    let tsconfig = cur.tsconfig;
    let config = cur.config;

    let step: 'kind' | 'runtime' | 'node' | 'entry' | 'config' | 'confirm' = 'kind';
    for (;;) {
      // ---- 入口第一步：字节从哪来。两条路的配置完全不相交，先问清楚再收路径 ----
      if (step === 'kind') {
        const pick = await vscode.window.showQuickPick(
          [
            {
              label: '用一个便携运行时目录（推荐）',
              description:
                '目录里带 runtime.json：node、入口、cordis.yml 全在里面，不需要 tsx，也不需要本地 DSH 检出',
            },
            {
              label: '手工指定 node 与入口（开发者路径）',
              description: cur.runtimeDir
                ? '会清空 hello.dsh.runtimeDir（当前指向便携运行时），改按 node + 入口启动'
                : '本地有一份构建好的 DSH 检出，按 node + 入口 + cordis.yml 启动',
            },
          ],
          { placeHolder: 'DSH 运行时要跑哪一份字节？', title: 'DSH 运行路径配置' }
        );
        if (!pick) return;
        if (pick.label.startsWith('用一个便携')) {
          step = 'runtime';
        } else {
          // 手工路径与 runtimeDir 互斥（后者优先级更高）→ 选了手工就等于要清掉它
          runtimeDir = '';
          step = 'node';
        }
        continue;
      }
      if (step === 'runtime') {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: '选用该便携运行时目录',
          title: '选择便携运行时目录（内含 runtime.json）',
          defaultUri: runtimeDir && this._exists(runtimeDir) ? vscode.Uri.file(runtimeDir) : undefined,
        });
        if (!picked || picked.length === 0) return;
        const dir = picked[0].fsPath;
        const check = readRuntimeDir(dir);
        if (!check.ok) {
          // 留在这一步重选，不整段退出 —— 选错目录是常事，别让用户从头再来
          vscode.window.showErrorMessage(`这个目录不能用作便携运行时 —— ${check.problem}`);
          continue;
        }
        runtimeDir = dir;
        step = 'confirm';
        continue;
      }
      if (step === 'node') {
        const p = await this._pickDshFile({
          title: '选择 DSH 运行用的 node 可执行文件',
          openLabel: '选用该 node',
          filters: { '可执行文件': ['exe'] },
          defaultCandidates: [nodePath ? path.dirname(nodePath) : '', 'D:\\DSH\\tools'],
        });
        if (p === undefined) return; // Esc = 取消整个向导，尚未写入任何东西
        nodePath = p;
        // 首次必选入口；「重选 node」则保留已选的 entry，直接回确认
        step = entry === '' ? 'entry' : 'confirm';
        continue;
      }
      if (step === 'entry') {
        const p = await this._pickDshFile({
          title: '选择 DSH 入口脚本（如 packages/examples/jsonrpc-demo/src/bin.ts）',
          openLabel: '选用该入口',
          filters: { '脚本文件': ['ts', 'js'] },
          defaultCandidates: [
            entry ? path.dirname(entry) : '',
            runCwd || cur.runCwd || '',
            'D:\\DSH\\deepseek-harness',
          ],
        });
        if (p === undefined) return;
        entry = p;
        // —— 按入口推导（找不到 node_modules 根 → 全留空，不硬失败，确认弹窗会提示回退工作区根）——
        const root = this._dshRepoRootFromEntry(entry);
        runCwd = root || '';
        const ts = root ? path.join(root, 'tsconfig.json') : '';
        tsconfig = ts && this._exists(ts) ? ts : '';
        const yml = root ? path.join(root, 'examples', 'jsonrpc-agent', 'cordis.yml') : '';
        config = yml && this._exists(yml) ? yml : '';
        step = 'confirm';
        continue;
      }
      if (step === 'config') {
        const p = await this._pickDshFile({
          title: '选择 runtime 部署配置（cordis.yml，可选）',
          openLabel: '选用该配置',
          filters: { 'YAML': ['yml', 'yaml'] },
          defaultCandidates: [config ? path.dirname(config) : '', runCwd || ''],
        });
        if (p === undefined) return;
        config = p;
        step = 'confirm';
        continue;
      }

      // ---- step === 'confirm' ----
      // 展示行刻意写成灰字；`enabled` 不是 QuickPickItem 的字段（API 里没有），
      // 标了也不拦点击 —— 选中会落到末尾的兜底 return。保留只为标明"这行是给人看的"。
      const rows: Array<vscode.QuickPickItem & { enabled?: boolean }> = [];
      if (runtimeDir) {
        // 便携运行时生效时，其余五项都不参与启动 —— 列出来只会让人以为改了有用
        const portable = readRuntimeDir(runtimeDir);
        if (portable.ok) {
          rows.push(
            { label: '当前生效：便携运行时', description: portable.dir, enabled: false },
            { label: '  包内 node', description: `${portable.node}（${portable.manifest.nodeVersion ?? '版本未知'}）`, enabled: false },
            { label: '  入口', description: portable.entry, enabled: false },
            { label: '  配置文件', description: portable.config, enabled: false }
          );
        } else {
          rows.push({ label: '当前生效：便携运行时（不可用）', description: portable.problem, enabled: false });
        }
      } else {
        rows.push(
          { label: 'node', description: nodePath || '(未设置)', enabled: false },
          { label: '入口', description: entry || '(未设置)', enabled: false },
          { label: '工作目录', description: runCwd || '(未设置 → 回退工作区根)', enabled: false },
          { label: 'tsconfig', description: tsconfig || '(未设置)', enabled: false },
          { label: '配置文件', description: config || '(未设置)', enabled: false }
        );
      }
      rows.push({ label: '保存并重启 live', description: '把以上值写入用户设置（hello.dsh.*），随后重启 DSH 子进程' });
      if (runtimeDir) {
        rows.push(
          { label: '重新选择运行时目录', description: '' },
          { label: '改用手工配置', description: '清空 hello.dsh.runtimeDir，回到 node + 入口 的开发者路径' }
        );
      } else {
        rows.push(
          { label: '改用一个便携运行时目录', description: '推荐：目录自带 node 与配置，不需要 tsx 与 DSH 检出' },
          { label: '重新选择 node 可执行文件', description: '' },
          { label: '重新选择入口脚本', description: '将按入口所在仓库自动推导其余路径' },
          { label: '重新选择配置文件', description: '可选，缺省按入口自动推导' }
        );
      }
      rows.push({ label: '取消', description: '' });

      const pick = await vscode.window.showQuickPick(rows, {
        placeHolder: '确认以上最终值（灰字为将写入的内容）',
        title: 'DSH 运行路径配置',
      });

      if (!pick || pick.label === '取消') return;
      if (pick.label === '保存并重启 live') {
        const changed: Array<[string, string]> = [];
        if (runtimeDir !== cur.runtimeDir) changed.push(['runtimeDir', runtimeDir]);
        if (nodePath !== cur.nodePath) changed.push(['nodePath', nodePath]);
        if (entry !== cur.entry) changed.push(['entry', entry]);
        if (runCwd !== cur.runCwd) changed.push(['runCwd', runCwd]);
        if (tsconfig !== cur.tsconfig) changed.push(['tsconfig', tsconfig]);
        if (config !== cur.config) changed.push(['config', config]);

        const w = vscode.workspace.getConfiguration('hello.dsh');
        for (const [k, v] of changed) {
          try {
            await w.update(k, v, vscode.ConfigurationTarget.Global);
          } catch (err) {
            vscode.window.showErrorMessage(
              `写入 hello.dsh.${k} 失败：${err instanceof Error ? err.message : String(err)}`
            );
            return; // 写失败即中止，避免半套配置生效后误导性重启
          }
        }
        if (changed.length > 0) {
          vscode.window.showInformationMessage('DSH 运行路径已保存，正在重启 live 子进程…');
          this._restartLiveProcess(); // teardown → _postBackendStatus(→_postLiveConfig 灯转绿) → 在线则重连
        } else {
          vscode.window.showInformationMessage('配置没有变化，未写入。');
        }
        return;
      }
      if (pick.label.startsWith('重新选择运行时')) {
        step = 'runtime';
        continue;
      }
      if (pick.label === '改用手工配置') {
        runtimeDir = '';
        step = 'node';
        continue;
      }
      if (pick.label.startsWith('改用一个便携')) {
        step = 'runtime';
        continue;
      }
      if (pick.label.startsWith('重新选择 node')) {
        step = 'node';
        continue;
      }
      if (pick.label.startsWith('重新选择入口')) {
        step = 'entry';
        continue;
      }
      if (pick.label.startsWith('重新选择配置')) {
        step = 'config';
        continue;
      }
      return; // 兜底：未知动作直接收尾
    }
  }

  /** 确保 DSH 子进程在线（幂等：多个调用共享同一个进行中的握手；仅 harness 有效）。 */
  private _connectLive(): Promise<void> {
    if (this._mode !== 'harness') return Promise.resolve();
    if (this._backendState === 'online') return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;
    const p = this._doConnectLive();
    this._connectPromise = p;
    p.then(
      () => {
        if (this._connectPromise === p) this._connectPromise = undefined;
      },
      () => {
        if (this._connectPromise === p) this._connectPromise = undefined;
      }
    );
    return p;
  }

  /** 实际的握手：连接中 → initialize → 在线 / 错误。 */
  private async _doConnectLive(): Promise<void> {
    this._backendState = 'connecting';
    this._backendDetail = '连接中…';
    this._postBackendStatus();
    // 先解析 API key（SecretStorage → 回退文件）；只注入子进程 env，绝不落日志/入消息
    try {
      await this._resolveApiKey();
    } catch {
      /* key 解析失败不阻断握手：让子进程侧（llm-deepseek）报更具体的错 */
    }
    // C1：审批必须在 spawn **之前**就绪 —— _makeSpawnRequest 是同步的，它读的就是
    // _approvalFiles（派生配置路径）。准备失败会在内部告警并降级，不阻断连接。
    await this._ensureApproval();
    // C10：派生配置的**唯一**刷新点，故意放在这道屏障之后。
    // 它必须在这儿（而不是散进 _ensureApproval 的各条分支）有两个理由：
    //   1. **覆盖要跟审批解耦** —— 审批关着时 _ensureApproval 是空返回，只有这里有保障；
    //   2. 到这里 _approvalFiles 必然是本次连接要用的最终值，而 _makeSpawnRequest 是同步的、
    //      在 _getRuntime() 的懒 spawn 里才读 _effectiveConfigPath()，顺序刚好够。
    // 顺序错了（挪到 _makeSpawnRequest 之后、或放进懒加载回调）就会下发上一轮的旧配置。
    this._refreshDerivedConfig();
    let runtime: DshRuntime;
    try {
      runtime = this._getRuntime();
    } catch (err) {
      this._backendState = 'error';
      this._backendDetail = err instanceof Error ? err.message : String(err);
      this._backendModel = undefined;
      this._postBackendStatus();
      return;
    }
    try {
      await runtime.initialize(this._dshInitParams());
      this._backendState = 'online';
      this._backendModel = this._dshModel();
      this._backendDetail = undefined;
    } catch (err) {
      if (isAbortError(err)) {
        // 连接途中被停止/切走：保持可重试的安静态
        if (this._backendState !== 'online') {
          this._backendState = 'offline';
          this._backendDetail = undefined;
        }
      } else {
        this._backendState = 'error';
        this._backendDetail = err instanceof Error ? err.message : String(err);
        this._backendModel = undefined;
      }
    }
    this._postBackendStatus();
  }

  // ----- 子进程通知 → 状态/消息协议 -----

  private _onDshStatus(frame: DshStatusFrame): void {
    // 判据抽在 turnState.TurnStatus 里（本文件 import vscode，probe 加载不了）：
    // 非当前会话的通知忽略、running/idle 只在翻转时算数、重复通知幂等。
    const flipped = this._turnStatus.apply(frame);
    // 首次通知会认领会话 id（ready → _connectLive 那条路上 initialize 早于 _ensureDshSession，
    // 此时 _currentDshId 还是空的）—— 认领结果回写，两者别各记一套。
    if (this._turnStatus.id !== undefined) {
      this._currentDshId = this._turnStatus.id;
    }
    if (flipped && !this._turnStatus.running && this._liveRunning) {
      // idle 可能紧随同一批 stdout 行到达；微任务里收尾，避免同 burst 双重 finalize
      queueMicrotask(() => this._finishTurn('done'));
    }
  }

  private _onDshEvent(frame: DshEventFrame): void {
    if (!this._liveRunning) return;
    if (this._currentDshId !== undefined && frame.sessionId !== this._currentDshId) return;
    // C9：本轮时间线。**插在两个闸之后、switch 之前** —— 一处咽喉，下面六个 case 一个不用改，
    // 将来新加 case 也不会「忘了记一笔」。chunk 帧由模块按 type 早退，不入账，也不产生下发。
    // ⚠️ 别为了多抓几帧把它挪到 `_liveRunning` 闸之前：闸内丢的帧本来就不属于这一轮
    // （C8 ② 正是靠它让被杀进程的迟到帧不能复活界面），放宽它是 reopening 一个已修的 bug。
    if (this._runs.apply(frame, this._active.id)) this._postRuns();
    if (this._reactLive) {
      // 真组件画面：把原始帧转给 webview 增量装配（ChatView）。DOM 气泡仍照发
      // （chat.js 在 react 画面下忽略），SessionStore 转写因此保持完整。
      this._post({ type: 'dsh-event', frame });
    }
    const ev = frame.event;
    // wire 上 event 是完整信封 {type,seq,time,data,…}，真实载荷在 data 里
    const d = ev.data ?? ({} as DshEventData);
    switch (ev.type) {
      case 'assistant/chunk': {
        const chunk = d.chunk;
        // C3a：usage 早样本。必须先于下面那行 text-delta 早退处理 —— 它也是 chunk.type，
        // 否则每步的计数会在这里被静默丢掉。
        if (chunk && chunk.type === 'usage') {
          this._onUsageSample(d, chunk.usage);
          return;
        }
        if (!chunk || chunk.type !== 'text-delta') return;
        const delta = typeof chunk.text === 'string' ? chunk.text : '';
        if (!delta) return;
        if (!this._openAssistant || this._openAssistant.status !== 'streaming') {
          this._openAssistantBubble();
        }
        const m = this._openAssistant as ChatMessage;
        m.text += delta;
        this._post({ type: 'assistant-delta', id: m.id, delta });
        return;
      }
      case 'assistant/message': {
        // C3a：同一步的终样本，值与上面那条 usage chunk 逐字节相同 → 覆盖式并入，不重复计。
        if (d.usage) this._onUsageSample(d, d.usage);
        return;
      }
      case 'request/context': {
        // C3a：本次请求的路由与上下文窗口（占用率的分母）。
        // ⚠️ C10b 更正了一条曾经的错误认知（就写在这行注释里）：「每会话一条、会话开头就到，
        // 换子进程会重新发」。**续聊时它一条都不发** —— DSH 的 emit 拿从**日志**折出来的
        // previousContext 比对，provider/model/窗口三者相同就跳过（实测 1704 条事件的日志里
        // 只有 1 条，在会话第一次请求那处）。所以这里除了记活值，还要把分母**记进会话**
        // （落盘），否则整个连接里占用读数都是空的。详见 contextWindow.ts。
        if (typeof d.contextWindow === 'number' && d.contextWindow > 0) {
          this._contextWindow = d.contextWindow;
          this._active.contextWindow = d.contextWindow;
          this._postUsage();
        }
        return;
      }
      case 'compaction/summary':
      case 'compaction/end': {
        // C10：DSH 把一段旧事件折叠成摘要（或折不动失败了）。**这两个 case 是"记忆被改动了"
        // 唯一的告知通路** —— 在此之前它是完全静默的（事件早就转发过来了，只是没人读）。
        // 判据全在纯模块里（`readCompactionEvent`），这里只负责落一条说明。
        const note = readCompactionEvent(ev.type, d);
        if (note) {
          this._pushNote(note.text);
          if (note.kind === 'done') this._active.compacted = (this._active.compacted ?? 0) + 1;
        }
        return;
      }
      case 'tool/call': {
        // 工具前的文字收成独立气泡，再开一张 running 卡
        this._finalizeOpenAssistant('done');
        const key = this._toolKey(d);
        const msg: ChatMessage = {
          id: this._nextMsgId(),
          role: 'tool',
          text: '',
          status: 'done',
          toolName: typeof d.name === 'string' && d.name ? d.name : 'tool',
          // C8c 保险丝：**截在消息产生处**，内存 / webview / 盘上 / 导出 / 检索读到的才是同一串字符
          // （放存储层会让内存留全文 ⇒「同一个工具卡，重载窗口前后不一样」这种难复现的 bug）。
          toolInput: capToolInput(prettyValue(d.arguments)),
          toolState: 'running',
        };
        this._active.messages.push(msg);
        this._toolIds.set(key, msg.id);
        this._post({ type: 'tool-start', message: msg });
        return;
      }
      case 'tool/result': {
        const key = this._toolKey(d);
        const known = this._toolIds.get(key);
        let target = known
          ? this._active.messages.find((m) => m.id === known)
          : undefined;
        if (!target) {
          // 键对不上（callId 缺失等）：退而找最近一张 running 卡收尾
          target = this._active.messages
            .slice()
            .reverse()
            .find((m) => m.role === 'tool' && m.toolState === 'running');
        }
        if (!target) return;
        // C9：判据抽到 runInspector.ts，与检查器**共用同一份实现**（免得转写里是红卡、
        // 检查器里是绿行）。**三态**：补平帧正文说「结果未知」而帧上带 isError，
        // 判成 error 就是谎报（见 toolResultVerdict 的注释）。
        const verdict = toolResultVerdict(d);
        const outParts: string[] = [];
        for (const b of d.message?.content ?? []) {
          if (!b || b.type !== 'tool-result') continue;
          for (const c of b.content ?? []) {
            if (c && c.type === 'text' && typeof c.text === 'string') outParts.push(c.text);
          }
        }
        let output = outParts.join('\n');
        if (output.length > MAX_TOOL_OUTPUT_CHARS) {
          output = output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n…（输出过长，已截断）';
        }
        target.toolState = verdict;
        target.toolOutput = output;
        this._post({ type: 'tool-result', id: target.id, toolState: target.toolState, output });
        return;
      }
      case 'turn/end': {
        const reason = d.reason && typeof d.reason === 'object' ? d.reason : undefined;
        const kind = reason?.kind;
        // C8：`interrupted` 进白名单。它是**我们自己杀进程之后、运行时在下次 resume 时补平**
        // 「悬空尾 turn」所用的那个 reason（另见 TOOL_OUTCOME_UNKNOWN 的 tool/result）——
        // 补平是运行时的正确行为，不是异常，不该被当成「本轮异常结束」上浮。
        if (kind && kind !== 'completed' && kind !== 'aborted' && kind !== 'interrupted') {
          // DSH 的 reason.error 是结构化失败 {message, code}，尽量带出来让用户看得见
          const err = reason ? (reason as { error?: unknown }).error : undefined;
          const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
          const message =
            err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
              ? (err as { message: string }).message
              : undefined;
          this._surfaceLiveError(
            message
              ? `本轮异常结束（${typeof code === 'string' && code ? `${code}：` : ''}${message}）`
              : `本轮异常结束（reason=${kind}）`
          );
        }
        // 'completed' 什么都不做：以 session.status idle 作为本轮真正的完成信号
        return;
      }
      default:
        // turn/start、user/message、agent/inbox/*、reasoning-delta、
        // tool-call-delta、subagent.* 一律忽略
        // （assistant/message 与 request/context 原在此列，C3a 起各自成 case 了）
        return;
    }
  }

  // ---------- C3a 用量读数 ----------

  /**
   * 并入一条 usage 样本。
   *
   * **覆盖而非累加**：同一步的 chunk 早样本会被 message 终样本覆盖 —— 两者值相同，
   * 累加就是双计（实测三份抓帧都是恰好 2 倍）。
   */
  private _onUsageSample(d: DshEventData, usage: DshTokenUsage | undefined): void {
    if (!usage) return;
    // 新的这一轮（或上一轮已折叠）→ 换一个干净的累计器
    if (!this._turnUsage || this._turnUsage.folded) {
      this._turnUsage = { byStep: new Map(), folded: false };
    }
    const turn = this._turnUsage;
    turn.byStep.set(`${String(d.turn ?? '')}:${String(d.step ?? '')}`, {
      inputTokens: asCount(usage.inputTokens),
      cacheReadTokens: asCount(usage.cacheReadTokens),
      outputTokens: asCount(usage.outputTokens),
    });
    // prompt 侧压力 = 本次请求的输入规模（含缓存读写），末次样本优先
    turn.pressureTokens =
      asCount(usage.inputTokens) + asCount(usage.cacheReadTokens) + asCount(usage.cacheWriteTokens);
    this._postUsage();
  }

  /** 把本轮计数折进会话累计，**只此一处**（单点折叠 → 不可能双计）。轮尾调用。 */
  private _foldTurnUsage(): void {
    const turn = this._turnUsage;
    if (!turn || turn.folded) return;
    let sum = zeroUsage();
    for (const b of turn.byStep.values()) sum = addBuckets(sum, b);
    this._active.usage = addBuckets(this._active.usage ?? zeroUsage(), sum);
    // C10：顺手把"最后一次已知的上下文占用"落进会话。占用读数本来只活在内存里，
    // 于是重载窗口 / 切回旧会话时那条指示永远是空的 —— 而占用恰恰是它唯一要说的东西。
    // 记的是**上次已知值**，读出来会标 stale（渲染成「上次」），不冒充实时。
    // ⚠️ 分母走 `_effectiveContextWindow()`（活值 → 会话记住的）：续聊时活值根本没有，
    // 用 `this._contextWindow` 直接判的话这条**永远不会落盘**（C10b 修的就是这个）。
    const window = this._effectiveContextWindow();
    if (turn.pressureTokens !== undefined && window !== undefined) {
      this._active.context = {
        usedTokens: turn.pressureTokens,
        contextWindow: window,
        at: Date.now(),
      };
    }
    turn.folded = true;
    this._postUsage();
  }

  /**
   * 这次连接里**可用的分母**：活值优先，缺了用本会话记住的那个。
   *
   * 为什么需要回落而不是只用活值：`request/context` 在续聊时一条都不发（见
   * `contextWindow.ts` 与 `request/context` 那个 case 的注释），于是「继续一个旧会话」
   * 这条最常见的路径上活值恒为 undefined —— 没有回落，整条占用指示就是空的。
   */
  private _effectiveContextWindow(): number | undefined {
    return resolveContextWindow(this._contextWindow, this._active.contextWindow);
  }

  /**
   * 「接近 DSH 的压缩线了吗」。算术与那条近似的口径警告都在纯模块里（`contextStateOf`）。
   */
  private _contextState(usedTokens: number, contextWindow: number): 'ok' | 'near' {
    return contextStateOf(usedTokens, contextWindow, this._compactionThresholdRatio());
  }

  /**
   * 组装读数：本轮 / 本会话累计（含尚未折叠的当前轮）/ 上下文占用。
   *
   * **什么数据都没有时返回 undefined** —— 调用方据此把细条藏起来，而不是显示一排 0。
   * 三种情形都靠它兜住：重开一个从没跑过的旧会话、刚从别的会话切过来、切到「内嵌聊天」。
   */
  private _usageReadout(): UsageReadout | undefined {
    if (this._mode !== 'harness') return undefined;
    const turn = this._turnUsage;
    let turnSum = zeroUsage();
    if (turn) {
      for (const b of turn.byStep.values()) turnSum = addBuckets(turnSum, b);
    }
    // 未折叠的当前轮还没进 _active.usage，这里补上 —— 否则轮尾折叠那一刻读数会跳变。
    // 落盘的数据过一遍 asCount：手改坏了 sessions-harness.json 也别让读数显示 NaN。
    const stored = this._active.usage;
    const session = addBuckets(
      stored
        ? {
            inputTokens: asCount(stored.inputTokens),
            cacheReadTokens: asCount(stored.cacheReadTokens),
            outputTokens: asCount(stored.outputTokens),
          }
        : zeroUsage(),
      turn && !turn.folded ? turnSum : zeroUsage()
    );
    const used = turn?.pressureTokens;
    const contextWindow = this._effectiveContextWindow();
    const storedCtx = this._active.context;
    if (
      used === undefined &&
      contextWindow === undefined &&
      storedCtx === undefined &&
      this._active.compacted === undefined &&
      isZeroUsage(turnSum) &&
      isZeroUsage(session)
    ) {
      return undefined;
    }
    const readout: UsageReadout = { turn: turnSum, session };
    if (this._active.compacted) readout.compacted = this._active.compacted;
    if (used !== undefined && contextWindow !== undefined) {
      readout.context = { usedTokens: used, contextWindow, state: this._contextState(used, contextWindow) };
    } else if (storedCtx) {
      // 活值缺席（刚打开旧会话 / 刚重载窗口）：回落到上次落盘的样本，**标上 stale**。
      // 下限也过一遍 asCount：手改坏了 sessions-harness.json 时别让读数显示 NaN。
      const sUsed = asCount(storedCtx.usedTokens);
      const sWin = asCount(storedCtx.contextWindow);
      if (sWin > 0) {
        readout.context = {
          usedTokens: sUsed,
          contextWindow: sWin,
          state: this._contextState(sUsed, sWin),
          stale: true,
        };
      }
    }
    return readout;
  }

  private _postUsage(): void {
    const usage = this._usageReadout();
    if (usage) this._post({ type: 'usage', usage });
  }

  /** 换会话 / 换模式 / 新建时清掉本轮读数。**会话累计在 `_active.usage` 上，不动**。 */
  private _resetTurnUsage(): void {
    this._turnUsage = undefined;
  }

  // ---------- C9 运行检查器 ----------

  /**
   * 组装运行读数。**内嵌聊天返回 undefined**（同 `_usageReadout` 的守卫）——
   * mock 模式根本没有 DSH 帧，条上永远不会有东西，与其显示一排 0 不如整条藏起来。
   *
   * 与 `_usageReadout` 的关键差别：harness 下**从没跑过也返回读数**（`{runs: []}`），
   * 因为「还没跑过」本身就是调试时要看的一条信息，而条也是这个功能的入口 ——
   * 一个要等第一轮跑完才出现的入口，等于没有入口。
   */
  private _runsReadout(): RunReadout | undefined {
    if (this._mode !== 'harness') return undefined;
    return this._runs.readout(this._active.id);
  }

  /**
   * 下发运行读数。`details` **只在浮层开着时才带** —— 它是 O(轮数 × 工具数) 的，
   * 每收一帧都发等于把最近 20 轮的工具表反复推给前端；摘要（约 1 KB）才是每帧要发的东西。
   */
  private _postRuns(): void {
    const readout = this._runsReadout();
    if (!readout) return;
    this._post(
      this._runsPanelOpen
        ? { type: 'runs', readout, details: this._runs.details(this._active.id) }
        : { type: 'runs', readout }
    );
  }

  /**
   * tool/call 与 tool/result 对齐用的键：优先 callId。
   *
   * C9 起只是 `toolKeyFrom` 的一行委托 —— 配对键在检查器里也要用，两份实现漂移的代价是
   * 「检查器把结果算到 A 行、转写把它画到 B 卡」。实现与注释都在 src/runInspector.ts。
   */
  private _toolKey(d: DshEventData): string {
    return toolKeyFrom(d);
  }

  /** 子进程意外退出（非用户 kill）。live 中 → 上浮错误收尾；空闲 → 状态标 error。 */
  private _onDshExit(code: number | null): void {
    this._dsh = undefined; // 下一个 live 轮重新 spawn
    this._turnStatus.reset(); // 进程没了 → 线上状态一概不可信
    if (this._liveRunning) {
      this._surfaceLiveError(`DSH 子进程意外退出（code=${code}）`);
    } else {
      this._backendState = 'error';
      this._backendModel = undefined;
      this._backendDetail = `DSH 子进程已退出（code=${code}）`;
      this._postBackendStatus();
    }
  }

  // ---------- C1 事前审批：本机审批服务 + DSH hook 三件套 ----------

  /** 审批开关（hello.chat.approval.enabled，**默认开** —— 破坏性命令执行前来一道确认） */
  private _approvalEnabled(): boolean {
    return (
      vscode.workspace.getConfiguration('hello.chat').get<boolean>('approval.enabled', true) === true
    );
  }

  /** 当前策略正则（每次现读 → 改设置即时生效，不必重连） */
  private _approvalPatterns(): string[] {
    const raw = vscode.workspace
      .getConfiguration('hello.chat')
      .get<string[]>('approval.patterns', DEFAULT_APPROVAL_PATTERNS);
    return Array.isArray(raw) ? raw : DEFAULT_APPROVAL_PATTERNS;
  }

  /** 用户等待上限（毫秒，已按可用区间收敛） */
  private _approvalTimeoutMs(): number {
    const raw = vscode.workspace
      .getConfiguration('hello.chat')
      .get<number>('approval.timeoutSec', DEFAULT_APPROVAL_TIMEOUT_SEC);
    const rawSec = Number.isFinite(raw) ? Math.round(raw) : DEFAULT_APPROVAL_TIMEOUT_SEC;
    const sec = Math.min(Math.max(rawSec, APPROVAL_TIMEOUT_MIN_SEC), APPROVAL_TIMEOUT_MAX_SEC);
    return sec * 1000;
  }

  // ---------- C4 工作区外写：判定「越界」----------

  /** 越界是否弹确认条（hello.chat.approval.outsideWorkspace，默认开）。
   *  **只 gate「问」**：hook 挂着的时候，区外目标照旧进本轮审阅 —— 关掉它等于「不问只记」。 */
  private _approvalOutsideEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration('hello.chat')
        .get<boolean>('approval.outsideWorkspace', DEFAULT_APPROVAL_OUTSIDE) === true
    );
  }

  /**
   * 本次调用的会话工作区（相对 file_path 的解析基准）。用 hook 载荷里的 `cwd` —— DSH 给的就是
   * 会话工作区，路径本来就是相对它解析的；拿不到才退到打开的工作区根。
   * **绝不用 `_dshCwd()`**：那个无工作区时会退成用户主目录，拿家目录当"界内"等于放行一切。
   */
  private _sessionWorkspaceRoot(ask: ApprovalAsk): string {
    return String(ask.cwd ?? '').trim() || this._reviewRoot() || '';
  }

  /** fs 工具的目标绝对路径（拿不到 → undefined）。 */
  private _fsTargetAbs(ask: ApprovalAsk): string | undefined {
    const raw = String(ask.filePath ?? '').trim();
    if (!raw) return undefined;
    // POSIX 形态（Linux 侧给的 /mnt/… 之类）：Windows 的 path 会把它当"当前盘根下"解析出
    // 一个完全错误的位置 —— 宁可判不出来（调用方按越界处理，多问一次），也不乱认。
    if (raw.startsWith('/') && !raw.startsWith('//')) return undefined;
    if (path.isAbsolute(raw)) return path.resolve(raw);
    const base = this._sessionWorkspaceRoot(ask);
    return base ? path.resolve(path.join(base, raw)) : undefined;
  }

  /** target 是否落在 root 之内（含 root 自身）。win32 下 path.relative 已做大小写归一。
   *  **绝不用 startsWith 比前缀**：`C:\proj2` 会被 `C:\proj` 骗过。 */
  private _isInside(target: string, root: string): boolean {
    if (!root) return false;
    const rel = path.relative(path.resolve(root), path.resolve(target));
    if (!rel) return true; // 就是根本身
    if (path.isAbsolute(rel)) return false; // 不同盘符 → relative 返回绝对路径
    return rel !== '..' && !rel.startsWith('..' + path.sep);
  }

  /** 平台临时区内的路径（DSH 沙箱也刻意放行那里；temp churn 不该进审阅，也不该弹条）。 */
  private _isTempPath(abs: string): boolean {
    const tmp = os.tmpdir();
    return !!tmp && this._isInside(abs, tmp);
  }

  /** 是否越出会话工作区（临时区豁免）。定位不了 → 保守当越界。 */
  private _isOutsideWorkspace(ask: ApprovalAsk): boolean {
    const target = this._fsTargetAbs(ask);
    if (!target) return true;
    if (this._isTempPath(target)) return false;
    const root = this._sessionWorkspaceRoot(ask);
    return !this._isInside(target, root);
  }

  /**
   * 审批策略（注入给 ApprovalServer 的谓词，每次现读）。
   * bash 走 C1 的正则清单；write/edit 走 C4 的越界判定；其余工具不表态。
   */
  private _askNeedsApproval(ask: ApprovalAsk): boolean {
    if (ask.toolName === 'bash') {
      return matchesAnyPattern(this._approvalPatterns(), ask.command);
    }
    if (ask.toolName === 'write' || ask.toolName === 'edit') {
      return this._approvalOutsideEnabled() && this._isOutsideWorkspace(ask);
    }
    return false;
  }

  /**
   * C4 可见性那半：每次 write/edit 会先经过这里（**不论要不要问**），在工具**执行之前**
   * 给工作区外目标抓一张轮前快照。于是：
   * - 被用户拒绝的写从不落盘 → 轮末对比自然没有它，不需要额外判断；
   * - 用户自己在同一轮的编辑不会被算成 agent 的改动（只快照目标那一个文件）。
   */
  private _onApprovalObserved(ask: ApprovalAsk): void {
    if (ask.toolName !== 'write' && ask.toolName !== 'edit') return;
    // `_abort` 是本轮的 token：**轮跑着的时候非空**（_sendUser 里设、_runLive 的 finally 里清），
    // 而 hook 只在轮中触发 —— 所以这里要的是 `!this._abort`（不在轮中就别认领）。
    // 写成 `this._abort` 会让本方法每一轮都当场 return（区内行来自轮首播种的树根，不受影响，
    // 所以症状是「区外改动悄无声息地永远不进审阅」）。
    if (!this._abort || !this._reviewChangesOn()) return;

    const target = this._fsTargetAbs(ask);
    if (!target || this._isTempPath(target)) return;
    const root = this._sessionWorkspaceRoot(ask);
    // 工作区内的写由工作区树根那半负责；没开文件夹时 root 为空 → 一律按区外处理
    if (root && this._isInside(target, root)) return;

    for (const r of this._reviewRoots.values()) {
      if (r.kind === 'tree' && this._isInside(target, r.root)) return; // 已被树根覆盖
    }
    // 先到先得：第二次写到同一文件时，"轮前"早被第一次写污染了，换掉会让还原撒谎
    if (this._reviewRoots.has(target)) return;
    let outsideCount = 0;
    for (const r of this._reviewRoots.values()) if (r.kind === 'file') outsideCount += 1;
    // 满了就跳过，**不做淘汰** —— 淘汰会丢已有可还原项，那比少记一条更糟
    if (outsideCount >= MAX_OUTSIDE_REVIEW_ROOTS) return;

    const dir = path.dirname(target);
    this._reviewRoots.set(target, {
      kind: 'file',
      root: dir,
      // 键用**目标文件**而不是父目录：同目录两个目标会撞键，第二个就再也记不上了
      target,
      outside: dir,
      snap: snapshotSingleFile(dir, target),
    });
  }

  /**
   * 解析 `hello.dsh.runtimeDir`：读清单、把三个相对路径解析成绝对路径、逐个验存在。
   * 每次现读（清单才几百字节）→ 改了设置即时生效，也免去失效缓存的坑。
   */
  private _runtime(): RuntimeResolution | undefined {
    const raw = String(this._dshConfig().get('runtimeDir') ?? '').trim();
    if (!raw) return undefined;
    return readRuntimeDir(path.isAbsolute(raw) ? raw : path.resolve(this._dshCwd(), raw));
  }

  /**
   * spawn 用的 node：便携运行时自带的优先（版本由清单保证），否则用户手工配的。
   * 审批 hook 脚本也走这里 —— 否则便携场景下 hook 会落到 PATH 上的旧 node 上。
   */
  private _effectiveNodePath(): string {
    const runtime = this._runtime();
    if (runtime?.ok) return runtime.node;
    return String(this._dshConfig().get('nodePath') ?? '').trim();
  }

  /**
   * 入口要不要配 tsx loader。显式设了 `hello.dsh.loader` 就用它；否则按入口扩展名判断：
   * `.ts/.tsx/.mts` 走 tsx/esm（兼容既有手工配置），打包好的 `.js`（便携运行时的
   * packaged-bin.js）**不加任何 loader**。设置默认值因此是空串 —— 空 = 交给这条规则。
   */
  private _dshLoader(entry: string): string {
    const explicit = String(this._dshConfig().get('loader') ?? '').trim();
    if (explicit) return explicit;
    return /\.(ts|tsx|mts)$/i.test(entry) ? 'tsx/esm' : '';
  }

  /** 用户的基础 cordis.yml 绝对路径（相对路径按 runCwd 解析）；空串 = 没配 */
  private _baseConfigPathAbs(): string {
    const runtime = this._runtime();
    // 便携运行时：清单里的 config 就是基础配置 —— C1 的派生配置从这里派生出去
    if (runtime) return runtime.ok ? runtime.config : '';
    const raw = String(this._dshConfig().get('config') ?? '').trim();
    if (!raw) return '';
    return path.isAbsolute(raw) ? raw : path.resolve(this._dshRunCwd(), raw);
  }

  /** spawn 时真正下发的 cordis.yml：有派生配置 → 派生配置；否则用户原配置。 */
  private _effectiveConfigPath(): string {
    // C10 在前：`_overlayConfigPath` 是 hooks 块 + 比例补丁的**合成物**，是更新的那一份。
    // 它为空（没开审批、也没调阈值）时往下走，行为与 C1 时期完全一致。
    if (this._overlayConfigPath) return this._overlayConfigPath;
    if (this._approvalFiles) return this._approvalFiles.cordisPath;
    const runtime = this._runtime();
    if (runtime) return runtime.ok ? runtime.config : '';
    return String(this._dshConfig().get('config') ?? '').trim();
  }

  // ---------- C10：压缩阈值覆盖 ----------

  /** 设置项 `hello.chat.compaction.thresholdRatio`。每次现读（同 `_approvalPatterns` 的体例）。 */
  private _compactionThresholdRatio(): number {
    return vscode.workspace
      .getConfiguration('hello.chat')
      .get<number>('compaction.thresholdRatio', DEFAULT_COMPACTION_THRESHOLD_RATIO);
  }

  /** 用户把阈值调离默认值时的覆盖；仍是默认 → undefined（= 完全不派生，行为与没有这个功能时逐字节相同） */
  private _compactionOverride(): CompactionRatios | undefined {
    return compactionOverride(this._compactionThresholdRatio());
  }

  /**
   * 压缩阈值告警：控制台始终留痕、用户侧每次 activation 只弹一条。
   * 体例同 `_approvalWarn` / `_storageWarn`，**旗标必须是独立的** —— 共用一个的话先到的会吞掉后到的。
   */
  private _compactionWarn(text: string): void {
    console.warn('[compaction]', text);
    if (this._compactionWarned) return;
    this._compactionWarned = true;
    void vscode.window.showWarningMessage(`压缩阈值设置未生效：${text}`);
  }

  /**
   * 重写派生配置，并把「下发改用它」这件事定下来（幂等，**永不抛**）。
   *
   * 输入只有两个，且互相独立：
   *   · `_approvalFiles?.hooksPath` —— 审批就绪时追加 hooks 块（C1 的既有行为，一字不改）
   *   · `_compactionOverride()`    —— 调低了阈值时改底本里 compaction-basic 那两行
   *
   * **为什么它必须跟审批解耦**：C10 的这条旋钮跟审批没有任何关系，用户完全可以关掉审批只用它。
   * 旧结构里「派生的时机」挂在审批就绪上，所以那里必须多出一个独立入口 —— 就是本函数
   * 唯一的调用点（`_doConnectLive` 里 `_ensureApproval()` 之后那行）。
   */
  private _refreshDerivedConfig(): void {
    const hooksPath = this._approvalFiles?.hooksPath ?? '';
    const compaction = this._compactionOverride();
    if (!hooksPath && !compaction) {
      // 两样都不需要 → 不派生。留着旧的派生文件只会是一份会过期的副本。
      this._overlayConfigPath = undefined;
      return;
    }
    const baseConfigPath = this._baseConfigPathAbs();
    if (!baseConfigPath) {
      this._overlayConfigPath = undefined;
      return;
    }
    try {
      const r = writeDerivedConfig({ storageDir: this._storageDir, baseConfigPath, hooksPath, compaction });
      // 比例没落上（底本里没有那个插件块等）时仍然要用这份文件 —— hooks 块在里面
      if (r.warning) this._compactionWarn(r.warning);
      this._overlayConfigPath = r.cordisPath;
    } catch (err) {
      // 只剩「底本读不出来」会走到这。降级到「不用派生配置」，绝不阻断连接 —— 与 _ensureApproval 同一条纪律。
      this._overlayConfigPath = undefined;
      if (compaction) this._compactionWarn(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 确保审批就绪（幂等）。开关关着 → 顺手拆掉服务与派生配置（下次 spawn 回到用户原配置）。
   * 任何一步失败都只降级 + 告警：审批不生效，但插件照常能用。
   */
  private _ensureApproval(): Promise<void> {
    if (!this._approvalEnabled()) {
      if (this._approval) {
        this._approval.dispose();
        this._approval = undefined;
      }
      this._approvalFiles = undefined;
      return Promise.resolve();
    }
    if (this._approval && this._approvalFiles) return Promise.resolve();
    if (this._approvalSetup) return this._approvalSetup;
    const p = this._setupApproval();
    this._approvalSetup = p;
    const clear = (): void => {
      if (this._approvalSetup === p) this._approvalSetup = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  private async _setupApproval(): Promise<void> {
    const conf = this._dshConfig();
    // 整段覆盖启动命令时，config 写死在 args 里，我们无从替换 → 明确不启用（并说清原因）
    if (String(conf.get('command') ?? '').trim()) {
      this._approvalWarn('hello.dsh.command 整段覆盖了启动命令，配置由该命令自带，审批无法接入。');
      return;
    }
    // 运行时目录坏了就别往下走：派生配置没有底本，再往下只会报出「未配置 hello.dsh.config」这种误导文案
    const problem = this._dshConfigProblem();
    if (problem) {
      this._approvalWarn(`${problem} 审批无法接入。`);
      return;
    }
    // 便携运行时自带的 node 优先 —— 否则便携场景下 hook 会落到 PATH 上的旧 node 上（静默降级）
    const nodePath = this._effectiveNodePath();
    if (!nodePath) {
      this._approvalWarn('没有可用的 node（既没配便携运行时也没配 hello.dsh.nodePath），hook 脚本跑不起来。');
      return;
    }

    const server = new ApprovalServer(
      (ask) => this._askNeedsApproval(ask),
      () => this._approvalTimeoutMs(),
      (ask) => this._onApprovalAsk(ask),
      (id, outcome) => this._onApprovalResolved(id, outcome),
      (ask) => this._onApprovalObserved(ask)
    );
    try {
      await server.start();
    } catch (err) {
      this._approvalWarn(`审批服务启动失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // hook 由 DSH 用 `bash -c` 跑，而 bash 既可能是 WSL 也可能是 Git Bash —— 命令里的路径形态
    // 完全不同（WSL 下 `D:\…\node.exe` 连可执行文件都算不上，直接 command not found）。
    // probeShell 只是**首猜**（超时会按平台先验落到 wsl，见 shellGuessOnTimeout），真正的判据是
    // **自检本身**：哪种形态的命令在同一把 shell 里跑得起来，就是它。两种形态互斥（A 形态的
    // 命令在 B 里必然 command not found），所以「谁过」是无歧义的。
    //
    // 排程交给 nextShellCheck（纯函数，探针钉着）：它额外负责**冷启动那次不算数** —— 重载那一刻
    // WSL 可能还在开机，超时/空手退出这两种「不可判」的失败不判形态死刑，排到队尾再验一次。
    // 线上症状就是这么来的：posix 形态自检超时(15s) + wsl 形态 `bash 退出码 1`（两边空），
    // 两条都不说明形态写错了，却把审批整个关掉了。
    const runCwd = this._dshRunCwd();
    const guess = await probeShell(runCwd);
    const order: ShellKind[] = guess === 'wsl' ? ['wsl', 'posix'] : ['posix', 'wsl'];

    const attempts: ShellCheckAttempt[] = [];
    // 重试每次 activation 只给一次：冷启动只发生一次，下一次 spawn 时 WSL 已经热了（那时首轮就过）。
    // 不这么闸住的话，真接不上的场景会变成「每发一条消息先干等两轮超时」。
    let retriesUsed = this._approvalRetried ? 1 : 0;
    const failure: string[] = [];
    for (;;) {
      const shellKind = nextShellCheck(order, attempts, retriesUsed);
      if (!shellKind) break;
      const isRetry = attempts.some((a) => a.kind === shellKind);
      if (isRetry) {
        retriesUsed += 1;
        this._approvalRetried = true;
      }
      let files: ApprovalHookFiles;
      try {
        files = this._writeApprovalFiles(shellKind, nodePath, server);
      } catch (err) {
        // 生成失败（基础 cordis.yml 不是块状列表等）与 shell 形态无关 → 换一种也一样，不再试
        server.dispose();
        this._approvalWarn(`审批 hook 生成失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      // 自检：这条 hook 命令在**同一个 shell**（DSH 也是 bash -c）里跑得起来吗？
      const test = await testApprovalHook(files.hookCommand, runCwd);
      attempts.push({ kind: shellKind, retriable: test.retriable });
      if (test.ok) {
        this._approval = server;
        this._approvalFiles = files;
        console.log(
          `[approval] 事前审批已就绪（shell=${shellKind}${shellKind === guess ? '' : `，首猜 ${guess} 猜错了`}` +
            `${isRetry ? '，第一次是「不可判」的失败，重试才过 —— 那多半是 WSL 冷启动' : ''}，hook 自检通过）`
        );
        return;
      }
      failure.push(`${shellKind} 形态${isRetry ? '（重试）' : ''}：${test.detail}`);
    }

    // 两种形态、连重试都跑不起来 = 这一轮审批**确实**接不进去。这里要「干净地不启用」而不是留着半套：
    // 丢掉派生配置（下次 spawn 回到用户原配置，不往他们的 DSH 里塞一条跑不起来的 hook），
    // 同时清掉 _approval —— 于是 _ensureApproval 下次 spawn 会重试一次（重载时 WSL 冷启动
    // 失败是暂时的，热了之后自愈），弹窗有 _approvalWarned 兜着，不会刷屏。
    server.dispose();
    this._approvalFiles = undefined;
    // 话术要点：说清「什么时候会再试」，否则用户会以为这个功能坏了、去翻设置（线上那条告警就
    // 只说了「审批不会生效」，没说下一条消息会自动重来）。
    this._approvalWarn(
      `审批 hook 自检没通过（下一条消息会自动再试一次）：${failure.join('；').slice(0, 400)}`
    );
  }

  /** 按指定 shell 形态生成三件套（hook 脚本 / hooks.json / 派生 cordis.yml）。 */
  private _writeApprovalFiles(
    shellKind: ShellKind,
    nodePath: string,
    server: ApprovalServer
  ): ApprovalHookFiles {
    const timeoutMs = this._approvalTimeoutMs();
    return writeApprovalHookFiles({
      storageDir: this._storageDir,
      nodePath,
      shellKind,
      url: server.url,
      token: server.token,
      // 三层超时梯度：扩展先放弃并拒绝(540) < 脚本 socket 放弃(560) < DSH 杀 hook(580)
      scriptTimeoutMs: timeoutMs + 20000,
      hookTimeoutSec: Math.ceil((timeoutMs + 40000) / 1000),
      baseConfigPath: this._baseConfigPathAbs(),
    });
  }

  /**
   * 确认条与留痕要显示的文本。bash = 命令原文；C4 的 write/edit 载荷里**根本没有可展示的
   * 命令**（正文是模型写的文件内容，绝不转发），所以在这里现拼一个路径标签。
   */
  private _approvalLabel(ask: ApprovalAsk): string {
    if (ask.toolName === 'write' || ask.toolName === 'edit') {
      const verb = ask.toolName === 'edit' ? '编辑' : '写';
      const target = this._fsTargetAbs(ask) ?? String(ask.filePath ?? '（未知路径）');
      return `${verb}工作区外的文件：${target}`;
    }
    return ask.command;
  }

  /** 需要用户拍板：推确认条 + 把侧栏亮出来（视图折叠着就看不见确认条，只能干等到超时）。 */
  private _onApprovalAsk(ask: ApprovalAsk): void {
    const label = this._approvalLabel(ask);
    this._approvalCmds.set(ask.id, label);
    this._post({
      type: 'approval-request',
      id: ask.id,
      toolName: ask.toolName,
      command: label,
    });
    // 视图折叠着就看不到确认条，只能干等到超时 → 主动把它亮出来（失败也不影响流程）
    vscode.commands.executeCommand('hello.chatView.focus').then(undefined, () => {});
    vscode.window.setStatusBarMessage(`等待确认：${oneLine(label, 60)}`, 5000);
  }

  /** 一条审批有了结果：收起确认条 + 往转写补一条留痕（note 随会话持久化/回放）。 */
  private _onApprovalResolved(id: string, outcome: ApprovalOutcome): void {
    const command = this._approvalCmds.get(id);
    this._approvalCmds.delete(id);
    this._post({ type: 'approval-resolved', id, outcome });
    if (!command) return;
    const label =
      outcome === 'allowed'
        ? '已允许执行'
        : outcome === 'rejected'
          ? '已拒绝，未执行'
          : outcome === 'timeout'
            ? '确认超时，已按拒绝处理（未执行）'
            : '审批已取消（本轮停止或切换），未执行';
    this._pushNote(`${label}：${oneLine(command, 120)}`);
  }

  /** 审批相关告警：控制台始终留痕，用户侧每次 activation 只弹一次（不刷屏）。 */
  private _approvalWarn(text: string): void {
    console.warn('[approval]', text);
    if (this._approvalWarned) return;
    this._approvalWarned = true;
    void vscode.window.showWarningMessage(`事前审批未生效：${text}`);
  }

  /**
   * C8c：存储告警，体例同上（控制台始终留痕、每次 activation 只弹一条）。
   *
   * 不并入 `_approvalWarn` 的两个理由：旗标要独立（否则先到的吞掉后到的）；前缀要是 `[storage]`
   * —— 用户贴日志来排查时，前缀就是「去哪看」。
   */
  private _storageWarn(text: string, detail: string = ''): void {
    console.warn('[storage]', text, detail); // detail 只进控制台：那是给排查用的，不该糊到弹窗上
    if (this._storageWarned) return;
    this._storageWarned = true;
    void vscode.window.showWarningMessage(`历史会话：${text}`);
  }

  /**
   * C8c：把两个 store 的加载结局翻成用户能懂的一句话。挂在 `case 'ready'`。
   *
   * 静默的两条：`source === 'file'`（一切正常），以及 **`empty` + `missing`**（首次运行，文件还没建）。
   * 后者报出来就是误报，而误报会让真正的损坏告警被用户当噪音忽略掉。
   *
   * ⚠️ 注意**不是**「`reason === 'missing'` 一律跳过」：主文件不见了、却从备份捞回来的话，
   * `reason` 也是 `missing`，但那是一次货真价实的恢复，必须说（从前真有可能是被人手删了、
   * 被安全软件隔离了）。判据挂在 `source` 上才切得干净。
   */
  private _checkStorageHealth(): void {
    for (const [mode, store] of Object.entries(this._stores) as [Mode, SessionStore][]) {
      const r: LoadReport = store.loadReport;
      if (r.source === 'file' || (r.source === 'empty' && r.reason === 'missing')) {
        continue;
      }
      if (r.source === 'backup') {
        this._storageWarn(
          `上次的转写文件没能用上，已从备份恢复（${mode}）。明细见「输出 → 扩展宿主」里的 [storage]。`,
          r.detail
        );
      } else {
        this._storageWarn(
          `转写文件损坏且没有可用备份，历史列表暂时是空的（${mode}）。明细见「输出 → 扩展宿主」里的 [storage]。`,
          r.detail
        );
      }
    }
  }

  // ----- 配置 / 子进程构建（全部来自 hello.dsh.*，可被用户覆盖） -----

  private _dshConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('hello.dsh');
  }

  /** DSH 运行路径是否已配（与 _makeSpawnRequest 的 throw 条件同构）：
   *  便携运行时目录合法 → 算配好；否则要求 nodePath 与 entry 都填。
   *  注：若用户走 hello.dsh.command 整段覆盖而 nodePath/entry 为空，这里会报「未配置」——可接受边缘，
   *  因为配置条引导的就是这两条路径本身。 */
  private _dshConfigured(): boolean {
    const runtime = this._runtime();
    if (runtime) return runtime.ok;
    const conf = this._dshConfig();
    const nodePath = String(conf.get('nodePath') ?? '').trim();
    const entry = String(conf.get('entry') ?? '').trim();
    return !!(nodePath && entry);
  }

  /** 配置有什么毛病时说给用户听的一句话（配置条/告警用）；没问题则返回空串。 */
  private _dshConfigProblem(): string {
    const runtime = this._runtime();
    return runtime && !runtime.ok ? runtime.problem : '';
  }

  /** 路径存在判断（目录或文件都算）。 */
  private _exists(p: string): boolean {
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  }

  /** 从入口脚本向上（最多 8 层）定位 DSH 仓库根。
   *  注意：pnpm 每个包目录都自带 node_modules，不能停在内层包目录 —— 所以收集所有带 node_modules 的祖先，
   *  优先挑带"仓库根标记"的（node_modules/.pnpm 存在，或含 examples/jsonrpc-agent/cordis.yml），
   *  都没有再回退最外层那个；全无返回 ''。
   *  tsx / @deepseek-ai/* 都靠这个根的 node_modules 解析，向导拿它当 runCwd / 推导 tsconfig / config。 */
  private _dshRepoRootFromEntry(entry: string): string {
    let dir = path.dirname(entry);
    let outermost = '';
    let marked = '';
    for (let i = 0; i < 8; i++) {
      if (this._exists(path.join(dir, 'node_modules'))) {
        outermost = dir;
        if (
          !marked &&
          (this._exists(path.join(dir, 'node_modules', '.pnpm')) ||
            this._exists(path.join(dir, 'examples', 'jsonrpc-agent', 'cordis.yml')))
        ) {
          marked = dir;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return marked || outermost;
  }

  /** 原生单选文件选择器：返回 fsPath，取消返回 undefined。
   *  defaultUri 取第一个「存在」的目录（可为空数组 → 落 os.homedir()），不在各机器硬编码 DSH 位置。 */
  private async _pickDshFile(opts: {
    title: string;
    openLabel: string;
    filters?: Record<string, string[]>;
    defaultCandidates: string[];
  }): Promise<string | undefined> {
    const dir = opts.defaultCandidates.find((p) => {
      try {
        return !!p && fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      title: opts.title,
      openLabel: opts.openLabel,
      filters: opts.filters,
      defaultUri: dir ? vscode.Uri.file(dir) : vscode.Uri.file(os.homedir()),
    });
    return picked && picked[0] ? picked[0].fsPath : undefined;
  }

  /** 工具真实工作目录（bash/fs 工具从这里起步）：工作区根，否则用户主目录。 */
  private _dshCwd(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : os.homedir();
  }

  /** 子进程 spawn 的 cwd：便携运行时 = 运行时目录本身；否则保证 tsx / @deepseek-ai/* 能解析（默认 DSH 仓库根）。 */
  private _dshRunCwd(): string {
    const runtime = this._runtime();
    if (runtime?.ok) return runtime.dir;
    const conf = this._dshConfig();
    return String(conf.get('runCwd') ?? '').trim() || this._dshCwd();
  }

  private _dshProvider(): string {
    const conf = this._dshConfig();
    return String(conf.get('provider') ?? DEFAULT_DSH_PROVIDER).trim() || DEFAULT_DSH_PROVIDER;
  }

  private _dshModel(): string {
    // 配置条里选过的模型优先（globalState），否则回退 hello.dsh.model → 内置默认
    const saved = this._globalState.get<string>(LIVE_MODEL_KEY);
    if (saved && saved.trim()) return saved.trim();
    const conf = this._dshConfig();
    return String(conf.get('model') ?? DEFAULT_DSH_MODEL).trim() || DEFAULT_DSH_MODEL;
  }

  private _dshInitParams(): { cwd: string; provider: string; model: string } {
    return { cwd: this._dshCwd(), provider: this._dshProvider(), model: this._dshModel() };
  }

  /** 子进程环境：继承宿主 + DSH_* / TSX 相关覆盖 + 已解析的 API key。不含明文密钥日志。 */
  private _dshEnv(): NodeJS.ProcessEnv {
    const conf = this._dshConfig();
    const env: NodeJS.ProcessEnv = { ...process.env };

    // C1：审批就绪时这里下发的是"派生配置"（用户原文 + hooks 插件块），否则就是用户原配置
    const configFile = this._effectiveConfigPath();
    if (configFile) env.DSH_CORDIS_CONFIG = configFile;

    // 便携运行时是打包好的纯 JS，不经过 tsx —— 别给它塞无意义的 tsconfig 环境变量
    const tsconfig = String(conf.get('tsconfig') ?? '').trim();
    if (tsconfig && !this._runtime()?.ok) env.TSX_TSCONFIG_PATH = tsconfig;

    // 会话落盘到 globalStorage（绝不落工作区 ./ 造成污染）。
    // C7：根目录走 `_dshRoot()` —— 同一条路径既决定子进程往哪写，也决定彻底删除时去哪删，
    // 两份字面量复制迟早会漂移，而那意味着「删不到」或更糟。
    const sessionRoot = this._dshRoot();
    try {
      fs.mkdirSync(sessionRoot, { recursive: true });
    } catch {
      /* 目录建不出来就不强制设置 */
    }
    env.DSH_SESSION_ROOT = sessionRoot;
    env.DSH_CWD = this._dshCwd();

    const key = this._apiKeyCache || '';
    if (key) env.DEEPSEEK_API_KEY = key;
    return env;
  }

  /**
   * 组装 spawn 请求。三种模式，优先级从高到低：
   * - `hello.dsh.command` 非空 → 整段覆盖（command + args）；
   * - `hello.dsh.runtimeDir` 指向一个合法的便携运行时 → 包内 node 跑纯 JS 入口（**不加 loader**）；
   * - 否则按 nodePath + [--import loader] + entry + config 拼（开发者路径）。
   */
  private _makeSpawnRequest(): DshSpawnRequest {
    const conf = this._dshConfig();
    const override = String(conf.get('command') ?? '').trim();
    const env = this._dshEnv();
    const cwd = this._dshRunCwd();
    if (override) {
      return {
        command: override,
        args: (conf.get<string[]>('args') ?? []).slice(),
        cwd,
        env,
      };
    }

    const runtime = this._runtime();
    if (runtime) {
      // 指了运行时目录但不可用 → 报错。绝不退回 nodePath：那会让用户以为自己在跑便携包
      if (!runtime.ok) throw new Error(runtime.problem);
      return { command: runtime.node, args: [runtime.entry, runtime.config], cwd, env };
    }

    const nodePath = String(conf.get('nodePath') ?? '').trim();
    const entry = String(conf.get('entry') ?? '').trim();
    if (!nodePath || !entry) {
      throw new Error('DSH 未配置：请设置 hello.dsh.runtimeDir（便携运行时），或 hello.dsh.nodePath + hello.dsh.entry，或直接设 hello.dsh.command。');
    }
    const loader = this._dshLoader(entry);
    const configFile = this._effectiveConfigPath();
    const args: string[] = [];
    if (loader) args.push('--import', loader);
    args.push(entry);
    if (configFile) args.push(configFile);
    return { command: nodePath, args, cwd, env };
  }

  /** 懒创建常驻 runtime（子进程真正 spawn 在首个请求到来时）。 */
  private _getRuntime(): DshRuntime {
    if (!this._dsh) {
      const debug = this._dshConfig().get<boolean>('debug') === true;
      this._dsh = new DshRuntime(
        () => this._makeSpawnRequest(),
        {
          onStatus: (f) => this._onDshStatus(f),
          onEvent: (f) => this._onDshEvent(f),
          onExit: (code) => this._onDshExit(code),
          onLog: (line) => console.log('[dsh-runtime]', line),
        },
        debug
      );
    }
    return this._dsh;
  }

  /**
   * API key：SecretStorage 优先，未存则回退读 `credentialsFile`（YAML 键值）。
   * 解析结果只缓存在内存、只注入子进程 env —— **任何日志 / 转写都不该出现它的值**。
   */
  private async _resolveApiKey(): Promise<string | undefined> {
    if (this._apiKeyCache !== undefined) return this._apiKeyCache || undefined;
    let key: string | undefined;
    try {
      key = (await this._secrets.get(API_KEY_SECRET_KEY)) ?? undefined;
    } catch {
      key = undefined;
    }
    if (!key) key = this._readCredentialsFile();
    this._apiKeyCache = key ?? '';
    return key;
  }

  private _readCredentialsFile(): string | undefined {
    const conf = this._dshConfig();
    const file = String(conf.get('credentialsFile') ?? '').trim();
    if (!file) return undefined;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = text.match(/^\s*DEEPSEEK_API_KEY\s*[:=]\s*(.+?)\s*$/m);
      if (!m || !m[1]) return undefined;
      const v = m[1].trim();
      const unquoted =
        v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          ? v.slice(1, -1)
          : v;
      return unquoted || undefined;
    } catch {
      return undefined;
    }
  }

  /** 把 DSH 连接状态 + busy 广播给 webview（顶栏 harness 状态点 / busy 锁的唯一真相）。 */
  private _postBackendStatus(): void {
    const busy = this._liveRunning;
    this._post({
      type: 'backend-status',
      state: this._backendState,
      model: this._backendModel,
      detail: this._backendDetail,
      busy,
    });
    this._postLiveConfig(); // 顺带刷新配置条（模型/预设/API 灯）
  }

  /** 把配置条状态广播给 webview：当前模型 + 可选预设 + API key / DSH 路径是否已配。 */
  private _postLiveConfig(): void {
    const model = this._dshModel();
    const models = PRESET_MODELS.includes(model) ? PRESET_MODELS : [model, ...PRESET_MODELS];
    this._post({
      type: 'live-config',
      model,
      models,
      apiConfigured: this._apiKeyCache !== undefined && this._apiKeyCache !== '',
      dshConfigured: this._dshConfigured(),
    });
  }

  /** 若 key 尚未解析，先试一次（SecretStorage → 回退文件），再重广播配置条（点亮 API 灯）。 */
  private async _refreshApiKeyStatus(): Promise<void> {
    if (this._apiKeyCache === undefined) {
      try {
        await this._resolveApiKey();
      } catch {
        /* 解析失败就按"未配置"显示 */
      }
      this._postLiveConfig();
    }
  }

  // ---------- 附件 ----------

  /** 「+附件」→ 系统文件选择器；选中即读取，结果发给 webview 加入待发送列表。 */
  private async _pickFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: '添加到会话',
      title: '选择要添加到会话的文件',
    });
    if (!picked || picked.length === 0) return;
    const attachments: Attachment[] = picked.map((uri) => this._readFileAttachment(uri.fsPath));
    this._post({ type: 'files-picked', attachments });
  }

  /** 把 FileRef 列表解析成最终 Attachment：已有内容就校验截断；只有路径就现读。 */
  private _resolveAttachments(refs: FileRef[]): Attachment[] {
    const out: Attachment[] = [];
    for (const r of refs) {
      const name = r.name || (r.path ? path.basename(r.path) : '（未命名文件）');
      let att: Attachment;
      if (r.path && r.content === undefined) {
        att = this._readFileAttachment(r.path);
      } else {
        att = { name };
        if (r.path) att.path = r.path;
        if (r.content !== undefined) {
          att.content = r.content;
          if (att.content.length > MAX_CONTENT_CHARS) {
            att.content = att.content.slice(0, MAX_CONTENT_CHARS);
            att.truncated = true;
          }
        } else {
          att.readError = '没有可用的文件内容';
        }
      }
      if (r.selection) att.selection = true; // 选区标记透传：组包时落成 @临时文件 chip（气泡干净）
      out.push(att);
    }
    return out;
  }

  /** 按路径读文件为附件：超大的不读、超长的截断、异常给 readError。 */
  private _readFileAttachment(filePath: string): Attachment {
    const name = path.basename(filePath);
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) {
        return { name, path: filePath, readError: '不是文件' };
      }
      if (st.size > MAX_FILE_BYTES) {
        return { name, path: filePath, readError: `文件过大（>${MAX_FILE_BYTES / 1024}KB），未读取` };
      }
      let content = fs.readFileSync(filePath, 'utf8');
      let truncated = false;
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS);
        truncated = true;
      }
      return { name, path: filePath, content, truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, path: filePath, readError: `读取失败：${message}` };
    }
  }

  /** 若整行文本能解析成一个真实存在的文件路径，返回其绝对路径；否则 undefined。 */
  private _pathFromLine(line: string): string | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    // 允许带引号的路径（含空格）
    const candidate =
      trimmed.length >= 2 &&
      ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1)
        : trimmed;
    // 排除明显是普通句子的行（含尖括号/问号等不像路径的字符）
    if (/[<>]/.test(candidate)) return undefined;

    if (this._isReadableFile(candidate)) return candidate;

    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      for (const f of folders) {
        const abs = path.join(f.uri.fsPath, candidate);
        if (this._isReadableFile(abs)) return abs;
      }
    }
    return undefined;
  }

  private _isReadableFile(p: string): boolean {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  /** 给 chat 模式的产出器拼 prompt：正文在前，每个附件按 <file> 包裹路径与内容。 */
  private _buildPrompt(text: string, attachments: Attachment[]): string {
    const parts: string[] = [];
    if (text) parts.push(text);
    for (const a of attachments) {
      const loc = a.path ? ` path="${a.path}"` : '';
      const err = a.readError ? ` error="${a.readError}"` : '';
      const body = a.readError ? '' : (a.content ?? '');
      const tail = a.truncated ? '\n…（内容过长，已截断）' : '';
      parts.push(`<file name="${a.name}"${loc}${err}>\n${body}${tail}\n</file>`);
    }
    return parts.join('\n\n');
  }

  // ---------- 会话：切换 / 删除 / 列表 ----------

  /** 安全中止当前正在跑的流/整轮：半截助手消息标 interrupted，running 工具卡落 error。 */
  private _cancelActiveRun(): void {
    // C1：切会话/切模式/新建对话都会走到这里，挂起的审批一律取消（放到早返回之前，宁可多清）
    this._approval?.cancelAll();
    const ctrl = this._abort;
    if (!ctrl) return;
    const msg = this._runningMsg;
    ctrl.abort();
    if (msg && msg.status === 'streaming') {
      msg.status = 'interrupted';
    }
    // 工具卡的"running"残留一并清掉，避免 snapshot 回放时转圈（未知，不是失败 —— 同 _finishTurn）
    for (const m of this._active.messages) {
      if (m.role === 'tool' && m.toolState === 'running') {
        m.toolState = 'unknown';
      }
    }
    this._abort = undefined;
    this._runningMsg = undefined;
  }

  private _openSession(id: string): void {
    const target = this._store.get(id);
    if (!target || target.id === this._active.id) return;
    // C6：回收站里的会话不许被打开。真实触发路径：检索命中列表里点开某条 → 列表里把它删了
    // → 再点那条**仍在屏上**的命中（点命中不重跑检索）。不拦的话它会被设成 `_active`，
    // 接着发消息还会走 _ensureDshSession，等于给一个「已删」的会话继续烧 DSH 记忆。
    if (target.deletedAt !== undefined) {
      vscode.window.setStatusBarMessage('该会话已在回收站，先从回收站恢复', 3000);
      return;
    }

    this._cancelActiveRun();
    this._dropReview(true); // 切会话 → 清掉上一会话的审阅
    this._resetTurnUsage(); // C3a：本轮读数属于切走的那个会话
    this._persistActiveSession();

    // 新打开的会话不会再续跑任何流：残留的 streaming 一律落成 interrupted
    for (const m of target.messages) {
      if (m.status === 'streaming') {
        m.status = 'interrupted';
      }
      if (m.role === 'tool' && m.toolState === 'running') {
        // 落盘的 running = 那条 result 从没到过（进程被杀 / 窗口关掉），跑没跑完**不可知**。
        // 判成失败是谎报：会让人去重试一个可能已经生效的命令（同 _finishTurn 那条注释）
        m.toolState = 'unknown';
      }
    }
    target.updatedAt = Date.now();
    this._store.replace(target);
    this._store.persist();

    this._actives[this._mode] = target;
    // 打开历史会话后，让消息 id 序号接续既有历史：避免"重启后续聊"产生撞 id
    this._seedMsgSeq();
    this._postSnapshot();
    this._sendHistory();
  }

  /**
   * 「在新对话中分支」（真 DSH ChatView 轮尾动作栏的分支按钮触发）：把当前 harness
   * 会话深拷贝出一份新会话（保留全部转写）并切换过去。新会话继续发消息即进入 DSH
   * 会话的下一轮；因分支与源会话共享同一 DSH 会话映射，模型记忆无缝延续（各 UI 会话
   * 只展示自己的转写）。用户已在设计时拍板采用该"同记忆"语义。
   */
  private _forkSession(): void {
    if (this._mode !== 'harness') return; // 分支按钮只在 harness 的真 ChatView 里存在
    if (this._liveRunning || this._abort) {
      vscode.window.setStatusBarMessage('等本轮结束后再分支', 3000);
      return;
    }
    const src = this._active;
    if (src.messages.length === 0) return;

    // 深拷贝转写（ChatMessage 是纯 JSON 字段）；克隆副本防与源会话未来互染
    const messages = JSON.parse(JSON.stringify(src.messages)) as ChatMessage[];
    const firstUser = messages.find((m) => m.role === 'user');
    const fork = this._store.create(
      src.title
        ? src.title + '（分支）'
        : firstUser
          ? titleFromText(firstUser.text)
          : ''
    );
    fork.messages = messages;
    fork.updatedAt = Date.now();
    // C3a：分支**继承**用量累计。它保留了整份转写、且下面复用同一个 DSH 会话，
    // 清零会让"刚分完支就显示本会话 0 token"读起来像 bug。代价是两个会话各显示同一份
    // 累计（是副本不是分割）—— 这是有意为之。
    fork.usage = src.usage;

    this._dropReview(true); // 切会话 → 清掉上一会话的审阅（同 _openSession 惯例）
    this._resetTurnUsage(); // C3a：本轮读数属于切走的那个会话
    this._store.add(fork); // fork 已有内容 → 立即上历史列表
    this._persistActiveSession(); // 归档源会话并落盘（fork 此时已在列，一并写入）

    // C5：分支**继承**源会话的 DSH 身份，这样「分支共享同一份 DSH 记忆」在 host 重启之后依然成立。
    // （只挂在 _dshSessions 这个缓存上是不够的 —— 缓存活不过重载，重载后 fork 会另铸 id、记忆断掉。）
    fork.dsh = src.dsh;
    // 记忆延续：分支共享源 DSH 会话 → 后续 _ensureDshSession 直接复用、不插"失忆"note
    const srcDshId = this._dshSessions.get(src.id);
    if (srcDshId) {
      this._dshSessions.set(fork.id, srcDshId);
    }

    this._actives[this._mode] = fork;
    this._seedMsgSeq(); // 续接消息 id 尾号，防撞 id
    this._postSnapshot();
    this._sendHistory();
  }

  /**
   * C6：删除 = **软删除**，进回收站，可恢复。
   *
   * 软删不打确认（可撤销，弹条反而碍事）；真正不可逆的是 `_purgeSession` / `_purgeTrash`。
   * 这里**不动 `_dshSessions`** —— 回收站期间 DSH 记忆保持可用，恢复后重开还接得上。
   */
  private _trashSession(id: string): void {
    const isActive = this._active.id === id;
    if (isActive) {
      this._cancelActiveRun();
    }
    if (!this._store.softDelete(id)) {
      this._sendHistory(); // 状态没变（已被别处删掉）→ 至少把列表刷成真实状态
      return;
    }
    this._store.persist();

    if (isActive) {
      this._dropReview(true); // 删的是当前会话 → 一并清掉审阅
      this._resetTurnUsage(); // C3a：连同被删会话的本轮读数一起清掉
      this._actives[this._mode] = this._store.create();
      this._postSnapshot();
    }
    this._sendHistory();
  }

  /** C6：从回收站恢复。**不自动切过去** —— 恢复是「放回列表」，不是「打开」，别把用户正在看的会话换掉。 */
  private _restoreSession(id: string): void {
    if (!this._store.restore(id)) {
      this._sendHistory();
      return;
    }
    this._store.persist();
    this._sendHistory();
  }

  /**
   * C7：模态里那句补充说明 —— 说清**这一次点下去到底会删掉什么**。
   *
   * 三种情形给的承诺不同，含糊过去就是骗人：没跑过 harness 的会话盘上**压根没有**日志；
   * 分支共享的会话**不会**被连坐（引用计数拦着）；只有独占的才把日志一起带走。
   * 在 `await` **之前**算好 —— 弹窗期间列表可能变（沿用 C6 捕获计数的惯例）。
   */
  private _purgeDetail(s: StoredSession): string | undefined {
    if (!s.dsh) {
      return undefined;
    }
    return this._dshStillReferenced(s.dsh, s.id)
      ? '此会话与它的分支共享同一份 DSH 记忆日志，日志会保留。'
      : '转写与它在磁盘上的 DSH 记忆日志会一并删除。';
  }

  /** C6：彻底删除单条（不可撤销）→ 先弹原生模态。 */
  private async _purgeSession(id: string): Promise<void> {
    const target = this._store.get(id);
    if (!target || target.deletedAt === undefined) {
      this._sendHistory();
      return;
    }
    const name = target.title || '（无标题）';
    const detail = this._purgeDetail(target);
    const picked = await vscode.window.showWarningMessage(
      `彻底删除「${name}」？此操作不可撤销。`,
      detail ? { modal: true, detail } : { modal: true },
      '彻底删除'
    );
    if (picked !== '彻底删除') {
      return;
    }
    this._purgeOne(id);
    this._store.persist();
    this._sendHistory();
  }

  /** C6：清空回收站（不可撤销）。条数取**点击那一刻**的 —— await 期间新删的会被一并清掉。 */
  private async _purgeTrash(): Promise<void> {
    const doomed = this._store.trashed();
    if (doomed.length === 0) {
      return;
    }
    const picked = await vscode.window.showWarningMessage(
      `清空回收站里的 ${doomed.length} 个会话？此操作不可撤销。`,
      {
        modal: true,
        // C7：逐条承诺做不到（批量），但得说清**默认会连日志一起删** —— 唯一的例外是仍被分支引用的那些。
        detail: '转写与它们在磁盘上的 DSH 记忆日志会一并删除（仍被分支引用的除外）。',
      },
      '清空回收站'
    );
    if (picked !== '清空回收站') {
      return;
    }
    for (const s of doomed) {
      this._purgeOne(s.id);
    }
    this._store.persist();
    this._sendHistory();
  }

  /**
   * C7 留存天数。**每次现读、绝不缓存**（与 `_reviewChangesOn()` 同一惯例）——
   * 用户把设置改成 0 之后不必重载窗口就能失效。
   *
   * 非法值 / 负数一律归 0 = 关闭：真正的判据闸门在 `isExpired()` 里，这里只做读取与兜底。
   */
  private _retentionDays(): number {
    const raw = vscode.workspace.getConfiguration('hello.chat').get('retention.days');
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * C7：清理「在回收站里放了超过留存天数」的会话（不可撤销）。
   *
   * **只清回收站里的**。同一条判据只在扩展侧算一次，webview 只负责显示条数
   * （`history-update.retention`）—— 让第二处重算判据早晚会漂移，而这里漂移的代价是**删错东西**。
   *
   * 模态**额外报告**在列会话里有多少条也一样久没动：它们本次**不动**，但必须让用户看见，
   * 否则他会以为这个按钮把整个库都瘦身了。
   */
  private async _purgeExpired(): Promise<void> {
    const days = this._retentionDays();
    if (days <= 0) {
      return; // 0 = 关闭。按钮本该是隐藏的，走到这里说明 webview 状态过期了 —— 静默吞掉。
    }
    const now = Date.now();
    // ⚠️ 条数与名单取**点击那一刻**的（await 期间列表还在变）
    const doomed = this._store.expired(days, now);
    if (doomed.length === 0) {
      this._sendHistory(); // 让按钮回到「没有可清理的」状态
      return;
    }
    const stale = this._store.active().filter((s) => now - s.updatedAt > days * RETENTION_DAY_MS).length;
    const picked = await vscode.window.showWarningMessage(
      `清理 ${doomed.length} 个在回收站里放了超过 ${days} 天的会话？此操作不可撤销。`,
      {
        modal: true,
        detail:
          '转写与它们在磁盘上的 DSH 记忆日志会一并删除（仍被分支引用的除外）。' +
          (stale > 0 ? `\n另有 ${stale} 个在列会话也超过 ${days} 天没动，本次不动。` : ''),
      },
      // 复用与 C6 同一个字面量：两处各写一个，将来谁改了文案按钮就**静默**失效
      '彻底删除'
    );
    if (picked !== '彻底删除') {
      return;
    }
    for (const s of doomed) {
      this._purgeOne(s.id);
    }
    this._store.persist();
    this._sendHistory();
  }

  /**
   * C7：彻底删一条的真动作 —— 从存储摘掉 + 清掉内存里的 DSH 身份缓存 + **删掉磁盘上的 DSH 日志**。
   *
   * ⚠️ 顺序是承重的：`dsh` 必须在 `purge()` **之前**读。purge 把对象摘出数组后 `get(id)` 就返回
   * undefined 了，`{id, cwd}` 再也拿不到 —— 日志会被**静默**漏删，而这正是 C7 的验收项
   * 「删除后磁盘无残留」。
   */
  private _purgeOne(id: string): void {
    const dsh = this._store.get(id)?.dsh;
    if (!this._store.purge(id)) {
      return;
    }
    this._dshSessions.delete(id);
    if (!dsh || this._dshStillReferenced(dsh, id)) {
      return;
    }
    const r = removeDshSessionDir(this._dshRoot(), dsh.cwd, dsh.id);
    if (!r.removed && r.reason !== 'missing') {
      // missing 是正常的（该会话从没在盘上落过日志）；其余情况说明日志**没删掉**，得让人能看见。
      console.warn('C7：DSH 日志未清理 ——', id, r.reason, r.detail ?? '');
    }
  }

  /**
   * C7：还有**别的**会话引用这份 DSH 日志吗？（判据本体在 `sessionStore.dshStillReferenced`，
   * 与自检共用一份 —— 这里只负责把**两个 store 都**拼进来。）
   *
   * **两个 store 都要扫**：依据是引用关系，不是「这条会话住在哪个库」。
   * 逐条判定而不是批量开工前算一次：一对共享会话都被清空时，日志恰好被删一次。
   */
  private _dshStillReferenced(dsh: { id: string; cwd: string }, excludingId: string): boolean {
    return dshStillReferenced([...this._stores.chat.all(), ...this._stores.harness.all()], dsh, excludingId);
  }

  /** C7：DSH 会话日志根目录。`_dshEnv` 与实际删除**共用这一处** —— 两份表达式迟早会漂移。 */
  private _dshRoot(): string {
    return path.join(this._storageDir, 'dsh-sessions');
  }

  /**
   * C6：单会话导出。先选格式（**不用扩展名反推** —— `path.extname('讨论 v1.2')` 返回 `.2`
   * 不是空串，那条路上「没有扩展名」的分支根本进不去），再弹保存对话框。
   */
  private async _exportSession(id: string): Promise<void> {
    const target = this._store.get(id);
    if (!target) {
      return;
    }
    // 对话框是 await 的，期间活动会话还在被流式追加 → 先把这一刻的转写冻下来
    const frozen = JSON.parse(JSON.stringify(target)) as StoredSession;

    const fmt = await vscode.window.showQuickPick(
      [
        { label: 'Markdown', detail: '给人看的转写（表格/代码围栏；超长工具输出会截断）', ext: 'md' },
        { label: 'JSON', detail: '无损转储（含附件正文与用量；将来可重新导入）', ext: 'json' },
      ],
      { title: '导出为什么格式？', placeHolder: 'Markdown' }
    );
    if (!fmt) {
      return;
    }

    const defaultName = suggestedFileName(frozen, fmt.ext);
    const picked = await vscode.window.showSaveDialog({
      title: '导出会话',
      saveLabel: '导出',
      defaultUri: vscode.Uri.file(path.join(this._dshCwd(), defaultName)),
      filters: fmt.ext === 'md' ? { Markdown: ['md'] } : { JSON: ['json'] },
    });
    if (!picked) {
      return;
    }

    const text = fmt.ext === 'md' ? sessionToMarkdown(frozen) : sessionToJson(frozen);
    try {
      // 用 workspace.fs 而不是 fs.writeFileSync：只读路径、远端盘符交给 VS Code 报错，别自己炸
      await vscode.workspace.fs.writeFile(picked, Buffer.from(text, 'utf8'));
    } catch (err) {
      void vscode.window.showErrorMessage(`导出失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    void vscode.window
      .showInformationMessage(`已导出：${path.basename(picked.fsPath)}`, '打开')
      .then((act) => {
        if (act === '打开') {
          void vscode.window.showTextDocument(picked);
        }
      });
  }

  /** C6：全文检索。同步返回 —— 见 `_onMessage` 里那条 case 的注释。 */
  private _searchSessions(query: string, seq: number): void {
    const hits = searchSessions(this._store.all(), query);
    this._post({ type: 'search-results', seq, query, hits });
  }

  /**
   * 重命名当前会话。规则统一：
   * - 给了名字 → 用它；
   * - 给空名字（用户清空）→ 视为"未编辑"，回退成第一条消息做默认标题。
   * 会话有内容才入库/上列表/持久化；空会话只记在内存（反正还没进列表）。
   */
  private _renameSession(rawTitle: string): void {
    const trimmed = rawTitle.trim();
    const firstUserMsg = this._active.messages.find((m) => m.role === 'user');
    this._active.title = trimmed
      ? trimmed
      : firstUserMsg
        ? titleFromText(firstUserMsg.text)
        : '';

    if (this._active.messages.length > 0) {
      this._store.replace(this._active);
      this._store.persist();
      this._sendHistory(); // 让历史下拉框立即显示新名字
    }
  }

  /** C6：列表与回收站一起下发。「哪些会话该出现在列表里」的规则只在 `SessionStore.active()` 里
   *  —— 从前这里有第二份内联 filter，两份必然漏改一处，已删掉。 */
  private _sendHistory(): void {
    const summary = (s: StoredSession): SessionSummary => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      deletedAt: s.deletedAt,
    });
    const sessions = this._store
      .active()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summary);
    const trashed = this._store
      .trashed()
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .map(summary);
    // C7：留存天数与「有几条过期」一并下发 —— webview 只显示，**判据只在这一处算**。
    // days 为 0（关闭）时 count 恒为 0：按钮据此隐藏/禁用。
    const days = this._retentionDays();
    this._post({
      type: 'history-update',
      sessions,
      trashed,
      activeId: this._active.id,
      retention: { days, count: days > 0 ? this._store.expired(days).length : 0 },
    });
  }

  // ---------- 工具 ----------

  /** 一轮回复结束（含被中止）后把 active 会话写盘。 */
  private _afterTurn(): void {
    if (this._active.messages.length === 0) return;
    this._active.updatedAt = Date.now();
    this._store.replace(this._active);
    this._store.persist();
  }

  // ---------- 1.1 发送自动附选区 ----------

  /** 开关：每次发送现读（不缓存，改了立刻生效，无需 onDidChangeConfiguration）。 */
  private _autoAttachSelectionOn(): boolean {
    return vscode.workspace.getConfiguration('hello.chat').get<boolean>('autoAttachSelection', true);
  }

  /**
   * 当前活动编辑器的选区附件引用；不满足条件（开关关 / 非 harness / 无工作区 / 非 file /
   * 无选区 / 空选区文本）返回 undefined。content 直接取编辑器缓冲 → dirty 未保存也带上。
   */
  private _activeSelectionRef(): FileRef | undefined {
    if (!this._autoAttachSelectionOn()) return undefined;
    if (this._mode !== 'harness') return undefined;
    if (!vscode.workspace.workspaceFolders) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const doc = editor.document;
    if (doc.uri.scheme !== 'file') return undefined;
    const sel = editor.selection;
    if (sel.isEmpty) return undefined;
    const content = doc.getText(sel);
    if (!content) return undefined;
    // content 取编辑器缓冲（dirty 未保存也含），wire 一并发给 agent —— 它不能替用户读编辑器。
    return { name: path.basename(doc.fileName), path: doc.fileName, content, selection: true };
  }

  /** 1.1 选区注入的内联摘录（**仅作临时文件写盘失败时的兜底**）：把选中文本放进独立代码块
   *  （行/字符双上限截断）。正常路径已改为 @临时文件 chip（气泡干净）；只有临时文件写不出来
   *  才回退到这里，宁可气泡露出代码块也不让 agent 丢掉内容。 */
  private _selectionExcerpt(a: Attachment): string {
    const content = a.content ?? '';
    const allLines = content.split('\n');
    const totalLines = allLines.length;
    const reasons: string[] = [];
    let snippet = content;
    if (totalLines > SNIPPET_LINE_CAP) {
      snippet = allLines.slice(0, SNIPPET_LINE_CAP).join('\n');
      reasons.push(`选区共 ${totalLines} 行，仅展示前 ${SNIPPET_LINE_CAP} 行`);
    }
    if (snippet.length > SNIPPET_CHAR_CAP) {
      snippet = snippet.slice(0, SNIPPET_CHAR_CAP);
      reasons.push('内容超长已截断');
    }
    if (a.truncated) reasons.push('原文超出单条上限');
    // 摘录放进代码围栏：优先 ```，内容自身带 ``` 就换 ~~~，再不行就不围栏（防围栏被内容打断）
    const fence = !snippet.includes('```') ? '```' : !snippet.includes('~~~') ? '~~~' : '';
    let out = `编辑器选中的代码（共 ${totalLines} 行）：`;
    out += fence
      ? `\n${fence}\n${snippet}\n${fence}`
      : `\n${snippet}`;
    if (reasons.length > 0) {
      out += `\n（${reasons.join('；')}）`;
    }
    return out;
  }

  /** 1.1 把选中文本落成只读临时文件（内容 = 编辑器缓冲原文，dirty 未保存也准），返回其绝对路径；
   *  发给 agent 的 `@"路径"` chip 指向它 —— 气泡里只有 chip + 用户的话，agent 打开文件即可读到
   *  确切的选中行。文件名 = 原文件名 + `·选区`（chip 上仍看得出是哪个文件）。写盘失败 → undefined，
   *  调用方回退内联摘录。
   *
   * 位置：优先工作区根下的 `.hello-chat/selection-attach`（DSH agent 与工作区同盘、能直接读 d:\…
   *  路径；该目录已被快照忽略，绝不当成 agent 改动出现在 2.1 审阅里）。放 C:\ globalStorage 会被
   *  证明读不到 —— agent 曾为读到它把文件复制进工作区，制造出幽灵改动。无工作区才回退 globalStorage。 */
  private _writeSelectionTmp(a: Attachment): string | undefined {
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const dir = root
        ? path.join(root, '.hello-chat', 'selection-attach')
        : path.join(this._storageDir, 'selection-attach');
      fs.mkdirSync(dir, { recursive: true });
      this._sweepSelectionTmp(dir); // 顺带清掉过期文件，防堆积
      const target = path.join(dir, `${a.name}·选区`);
      fs.writeFileSync(target, a.content ?? '', 'utf8');
      return target;
    } catch {
      return undefined;
    }
  }

  /** 清掉 selection-attach 目录里超过存活期的临时文件（agent 通常只在当轮读它；留多轮窗口防
   *  会话续聊引用失效）。目录不存在 / 单文件删除失败都静默忽略。 */
  private _sweepSelectionTmp(dir: string, maxAgeMs = 6 * 3600 * 1000): void {
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        try {
          const p = path.join(dir, f);
          if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
        } catch {
          /* 单个文件 stat/unlink 失败忽略 */
        }
      }
    } catch {
      /* 目录不存在等忽略 */
    }
  }

  // ---------- 2.1 每轮 DSH 改动审阅（快照 / 对比 / 动作） ----------

  /** 开关：每轮结束后生成审阅（现读，默认开）。 */
  private _reviewChangesOn(): boolean {
    return vscode.workspace.getConfiguration('hello.chat').get<boolean>('reviewChanges', true);
  }

  /** 审阅快照根 = 打开的工作区根 folder[0]（agent 改的就是它）。无文件夹 → 本轮不审（绝不快照 homedir）。 */
  private _reviewRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * 轮首：清上一轮审阅 + 快照当前工作区根（同步取盘，快照点必须在一切 await 之前）。
   * 工作区外目标的根**这里不建** —— 它们由 C4 在 PreToolUse 路径上、真执行之前逐个补进
   * `_reviewRoots`（见 `_onApprovalObserved`）。所以「工作区根快照 abort / 没有工作区文件夹」
   * 不等于本轮无审阅，别在这里提前 return 掉那半。
   */
  private _captureBaselineAtTurnStart(): void {
    this._reviewSeq += 1;
    // 重新赋值一个新 Map（而不是 clear）：对比那边靠**引用相等**判断「还是不是本轮」
    this._reviewRoots = new Map();
    this._pendingReview = [];
    this._post({ type: 'review-clear' }); // 新一轮开始 → 隐去上轮审阅条
    const root = this._reviewRoot();
    if (!root || !this._reviewChangesOn()) return;
    const shot = snapshotTree(root);
    if ('aborted' in shot) return; // 目录过大/根不可读 → 工作区那半本轮无审阅（区外那半照常）
    this._reviewRoots.set(root, { kind: 'tree', root, snap: shot });
  }

  /** 清掉本轮审阅内存；doPost 时通知 webview 隐藏审阅条/面板。 */
  private _dropReview(doPost: boolean): void {
    this._reviewSeq += 1;
    this._reviewRoots = new Map();
    this._pendingReview = [];
    if (doPost) {
      this._post({ type: 'review-clear' });
    }
  }

  /**
   * 轮 done 后（finally 里）调用：退栈再异步对比，token 失配即静默丢（防新一轮/清理交错）。
   *
   * **捕获的是 Map 的引用**：工作区根快照 abort（巨型工作区）或没开工作区文件夹时，本轮开局
   * map 就是空的，区外根要到轮中才由 `_onApprovalObserved` 逐个补进来 —— 而那正是最需要
   * 看见越界改动的人。所以判空放在退栈之后，且判的是**捕获到的那个** map。
   */
  private _scheduleReviewAfterTurn(): void {
    const mySeq = this._reviewSeq;
    const roots = this._reviewRoots;
    void (async () => {
      // 重活不在 _finishTurn/_runLive 的同步路径上做
      await new Promise<void>((r) => setImmediate(r));
      if (this._reviewSeq !== mySeq || this._reviewRoots !== roots) return;
      if (roots.size === 0) return; // 到这儿还空 = 本轮真的没得看
      const pending: PendingReview[] = [];
      // 逐根重快照；单个根 abort 只跳过它自己，不影响其余根
      for (const r of roots.values()) {
        const afterShot = r.kind === 'tree' ? snapshotTree(r.root) : snapshotSingleFile(r.root, r.target!);
        if ('aborted' in afterShot) continue;
        for (const change of compareTrees(r.snap, afterShot)) {
          pending.push({ id: `rv${++this._reviewIdSeq}`, root: r, change });
        }
      }
      if (pending.length === 0) return;
      this._pendingReview = pending;
      this._postReviewSet();
    })();
  }

  /** 把 pending 改动整理成 webview DTO（行级 diff + 跨文件字节护栏）推给前端。 */
  private _postReviewSet(): void {
    const out: ReviewChange[] = [];
    let budget = 200 * 1024; // 跨文件 diff 文本总护栏，防压垮 postMessage
    for (const p of this._pendingReview) {
      const ch = p.change;
      const item: ReviewChange = {
        // id 在对比时已分配并存下，这里只搬运 —— 若按 out 下标现算，每次 keep/revert 重发
        // 都会换一批 id，前端的展开态与动作会指错行
        id: p.id,
        kind: ch.kind,
        rel: ch.rel,
        name: ch.rel.slice(ch.rel.lastIndexOf('/') + 1),
        outside: p.root.outside,
        reversible: ch.reversible,
      };
      const beforeC = ch.before?.content ?? undefined;
      const afterC = ch.after?.content ?? undefined;
      // modified = 新老都预览；added 缺老侧 → 全文作新增；deleted 缺新侧（有内容）→ 全文作删除。
      // 任一内容为 undefined（二进制/超大/预算耗尽）→ 无 diff，仅列出。
      const oldText =
        ch.kind === 'modified' || ch.kind === 'deleted' ? beforeC : undefined;
      const newText =
        ch.kind === 'modified' || ch.kind === 'added' ? afterC : undefined;
      if (oldText !== undefined || newText !== undefined) {
        const r = lineDiff(oldText ?? '', newText ?? '');
        let size = 0;
        for (const l of r.lines) size += l.text.length + 1;
        if (size > 0 && size <= budget) {
          item.diff = r.lines;
          item.diffTruncated = r.truncated;
          budget -= size;
        } else if (size > 0) {
          item.diffTruncated = true; // 超出护栏 → 只列名不预览
        }
      }
      out.push(item);
    }
    this._post({ type: 'review-set', changes: out });
  }

  /** 审阅动作入口（keep/revert 单条 + keep-all/revert-all）。正在跑或本轮没算过 → 忽略。
   *  注意判空**必须看 length**：`_reviewRoots` 是 Map，拿它当布尔**恒为真**，守卫会凭空消失。 */
  private _reviewAction(action: 'keep' | 'revert' | 'keep-all' | 'revert-all', id?: string): void {
    if (this._abort || this._pendingReview.length === 0) return;

    if (action === 'keep' || action === 'keep-all') {
      // keep = 保留磁盘改动，仅从审阅里收起，不碰文件
      this._pendingReview = id
        ? this._pendingReview.filter((c) => c.id !== id)
        : [];
      if (this._pendingReview.length === 0) this._dropReview(true);
      else this._postReviewSet();
      return;
    }

    const targets = id
      ? this._pendingReview.filter((c) => c.id === id)
      : this._pendingReview.slice();
    if (targets.length === 0) return;

    const ok: PendingReview[] = [];
    const failed: { rel: string; reason: string }[] = [];
    for (const p of targets) {
      if (!p.change.reversible) {
        failed.push({ rel: p.change.rel, reason: '无轮前内容可还原（二进制/超大文件）' });
        continue;
      }
      try {
        // 还原回**它自己那个根**（区外项的工作区根完全不同）
        applyRevert(p.root.root, p.change);
        ok.push(p);
      } catch (err) {
        failed.push({ rel: p.change.rel, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (ok.length > 0) {
      this._pendingReview = this._pendingReview.filter((c) => !ok.includes(c));
      const summary =
        ok.length === 1
          ? `已还原本轮 DSH 改动：${oneLine(ok[0].change.rel, 120)}`
          : `已还原本轮 DSH 改动：${ok.length} 个文件成功`;
      this._pushNote(failed.length > 0 ? `${summary}；${failed.length} 个未还原` : summary);
    }
    if (failed.length > 0) {
      vscode.window.showErrorMessage(
        `还原失败 ${failed.length} 项：${failed
          .map((f) => `${oneLine(f.rel, 80)}（${f.reason}）`)
          .join('、')}`
      );
    }
    if (this._pendingReview.length === 0) this._dropReview(true);
    else this._postReviewSet();
  }

  /** 把一条 role:'note' 说明入列当前会话并下发（还原反馈/审批留痕；react-live 态仅在转录持久化可见）。 */
  private _pushNote(text: string): void {
    const note: ChatMessage = {
      id: this._nextMsgId(),
      role: 'note',
      text,
      status: 'done',
    };
    this._active.messages.push(note);
    this._post({ type: 'note-message', message: note });
  }

  /** 消息 id 带会话前缀，保证跨会话/跨重启仍全局唯一（避免旧流的迟到消息误伤）。 */
  private _nextMsgId(): string {
    return `${this._active.id}#${++this._msgSeq}`;
  }

  /**
   * 载入历史会话后，把消息序号种子到既有 id 的最大尾号。
   * 否则 host 重启后 `_msgSeq` 归零，「在旧对话里继续发消息」会复用到历史 id，
   * webview 的 byId 会静默覆盖旧消息 → DOM 错乱。
   */
  private _seedMsgSeq(): void {
    let max = 0;
    for (const m of this._active.messages) {
      const hash = m.id.lastIndexOf('#');
      if (hash >= 0) {
        const n = Number(m.id.slice(hash + 1));
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    this._msgSeq = max;
  }

  private _postSnapshot(): void {
    this._post({
      type: 'snapshot',
      messages: this._active.messages,
      sessionId: this._active.id,
      sessionTitle: this._active.title,
      // C3a：读数随整帧一起下发 —— 它本身就是会话级状态，跟 snapshot 同生共死，
      // 既能把重开会话的累计恢复出来，也保证"切到没有用量的会话"时细条被清掉。
      usage: this._usageReadout(),
      // C9：同理。运行记录是**纯内存**的，所以重载窗口后这里是空的 ——
      // 切会话则能立刻恢复该会话这一轮的记录（它还在环里），这是要点。
      runs: this._runsReadout(),
    });
    // C8：按钮状态跟会话走（切会话/重开会话/窗口重载后由这一条纠偏）。
    // 判据是**已落盘**的 lastTurn，所以重载窗口甚至重启 VS Code 之后按钮照常在。
    this._sendTurnState();
  }

  private _post(msg: ExtToWebview): void {
    if (this._view) {
      void this._view.webview.postMessage(msg);
    }
  }

  private _disposeViewListeners(): void {
    for (const d of this._viewDisposables) {
      d.dispose();
    }
    this._viewDisposables = [];
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
    );
    // 侧栏头部的品牌标记：拿单色 icon.svg 当遮罩（见 chat.html 的 .brand-mark）。
    // 走 img-src（CSP 已放行 cspSource），不需要额外改 CSP。
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.svg')
    );

    // 真 DSH 组件的构建产物（media/dsh-live）。缺失时置空 → webview 侧懒加载桥自动
    // 放弃 React 画面、保持既有 DOM 渲染（开发期未打包 dsh-live 也能正常用）。
    const dshLiveDir = path.join(this._extensionUri.fsPath, 'media', 'dsh-live');
    const hasDshBundle =
      fs.existsSync(path.join(dshLiveDir, 'dsh-live.js')) &&
      fs.existsSync(path.join(dshLiveDir, 'dsh-live.css'));
    this._hasDshBundle = hasDshBundle;
    const dshLiveJsUri = hasDshBundle
      ? webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'dsh-live', 'dsh-live.js')).toString()
      : '';
    const dshLiveCssUri = hasDshBundle
      ? webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'dsh-live', 'dsh-live.css')).toString()
      : '';

    const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'chat.html');
    const template = fs.readFileSync(htmlPath, 'utf8');

    // 常驻 DSH 主题令牌：产物齐全时把 dsh-live.css 以 <link> 放进 head（先于 chat.css，
    // 便于 chat.css 覆盖任何 base 默认）。缺失时整段置空 → chat.css 的双兜底变量回落 VS Code 观感。
    const dshThemeLink = hasDshBundle
      ? '<link rel="stylesheet" href="' + dshLiveCssUri + '">'
      : '';

    return template
      .replace(/%%CSP_SOURCE%%/g, webview.cspSource)
      .replace(/%%NONCE%%/g, nonce)
      .replace(/%%CSS_URI%%/g, cssUri.toString())
      .replace(/%%ICON_URI%%/g, iconUri.toString())
      .replace(/%%JS_URI%%/g, jsUri.toString())
      .replace(/%%DSH_THEME_LINK%%/g, dshThemeLink)
      .replace(/%%DSH_LIVE_JS_URI%%/g, dshLiveJsUri)
      .replace(/%%DSH_LIVE_CSS_URI%%/g, dshLiveCssUri);
  }
}
