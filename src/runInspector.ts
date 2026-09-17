/**
 * C9：一轮（turn）的**运行时间线**——工具调用序列、轮/步/工具耗时、本轮错误。
 *
 * **纯模块，绝不 import `vscode`**（连 `dshRuntime` 也不 import）—— 与 `turnState.ts` /
 * `sessionSearch.ts` 同规矩：自检 `scripts/probe-run-inspector.mjs` 要在扩展宿主**之外**
 * 加载这份编译产物。为此入参是**结构型**的帧（`RunFrameLike`，同 `TurnStatus.StatusFrameLike`
 * 的理由）：字段一律 `unknown` 进、按需窄化出，谁来喂都行，探针用合成帧也一样。
 *
 * ## 三条不许在后来的改动里丢掉的约束
 *
 * 1. **只留时间线，不留正文。** `assistant/chunk` 一律不入账（实测最大一份抓帧里 819 条 chunk
 *    对 4 次工具调用 —— 99.5% 的帧是噪声）；**工具入参也不留** —— 消息卡里那份已经过
 *    `capToolInput` 的 2 万字符熔断（`chatViewProvider.ts` 的 `tool/call` 分支），这里再存一份
 *    既是双份内存，又是**绕过那条保险丝的一条新路**。要展示命令原文就让它在产生处过熔断，
 *    别在这里开洞。
 * 2. **判据只此一处。** 配对键（`toolKeyFrom`）与「这次结果算成功/失败/未知」
 *    （`toolResultVerdict`）由本模块导出、provider 调用同一份实现 —— 否则转写里是红卡、
 *    检查器里是绿行（或反过来），用户不知道信哪个。
 * 3. **有界，且不落盘。** 一个全局环（`MAX_RUNS`）在读取时按会话过滤，**不建
 *    `Map<sessionId, ring>`**（那会随「开过的会话数」无界增长）。下一句点名一个函数，
 *    防后人「顺手」把这份记录持久化：**绝不要从 `chatViewProvider._afterTurn()` 走到这里** ——
 *    那是唯一的落盘咽喉，C9 的用户决策是纯内存（重载窗口即清空）。
 *
 *
 * ## 时间从哪来
 *
 * 全部来自**帧信封上的 `time`**（epoch ms）。不新增任何计时器：两个信封相减就是耗时，
 * 而 DSH 一步一次工具、call/result 成对到达，粒度天然够用。
 *
 * ⚠️ **本模块一次 `Date.now()` 都不调** —— 一旦掺进宿主时钟，自检就不可复现了。
 * 没有 `turn/end` 的收尾（进程被杀）用**收到的最后一帧的时间**当终点（`lastFrameAt`），
 * 语义上也更贴切：那是这一轮最后一次有人说话的时刻。
 *
 * ## 一条实测纠正（2026-09-17，别把它改回去）
 *
 * 原设计写「`unmatched` 正常恒为 0，非 0 就是我们的 bug」。**这是错的**：DSH 补平中断轮时
 * 会补写结果帧（`TOOL_NOT_STARTED` / 「Its outcome is unknown」），那些帧**本来就配不上任何
 * 调用**。正确的形状是按「谁写的」分开数（见 `unmatched` 与 `repaired`），
 * 而补平帧的状态判据也必须是三态（见 `toolResultVerdict`）——
 * 它们**正文说「未知」、帧上却带 `isError: true`**。
 */

/**
 * 收帧用的结构型入参：只取真读的字段。`DshEventFrame` 结构上可直接喂进来。
 */
export interface RunFrameLike {
  sessionId?: unknown;
  event: {
    type?: unknown;
    seq?: unknown;
    time?: unknown;
    data?: unknown;
  };
}

/**
 * 一轮的终态。`running` = 还没收尾（唯一会随时间自己变的状态）。
 *
 * `aborted` 与 `interrupted` 分开留：线上 `turn/end` 报的是哪个就记哪个，徽章文案也分开
 * （前者是 DSH 自己中止的，后者是**我们**杀进程之后由运行时补平悬空尾轮所用的 reason，
 * 见 `chatViewProvider` 的 `turn/end` 分支注释）。
 */
export type RunOutcome = 'running' | 'completed' | 'aborted' | 'interrupted' | 'error';

/**
 * 一行工具的状态。
 *
 * `unknown` 是**刻意**的第四态：本轮收尾时这张卡还没有 result —— 它可能跑完了、也可能
 * 半路被杀，**无法区分**。与 C8 的 `TOOL_OUTCOME_UNKNOWN` 同一套措辞（「结果未知，别盲重试」）。
 * **绝不折成 error** —— 那是谎报，会让用户以为工具真的失败了而去重试一个有副作用的命令。
 */
export type RunToolState = 'running' | 'ok' | 'error' | 'unknown';

/** 一条工具调用行。**不存 `arguments`、不存输出**（见文件头约束 1）。 */
export interface RunToolRow {
  /**
   * 本轮内第几次工具调用（1 起，跨 step 连续）—— 验收里的「工具调用序列」。
   * ⚠️ **不是**帧信封上的 `seq`（那是传输序号，我们不展示，且会因帧类型而跳号）。
   */
  index: number;
  /** 属于第几步（wire 的 step） */
  step: number;
  /** 工具名（wire 原名，不翻译 —— 它要与 `hello.dsh.debug` 打出来的帧对得上） */
  name: string;
  /** 配对键（`toolKeyFrom`），留档以便与转写里的卡对齐排查 */
  key: string;
  state: RunToolState;
  /** call 帧的 time */
  startedAt?: number;
  /** result 帧的 time */
  endedAt?: number;
  /** `endedAt - startedAt`；两端不齐或为负 → 缺省（宁可没有，也绝不给 NaN / 负数） */
  durationMs?: number;
}

/** 一步的时间。DSH 一步 = 一次模型调用（可能带一次工具）—— 所以步耗时 ≥ 工具耗时，两者不冗余。 */
export interface RunStep {
  step: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/** 本轮上浮的错误。只由 `endRun('error', …)` 写入（见 `endRun` 的「单写者」注释）。 */
export interface RunError {
  at?: number;
  message: string;
}

/** 一整轮的记录（也是下发给面板的详情）。纯 JSON，可直接 postMessage。 */
export interface RunRecord {
  /**
   * 我们自己的单调序号 —— **列表主键**。
   * 不用 wire 的 `turn`：DSH 身份丢失后新会话的轮号会从 1 重数，那样两条记录会撞键。
   */
  id: number;
  /**
   * 哪个 **UI 会话**（`StoredSession.id`）。读数按它过滤。
   *
   * ⚠️ **不能用 `_currentDshId` 过滤**：`_openSession` 不重置它，只有 `_teardownLive` 会 ——
   * 于是刚切到会话 B 时它还是 A 的 id，面板会显示 A 那一轮的记录。DSH id 只记在下面
   * 做诊断，以及给「迟到帧该归哪一轮」当判据。
   */
  uiSessionId: string;
  /** 帧信封上的 sessionId（诊断用） */
  dshSessionId?: string;
  /** wire 的轮号 */
  turn: number;
  outcome: RunOutcome;
  /** `turn/end` 的 `reason.kind` **原样留档** —— 徽章看着不对时永远可诊断 */
  reasonKind?: string;
  /** 上一轮还没收尾就来了新的一轮（缺 `turn/end`）→ 强制收尾并打这个标 */
  superseded?: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** 收到的最后一帧的 time；没有 `turn/end` 时用它当终点 */
  lastFrameAt?: number;
  steps: RunStep[];
  /** 超出 `MAX_STEPS` 没记下的**步数**（继续计数，不是不数了） */
  stepsDropped: number;
  tools: RunToolRow[];
  /** 超出 `MAX_TOOL_ROWS` 没记下的工具调用**次数**（继续计数） */
  toolsDropped: number;
  /**
   * 配不上任何一行的 `tool/result` 条数 —— 「配对键失效」的探针。
   *
   * ⚠️ **先前这里写着「正常恒为 0」，那是错的**（2026-09-17 实测推翻）：DSH 补平中断轮时会
   * 补写结果帧，而那些帧本来就配不上任何调用 —— 混在一起数，等于把一个**必然出现的运行时
   * 行为**报成我们自己的 bug。它们现在单列在 `repaired`，本字段只留真正的键失效。
   */
  unmatched: number;
  /**
   * DSH **补平**帧的条数（判据 `isRepairResult`）：**运行时代我们写的结果**。
   *
   * 名字说的是「谁写的」而不是「那个调用跑没跑」—— 因为两个真实变体的语义本就不同：
   *   · `TOOL_NOT_STARTED` → 调用从未被记录为开始，**没有** `tool/call` 行可配；
   *   · `interrupted-tool-result-<callId>-<seq>` → 已经开始了，只是结果没落盘。它的
   *     `toolCallId` 与真调用**逐字相同**，所以只要那一行还在窗口里，它会正常配上并把状态
   *     判成 `unknown`（**不会**走到本字段）；只有那一行也不在（轮早于我们开始、或被上限丢掉）
   *     才会落到这里。
   * 两种情况都不是我们的 bug，所以与 `unmatched` 分开数。
   */
  repaired: number;
  errors: RunError[];
  /** 超出 `MAX_ERRORS` 没记下的条数 */
  errorsDropped: number;
}

/** 条与面板头部要的那几个数（**扩展算好，webview 只排版**，同 C3a 的分工）。 */
export interface RunSummary {
  id: number;
  turn: number;
  outcome: RunOutcome;
  startedAt?: number;
  /** 还在跑时为缺省：这里不编一个「到现在为止」，前端也就不会拿它当判据 */
  durationMs?: number;
  stepCount: number;
  toolCount: number;
  toolErrors: number;
  toolUnknown: number;
  errorCount: number;
  /** 这一轮有东西被上限丢掉（工具行/步/错误任一） */
  truncated: boolean;
}

/**
 * 读数：最新在前。
 * 空数组 = 这个会话还没跑过 —— **不是** undefined（调用方按模式决定发不发）。
 */
export interface RunReadout {
  runs: RunSummary[];
}

// ---------- 上限（数字的理由：真实数据是每轮 1~5 次工具、1 次工具/步，下面全是 20~100 倍余量；
//            它们存在的意义是「跑飞时不冻住面板与宿主」，不是为了省内存） ----------

/** 保留最近多少轮。20 轮 ≈ 一次调试会话；最坏内存约 20 × (100 行 × ~110B + 100 步 × ~60B) ≈ 340 KB。 */
export const MAX_RUNS = 20;
/** 单轮最多留多少**工具行**。读一次跑 5000 遍的失控循环不该把面板撑爆。 */
export const MAX_TOOL_ROWS = 100;
/** 单轮最多留多少**步**。 */
export const MAX_STEPS = 100;
/** 单轮最多留多少**错误**（实践中一轮 0~2 条）。 */
export const MAX_ERRORS = 10;

/**
 * 终态优先级：`endRun` 只在**严格更大**时才覆盖。
 *
 * 这张表是刻意的，四种情形都真实存在：
 *   · wire 报 `aborted`、随后 idle 还是来了 → `endRun('done')` 不许把 `aborted` 洗成「已完成」；
 *   · `endRun('error', …)` 永远赢；
 *   · 杀进程（没有 `turn/end`）→ 从 `running` 落成 `interrupted`；
 *   · wire 已报 `completed`、而用户在 idle 到达前按了停止 → 落成 `interrupted`。
 *     看着别扭，但与**转写里那个气泡同一口径**（`_finishTurn('interrupted')` →
 *     `_finalizeOpenAssistant` 把助手气泡标成 interrupted）：一边说「已完成」、一边画成被打断，
 *     才是真的没法解释。窗口只有一个微任务那么宽，实践中几乎撞不上。
 *
 * 注意 `interrupted` 与 `aborted` 同秩 —— 两者都是「没跑完」，谁先到就记谁，不做更细的仲裁。
 */
const OUTCOME_RANK: Record<RunOutcome, number> = {
  running: 0,
  completed: 1,
  aborted: 2,
  interrupted: 2,
  error: 3,
};

/** `turn/end` 的 reason.kind → 我们的终态。白名单外的一律 `error`（与 provider 的判据同源）。 */
function outcomeFromKind(kind: string): RunOutcome {
  if (kind === 'completed') return 'completed';
  if (kind === 'aborted') return 'aborted';
  if (kind === 'interrupted') return 'interrupted';
  return 'error';
}

// ---------- 窄化小工具（`unknown` 进，安全出） ----------

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 帧时间：非有限数一律当没有（`undefined` 的耗时好过 `NaN`）。 */
function asTime(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 只在前端确实晚于后端时给耗时；否则缺省（绝不产出负数）。 */
function dur(from?: number, to?: number): number | undefined {
  return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}

/**
 * call/result 的对齐键：优先 `callId`（call 在 `data.callId`，result 嵌在
 * `data.message.content[].toolCallId`），两边都取不到才退而用 `turn:step`。
 *
 * **与 `chatViewProvider._toolKey` 逐字同源**（那里现在只是本函数的一行委托）——
 * 两份实现漂移的代价是「检查器把结果算到 A 行、转写把它画到 B 卡」。
 */
export function toolKeyFrom(data: unknown): string {
  const d = asObject(data);
  let callId = d?.callId;
  if (typeof callId !== 'string' || !callId) {
    // 逐字复刻 provider 的查找顺序：先找**第一个 truthy 的 toolCallId 块**，再判它是不是字符串。
    // （换成「第一个字符串型 toolCallId」在病态数据上会选出不同的块，那就不叫同源了。）
    const block = asArray(asObject(d?.message)?.content).find((b) => {
      const o = asObject(b);
      return o !== undefined && Boolean(o.toolCallId);
    });
    const id = asObject(block)?.toolCallId;
    if (typeof id === 'string') callId = id;
  }
  return typeof callId === 'string' && callId
    ? `c:${callId}`
    : `ts:${String(d?.turn ?? '')}:${String(d?.step ?? '')}`;
}

/** DSH 补平中断轮时补写的结果帧，`message.id` 长这样：`interrupted-tool-result-<callId>-<seq>`。 */
const REPAIR_ID_PREFIX = 'interrupted-tool-result-';

/**
 * 这是不是 DSH **补平中断轮**时补写的「结果」。
 *
 * 判据只有这两处，都是 2026-09-17 那份真实日志里逐字出现的：
 *   · `error.code === 'TOOL_NOT_STARTED'`（调用**从未被记录为开始**）
 *   · `message.id` 以 `interrupted-tool-result-` 开头（已记录、但结果没落盘）
 * 帧上没有更结构化的「结果未知」字段可用 —— `isError` 反而是**反着的**（见下）。
 */
export function isRepairResult(data: unknown): boolean {
  const d = asObject(data);
  if (!d) return false;
  if (asString(asObject(d.error)?.code) === 'TOOL_NOT_STARTED') return true;
  return (asString(asObject(d.message)?.id) ?? '').startsWith(REPAIR_ID_PREFIX);
}

/** 一条 `tool/result` 给工具行的状态。 */
export type ToolResultVerdict = 'ok' | 'error' | 'unknown';

/**
 * 这次 `tool/result` 算成功、失败、还是**未知**。**三态，不是布尔。**
 *
 * ⚠️ **为什么必须三态**：DSH 补平悬空 turn 时补写的结果帧，**正文自己写着「结果未知」，
 * 帧上却照样带 `isError: true`**（实测原文：「…but no result was durably recorded.
 * Its outcome is unknown.」）。只按 `isError` 判，就会把「未知」涂成红色的「失败」——
 * 那正是 `RunToolState` 立身要避免的那句谎话。先前只判失败/成功两态没暴露，靠的是**运气**：
 * 这些帧多半在进程重启时才落盘，那时轮已经结束、落在 `_liveRunning` 闸外，压根不入账。
 *
 * 其余照旧：`data.error` 非空或任一 `tool-result` 块的 `isError` → 失败。注意**命令非零退出
 * 也算失败**（DSH 把它标成 `isError`）—— 这是「工具报错」，与「本轮出错」
 * （`RunOutcome === 'error'`）是两件事，别混。
 */
export function toolResultVerdict(data: unknown): ToolResultVerdict {
  if (isRepairResult(data)) return 'unknown';
  const d = asObject(data);
  if (!d) return 'ok';
  let failed = d.error !== undefined && d.error !== null;
  for (const b of asArray(asObject(d.message)?.content)) {
    const o = asObject(b);
    if (!o || o.type !== 'tool-result') continue;
    if (o.isError) failed = true;
  }
  return failed ? 'error' : 'ok';
}

/**
 * 本轮的运行时间线累积器。
 *
 * 生命周期**不由本模块管**：会话身份是 `uiSessionId` **入参**（不是内部状态），所以
 * 换会话 / 换模式 / 新建 / fork 时**没有任何东西需要重置** —— provider 的五个
 * `_resetTurnUsage()` 调用点一行都不用动。这是刻意的：少一处「忘了清」的机会。
 */
export class RunInspector {
  /** 最新在前。**全局一个环**，按会话过滤在读取时做（见文件头约束 3）。 */
  private _runs: RunRecord[] = [];
  /** 当前开着的那一轮（全局最多一轮 —— 一个扩展宿主同时只跑一轮）。 */
  private _open?: RunRecord;
  /** 自增主键。`reset()` 会归零，而 `reset()` 只在视图销毁时调用（那时 webview 也一起没了）。 */
  private _seq = 0;
  /**
   * 本轮已经记过一条「线上出错」了。
   *
   * 为什么要这个 flag：`endRun('error', …)` 要处理**一轮都没开始就出错**（spawn 失败、
   * prompt RPC 失败 —— 那种情形 `_open` 是空的，却同样值得留一条记录）。而收尾之后
   * `_open` 已被清空，同一个错误再上浮一次就会凭空空开第二条记录。有了它，
   * 重复的 `endRun('error')` 是安全的空操作。下一轮真正开起来时（`_ensureRun` 建新轮）清掉。
   */
  private _errorClaimed = false;
  /**
   * 被上限丢掉的那些 call 的键，用于让它们迟到的 result 落进 `unmatched` 而不是
   * **错关一条留存的 running 行**（那会把耗时算到另一次工具头上）。
   *
   * 有界：只记最近 `MAX_TOOL_ROWS` 个。超过这个量级的失控循环里，最老的那批丢失键会被
   * 遗忘，其结果会退化成「就近关一条」—— 在一个已经明说「另有 N 次未记录」的截断视图里，
   * 这是最不坏的选择。
   */
  private _droppedKeys = new Set<string>();
  /**
   * 每轮**已计入 `stepsDropped` 的步号**。
   *
   * 少了它就会双计：`step/start` 与 `step/end` 各来一次，两步都在上限之外 → 同一个步数两遍。
   * （实测就是这么发现的：150 步、上限 100，`stepsDropped` 报了 100 而不是 50。）
   * 按轮 id 存，随环淘汰一起清（见 `_createRun`），不随会话数增长。
   */
  private _droppedSteps = new Map<number, Set<number>>();

  /**
   * 收一帧。返回「这帧改变了可展示的读数吗」—— 调用方据此决定要不要下发。
   *
   * 绝大多数帧返回 `false`（`assistant/chunk` 全在内）—— 这就是本功能的全部体积故事：
   * 819/823 的帧一次都不产生下发给 webview 的消息。
   */
  apply(frame: RunFrameLike, uiSessionId: string): boolean {
    const ev = asObject(frame)?.event;
    const type = asString(asObject(ev)?.type);
    if (!type) return false;
    const data = asObject(asObject(ev)?.data);
    const t = asTime(asObject(ev)?.time);
    const dshId = asString(asObject(frame)?.sessionId);

    switch (type) {
      case 'turn/start': {
        const run = this._ensureRun(uiSessionId, dshId, data);
        this._touch(run, t);
        if (run.startedAt === undefined) run.startedAt = t;
        return true;
      }
      case 'step/start': {
        const run = this._ensureRun(uiSessionId, dshId, data);
        this._touch(run, t);
        const n = this._stepNo(data);
        const row = run.steps.find((s) => s.step === n && s.endedAt === undefined);
        if (row) {
          if (row.startedAt === undefined) row.startedAt = t;
        } else if (run.steps.length < MAX_STEPS) {
          run.steps.push({ step: n, startedAt: t });
        } else {
          this._dropStep(run, n);
        }
        return true;
      }
      case 'step/end': {
        const run = this._ensureRun(uiSessionId, dshId, data);
        this._touch(run, t);
        const n = this._stepNo(data);
        let row = run.steps.find((s) => s.step === n && s.endedAt === undefined);
        if (!row) {
          // step/start 被丢了（帧缺失）也要能收尾 —— 建一条只有终点的步，耗时缺省。
          if (run.steps.length >= MAX_STEPS) {
            this._dropStep(run, n);
            return true;
          }
          row = { step: n };
          run.steps.push(row);
        }
        if (row.endedAt === undefined) row.endedAt = t;
        row.durationMs = dur(row.startedAt, row.endedAt);
        return true;
      }
      case 'tool/call': {
        const run = this._ensureRun(uiSessionId, dshId, data);
        this._touch(run, t);
        const key = toolKeyFrom(data);
        if (run.tools.length >= MAX_TOOL_ROWS) {
          // 丢掉的是**行**，不是事实：计数继续涨，面板会写明「另有 N 次未记录」。
          run.toolsDropped++;
          this._rememberDropped(key);
          return true;
        }
        run.tools.push({
          index: run.tools.length + run.toolsDropped + 1,
          step: this._stepNo(data),
          name: asString(data?.name) || 'tool',
          key,
          state: 'running',
          startedAt: t,
        });
        return true;
      }
      case 'tool/result': {
        const run = this._ensureRun(uiSessionId, dshId, data);
        this._touch(run, t);
        // 配对三步（①② 分开是为了让「键没对上」这件事在 400 次时能被 unmatched 看见 ——
        // provider 的兜底把它静默盖掉了，这里不盖；② 对补平帧不开放，见那里的注释）：
        const key = toolKeyFrom(data);
        const repair = isRepairResult(data);
        let row = this._lastRunning(run, (r) => r.key === key);
        // ② 键对不上（callId 缺失等）：与 provider 的兜底同序 —— 最近一条 running 行。
        // **补平帧不走这条路**：它的 `message.id` 是补出来的，`toolCallId` 要么指回真调用、
        // 要么指一个从没开始过的调用 —— 让它去「就近关一条」等于把结果安到另一次工具头上
        // （耗时、成败全错）。配不上就老实地记进 `repaired`。
        if (!row && !repair && !this._droppedKeys.has(key)) {
          row = this._lastRunning(run, () => true);
        }
        if (!row) {
          // ③ 配不上任何一行：不建行、不报错，只计数（配对键失效的唯一可观测入口）。
          // 但要**分两种**，否则一个必然出现的运行时行为会被报成我们的 bug：
          //   · DSH 补平帧（运行时代写的）→ repaired；
          //   · 其余（键失效，或对应的 call 被上限丢掉了）→ unmatched。
          if (repair) run.repaired++;
          else run.unmatched++;
          return true;
        }
        row.endedAt = t;
        row.durationMs = dur(row.startedAt, row.endedAt);
        row.state = toolResultVerdict(data);
        return true;
      }
      case 'turn/end': {
        const run = this._ensureRun(uiSessionId, dshId, data);
        this._touch(run, t);
        const reason = asObject(data?.reason);
        const kind = asString(reason?.kind);
        if (kind !== undefined) run.reasonKind = kind;
        const mapped = kind !== undefined ? outcomeFromKind(kind) : 'completed';
        if (OUTCOME_RANK[mapped] > OUTCOME_RANK[run.outcome]) run.outcome = mapped;
        if (run.endedAt === undefined) run.endedAt = t;
        run.durationMs = dur(run.startedAt, run.endedAt);
        // ⚠️ 这里**不写 error 条目**：非白名单的 kind 会让 provider 调 `_surfaceLiveError`
        // → 那边的 `endRun('error', msg)` 才是唯一写错误的地方。两边都写就是每条错误显示两遍。
        return true;
      }
      default:
        // assistant/chunk（数量占绝对多数）、assistant/message、request/context、
        // request/header、user/message、session/title、agent/inbox/*、subagent.* …
        // 一律不入账，且一次都不下发。
        return false;
    }
  }

  /**
   * 本轮收尾（**UI 侧的真相**：idle / abort / 出错）。
   *
   * 幂等：重复调用返回 `false`。
   *
   * 关的是**当前开着的那一轮**，不看 `uiSessionId` 是否与它一致 —— 全局同时只有一轮在跑，
   * 而「切会话」那条路上 `_cancelActiveRun` 是同步收尾的（`_active` 那时还是旧会话）。
   * `uiSessionId` 只在**没有开着的轮**时用得上：那说明一轮都没开始就出错了。
   */
  endRun(outcome: 'done' | 'interrupted' | 'error', uiSessionId: string, message?: string): boolean {
    const mapped: RunOutcome =
      outcome === 'done' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'error';
    let run = this._open;
    if (!run) {
      // 没有开着的轮：正常收尾当作没事发生（`finally` 兜底会走到这里）。
      // 只有**出错**值得留痕 —— spawn 失败、prompt RPC 失败那种「一轮都没开始就出错」，
      // 恰恰是最需要看到的一次失败。同一个错误重复上浮由 `_errorClaimed` 挡住。
      if (outcome !== 'error' || this._errorClaimed) return false;
      run = this._createRun(uiSessionId, undefined, 0);
      this._errorClaimed = true;
    } else if (outcome === 'error') {
      this._errorClaimed = true;
    }
    let changed = false;
    if (message !== undefined && message !== '') {
      if (run.errors.length < MAX_ERRORS) {
        run.errors.push({ at: run.lastFrameAt, message });
      } else {
        run.errorsDropped++;
      }
      changed = true;
    }
    if (OUTCOME_RANK[mapped] > OUTCOME_RANK[run.outcome]) {
      run.outcome = mapped;
      changed = true;
    }
    if (this._closeDangling(run)) changed = true;
    if (run.endedAt === undefined) {
      // 没有 turn/end（被杀的轮）→ 用收到的最后一帧当终点。只信 wire 的钟，本模块不调 Date.now()。
      run.endedAt = run.lastFrameAt;
      run.durationMs = dur(run.startedAt, run.endedAt);
      if (run.endedAt !== undefined) changed = true;
    }
    if (this._open === run) this._open = undefined;
    return changed;
  }

  /** 该 UI 会话保留的轮次摘要（最新在前）。没有 → `{runs: []}`。 */
  readout(uiSessionId: string): RunReadout {
    const runs: RunSummary[] = [];
    for (const r of this._runs) {
      if (r.uiSessionId !== uiSessionId) continue;
      let toolErrors = 0;
      let toolUnknown = 0;
      for (const t of r.tools) {
        if (t.state === 'error') toolErrors++;
        else if (t.state === 'unknown') toolUnknown++;
      }
      const errorCount = r.errors.length + r.errorsDropped;
      runs.push({
        id: r.id,
        turn: r.turn,
        outcome: r.outcome,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        stepCount: r.steps.length + r.stepsDropped,
        toolCount: r.tools.length + r.toolsDropped,
        toolErrors,
        toolUnknown,
        errorCount,
        truncated: r.stepsDropped > 0 || r.toolsDropped > 0 || r.errorsDropped > 0,
      });
    }
    return { runs };
  }

  /** 该 UI 会话的完整记录（最新在前）。**只在面板开着时**才要（体积 O(轮数 × 工具数)）。 */
  details(uiSessionId: string): RunRecord[] {
    return this._runs.filter((r) => r.uiSessionId === uiSessionId);
  }

  /** 视图销毁：整片清掉。 */
  reset(): void {
    this._runs = [];
    this._open = undefined;
    this._seq = 0;
    this._errorClaimed = false;
    this._droppedKeys.clear();
    this._droppedSteps.clear();
  }

  // ---------- 内部 ----------

  /**
   * 找到（或开一条）这一帧所属的轮。
   *
   * 键是**三路** `(uiSessionId, dshSessionId, turn)` 而非只有 turn：DSH 身份丢失后
   * 新会话的轮号会从 1 重数，两路键会把新会话的第 1 轮折进旧的那条已收尾记录里。
   *
   * 键命中已有记录（**包括已收尾的**）就折回去 —— 于是收尾之后才到的迟到帧
   * （`tool/result` 追着被杀进程的尾巴来）不会凭空空开第二条。
   */
  private _ensureRun(
    uiSessionId: string,
    dshSessionId: string | undefined,
    data: Record<string, unknown> | undefined
  ): RunRecord {
    const turn = this._turnNo(data);
    const hit = this._runs.find(
      (r) => r.uiSessionId === uiSessionId && r.dshSessionId === dshSessionId && r.turn === turn
    );
    if (hit) return hit;
    const run = this._createRun(uiSessionId, dshSessionId, turn);
    if (this._open && this._open !== run) {
      // 上一轮还没收尾就来了新一轮（缺 turn/end）→ 强制收尾并打标。
      // 正常路径下走不到：运行时会先补一条 turn/end{interrupted} 把悬空尾轮关掉。
      const prev = this._open;
      if (OUTCOME_RANK.interrupted > OUTCOME_RANK[prev.outcome]) prev.outcome = 'interrupted';
      prev.superseded = true;
      prev.endedAt = prev.lastFrameAt;
      prev.durationMs = dur(prev.startedAt, prev.endedAt);
      this._closeDangling(prev);
    }
    return run;
  }

  private _createRun(uiSessionId: string, dshSessionId: string | undefined, turn: number): RunRecord {
    const run: RunRecord = {
      id: ++this._seq,
      uiSessionId,
      dshSessionId,
      turn,
      outcome: 'running',
      steps: [],
      stepsDropped: 0,
      tools: [],
      toolsDropped: 0,
      unmatched: 0,
      repaired: 0,
      errors: [],
      errorsDropped: 0,
    };
    this._runs.unshift(run);
    if (this._runs.length > MAX_RUNS) {
      this._runs.length = MAX_RUNS; // 从尾部丢弃最老的
      // 顺手把被淘汰那几轮的丢步记录清掉 —— 否则这张表会随「跑过的轮数」无界增长
      if (this._droppedSteps.size > MAX_RUNS) {
        for (const id of [...this._droppedSteps.keys()]) {
          if (!this._runs.some((r) => r.id === id)) this._droppedSteps.delete(id);
        }
      }
    }
    this._open = run;
    this._errorClaimed = false; // 新的一轮真的开起来了 → 「一轮没开就出错」那段翻篇
    this._droppedKeys.clear(); // 丢失键只在本轮内有意义
    return run;
  }

  private _touch(run: RunRecord, t: number | undefined): void {
    if (t !== undefined) run.lastFrameAt = t;
  }

  private _lastRunning(
    run: RunRecord,
    match: (row: RunToolRow) => boolean
  ): RunToolRow | undefined {
    for (let i = run.tools.length - 1; i >= 0; i--) {
      const row = run.tools[i];
      if (row.state === 'running' && match(row)) return row;
    }
    return undefined;
  }

  /** 收尾时把还挂着的 `running` 行落成 `unknown`（**不是** error —— 见 `RunToolState` 的注释）。 */
  private _closeDangling(run: RunRecord): boolean {
    let changed = false;
    for (const t of run.tools) {
      if (t.state === 'running') {
        t.state = 'unknown';
        changed = true;
      }
    }
    return changed;
  }

  private _dropStep(run: RunRecord, n: number): void {
    let seen = this._droppedSteps.get(run.id);
    if (!seen) {
      seen = new Set<number>();
      this._droppedSteps.set(run.id, seen);
    }
    if (seen.has(n)) return; // 同一步的 start 与 end 只算一次
    seen.add(n);
    run.stepsDropped++;
  }

  private _rememberDropped(key: string): void {
    if (this._droppedKeys.has(key)) return;
    this._droppedKeys.add(key);
    if (this._droppedKeys.size > MAX_TOOL_ROWS) {
      // Set 保插入序 → 删第一个就是最老的
      for (const k of this._droppedKeys) {
        this._droppedKeys.delete(k);
        break;
      }
    }
  }

  private _turnNo(data: Record<string, unknown> | undefined): number {
    const v = data?.turn;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  private _stepNo(data: Record<string, unknown> | undefined): number {
    const v = data?.step;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
}
