/**
 * C6 会话全文检索 —— **纯函数，零依赖**。
 *
 * ⚠️ 本模块只 `import type`，**绝不 import `vscode`**：`scripts/probe-session-tools.mjs`
 * 要在扩展宿主之外直接加载编译产物跑边界用例，一旦引入 `vscode` 就再也加载不起来。
 *
 * 为什么检索必须在扩展侧做：webview 手里只有 `SessionSummary`（id/标题/时间），
 * 转写正文在 `StoredSession.messages` 里、只在宿主侧。所以 webview 那个搜索框的职责
 * 从「本地过滤」改成「发查询 → 收命中」。
 */
import type { ChatMessage, SearchHit, SearchSnippet } from './protocol';
import type { StoredSession } from './sessionStore';

/** 片段里匹配点前/后各留多少字符。前面少留（一眼看到词就够）、后面多留（看清整句）。 */
const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 60;

/**
 * `toolInput` 参与检索的长度上限。
 *
 * **必须截断**：`toolInput` 由 `prettyValue()` 生成、**没有任何长度上限**（对比 `toolOutput`
 * 有 4000 的上限），而 write/edit 的入参里带着整份文件正文 —— 不截就是「搜文件内容」，
 * 噪音比搜 `toolOutput` 还大，且每次检索都要重扫几 MB。
 * 前 400 字符足以覆盖 bash 命令原文与 fs 工具的路径参数，正是用户要搜的那部分。
 */
export const SEARCH_TOOL_INPUT_CHARS = 400;

/** 转义正则元字符 —— 没有它，搜 `a.c` 会把 `abc` 也算命中。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * 切片段。**下标的来源是 `match.index`，永远落在原串上** —— 这就是全程用正则而不是
 * `toLowerCase()+indexOf` 的原因：`İ`(U+0130) 这类字符小写后长度会变 2，那种写法会让
 * 下标整体错位、片段切在离命中十万八千里的地方，且不报错。
 */
function makeSnippet(hay: string, index: number, len: number): SearchSnippet {
  let start = Math.max(0, index - SNIPPET_BEFORE);
  let end = Math.min(hay.length, index + len + SNIPPET_AFTER);

  // 边界别切在代理对中间：切出来一个落单的半个 emoji，渲染成 � 且长度对不上。
  if (start > 0 && isLowSurrogate(hay.charCodeAt(start))) {
    start--;
  }
  if (end < hay.length && isHighSurrogate(hay.charCodeAt(end - 1))) {
    end--;
  }

  // 片段要能一行显示（命中常常落在多行正文里）
  const flat = (t: string): string => t.replace(/\s+/g, ' ');

  return {
    before: (start > 0 ? '…' : '') + flat(hay.slice(start, index)),
    match: flat(hay.slice(index, index + len)),
    after: flat(hay.slice(index + len, end)) + (end < hay.length ? '…' : ''),
  };
}

/**
 * 一条消息里**参与检索的字段**，顺序即优先级（先命中的字段出片段）。
 *
 * 有意排除的两类：
 * - **`role:'note'` 整条不搜**。全库的 note 都是我们自己写的状态播报（「已开启全新 DSH 会话…」
 *   「已允许执行：…」），搜「会话」「DSH」「已允许」会命中几乎每个会话，片段毫无信息量。
 *   它想提供的那些信息（我上次跑过什么命令）本来就由 `toolInput` 覆盖。
 * - **`toolOutput` 不搜**（用户拍板的检索范围：正文 + 工具的命令名与入参）。
 */
function searchableFields(m: ChatMessage): string[] {
  if (m.role === 'note') {
    return [];
  }
  const fields: string[] = [];
  if (m.role === 'user' || m.role === 'assistant') {
    fields.push(m.text ?? '');
  }
  if (m.role === 'tool') {
    fields.push(m.toolName ?? '');
    fields.push((m.toolInput ?? '').slice(0, SEARCH_TOOL_INPUT_CHARS));
  }
  // 用户消息允许「只有附件、正文为空」——这类消息只能靠文件名/路径搜到
  for (const a of m.attachments ?? []) {
    fields.push(a.name ?? '');
    fields.push(a.path ?? '');
  }
  return fields;
}

/**
 * 在当前模式的历史里做全文检索。
 *
 * @param sessions 待检索的会话（调用方传 `_store.all()` 即可 —— 回收站条目由本函数自行排除）
 * @returns 命中列表，按 `updatedAt` 倒序
 */
export function searchSessions(sessions: StoredSession[], query: string): SearchHit[] {
  const q = query.trim();
  if (!q) {
    return [];
  }

  // ⚠️ 这个正则**只能喂给 `matchAll`**，绝不要在上面调 `.test()` / `.exec()`：
  // 那两个会改写 lastIndex，把后续所有 `matchAll` 的起点带偏（`matchAll` 内部克隆正则、
  // 不改动本对象，所以共享它是安全的）。
  const re = new RegExp(escapeRegExp(q), 'gi');
  const hits: SearchHit[] = [];

  for (const s of sessions) {
    // 回收站里的不参与检索 —— 放在这里而不是只靠调用方传 active()，是防调用点写错
    if (s.deletedAt !== undefined) {
      continue;
    }

    let count = 0;
    let snippet: SearchSnippet | undefined;

    for (const m of s.messages) {
      for (const field of searchableFields(m)) {
        if (!field) {
          continue;
        }
        const matches = [...field.matchAll(re)];
        if (matches.length === 0) {
          continue;
        }
        count += matches.length;
        if (!snippet) {
          // 恒取「第一条命中消息里的第一次出现」→ 同一份历史 + 同一个词总是同一个片段
          const first = matches[0];
          snippet = makeSnippet(field, first.index ?? 0, first[0].length);
        }
      }
    }

    // 标题只决定「进不进结果集」：标题匹配而正文没匹配 → count 0、无片段，
    // UI 据此不显示「N 处」（标题命中本来就在眼前，再截一段出来是废话）。
    const titleHit = new RegExp(escapeRegExp(q), 'i').test(s.title ?? '');
    if (titleHit || count > 0) {
      hits.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, count, snippet });
    }
  }

  return hits.sort((a, b) => b.updatedAt - a.updatedAt);
}
