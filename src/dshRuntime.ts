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
 * 只跑一次；kill() 杀进程并令已缓冲/迟到的 stdout 行不再分发。没有 cancel RPC
 * → 停止一轮的唯一手段就是 kill 子进程（下一轮再惰性重启）。
 */
import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';

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

/** 各类事件真实载荷（尽力而为的宽松类型；多余字段无视）。 */
export interface DshEventData {
  turn?: unknown;
  step?: unknown;
  /** assistant/chunk 的载荷 */
  chunk?: { type?: string; text?: string; id?: string };
  /** tool/call 的载荷 */
  callId?: string;
  name?: string;
  arguments?: unknown;
  /** tool/result 的结构性 error（多数情况错误在 message.content[].isError 上） */
  error?: { name?: string; code?: string } | unknown;
  /** tool/result 的 message.content 数组 */
  message?: { content?: DshToolResultBlock[] };
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
  timer: ReturnType<typeof setTimeout>;
}

export class DshRuntime {
  private child?: ChildProcess;
  private pending = new Map<number, PendingRec>();
  private _id = 0;
  /** 进程已死：不再分发任何 stdout 行（含 kill 前已缓冲的行）。 */
  private dead = false;
  private exited = false;
  private killedByUser = false;

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

  /** 主动杀掉子进程（用户停止 / provider dispose）。不触发 onExit。 */
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
      try {
        child.kill();
      } catch {
        /* 已退出 */
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

  /** 发一个请求，按 id 配对响应。signal 中止 → AbortError；超时 → Error。 */
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
      const timer = setTimeout(() => {
        this.settle(id, false, new Error(`DSH「${method}」响应超时`));
      }, timeoutMs);
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

  /** 提交一轮用户消息；只等「回执」messageId（本轮何时结束看 session.status idle）。 */
  prompt(sessionId: string, blocks: ContentBlock[], signal?: AbortSignal): Promise<unknown> {
    return this.request('session/prompt', { sessionId, contentBlocks: blocks }, 120_000, signal);
  }

  /** 让子进程正常退出（一般不用：kill 即可）。 */
  shutdown(signal?: AbortSignal): Promise<unknown> {
    return this.request('shutdown', {}, 10_000, signal);
  }
}
