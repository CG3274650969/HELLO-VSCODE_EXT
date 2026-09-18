/**
 * C10：把 DSH 的**上下文压缩**变成一句用户看得见的话。
 *
 * **纯模块，绝不 import `vscode`** —— 与 `runInspector.ts` / `turnState.ts` / `sessionSearch.ts` 同规矩：
 * 自检 `scripts/probe-compaction-notice.mjs` 要在扩展宿主**之外**加载这份编译产物。
 * 为此入参是 `unknown`（照 `TurnStatus.StatusFrameLike` 的理由）：字段按需窄化，谁来喂都行。
 *
 * ## 为什么需要它（这条比代码本身重要）
 *
 * `@deepseek-ai/dsh-compaction-basic` **本来就在跑**（`runtime/cordis.default.yml` 里 compose 了，
 * `auto` 默认 true）。它触发时会把一段旧事件摘要成一个 checkpoint，并 append
 * `compaction/start|summary|end` 三个会话事件。这些事件**已经按 wire 的全量转发规则到了扩展手里**，
 * 只是 `_onDshEvent` 一个 case 都没读过 —— 也就是说：**模型记忆被折叠掉的那一刻，界面上一个字都没有**。
 * 默认阈值（0.8 × 1M）下这事基本不会发生，但一旦用户把阈值调低，它就会发生，而且**不可撤销**。
 * 本模块就是那个"至少说一声"。
 *
 * ## 三条判据（改这个文件时别丢掉）
 *
 * 1. **压缩发生了就绝不沉默。** 载荷缺字段（版本漂移、字段改名）时降级成一句"细节缺失"的说明，
 *    **而不是返回 undefined** —— 静默正是这个模块要消灭的东西。只有载荷**根本不是对象**才不发声
 *    （那不是"压缩了但没说清"，那是"这条帧不是压缩帧"）。
 * 2. **成功只在 `compaction/summary` 上报一次。** 成功路径上 `summary` 之后紧跟一个无 `error` 的
 *    `compaction/end`（插件里两句是相邻的），两边都报就会出两条重复的 note。
 * 3. **不读摘要正文。** `data.summary` 是模型写的摘要全文，把它塞进 note 就是往用户的转写里
 *    灌一份二手记忆 —— 而 DSH 侧的记忆已经是权威了。我们要说的是"发生了什么"，不是"内容是什么"。
 */

/** 一句话说明。`kind` 只影响措辞与图标，渲染方不必再判断别的。 */
export interface CompactionNotice {
  /** `done` = 摘要已落盘（DSH 侧记忆被替换）；`failed` = 压缩失败（记忆没动） */
  kind: 'done' | 'failed';
  /** 直接给用户看的一整句（渲染方原样展示，不要再拼） */
  text: string;
}

/** 错误串的展示上限。`errorChain` 会把 cause 链一路拼起来，深链可以很长。 */
const MAX_ERROR_CHARS = 300;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** token 数只做量级可读化：这里是给人看的说明，不是用量读数（那个在 `UsageReadout` 里） */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return String(Math.round(n));
  // 十万以下留一位小数：实测日常压力就在 1K–6K 这个量级，整数会把它们全压成「2K」「6K」看不出差别
  if (n < 1e5) return (n / 1000).toFixed(1) + 'K';
  if (n < 1e6) return Math.round(n / 1000) + 'K';
  return (n / 1e6).toFixed(1) + 'M';
}

/** 结尾那句必须每次都在：它同时回答"我的转写还在吗"（在）与"能撤回吗"（不能） */
const TAIL = '这是 DSH 侧的记忆替换、不可撤销；本扩展的转写不受影响，消息一条没少。';

/**
 * 认 `compaction/summary`（成功）与带 `error` 的 `compaction/end`（失败）；其余一律 undefined。
 *
 * 垃圾输入不抛 —— 它跑在事件通路里，一次抛错会连累整轮的帧处理。
 */
export function readCompactionEvent(type: unknown, data: unknown): CompactionNotice | undefined {
  if (typeof type !== 'string') return undefined;

  if (type === 'compaction/summary') {
    if (!isRecord(data)) return undefined;
    const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined;
    const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined;
    const provider = typeof data.provider === 'string' ? data.provider : undefined;
    const model = typeof data.model === 'string' ? data.model : undefined;

    const bits: string[] = [];
    if (seqs !== undefined) bits.push(`前 ${seqs} 条事件`);
    if (tokens !== undefined) bits.push(`约 ${fmtTokens(tokens)} token`);
    const by = provider && model ? `（${provider}/${model}）` : '';
    const what = bits.length
      ? `${bits.length === 2 ? `${bits[0]}（${bits[1]}）` : bits[0]}已折叠成一份摘要`
      : '一段旧事件已折叠成一份摘要（细节缺失）';
    return { kind: 'done', text: `上下文已压缩：${what}${by}。${TAIL}` };
  }

  if (type === 'compaction/end') {
    if (!isRecord(data)) return undefined;
    const raw = data.error;
    if (raw === undefined || raw === null) return undefined; // 成功路径的收尾，summary 那条已经报过
    const text = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.message === 'string' ? raw.message : '（无详情）';
    const cut = text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) + '…' : text;
    return {
      kind: 'failed',
      text: `上下文压缩失败：${cut}。DSH 的记忆这次没被改动，对话可以照常继续。`,
    };
  }

  return undefined;
}
