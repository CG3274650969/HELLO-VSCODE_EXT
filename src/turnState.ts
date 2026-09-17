/**
 * C8：一轮（turn）的状态判据。
 *
 * **纯模块，绝不 import `vscode`** —— 与 `sessionSearch.ts` / `sessionExport.ts` / `dshPaths.ts` 同规矩：
 * 自检 `scripts/probe-turn-state.mjs` 要在扩展宿主**之外**加载这份编译产物，一旦这里长出 vscode 依赖，
 * 探针就加载不了（会以「找不到模块 vscode」响亮失败，而不是悄悄少测一块）。
 *
 * 两个面同处一个文件，因为它们是同一个问题「这一轮现在算怎么回事」的两半：
 *   · `needsContinue` —— 从**已落盘**的会话推断「该不该给用户一个『继续』按钮」；
 *   · `TurnStatus`    —— 从**线上**的 `session.status` 通知跟踪「当前会话还在跑吗」。
 */
import type { StoredSession } from './sessionStore';

/**
 * 上一轮是怎么结束的。**只有异常终态才落这个字段，正常跑完一律清掉** ——
 * 于是「有没有值」本身就是判据，不必再去猜消息的形状。
 *
 * 为什么不从消息状态反推（比如「最后一条助手消息是不是 interrupted」）：那样判不准。
 * 反例：agent 只跑了工具、一个字都没说就正常收尾，转写末尾是一张状态正常的工具卡；
 * 或者最后一张工具卡**合理失败**（命令非零退出）而这一轮是正常跑完的 ——
 * 两种情况下「末条消息不对劲」都成立，但用户根本不需要「继续」。这个字段没有歧义。
 */
export type LastTurn = 'interrupted' | 'error';

/** 已落盘的 `lastTurn` 是否可信（不是这两个值就当没有）。 */
export function readLastTurn(session: { lastTurn?: unknown }): LastTurn | undefined {
  const v = session.lastTurn;
  return v === 'interrupted' || v === 'error' ? v : undefined;
}

/**
 * 该不该给这个会话显示「继续」按钮。
 *
 * 判据**只有一条**：上一轮以 `interrupted` / `error` 收场。不发新消息它就一直为真 ——
 * 所以重载窗口、甚至完全关掉 VS Code 再开，按钮都还在（`lastTurn` 随 `_afterTurn` 落盘）。
 * 用户一发新消息（`_sendUser` 清掉字段）按钮就消失，不需要另外的失效逻辑。
 */
export function needsContinue(session: StoredSession): boolean {
  return readLastTurn(session) !== undefined;
}

/** `session.status` 通知的形状（只取我们认的两个字段）。 */
export interface StatusFrameLike {
  sessionId: string;
  status: string;
}

/**
 * 从 `session.status` 通知跟踪「当前会话还在不在跑」。
 *
 * ⚠️ **只用来「放宽」判断，绝不用来「认定已完成」**。`session.status` 只在状态**翻转**时发
 * （DSH `agent-loop` 里 `if (status !== previousStatus) emit(...)`），而且 wire 上没有对应的
 * **查询**方法 —— 漏收一条就再也补不回来。所以「已知 running」可信（它只会让我们多等一会儿），
 * 而「已知 idle」不能当成完成信号：真正的完成信号是 idle 通知本身、或子进程退出。
 *
 * 两个不变量：
 *   · 非当前会话的通知一律忽略（一个进程里可能有别的会话，见 `_currentDshId` 的过滤）；
 *   · 还没认领过会话 id 时**认领**第一条通知的 id（`ready` → `_connectLive` 那条路上，
 *     initialize 早于 `_ensureDshSession`，此时 `_currentDshId` 是空的）。
 */
export class TurnStatus {
  private _id?: string;
  private _state?: 'idle' | 'running';

  /** 当前认领的 DSH 会话 id（未认领时 undefined）。 */
  get id(): string | undefined {
    return this._id;
  }

  /** 这一轮是否**已知**在跑。 */
  get running(): boolean {
    return this._state === 'running';
  }

  /**
   * 换会话 / 换子进程：状态归零。
   *
   * 传 `undefined` = 彻底忘记（`_teardownLive` 那种「进程没了，一切都不可信」的场合）；
   * 传 id = 认领新会话但状态**仍归零** —— 上一个会话的 running 与新会话无关，
   * 继承过来会让 `_sendUser` 把用户挡在门外。
   */
  reset(id?: string): void {
    this._id = id;
    this._state = undefined;
  }

  /**
   * 收一条通知。返回「状态是否发生了翻转」——调用方据此决定要不要做收尾动作
   * （`idle` 翻转才收尾；重复到达的 idle 必须幂等）。
   */
  apply(frame: StatusFrameLike): boolean {
    if (!frame || typeof frame.sessionId !== 'string') {
      return false;
    }
    if (frame.status !== 'idle' && frame.status !== 'running') {
      return false;
    }
    if (this._id === undefined) {
      this._id = frame.sessionId; // 首次认领
    } else if (frame.sessionId !== this._id) {
      return false; // 别的会话，装没看见
    }
    if (this._state === frame.status) {
      return false; // 重复通知：幂等，别让调用方重复收尾
    }
    this._state = frame.status;
    return true;
  }
}
