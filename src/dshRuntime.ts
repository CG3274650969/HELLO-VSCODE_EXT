/**
 * 连接 DeepSeek Harness SDK JSON-RPC runtime 的最小客户端（零外部依赖）。
 *
 * 官方 SDK seam 的 wire 非常小：三组请求（initialize / session/prompt / shutdown）
 * + 通知（session.status / session.event / subagent.*），一律换行分隔 JSON
 * （newline-delimited JSON-RPC）跑在子进程 stdio 上。这里只负责「传输」：
 * spawn/杀进程、按 id 配对请求响应、把通知分发给回调；**不解释**会话事件——
 * 事件 → 我们消息协议的映射在 chatViewProvider 里做（好让"产出器可替换"的
 * 哲学只落在那一处）。
 *
 * 进程生命周期：由构造时给的回调 makeRequest() 惰性 spawn；initialize 每个进程
 * 只跑一次；kill() 停进程（先争取一次优雅退出，见 GRACEFUL_KILL_MS）并令已缓冲/
 * 迟到的 stdout 行不再分发。没有 cancel RPC → 停止一轮的唯一手段就是停子进程
 * （下一轮再惰性重启）。
 */
import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';

/**
 * kill() 给子进程的优雅退出窗口。
 *
 * DSH 运行时的干净退出路径是 `stdin end → disposeAndExit(0) → session/disposed → flush → fsync`
 * （写盘是 200 ms 攒批，硬切会丢掉最后一批）。实测空闲进程 stdin.end() 后 **~25 ms** 就 exit(0)，
 * 2 s 对「手上还有一批没落盘」的忙进程是 80 倍余量。
 *
 * ⚠️ 这只是**争取一次 flush，不是事务**：超时后仍然是硬杀，那 ≤200 ms 的窗口只是变小、没有消失。
 */
const GRACEFUL_KILL_MS = 2000;

/**
 * session/prompt 的**回执**上限（不是「本轮上限」）。
 *
 * 回执只是服务端「收下了」的收条（`{messageId}`），本轮何时结束看 `session.status` idle
 * 或子进程退出。所以这个值要**宽**：拿回执超时当本轮失败，会把一个还在跑、还在执行工具的
 * 长轮误报成 error。保留一个上限是刻意的 —— 子进程彻底卡死时得有出路。
 */
const PROMPT_ACK_TIMEOUT_MS = 10 * 60_000;

/** 发给 session/prompt 的内容块（v1 只用纯文本块）。 */
export type ContentBlock = { type: 'text'; text: string };

/** spawn 请求：command/args/cwd/env 都来自扩展侧（用户可在设置里改）。 */
export interface DshSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** initialize 的参数：路由 + 型号按会话在 JSON-RPC 里上报，不在 cordis.yml 里钉死。 */
export interface DshInitializeParams {
  cwd: string;
  provider: string;
  model: string;
  maxTokens?: number;
}

/**
 * 规范 SessionEvent 信封：{ type, seq, time, data }。DSH 核心的 session.append()
 * 总是把真实载荷放进 `data`，JSON-RPC 转发方原样透传整个信封 —— 所以消费端读
 * `event.data.*`，不是 event 顶层（顶层只有信封字段 + 少量 surface 元数据）。
 */
export interface DshSessionEvent {
  type: string;
  seq?: number;
  time?: number;
  /** 各类事件真实载荷 */
  data: DshEventData;
  /** surface 元数据（仅 assistant/message、tool/result 这类表面事件有） */
  surfaceOp?: unknown;
  sourceEventSeqs?: unknown;
}

/**
 * 一次模型调用的 token 计数（线上原样，不做加工）。
 * **三项互斥**：inputTokens 是未命中输入，缓存命中单列 cacheReadTokens；outputTokens 已含
 * reasoningTokens —— 详见 src/protocol.ts 的 UsageBuckets 注释与 DSH 的 llm/src/types.ts。
 */
export interface DshTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 各类事件真实载荷（尽力而为的宽松类型；多余字段无视）。 */
export interface DshEventData {
  turn?: unknown;
  step?: unknown;
  /** assistant/chunk 的载荷。usage chunk（type:'usage'）的计数在 usage 字段上 */
  chunk?: { type?: string; text?: string; id?: string; usage?: DshTokenUsage };
  /** 本次模型调用的用量：assistant/chunk(usage) 是早样本、assistant/message 是终样本，两者同值 */
  usage?: DshTokenUsage;
  /** request/context 的载荷：本次请求的路由与上下文窗口（占用率的分母） */
  provider?: string;
  model?: string;
  contextWindow?: number;
  /** tool/call 的载荷 */
  callId?: string;
  name?: string;
  arguments?: unknown;
  /** tool/result 的结构性 error（多数情况错误在 message.content[].isError 上） */
  error?: { name?: string; code?: string } | unknown;
  /** tool/result 的 message.content 数组 */
  message?: { content?: DshToolResultBlock[] };
  /**
   * C14：`tool/result` 的 `presentationMeta`（**只有顶层 exec 会带**：工具自己的
   * `presentationMeta(args, value)` 结果，write/edit 就在里面给 `diffs`）。
   * 一直在线、此前没人读 —— 形状交给 `changeForecast.actualForecast` 认，这里只要不丢就行。
   */
  meta?: unknown;
  /** turn/end 的收尾原因 */
  reason?: { kind?: string; [k: string]: unknown };
}

/** tool/result 里的 content block（type:'tool-result'） */
export interface DshToolResultBlock {
  type?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

/** session.event 通知的参数 */
export interface DshEventFrame {
  sessionId: string;
  event: DshSessionEvent;
}

/** session.status 通知的参数 */
export interface DshStatusFrame {
  sessionId: string;
  status: 'idle' | 'running';
}

export interface DshHandlers {
  /** 收到 session.status */
  onStatus?: (frame: DshStatusFrame) => void;
  /** 收到 session.event */
  onEvent?: (frame: DshEventFrame) => void;
  /** 子进程意外退出（非 kill() 所致）。code 可能为 null（spawn 失败）。 */
  onExit?: (code: number | null) => void;
  /** 调试日志（已脱敏：不含任何密钥）。 */
  onLog?: (line: string) => void;
}

function abortError(): Error {
  const e = new Error('操作已被中止');
  e.name = 'AbortError';
  return e;
}

/** 请求超时错误的 name。调用方一律走 `isDshTimeout()`，不要自己比字符串。 */
const DSH_TIMEOUT_ERROR = 'DshTimeoutError';

function timeoutError(method: string): Error {
  const e = new Error(`DSH「${method}」响应超时`);
  e.name = DSH_TIMEOUT_ERROR;
  return e;
}

/** 这个错误是不是「请求超时」（而不是子进程没了 / JSON-RPC 报错 / stdin 写失败）。 */
export function isDshTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === DSH_TIMEOUT_ERROR;
}

function rpcErrorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return `DSH ${typeof code === 'string' ? `(${code}) ` : ''}${message}`;
  }
  return 'DSH JSON-RPC 错误';
}

interface PendingRec {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** 无超时的请求（timeoutMs <= 0）没有计时器。 */
  timer?: ReturnType<typeof setTimeout>;
}

export class DshRuntime {
  private child?: ChildProcess;
  private pending = new Map<number, PendingRec>();
  private _id = 0;
  /** 进程已死：不再分发任何 stdout 行（含 kill 前已缓冲的行）。 */
  private dead = false;
  private exited = false;
  private killedByUser = false;
  /** kill() 里那个「优雅窗口用完了就硬杀」的计时器（子进程真的退出后清掉）。 */
  private forceKillTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly makeRequest: () => DshSpawnRequest,
    private readonly handlers: DshHandlers,
    private readonly debug = false
  ) {}

  /** 子进程就绪（惰性 spawn，进程死了会自动重来）。 */
  private ensureChild(): ChildProcess {
    const existing = this.child;
    if (existing && existing.exitCode === null && existing.signalCode === null) return existing;
    const req = this.makeRequest();
    this.dead = false;
    this.exited = false;
    this.killedByUser = false;

    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      // stdin 必须走 pipe 并保持打开：DSH jsonrpc runtime 在收到 stdin end 时
      // 会自认为「父进程已断开」而 disposeAndExit(0) 干净退出。ignore 会让管道
      // 立即 EOF → 子进程刚起来就退出（表现为 "DSH 子进程已退出"）。
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));

    child.stderr.on('data', (d: Buffer) => {
      if (this.debug) this.handlers.onLog?.call(this.handlers, `[dsh] ${String(d)}`);
    });

    child.on('error', (err) => {
      this.endChild(`DSH 子进程启动失败：${err.message}`, null);
    });
    child.on('exit', (code) => {
      this.endChild(code === 0 ? 'DSH 子进程已退出' : `DSH 子进程异常退出 (code=${code})`, code);
    });
    return child;
  }

  /** 进程结束（自发退出/spawn 失败/被杀）。统一拒绝在途请求；被杀时不上浮 onExit。 */
  private endChild(message: string, code: number | null): void {
    // 先于 exited 早退：kill() 会把 exited 抢先置位，这里才是清计时器的唯一时机。
    if (this.forceKillTimer !== undefined) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = undefined;
    }
    if (this.exited) return;
    this.exited = true;
    this.dead = true;
    const err = new Error(message);
    for (const id of Array.from(this.pending.keys())) {
      this.settle(id, false, err);
    }
    if (!this.killedByUser) {
      try {
        this.handlers.onExit?.call(this.handlers, code);
      } catch {
        /* 回调自身异常不影响子进程生命周期收尾 */
      }
    }
  }

  /**
   * 主动停掉子进程（用户停止 / 出错收尾 / provider dispose）。不触发 onExit。
   *
   * **两段式**：先 `stdin.end()` 让运行时走它自己的干净退出路径（flush 攒批 + fsync），
   * 给它 GRACEFUL_KILL_MS；到点还没退就硬杀。对外**仍是同步返回**、语义与从前一致
   * （调用后 `dead = true`，已缓冲/迟到的 stdout 行一律不再分发；在途请求立刻被拒）——
   * 变的只是「强杀」这一步延后了一小会儿。
   *
   * 为什么要争取这一次 flush：写盘是 200 ms 攒批，而 `stdin.end()` 与 `child.kill()`
   * 放在同一 tick 等于把那批必然还在内存里的事件直接扔掉。
   */
  kill(): void {
    this.killedByUser = true;
    this.dead = true;
    this.exited = true;
    const child = this.child;
    if (child) {
      try {
        child.stdin?.end();
      } catch {
        /* stdin 已关 */
      }
      // 进程还活着才排这个计时器。为什么必须在这里排、而不是靠 endChild：
      // kill() 已经把 exited 置位，真正 exit 时 endChild 会在开头就直接返回 —— 这条路径上
      // 没有别的地方会强杀。反过来，子进程若已退出就没什么可杀的（挂上也只是空转 2 s）。
      if (child.exitCode === null && child.signalCode === null) {
        this.forceKillTimer = setTimeout(() => {
          this.forceKillTimer = undefined;
          try {
            child.kill();
          } catch {
            /* 已退出 */
          }
        }, GRACEFUL_KILL_MS);
      }
    }
    const err = abortError();
    for (const id of Array.from(this.pending.keys())) {
      this.settle(id, false, err);
    }
  }

  private settle(id: number, ok: boolean, value: unknown): void {
    const rec = this.pending.get(id);
    if (!rec) return;
    this.pending.delete(id);
    clearTimeout(rec.timer);
    if (ok) rec.resolve(value);
    else rec.reject(value);
  }

  private onLine(line: string): void {
    if (this.dead) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      this.handlers.onLog?.call(this.handlers, `[dsh] 忽略非 JSON 行`);
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const m = obj as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (m.id !== undefined && m.method === undefined) {
      // 请求响应：result 或 error 二选一
      if (typeof m.id !== 'number') return;
      if (m.error !== undefined) {
        this.settle(m.id, false, new Error(rpcErrorText(m.error)));
      } else {
        this.settle(m.id, true, m.result);
      }
      return;
    }
    // 服务端通知
    if (m.method && m.params && typeof m.params === 'object') {
      const p = m.params as Record<string, unknown>;
      if (m.method === 'session.status') {
        this.handlers.onStatus?.call(this.handlers, p as unknown as DshStatusFrame);
      } else if (m.method === 'session.event') {
        this.handlers.onEvent?.call(this.handlers, p as unknown as DshEventFrame);
      } else if (this.debug) {
        this.handlers.onLog?.call(this.handlers, `[dsh] 忽略通知 ${m.method}`);
      }
    }
  }

  /**
   * 发一个请求，按 id 配对响应。signal 中止 → AbortError；超时 → Error。
   *
   * `timeoutMs <= 0` = **不挂计时器**，一直等到有响应、被中止、或子进程收尾
   * （`endChild` 会把在途请求全部拒绝，所以挂死不会漏掉）。
   */
  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const child = this.ensureChild();
    if (this.dead || child.exitCode !== null) {
      return Promise.reject(new Error('DSH 子进程未在运行'));
    }
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.settle(id, false, timeoutError(method));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: (v) => resolve(v),
        reject: (e) => reject(e),
        timer,
      });
      const onAbort = () => this.settle(id, false, abortError());
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
        if (err) this.settle(id, false, err);
      });
    });
  }

  /** 握手：上报 cwd / provider / model。每个进程只调用一次。 */
  initialize(params: DshInitializeParams, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      'initialize',
      params as unknown as Record<string, unknown>,
      30_000,
      signal
    );
  }

  /**
   * 提交一轮用户消息；只等「回执」messageId（本轮何时结束看 session.status idle）。
   *
   * ⚠️ 别把这个超时当作本轮失败 —— 回执早于本轮完成，超时只说明服务端迟迟没确认收下
   * （见 PROMPT_ACK_TIMEOUT_MS 的说明）。调用方要区分「真失败」与「只是还没回执」。
   */
  prompt(sessionId: string, blocks: ContentBlock[], signal?: AbortSignal): Promise<unknown> {
    return this.request(
      'session/prompt',
      { sessionId, contentBlocks: blocks },
      PROMPT_ACK_TIMEOUT_MS,
      signal
    );
  }

  /** 让子进程正常退出（一般不用：kill 即可）。 */
  shutdown(signal?: AbortSignal): Promise<unknown> {
    return this.request('shutdown', {}, 10_000, signal);
  }
}
