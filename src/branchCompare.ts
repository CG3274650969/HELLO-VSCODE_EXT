/**
 * C15「分支对照视图」的纯函数：两条会话之间**怎么比**，以及**它们是否共享 DSH 记忆**。
 * **不 import vscode** —— 判据必须能在扩展宿主之外加载（C10b 的教训）。
 *
 * 三条实测事实决定了这里的一切（出处见 docs/backlog.md 的 C15 一节）：
 *
 * 1. **两条分支的转写是逐字相同的深拷贝**（`_forkSession` 走 `JSON.parse(JSON.stringify(...))`）
 *    ⇒ 它们有一段**精确的共同前缀**，而且那段就是分叉点。
 * 2. **消息 id 里嵌着产生它的那条会话的 uuid**（`_nextMsgId` 返回 `` `${active.id}#${n}` ``）
 *    ⇒ 副本里的 id 仍带**源会话的** uuid，fork 之后的消息才带 fork 的。
 *    于是「按 id 逐条比」既稳定（id 不随正文变化）又不会假阳（两条无关会话的 uuid 不同，
 *    前缀恒为 0）。**这个比较不需要正文、不需要时间戳，只需要 id。**
 * 3. **拷完之后源会话还会被原地归一化、fork 那份不会**（`freezeTranscript` 只作用于被打开的那条）
 *    ⇒ 会出现「同 id 但 status 不同」。这不影响分叉点（id 一样就是共同前缀），但**面板若声称
 *    「共同前缀两侧逐字相同」就是谎话** ⇒ 所以有 `drifted`，把这类条数点出来。
 *
 * 两条「照直觉写就会错」的清单，探针里有对应反控：
 *
 * - **串话判据不能只看盘**：补丁不可用时 `_ensureDshSession` 的 `existing` 分支提前 return、
 *   **从不查盘**，且三条路里只有一条写盘 ⇒ 那种模式下 fork 与源**两侧盘上都没有 `dsh`**，
 *   但 `_dshSessions` 里确实共用同一个 id —— **真串话**。只看盘会静默漏报，正是本项要防的那件事。
 * - **共同前缀为 0 不能说成「分叉点在第 1 条」**：那读起来像一次正常的分支，实际是「这两条根本
 *   不是同一次分支的结果」。
 */

import type { ChatMessage } from './protocol';
import { freezeTranscript } from './sessionStore';
// 只要类型：编译后不留 require（与上面那行**值**导入相抵，运行时没有环 ——
// sessionStore 只 import fs/path/crypto 与 protocol，不 import 本文件、也不 import vscode）。
import type { StoredSession } from './sessionStore';

/**
 * 分支标题的后缀。**全仓唯一定义**（`_forkSession` 也从这里取）——
 * 它是 fork 在盘上留下的**唯一**痕迹（`StoredSession` 里没有 `forkedFrom`，
 * 而 C15 有意不加：识别只靠消息 id 与这个后缀这两条既有痕迹）。
 */
export const FORK_SUFFIX = '（分支）';

// ---------------------------------------------------------------- 分叉点

/** 共同前缀里**参与比对**的字段。⚠️ 是提示不是逐字 diff：附件与其余字段都不比。 */
const CONTENT_FIELDS = ['role', 'status', 'toolName', 'toolInput', 'toolOutput'] as const;

/** 两条同 id 的消息，内容是否一致（`drifted` 的判据）。 */
function sameContent(a: ChatMessage, b: ChatMessage): boolean {
  if (a.text !== b.text) return false;
  for (const f of CONTENT_FIELDS) {
    if (a[f] !== b[f]) return false;
  }
  return a.toolState === b.toolState;
}

export interface Divergence {
  /**
   * `same` = 两侧是同一条会话（UI 会拦，但函数必须自己认得 —— 否则
   * `shared === |a| === |b|` 会被读成「完全一致的分支」）；
   * `fork` = 有共同前缀（这就是分叉点）；`none` = 一条共同消息都没有。
   */
  kind: 'same' | 'fork' | 'none';
  /** 共同前缀条数（`kind === 'none'` 时恒 0）。 */
  shared: number;
  /** 两侧**分叉点之后**的条数。与 `frozenTail(s, shared)` 的长度**同源**（探针钉这条等式）。 */
  aAfter: number;
  bAfter: number;
  /** 共同前缀里「同 id 但内容不同」的条数（事实 3）。 */
  drifted: number;
}

/**
 * 比出分叉点。按 **id** 逐条比（见头注释事实 2）—— 正文一个字都不参与。
 *
 * ⚠️ 只看 id 的代价：**手工复制粘贴出来的两条相似会话算不出共同前缀**（会说「没有共享消息」）。
 * 这是有意的：宁可说不知道，也不按正文相似度去猜。
 */
export function divergenceOf(a: StoredSession, b: StoredSession): Divergence {
  if (a.id === b.id) {
    return { kind: 'same', shared: a.messages.length, aAfter: 0, bAfter: 0, drifted: 0 };
  }
  const max = Math.min(a.messages.length, b.messages.length);
  let shared = 0;
  let drifted = 0;
  while (shared < max) {
    const ma = a.messages[shared];
    const mb = b.messages[shared];
    if (ma.id !== mb.id) break;
    if (!sameContent(ma, mb)) drifted++;
    shared++;
  }
  return {
    kind: shared > 0 ? 'fork' : 'none',
    shared,
    aAfter: a.messages.length - shared,
    bAfter: b.messages.length - shared,
    drifted,
  };
}

/** 一句话说清分叉点。⚠️ 左侧一律叫「左」、右侧一律叫「右」（与面板的栏序一致）。 */
export function divergenceLine(d: Divergence): string {
  if (d.kind === 'same') {
    return '两侧是同一条会话 —— 对照要看的是两条不同的会话';
  }
  if (d.kind === 'none') {
    // ⚠️ 绝不能说成「分叉点在第 1 条」：那读起来像一次正常的分支
    return '两侧没有共享消息 —— 不是同一次分支的结果（或源会话的那一段已被清掉）';
  }
  const drift = d.drifted > 0 ? ` · 其中 ${d.drifted} 条同 id 但内容已被改动` : '';
  return `分叉点在第 ${d.shared} 条 · 此后 左 ${d.aAfter} 条 / 右 ${d.bAfter} 条${drift}`;
}

/** 悬停展开：把判据本身说出来，免得用户以为这是按正文相似度猜的。 */
export function divergenceTitle(d: Divergence): string {
  return (
    '判据：两条会话的消息 id 逐条比对。分支是从源会话**深拷贝**出来的，' +
    '而消息 id 里带着产生它的会话 uuid，所以副本与前缀逐字同 id ⇒ 共同前缀就是分叉点。' +
    '手工复制粘贴出来的相似会话算不出来（会显示「没有共享消息」）—— 不按正文相似度猜。' +
    `\n本次：共同前缀 ${d.shared} 条；此后 左 ${d.aAfter} 条 / 右 ${d.bAfter} 条；` +
    `共同前缀里内容已改动的 ${d.drifted} 条。`
  );
}

/**
 * 某一栏顶上那句「共同前缀」说明。判定的部分放这里、不放 webview —— 免得两边各写一套。
 */
export function sharedPrefixNote(shared: number, drifted: number): string {
  if (shared === 0) return '没有共享消息（新会话，或不与对侧同源）';
  const drift = drifted > 0 ? ` · 其中 ${drifted} 条内容已改动` : '';
  return `共同前缀 ${shared} 条已折叠（两侧同源）${drift}`;
}

// ---------------------------------------------------------------- 串话

export type CrossTalkKind = 'shared' | 'distinct' | 'unknown';

export interface CrossTalk {
  kind: CrossTalkKind;
  /** 这次是拿哪份证据判的（面板悬停要**说出来**，别让用户以为只有一个来源）。 */
  by: 'live' | 'disk' | 'none';
  /** `kind === 'shared'` 时是那个共享的 DSH 会话 id。 */
  dshId?: string;
  /** `kind === 'unknown'` 的成因。三种各自对应一句不同的话（探针钉「两两不同」）。 */
  why?: 'no-identity' | 'one-side' | 'cwd-differs';
}

/**
 * 两条会话是否共享同一份 DSH 记忆（= 串话风险）。
 *
 * **双证据、优先级写死在这一处**（理由见头注释「串话判据不能只看盘」）：
 *   1. `live`（本次 activation 里两条 UI 会话的映射，只读、无副作用）两侧都有值 → 用它。
 *      它是**唯一**能覆盖「补丁不可用 / `hello.dsh.command` 覆盖」那两条绝不写盘的路的证据。
 *   2. 否则看盘上的 `dsh`。**同 id 还要 cwd 相同**才算真共享 ——
 *      DSH 的会话日志按 cwd 归属（`_ensureDshSession` 的 resume 条件就是 `stored?.cwd === cwd`），
 *      同 id 不同 cwd 不会真的落到同一个会话，**不该警示**。
 *   3. 其余 → `unknown`（无从判断，如实说）。
 *
 * ⚠️ 只读 `_dshSessions` 这个纯缓存。不读 `_liveRunning` / `_currentDshId` / `_turnStatus` /
 *    `_abort` 的语义 —— 那几个单值闩是 C8 的核心，C15 一个字都不碰。
 */
export function crossTalkOf(
  a: StoredSession,
  b: StoredSession,
  live?: { a?: string; b?: string }
): CrossTalk {
  if (live && live.a && live.b) {
    return live.a === live.b
      ? { kind: 'shared', by: 'live', dshId: live.a }
      : { kind: 'distinct', by: 'live' };
  }

  const da = a.dsh;
  const db = b.dsh;
  if (!da && !db) return { kind: 'unknown', by: 'none', why: 'no-identity' };
  if (!da || !db) return { kind: 'unknown', by: 'none', why: 'one-side' };
  if (da.id !== db.id) return { kind: 'distinct', by: 'disk' };
  // 同 id 不同 cwd：精确字符串比较。真 fork 是 `fork.dsh = src.dsh` 同一份字符串，
  // 精确比不会误判；只有手改过 sessions.json 才会见到这一档。
  if (da.cwd !== db.cwd) return { kind: 'unknown', by: 'disk', why: 'cwd-differs' };
  return { kind: 'shared', by: 'disk', dshId: da.id };
}

/** 一行人话。三句 `unknown` 必须**两两不同**（探针钉这条）。 */
export function crossTalkLine(c: CrossTalk): string {
  if (c.kind === 'shared') {
    return '两条会话共享同一份 DSH 记忆 —— 在任一边继续发消息，另一边也会看到';
  }
  if (c.kind === 'distinct') {
    return '两条会话的 DSH 记忆是分开的 —— 在一边发消息不会影响另一边';
  }
  if (c.why === 'cwd-differs') {
    return '两侧记着同一个 DSH 会话 id，但 cwd 不同 —— 按 DSH 的归属规则它们不会落到同一份记忆';
  }
  if (c.why === 'one-side') {
    return '只有一侧有 DSH 身份 —— 无从判断是否共享记忆';
  }
  return '两侧都还没有 DSH 身份（都还没发过消息）—— 无从判断是否共享记忆';
}

/** 悬停展开：把「凭什么是这个结论」说出来，含证据来源与 id。 */
export function crossTalkTitle(c: CrossTalk): string {
  const by =
    c.by === 'live'
      ? '判据：本次运行中的会话映射（最能反映当下 —— 有些情形下身份不落盘）'
      : c.by === 'disk'
        ? '判据：盘上保存的 DSH 身份'
        : '判据：没有形成可比较的两份证据';
  const id = c.dshId ? `\n共享的 DSH 会话 id：${c.dshId}` : '';
  const same = c.kind === 'shared' ? '\n判定为共享、且未落盘的场景：仅在本 activation 内有效。' : '';
  return `${by}${id}${same}`;
}

// ---------------------------------------------------------------- 尾段与默认对侧

export interface FrozenTail {
  messages: ChatMessage[];
  /** 其中被冻结的条数（>0 时面板要说出来）。 */
  frozen: number;
}

/**
 * 取 `from` 之后的尾段并**冻结**（`streaming`→`interrupted`、`running`→`unknown`）。
 *
 * ⚠️ **深拷贝，绝不改原对象** —— 面板是只读的，改到 `_store` 里那份就等于替用户改了会话。
 * （探针有正面证明：调用前后把原 `StoredSession.messages` 序列化比一遍。）
 *
 * 归一化走 `sessionStore.freezeTranscript` —— 与「真打开这条会话」**同一条规则**，
 * 否则面板里看到的和点进去看到的会是两张脸。
 */
export function frozenTail(s: StoredSession, from: number): FrozenTail {
  const messages = JSON.parse(JSON.stringify(s.messages.slice(from))) as ChatMessage[];
  const frozen = freezeTranscript(messages);
  return { messages, frozen };
}

/**
 * 打开面板时的**默认对侧**。三级回退：
 *   ① 标题上的分支关系（fork 在盘上留下的唯一痕迹）
 *   ② 共同前缀最长的那条（>0 才算）
 *   ③ 最近更新的那条
 *
 * ⚠️ 它是**默认值不是断言**：面板永远把两条都摆出来给人改。所以这里挑错也不致命 ——
 * 但三级回退的顺序要在探针里钉住，免得退化成「随便给一条」。
 */
export function pickCounterpart(
  target: StoredSession,
  others: StoredSession[]
): StoredSession | undefined {
  const pool = others.filter((s) => s.id !== target.id);
  if (pool.length === 0) return undefined;

  // ① 标题上的分支关系：target 自己是分支 ⇒ 找它的源；否则找它分出来的那条。
  const base = target.title.endsWith(FORK_SUFFIX)
    ? target.title.slice(0, -FORK_SUFFIX.length)
    : undefined;
  const named = pool.find((s) =>
    base !== undefined ? s.title === base : s.title === target.title + FORK_SUFFIX
  );
  if (named) return named;

  // ② 共同前缀最长的那条
  let best: StoredSession | undefined;
  let bestShared = 0;
  for (const s of pool) {
    const shared = divergenceOf(target, s).shared;
    if (shared > bestShared) {
      bestShared = shared;
      best = s;
    }
  }
  if (best) return best;

  // ③ 最近更新的那条
  return pool.reduce((acc, s) => (s.updatedAt > acc.updatedAt ? s : acc), pool[0]);
}
