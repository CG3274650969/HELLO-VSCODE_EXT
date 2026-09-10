/**
 * C1 事前审批：本机审批服务（零依赖，只用 node:http）。
 *
 * 通路：DSH 的 hooks-claude-code 插件按我们生成的 hooks.json 跑 hook 脚本
 * （见 dshHooks.ts），脚本把「即将执行的 bash 命令」POST 到这里；这条 HTTP 连接
 * **一直挂着**，直到用户在侧栏确认条上点了允许/拒绝（或超时）——返回决策后 DSH
 * 的工具管道才继续，所以整轮是真的"暂停等确认"。
 *
 * 安全边界：
 * - 只监听 127.0.0.1（`listen(0)` 随机端口），并要求随机 token（header 或 query）。
 * - 本服务只"回答决策"，绝不执行任何东西；命令文本仅用于展示与正则匹配。
 * - 超时 / 取消 / 内部异常一律按拒绝处理（fail closed）；脚本侧还有一层内置兜底
 *   （扩展整体不可达时按保守清单拒绝）。
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'crypto';

/** 请求体大小上限（自家脚本只会发几十字节；超了就是异常流量） */
const MAX_BODY_BYTES = 256 * 1024;

/** 一次待确认的调用（来自 hook 脚本的 POST） */
export interface ApprovalAsk {
  id: string;
  /** 工具名（本期只会是 bash） */
  toolName: string;
  /** 完整命令原文（展示 + 匹配用） */
  command: string;
}

/** 一条审批的最终去向 */
export type ApprovalOutcome = 'allowed' | 'rejected' | 'timeout' | 'cancelled';

/** 挂起中的一条：那条 HTTP 连接的结算函数 + 超时定时器 */
interface Pending {
  settle: (r: Decision) => void;
  timer: NodeJS.Timeout;
}

/** 回给 hook 脚本的决策 */
interface Decision {
  allow: boolean;
  reason?: string;
}

export class ApprovalServer {
  private _server?: http.Server;
  private _port = 0;
  /** 每次实例一个随机令牌：hook 脚本按命令行参数拿到，别的进程猜不到 */
  private readonly _token = randomBytes(16).toString('hex');
  /** 挂起中的审批（id → 结算器）；同一时刻通常最多一条 */
  private readonly _pending = new Map<string, Pending>();
  private _seq = 0;

  constructor(
    /** 当前策略（每次询问现读 → 改了设置立即生效）：命中即需用户确认 */
    private readonly _patterns: () => string[],
    /** 用户等待上限（毫秒） */
    private readonly _timeoutMs: () => number,
    /** 需要用户拍板时回调（扩展 → webview 弹确认条） */
    private readonly _onAsk: (ask: ApprovalAsk) => void,
    /** 一条审批有了结果 → 扩展落转写 + 通知 webview */
    private readonly _onResolved: (id: string, outcome: ApprovalOutcome) => void
  ) {}

  /** 回连地址（写给 hook 脚本用）；未启动时为空串 */
  get url(): string {
    return this._port ? `http://127.0.0.1:${this._port}` : '';
  }

  /** hook 脚本要带的令牌 */
  get token(): string {
    return this._token;
  }

  /** 起服务（幂等）。失败上浮给调用方决定降级，绝不抛进 agent 链路。 */
  start(): Promise<void> {
    if (this._server) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const server = http.createServer((req, res) => {
        void this._handle(req, res);
      });
      server.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        // 运行期错误（罕见）不该把扩展打挂：丢下服务，下次 ensure 重建
        this._server = undefined;
        this._port = 0;
        console.log('[approval] server error:', err.message);
      });
      server.listen(0, '127.0.0.1', () => {
        settled = true;
        this._server = server;
        this._port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  /** 用户在确认条上拍了板。false = 这条已失效（超时/已取消/已答过），无需再处理。 */
  answer(id: string, allow: boolean): boolean {
    const p = this._pending.get(id);
    if (!p) return false;
    this._pending.delete(id);
    clearTimeout(p.timer);
    this._onResolved(id, allow ? 'allowed' : 'rejected');
    p.settle(
      allow
        ? { allow: true }
        : { allow: false, reason: '用户在 AlohaDSH 中拒绝了该命令，未执行。' }
    );
    return true;
  }

  /** 本轮被停 / 切走 / 切换模式 / 视图销毁：挂起的全部取消（脚本侧按拒绝收尾）。 */
  cancelAll(): void {
    if (this._pending.size === 0) return;
    for (const id of [...this._pending.keys()]) {
      const p = this._pending.get(id);
      if (!p) continue;
      this._pending.delete(id);
      clearTimeout(p.timer);
      this._onResolved(id, 'cancelled');
      p.settle({ allow: false, reason: '本轮已停止或切换，审批被取消，命令未执行。' });
    }
  }

  dispose(): void {
    this.cancelAll();
    const server = this._server;
    this._server = undefined;
    this._port = 0;
    if (server) {
      try {
        server.close();
      } catch {
        /* 关闭失败无可挽回，忽略 */
      }
    }
  }

  // ---------- HTTP ----------

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      const text = JSON.stringify(body ?? {});
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'POST' || url.pathname !== '/pre-tool-use') {
        send(404, { error: 'not found' });
        return;
      }
      const token = String(req.headers['x-hello-token'] ?? url.searchParams.get('token') ?? '');
      if (token !== this._token) {
        send(403, { error: 'forbidden' });
        return;
      }
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as { toolName?: unknown; command?: unknown };
      const toolName = typeof parsed.toolName === 'string' ? parsed.toolName : '';
      const command = typeof parsed.command === 'string' ? parsed.command : '';

      // 不命中策略 → 立即放行（无感；agent 不必等）
      if (!this._needsApproval(command)) {
        send(200, { decision: 'allow' });
        return;
      }
      const decision = await this._askUser(toolName, command);
      send(
        200,
        decision.allow
          ? { decision: 'allow' }
          : { decision: 'deny', reason: decision.reason ?? '未获批准，命令未执行。' }
      );
    } catch {
      // 解析/内部异常 → 拒绝（fail closed：绝不让"不知道"退化成"放行"）
      send(200, { decision: 'deny', reason: '审批服务内部错误，已按拒绝处理。' });
    }
  }

  /** 命令是否命中策略。空模式跳过，非法正则忽略（一条坏配置不该让整个策略变成"拒绝一切"）。 */
  private _needsApproval(command: string): boolean {
    if (!command) return false;
    for (const src of this._patterns()) {
      const pattern = String(src ?? '').trim();
      if (!pattern) continue;
      try {
        if (new RegExp(pattern, 'i').test(command)) return true;
      } catch {
        /* 非法正则：忽略这一条 */
      }
    }
    return false;
  }

  /** 建一条挂起、通知 UI、等用户（或超时）。 */
  private _askUser(toolName: string, command: string): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const id = `ap${++this._seq}`;
      const timeoutMs = this._timeoutMs();
      const timer = setTimeout(() => {
        if (!this._pending.delete(id)) return; // 已被答复/取消
        this._onResolved(id, 'timeout');
        resolve({ allow: false, reason: '等待确认超时，已按拒绝处理，命令未执行。' });
      }, timeoutMs);
      this._pending.set(id, { settle: resolve, timer });
      this._onAsk({ id, toolName, command });
    });
  }
}

/** 读完整请求体（带上限，防异常流量把内存撑爆）。 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
