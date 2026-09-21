/**
 * C14「事前 diff 预览（近似）」的纯函数：把一条 `tool/call` 的入参翻成「这条调用要动哪个文件、
 * 大概改成什么样」。**不 import vscode** —— 判据必须能在扩展宿主之外加载（C10b 的教训）。
 *
 * 三条实测事实决定了这里的一切（出处见 docs/wire-vocabulary.md 的补记）：
 *
 * 1. **`tool/call` 帧在 `dispatch` 之前就 append**（`dsh-agent-loop`：`appendToolCall` 在前、
 *    `scheduler.dispatch` 在后）⇒ 它是**真·事前**信号。⚠️ 但只领先毫秒级，**不是可拦截的窗口**：
 *    真正的阻塞窗口只有 C1 的 hook（且只覆盖破坏性 bash 与工作区外的写）。别把这行当审批用。
 * 2. **`data.arguments` 是 JSON 字符串**，不是对象 ⇒ 必须先 parse，且**畸形也要不抛地退化**。
 * 3. `tool/result` 帧带 `meta.diffs`（fs 后端用它自己的真 before/after 算的 hunk）⇒ 事后那半
 *    用 `actualForecast` 收，预测一跑完就被换成事实。
 *
 * 两张「照直觉写就会错」的清单，探针里有对应反控：
 *
 * - **工具名必须精确匹配**：真实会话里存在 `todo_write`，所以 `name.includes('write')` 会假阳。
 * - **行尾必须先归一化再判命中**：本仓库自己就是 CRLF/LF 混排，拿模型给的 LF `old_string` 去
 *   `indexOf` 一个 CRLF 文件会**假报「找不到」**（而 DSH 那边其实能成功）。
 */

import * as path from 'path';
import type { DiffLine } from './protocol';
import { lineDiff, MAX_DIFF_ROWS } from './fileSnapshot';

/**
 * 会写文件的工具 —— **精确匹配**（见头注释：`todo_write` 存在，子串判据会假阳）。
 * 与 C1 的 hook matcher（`bash|write|edit`）取同一集合里的 fs 部分：
 * `bash` 不在此列 —— 它的重定向/`rm`/`tee` 是 shell 语法，猜错比不说更坏（见 backlog 的「本次不做」）。
 */
export const FORECAST_TOOLS = ['write', 'edit'] as const;
export type ForecastTool = (typeof FORECAST_TOOLS)[number];

export function isForecastTool(name: unknown): name is ForecastTool {
  return typeof name === 'string' && (FORECAST_TOOLS as readonly string[]).includes(name);
}

/** 入参：对象直接用，字符串当 JSON 解。非对象结果（`3`/`[]`/`null`）与解析失败一律 undefined，**永不抛**。 */
export function parseToolArgs(raw: unknown): Record<string, unknown> | undefined {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    try {
      v = JSON.parse(s);
    } catch {
      return undefined;
    }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/**
 * POSIX 形态（Linux 侧给的 `/mnt/d/x` 之类）：**单斜杠开头**。`//…`（UNC）不算 ——
 * 那不是「模型把 `D:\x` 写成了 POSIX」，它本来就是 Windows 上合法的绝对位置。
 *
 * ⚠️ `shellDiag.readPosixTarget` 里有一句**同形不同命**的判据（那边是*翻译*，这边是*拒绝*），
 * 两份都必须留着 —— 全仓只允许这两个宿主，`probe-change-forecast` 的 H 组钉着。
 */
export function isPosixShapedPath(raw: string): boolean {
  return raw.startsWith('/') && !raw.startsWith('//');
}

/**
 * 目标绝对路径（拿不到 → undefined）。规则与 C4 那条完全一致（只是搬了个位置）：
 * Windows 的 path 会把这个 POSIX 路径解析成「当前盘根下」某个完全错误的位置 ——
 * 宁可判不出来（调用方按越界处理，多问一次），也不乱认。
 *
 * `//…`（UNC）**不按 POSIX 处理** ⇒ 走 `path.isAbsolute` 原样返回（`\\server\share\x` 本来就是
 * 合法位置）。它算不算区外交给 `_isInside`：跨根的 `path.relative` 给绝对路径 ⇒ 按区外问一次。
 */
export function resolveTargetPath(raw: unknown, base: string): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (isPosixShapedPath(s)) return undefined;
  if (path.isAbsolute(s)) return path.resolve(s);
  const b = String(base ?? '').trim();
  return b ? path.resolve(path.join(b, s)) : undefined;
}

/** 注入的 IO：探针给假实现，扩展宿主里用真盘（**判据与实现分离**）。 */
export interface ForecastIO {
  /** 现在盘上的文本；不存在 / 二进制 / 超大 / 读失败 ⇒ undefined。缺省 = 一律说不出来。 */
  readText?: (abs: string) => string | undefined;
  /** 盘上有没有这个文件。缺省 = 由 `readText` 反推（给得出文本 ⇒ 存在）。 */
  exists?: (abs: string) => boolean;
}

/** `edit` 的 `old_string` 在**现在盘上的内容**里（已归一化行尾）的命中情况。 */
export interface EditFinding {
  occurrences: number;
  replaceAll: boolean;
}

/** 一条调用的预计改动。`kind`/`diff` 都是**预测**，跑完会被 `actualForecast` 的事实替换。 */
export interface FileForecast {
  tool: ForecastTool;
  /** 入参里原样的路径（永远给得出，哪怕解析不出绝对路径） */
  raw: string;
  /** `resolveTargetPath` 的结果；POSIX / UNC / 无基准 ⇒ undefined */
  abs?: string;
  exists?: boolean;
  /** 预测的落点性质：`write` 看盘上有没有，`edit` 恒 `modify`（它不建文件） */
  kind?: 'create' | 'modify';
  diff?: DiffLine[];
  diffTruncated?: boolean;
  /** 没有 diff 时**必须**给一句人话（不预览也要说清为什么） */
  diffNote?: string;
  /** 仅 `edit`：命中数。盘上读不到内容时**不给**（不猜） */
  finding?: EditFinding;
  /** 仅 `edit`：`old_string === new_string` —— DSH 会直接拒（这条不用读盘就知道） */
  sameText?: boolean;
}

/** 行尾归一化（只用于**命中检查**，不参与 diff 的文本）：CRLF 与 LF 混排时不许假报「找不到」。 */
function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 一条调用的预计改动。非 fs 工具 / 入参读不出路径 ⇒ undefined（**没有预测也是一种答案**，
 * 调用方据此什么都不显示，绝不留一个空壳）。
 */
export function forecastFileChange(
  name: unknown,
  args: unknown,
  base: string,
  io: ForecastIO = {}
): FileForecast | undefined {
  if (!isForecastTool(name)) return undefined;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
  if (!a) return undefined;
  const raw = typeof a.file_path === 'string' ? a.file_path.trim() : '';
  if (!raw) return undefined;

  const abs = resolveTargetPath(raw, base);
  const out: FileForecast = { tool: name, raw };
  if (!abs) {
    out.diffNote = '路径形态无法解析成盘上的位置（以 / 开头，DSH 会按 Windows 相对根解析）';
    return out;
  }
  out.abs = abs;

  const readText = io.readText;
  const before = readText ? readText(abs) : undefined;
  const exists = io.exists ? io.exists(abs) : before !== undefined;
  out.exists = exists;

  if (name === 'write') {
    out.kind = exists ? 'modify' : 'create';
    const content = typeof a.content === 'string' ? a.content : undefined;
    if (!exists) {
      out.diffNote = '新建文件';
    } else if (content === undefined) {
      out.diffNote = '入参里没有可读的 content';
    } else if (before === undefined) {
      out.diffNote = '这个文件的内容读不出来（二进制或超过 256 KB），不预览';
    } else if (before === content) {
      out.diffNote = '内容与现在盘上完全一样 —— 这次调用不会改变它';
    } else {
      const d = lineDiff(before, content);
      out.diff = d.lines;
      out.diffTruncated = d.truncated;
      out.diffNote = '按现在盘上的内容算的';
    }
    return out;
  }

  // edit：不建文件，恒 modify；diff 只在**替换片段**上算 —— 「替换哪一处」是 DSH 的语义，
  // 这里模拟它（唯一性/上下文）只会在说谎，所以干脆不模拟。
  out.kind = 'modify';
  const oldText = typeof a.old_string === 'string' ? a.old_string : undefined;
  const newText = typeof a.new_string === 'string' ? a.new_string : undefined;
  const replaceAll = a.replace_all === true;
  if (oldText === undefined || newText === undefined) {
    out.diffNote = '入参不完整（缺 old_string / new_string）';
    return out;
  }
  const d = lineDiff(oldText, newText);
  out.diff = d.lines;
  out.diffTruncated = d.truncated;
  out.sameText = oldText === newText;
  out.diffNote = '模型想把这段改成那样（只在替换片段上算，不含上下文）';
  if (!exists) {
    out.diffNote = '盘上没有这个文件';
  } else if (before !== undefined) {
    const occurrences = countOccurrences(normalizeEol(before), normalizeEol(oldText));
    out.finding = { occurrences, replaceAll };
  }
  return out;
}

/** 卡片上那一行（纯模块只出文本，UI 由调用方加 —— 体例同 C13 的 `shellStatusSegment`）。 */
export interface ForecastLines {
  text: string;
  level: 'ok' | 'warn';
  title: string;
}

/** diff 的增删行数（`edit` 的片段 diff 也走这里） */
function diffCounts(diff: DiffLine[] | undefined): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of diff ?? []) {
    if (l.kind === 'add') add += 1;
    else if (l.kind === 'del') del += 1;
  }
  return { add, del };
}

/** 事前就能说出「这次调用会失败」的那几种（返回 undefined = **没看出问题**，不是保证会成功）。 */
export function forecastProblem(f: FileForecast): string | undefined {
  if (f.tool === 'edit') {
    // DSH 自己就会拒：`parseEditArgs` 要求 old_string 非空且与 new_string 不同
    if (f.sameText) return 'old_string 与 new_string 相同 —— 这次调用会被拒';
    if (f.exists === false) return '盘上没有这个文件 —— 这次调用会失败';
    if (f.finding) {
      if (f.finding.occurrences === 0) return '现在盘上的内容里找不到这段 old_string —— 这次调用会失败';
      if (f.finding.occurrences > 1 && !f.finding.replaceAll) {
        return `这段 old_string 在盘上的内容里出现 ${f.finding.occurrences} 处，而 replace_all 没开 —— 这次调用会失败`;
      }
    }
  }
  return undefined;
}

export function forecastLine(f: FileForecast): ForecastLines {
  const problem = forecastProblem(f);
  const where = f.abs ?? f.raw;
  const { add, del } = diffCounts(f.diff);
  const kindText = f.kind === 'create' ? '新建' : '修改';
  const size = f.diff ? ` · +${add} −${del}` : '';
  const text = `预计改动 ${where}（${kindText}${size}）`;

  const lines: string[] = [];
  lines.push(problem ? `⚠️ ${problem}` : '这次调用看下来没有明显问题（不代表一定成功）');
  if (f.raw !== where) lines.push(`入参里给的是：${f.raw}`);
  if (f.diffNote) lines.push(f.diffNote);
  if (f.diffTruncated) lines.push('diff 过长，已只保留前段');
  if (!f.abs) lines.push('这类目标不会进本轮审阅（审阅按盘上的绝对路径对拍）');
  lines.push('这是预测（按 tool/call 的入参算），跑完会换成 DSH 报的实际 diff');
  return { text, level: problem || !f.abs ? 'warn' : 'ok', title: lines.join('\n') };
}

/** 事后那半：一条调用的**实际**改动（路径 + diff 都来自 DSH，不是我们算的）。 */
export interface ActualChange {
  /** DSH 报的路径，**原样**（注释说它盖的是"model-facing file_path"，可能是入参原文也可能是
   *  后端相对化过的 —— 所以只显示、不断言，F5 去看它到底长什么样） */
  path?: string;
  /** 所有 hunk 拼成一段（同一条调用只动一个文件）；hunk 之间插一条 `…` */
  diff: DiffLine[];
  diffTruncated: boolean;
  /** hunk 条数。**0 不等于「没有改动」** —— 见下面那段 */
  hunks: number;
}

/**
 * 把 `tool/result.meta.diffs` 收成事实。三种取值**必须分得开**：
 *
 * - `undefined` = 这份 meta 里没有可认的 diffs（老运行时 / 这条工具没挂 `presentationMeta` /
 *   嵌套（Code Mode）调用 / **失败路径通常压根不带 meta**）⇒ 调用方要说「这次没跑成，
 *   上面那行只是预测」，绝不能把一条预测永远挂在卡上；
 * - `{ hunks: 0 }` = DSH 报了但**一个 hunk 都没有**：`computeHunkDiffs` 在「前后文本完全相同」时
 *   返回空，而 `write` 的 `presentationMeta` 又在 `before === null`（原本没这个文件）时写死 `[]`
 *   ⇒ 这一档的两种成因是**新建文件**与**内容与改动前一样**，我们分不出来，所以话要说得能容下两者；
 * - `{ hunks: n }` = 真 hunk（每 hunk 一条；纯插入的 `oldText` 是 `null`，这里当空串）。
 *
 * 畸形（元素不是对象 / `diffs` 不是数组）⇒ 整份不认 —— 宁可不说，也不印半截。
 */
export function actualForecast(meta: unknown): ActualChange | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const diffs = (meta as { diffs?: unknown }).diffs;
  if (!Array.isArray(diffs)) return undefined;
  const out: ActualChange = { diff: [], diffTruncated: false, hunks: 0 };
  for (const item of diffs) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const rec = item as { path?: unknown; oldText?: unknown; newText?: unknown };
    if (typeof rec.newText !== 'string') return undefined;
    if (out.path === undefined && typeof rec.path === 'string') out.path = rec.path;
    // 纯插入：DSH 给 oldText=null（`isFileDiff` 认这个值），空串就是它的 diff 语义
    const oldText = typeof rec.oldText === 'string' ? rec.oldText : '';
    const d = lineDiff(oldText, rec.newText);
    if (out.hunks > 0) out.diff.push({ kind: 'ctx', text: `…（共 ${diffs.length} 段改动）` });
    out.diff.push(...d.lines);
    out.diffTruncated = out.diffTruncated || d.truncated;
    out.hunks += 1;
  }
  if (out.diff.length > MAX_DIFF_ROWS) {
    out.diff.length = MAX_DIFF_ROWS;
    out.diffTruncated = true;
  }
  return out;
}

/**
 * 事后**没能**把预测换成事实时的三种话（都写在纯模块里，好让探针直接断言 —— 这几句
 * 是「不许靠沉默说谎」那条规矩的实体：预测作废时卡上必须留一句人话）。
 */
export const FORECAST_FAILED_LINE = '这次调用失败了 —— 上面那行只是预测，不是结果';
export const FORECAST_UNKNOWN_LINE = '本轮中断：这条调用改没改，未知';
export const FORECAST_NO_DIFF_LINE = '这次调用没带回 diff 信息 —— 上面那行只是预测';

/**
 * 事后那行。`fallback` = 事前预测过的路径（DSH 没报 path 时接着用它，免得「实际改动」后面
 * 空着一块）—— 但**不假装那是 DSH 报的**，title 里说清这一步是谁给的。
 */
export function actualLine(a: ActualChange, fallback?: string): ForecastLines {
  const where = a.path ?? fallback ?? '（DSH 没报路径）';
  const { add, del } = diffCounts(a.diff);
  const lines: string[] = [];
  if (a.hunks === 0) {
    lines.push('DSH 一个 hunk 都没报 —— 它的两种成因（新建文件 / 内容与改动前完全一样）从这里分不出来');
  } else {
    lines.push(`DSH 报的改动：+${add} −${del}（${a.hunks} 段 hunk）`);
  }
  if (a.path === undefined && fallback !== undefined) lines.push(`DSH 没在这份 diff 里给路径，这里沿用事前算出来的：${fallback}`);
  if (a.diffTruncated) lines.push('diff 过长，已只保留前段');
  lines.push('这份 diff 是 DSH 自己按真 before/after 算的（不是入参预测）');
  return {
    // 恒 'ok'：`hunks === 0` 的常见成因是**新建文件**（正常事件），染成告警色会养成狼来了
    text: a.hunks === 0 ? `实际改动 ${where}（DSH 没报改动）` : `实际改动 ${where}（+${add} −${del}）`,
    level: 'ok',
    title: lines.join('\n'),
  };
}
