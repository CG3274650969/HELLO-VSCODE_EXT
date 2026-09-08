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
  WebviewToExt,
} from './protocol';
import { isAbortError, streamMockReply } from './mockAssistant';
import { SessionStore, StoredSession, titleFromText } from './sessionStore';
import {
  applyRevert,
  compareTrees,
  FsSnapshot,
  lineDiff,
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
} from './dshRuntime';

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
  /** UI 会话 id → DSH sessionId（`${uiId}::${hostRand}`）；同 activation 内复用 = 真多轮记忆 */
  private readonly _dshSessions = new Map<string, string>();
  /** 每 activation 随机一次：host 重启后绝不撞上旧进程的 DSH 会话 id */
  private readonly _dshHostRand = randomBytes(4).toString('hex');
  /** live 正在跑一轮（busy / 输入锁定的扩展侧真相） */
  private _liveRunning = false;
  /** live 轮里"当前开着的"助手文字气泡（工具前文字先收尾成独立气泡的依据） */
  private _openAssistant?: ChatMessage;
  /** 当前 live 轮对应的 DSH 会话 id（事件按它过滤） */
  private _currentDshId?: string;
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
  /** 本轮审阅快照所在的工作区根（undefined = 本轮不审） */
  private _reviewRootAbs?: string;
  /** 轮首工作区快照：diff 完成后仍保留供 keep/revert 动作还原用 */
  private _baseline?: FsSnapshot;
  /** token：新一轮 / 导航清理时自增，让迟到的异步对比失效（防两轮 diff 交错） */
  private _reviewSeq = 0;
  /** 已算出、尚未被 keep/revert 处理的改动（rich 版，动作处理与还原用） */
  private _pendingReview: TreeChange[] = [];

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
    this._dropReview(false); // 清掉本轮审阅内存（视图已销毁，不必再发 clear）
    this._disposeViewListeners();
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
        if (this._pendingReview.length > 0 && this._baseline !== undefined && !this._liveRunning) {
          this._postReviewSet();
        }
        // harness 默认模式：视图每次就绪都预热到「在线/未配置」可读状态
        //（幂等；未配置时 _getRuntime 在 spawn 前抛错 → 红点显示「DSH 未配置」引导）
        if (this._mode === 'harness' && !this._liveRunning) {
          void this._connectLive();
        }
        // 尝试解析一次 API key（有则缓存），让配置条的 API 灯如实点亮
        void this._refreshApiKeyStatus();
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
      case 'pick-files':
        void this._pickFiles();
        break;
      case 'stop':
        this._abort?.abort();
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
      case 'delete-session':
        this._deleteSession(msg.sessionId);
        break;
      case 'rename-session':
        this._renameSession(msg.title);
        break;
      case 'review-keep':
        this._reviewAction('keep', msg.rel);
        break;
      case 'review-revert':
        this._reviewAction('revert', msg.rel);
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

  private _sendUser(rawText: string, refs: FileRef[] = []): void {
    if (this._abort) {
      vscode.window.showInformationMessage('上一条回复还在生成中，先等它结束或点「停止」。');
      return;
    }

    // 1) 「整行=文件路径」的行自动提升为附件（支持绝对路径 + 相对工作区根目录），
    //    其余内容保留为正文 —— 这样在输入框直接贴一行路径也能加文件。
    const fileRefs = refs.slice();
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
    const text = keptLines.join('\n').trim();

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
    this._post({ type: 'user-message', message: userMsg });
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
        this._surfaceLiveError(err instanceof Error ? err.message : String(err));
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
    if (outcome === 'done') {
      this._turnNormalDone = true; // 2.1：正常走完 → finally 里排异步改动对比
    }
    this._liveRunning = false;
    this._finalizeOpenAssistant(outcome);
    if (outcome === 'interrupted') {
      // 停止时还挂着的 running 工具卡 → error，不留转圈残留
      for (const m of this._active.messages) {
        if (m.role === 'tool' && m.toolState === 'running') {
          m.toolState = 'error';
          this._post({ type: 'tool-result', id: m.id, toolState: 'error' });
        }
      }
    }
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
        m.toolState = 'error';
        this._post({ type: 'tool-result', id: m.id, toolState: 'error' });
      }
    }
    this._backendState = 'error';
    this._backendModel = undefined;
    this._backendDetail = message;
    this._liveRunning = false;
    this._postBackendStatus();
    const resolve = this._endTurnResolve;
    this._endTurnResolve = undefined;
    resolve?.();
  }

  /**
   * UI 会话 → DSH 会话 id 的（首次）映射，并在"续聊旧历史"时插一行 note。
   * 必须在 _sendUser 把本条 user 消息入列**之后**调用（保证 note 排在其后，
   * 不会劫持 isFirst / 默认标题逻辑）。
   */
  private _ensureDshSession(): string {
    const uiId = this._active.id;
    const existing = this._dshSessions.get(uiId);
    if (existing) {
      this._currentDshId = existing;
      return existing;
    }
    const dshId = `${uiId}::${this._dshHostRand}`;
    this._dshSessions.set(uiId, dshId);
    this._currentDshId = dshId;
    // 该 UI 会话在**这个 activation**里首次发消息，且此前已有人类历史
    // （典型：host 重启后继续旧对话）。DSH 会话是全新的，模型不记得之前的内容。
    if (this._hadHistoryBeforeSend) {
      const note: ChatMessage = {
        id: this._nextMsgId(),
        role: 'note',
        text: '已开启全新 DSH 会话 —— 模型只记得本条消息之后的内容，不再拥有此前对话的记忆。',
        status: 'done',
      };
      this._active.messages.push(note);
      this._post({ type: 'note-message', message: note });
    }
    return dshId;
  }

  /** 杀掉子进程 + 清空 live 相关状态（重启换模型 / key / 路径、视图销毁时共用）。 */
  private _teardownLive(): void {
    this._dsh?.kill();
    this._dsh = undefined;
    this._connectPromise = undefined;
    this._dshSessions.clear();
    this._currentDshId = undefined;
    this._backendState = 'offline';
    this._backendModel = undefined;
    this._backendDetail = undefined;
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
   * 「配置 DSH」引导向导：用原生对话框收集 nodePath / entry，并按入口所在 DSH 仓库根推导
   * runCwd / tsconfig / config，最后 quickpick 确认、用 ConfigurationTarget.Global 写 hello.dsh.*
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
      nodePath: String(conf.get('nodePath') ?? '').trim(),
      entry: String(conf.get('entry') ?? '').trim(),
      runCwd: String(conf.get('runCwd') ?? '').trim(),
      tsconfig: String(conf.get('tsconfig') ?? '').trim(),
      config: String(conf.get('config') ?? '').trim(),
    };
    let nodePath = cur.nodePath;
    let entry = cur.entry;
    let runCwd = cur.runCwd;
    let tsconfig = cur.tsconfig;
    let config = cur.config;

    let step: 'node' | 'entry' | 'config' | 'confirm' = 'node';
    for (;;) {
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
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'node', description: nodePath || '(未设置)', enabled: false },
          { label: '入口', description: entry || '(未设置)', enabled: false },
          { label: '工作目录', description: runCwd || '(未设置 → 回退工作区根)', enabled: false },
          { label: 'tsconfig', description: tsconfig || '(未设置)', enabled: false },
          { label: '配置文件', description: config || '(未设置)', enabled: false },
          { label: '保存并重启 live', description: '把以上值写入用户设置（hello.dsh.*），随后重启 DSH 子进程' },
          { label: '重新选择 node 可执行文件', description: '' },
          { label: '重新选择入口脚本', description: '将按入口所在仓库自动推导其余路径' },
          { label: '重新选择配置文件', description: '可选，缺省按入口自动推导' },
          { label: '取消', description: '' },
        ],
        { placeHolder: '确认以上最终值（灰字为将写入的内容）', title: 'DSH 运行路径配置' }
      );

      if (!pick || pick.label === '取消') return;
      if (pick.label === '保存并重启 live') {
        const changed: Array<[string, string]> = [];
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
    if (this._currentDshId !== undefined && frame.sessionId !== this._currentDshId) return;
    if (frame.status === 'idle' && this._liveRunning) {
      // idle 可能紧随同一批 stdout 行到达；微任务里收尾，避免同 burst 双重 finalize
      queueMicrotask(() => this._finishTurn('done'));
    }
  }

  private _onDshEvent(frame: DshEventFrame): void {
    if (!this._liveRunning) return;
    if (this._currentDshId !== undefined && frame.sessionId !== this._currentDshId) return;
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
          toolInput: prettyValue(d.arguments),
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
        let failed = d.error !== undefined && d.error !== null;
        const outParts: string[] = [];
        for (const b of d.message?.content ?? []) {
          if (!b || b.type !== 'tool-result') continue;
          if (b.isError) failed = true;
          for (const c of b.content ?? []) {
            if (c && c.type === 'text' && typeof c.text === 'string') outParts.push(c.text);
          }
        }
        let output = outParts.join('\n');
        if (output.length > MAX_TOOL_OUTPUT_CHARS) {
          output = output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n…（输出过长，已截断）';
        }
        target.toolState = failed ? 'error' : 'ok';
        target.toolOutput = output;
        this._post({ type: 'tool-result', id: target.id, toolState: target.toolState, output });
        return;
      }
      case 'turn/end': {
        const reason = d.reason && typeof d.reason === 'object' ? d.reason : undefined;
        const kind = reason?.kind;
        if (kind && kind !== 'completed' && kind !== 'aborted') {
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
        // turn/start、user/message、assistant/message、agent/inbox/*、
        // reasoning-delta、tool-call-delta、subagent.* 一律忽略
        return;
    }
  }

  /**
   * tool/call 与 tool/result 对齐用的键：优先 callId。
   * call 的 callId 在 data.callId；result 的嵌在 data.message.content[0].toolCallId，
   * 两边都取不到才退而用 turn:step。
   */
  private _toolKey(d: DshEventData): string {
    let callId = d.callId;
    if (typeof callId !== 'string' || !callId) {
      const block = d.message?.content?.find((b) => b && b.toolCallId);
      if (block && typeof block.toolCallId === 'string') callId = block.toolCallId;
    }
    return typeof callId === 'string' && callId
      ? `c:${callId}`
      : `ts:${String(d.turn ?? '')}:${String(d.step ?? '')}`;
  }

  /** 子进程意外退出（非用户 kill）。live 中 → 上浮错误收尾；空闲 → 状态标 error。 */
  private _onDshExit(code: number | null): void {
    this._dsh = undefined; // 下一个 live 轮重新 spawn
    if (this._liveRunning) {
      this._surfaceLiveError(`DSH 子进程意外退出（code=${code}）`);
    } else {
      this._backendState = 'error';
      this._backendModel = undefined;
      this._backendDetail = `DSH 子进程已退出（code=${code}）`;
      this._postBackendStatus();
    }
  }

  // ----- 配置 / 子进程构建（全部来自 hello.dsh.*，可被用户覆盖） -----

  private _dshConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('hello.dsh');
  }

  /** DSH 运行路径是否已配：nodePath 与 entry 都填了才算（与 _makeSpawnRequest 的 throw 条件同构）。
   *  注：若用户走 hello.dsh.command 整段覆盖而 nodePath/entry 为空，这里会报「未配置」——可接受边缘，
   *  因为配置条引导的就是 nodePath/entry 路径本身。 */
  private _dshConfigured(): boolean {
    const conf = this._dshConfig();
    const nodePath = String(conf.get('nodePath') ?? '').trim();
    const entry = String(conf.get('entry') ?? '').trim();
    return !!(nodePath && entry);
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

  /** 子进程 spawn 的 cwd：保证 tsx / @deepseek-ai/* 能解析（默认 DSH 仓库根）。 */
  private _dshRunCwd(): string {
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

    const configFile = String(conf.get('config') ?? '').trim();
    if (configFile) env.DSH_CORDIS_CONFIG = configFile;

    const tsconfig = String(conf.get('tsconfig') ?? '').trim();
    if (tsconfig) env.TSX_TSCONFIG_PATH = tsconfig;

    // 会话落盘到 globalStorage（绝不落工作区 ./ 造成污染）
    const sessionRoot = path.join(this._storageDir, 'dsh-sessions');
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
   * 组装 spawn 请求。支持两种模式：
   * - `hello.dsh.command` 非空 → 整段覆盖（command + args）；
   * - 否则按 nodePath + --import loader + entry + config 拼（默认）。
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
    const nodePath = String(conf.get('nodePath') ?? '').trim();
    const entry = String(conf.get('entry') ?? '').trim();
    if (!nodePath || !entry) {
      throw new Error('DSH 未配置：请设置 hello.dsh.nodePath 与 hello.dsh.entry（或直接设 hello.dsh.command）。');
    }
    const loader = String(conf.get('loader') ?? '').trim() || 'tsx/esm';
    const configFile = String(conf.get('config') ?? '').trim();
    const args = ['--import', loader];
    if (entry) args.push(entry);
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
    const ctrl = this._abort;
    if (!ctrl) return;
    const msg = this._runningMsg;
    ctrl.abort();
    if (msg && msg.status === 'streaming') {
      msg.status = 'interrupted';
    }
    // 工具卡的"running"残留一并清掉，避免 snapshot 回放时转圈
    for (const m of this._active.messages) {
      if (m.role === 'tool' && m.toolState === 'running') {
        m.toolState = 'error';
      }
    }
    this._abort = undefined;
    this._runningMsg = undefined;
  }

  private _openSession(id: string): void {
    const target = this._store.get(id);
    if (!target || target.id === this._active.id) return;

    this._cancelActiveRun();
    this._dropReview(true); // 切会话 → 清掉上一会话的审阅
    this._persistActiveSession();

    // 新打开的会话不会再续跑任何流：残留的 streaming 一律落成 interrupted
    for (const m of target.messages) {
      if (m.status === 'streaming') {
        m.status = 'interrupted';
      }
      if (m.role === 'tool' && m.toolState === 'running') {
        m.toolState = 'error';
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

    this._dropReview(true); // 切会话 → 清掉上一会话的审阅（同 _openSession 惯例）
    this._store.add(fork); // fork 已有内容 → 立即上历史列表
    this._persistActiveSession(); // 归档源会话并落盘（fork 此时已在列，一并写入）

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

  private _deleteSession(id: string): void {
    const isActive = this._active.id === id;
    if (isActive) {
      this._cancelActiveRun();
    }
    this._store.remove(id);
    this._store.persist();

    if (isActive) {
      this._dropReview(true); // 删的是当前会话 → 一并清掉审阅
      this._actives[this._mode] = this._store.create();
      this._postSnapshot();
    }
    this._sendHistory();
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

  private _sendHistory(): void {
    const sessions: SessionSummary[] = this._store
      .all()
      .filter((s) => s.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
    this._post({ type: 'history-update', sessions, activeId: this._active.id });
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

  /** 轮首：清上一轮审阅 + 快照当前工作区根（同步取盘，快照点必须在一切 await 之前）。 */
  private _captureBaselineAtTurnStart(): void {
    this._reviewSeq += 1;
    this._baseline = undefined;
    this._reviewRootAbs = undefined;
    this._pendingReview = [];
    this._post({ type: 'review-clear' }); // 新一轮开始 → 隐去上轮审阅条
    const root = this._reviewRoot();
    if (!root || !this._reviewChangesOn()) return;
    const shot = snapshotTree(root);
    if ('aborted' in shot) return; // 目录过大/根不可读 → 本轮静默无审阅
    this._reviewRootAbs = root;
    this._baseline = shot;
  }

  /** 清掉本轮审阅内存；doPost 时通知 webview 隐藏审阅条/面板。 */
  private _dropReview(doPost: boolean): void {
    this._reviewSeq += 1;
    this._baseline = undefined;
    this._reviewRootAbs = undefined;
    this._pendingReview = [];
    if (doPost) {
      this._post({ type: 'review-clear' });
    }
  }

  /** 轮 done 后（finally 里）调用：退栈再异步对比，token 失配即静默丢（防新一轮/清理交错）。 */
  private _scheduleReviewAfterTurn(): void {
    const mySeq = this._reviewSeq;
    const before = this._baseline;
    const root = this._reviewRootAbs;
    if (!before || !root) return;
    void (async () => {
      // 重活不在 _finishTurn/_runLive 的同步路径上做
      await new Promise<void>((r) => setImmediate(r));
      if (this._reviewSeq !== mySeq || this._baseline !== before) return;
      const afterShot = snapshotTree(root);
      if ('aborted' in afterShot) {
        this._baseline = undefined;
        this._reviewRootAbs = undefined;
        return;
      }
      const changes = compareTrees(before, afterShot);
      if (changes.length === 0) {
        this._baseline = undefined;
        this._reviewRootAbs = undefined;
        return;
      }
      this._pendingReview = changes;
      this._postReviewSet();
    })();
  }

  /** 把 pending 改动整理成 webview DTO（行级 diff + 跨文件字节护栏）推给前端。 */
  private _postReviewSet(): void {
    const out: ReviewChange[] = [];
    let budget = 200 * 1024; // 跨文件 diff 文本总护栏，防压垮 postMessage
    for (const ch of this._pendingReview) {
      const item: ReviewChange = {
        kind: ch.kind,
        rel: ch.rel,
        name: ch.rel.slice(ch.rel.lastIndexOf('/') + 1),
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

  /** 审阅动作入口（keep/revert 单条 + keep-all/revert-all）。正在跑或没有本轮基线 → 忽略。 */
  private _reviewAction(action: 'keep' | 'revert' | 'keep-all' | 'revert-all', rel?: string): void {
    if (this._abort || !this._baseline || !this._reviewRootAbs) return;
    const root = this._reviewRootAbs;

    if (action === 'keep' || action === 'keep-all') {
      // keep = 保留磁盘改动，仅从审阅里收起，不碰文件
      this._pendingReview = rel
        ? this._pendingReview.filter((c) => c.rel !== rel)
        : [];
      if (this._pendingReview.length === 0) this._dropReview(true);
      else this._postReviewSet();
      return;
    }

    const targets = rel
      ? this._pendingReview.filter((c) => c.rel === rel)
      : this._pendingReview.slice();
    if (targets.length === 0) return;

    const ok: TreeChange[] = [];
    const failed: { rel: string; reason: string }[] = [];
    for (const ch of targets) {
      if (!ch.reversible) {
        failed.push({ rel: ch.rel, reason: '无轮前内容可还原（二进制/超大文件）' });
        continue;
      }
      try {
        applyRevert(root, ch);
        ok.push(ch);
      } catch (err) {
        failed.push({ rel: ch.rel, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (ok.length > 0) {
      this._pendingReview = this._pendingReview.filter((c) => !ok.includes(c));
      const summary =
        ok.length === 1
          ? `已还原本轮 DSH 改动：${ok[0].rel}`
          : `已还原本轮 DSH 改动：${ok.length} 个文件成功`;
      this._pushReviewNote(
        failed.length > 0 ? `${summary}；${failed.length} 个未还原` : summary
      );
    }
    if (failed.length > 0) {
      vscode.window.showErrorMessage(
        `还原失败 ${failed.length} 项：${failed.map((f) => `${f.rel}（${f.reason}）`).join('、')}`
      );
    }
    if (this._pendingReview.length === 0) this._dropReview(true);
    else this._postReviewSet();
  }

  /** 把一条 role:'note' 说明入列当前会话并下发（还原反馈；react-live 态仅在转录持久化可见）。 */
  private _pushReviewNote(text: string): void {
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
    });
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
      .replace(/%%JS_URI%%/g, jsUri.toString())
      .replace(/%%DSH_THEME_LINK%%/g, dshThemeLink)
      .replace(/%%DSH_LIVE_JS_URI%%/g, dshLiveJsUri)
      .replace(/%%DSH_LIVE_CSS_URI%%/g, dshLiveCssUri);
  }
}
