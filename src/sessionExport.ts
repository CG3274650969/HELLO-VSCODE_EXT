/**
 * C6 单会话导出（Markdown / JSON）—— **纯函数，零依赖**。
 *
 * ⚠️ 只 `import type`，**绝不 import `vscode`**：`scripts/probe-session-tools.mjs` 要在扩展宿主
 * 之外直接加载编译产物跑边界用例。落盘（对话框、写文件）全在 `chatViewProvider._exportSession`。
 *
 * 两种格式的分工：
 * - **JSON = 无损转储**（原对象直出，含 attachments.content / usage / dsh）—— 要备份、
 *   要交付、要将来导入，用它。
 * - **Markdown = 给人看的转写**。它是**忠实转储、不做转义**：正文里以 `#` 开头的一行会被
 *   渲染成标题。这是有意的（转义会把代码片段改得面目全非），代价写在文档里。
 */
import type { Attachment, ChatMessage } from './protocol';
import type { StoredSession } from './sessionStore';

/** Markdown 里内嵌的工具入参/输出上限（与 `MAX_TOOL_OUTPUT_CHARS` 同口径）。 */
export const MD_EMBED_MAX_CHARS = 4000;

/** 由标题生成的 `#` 行长度上限。 */
const TITLE_MAX_CHARS = 120;

/** 文件名主体长度上限（不含扩展名）。 */
const FILE_BASE_MAX_CHARS = 80;

/**
 * 控制字符与格式字符（含换行/制表/DEL/零宽连接符）。
 * 用 Unicode 属性转义，而不是把字面控制字符写进源码——那种字符在编辑器里不可见，一碰就烂。
 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]+/gu;

/** JSON 导出：`JSON.stringify(s, null, 2)` + 末尾换行（POSIX 惯例，且 diff 友好）。 */
export function sessionToJson(s: StoredSession): string {
  return JSON.stringify(s, null, 2) + '\n';
}

/** 本地时间 `YYYY-MM-DD HH:mm`。不用 `toLocaleString`：它随机器 locale 变（`2026/9/14` vs `9/14/2026`），
 *  导出的文件不该因为换了台电脑就长得不一样。 */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(ts) || Number.isNaN(d.getTime())) {
    return '（未知）';
  }
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 超长就截断并留话 —— 不截的话一次 write 调用就能把整份文件塞进 md。 */
function clip(text: string): string {
  if (text.length <= MD_EMBED_MAX_CHARS) {
    return text;
  }
  return text.slice(0, MD_EMBED_MAX_CHARS) + '\n…（已截断，完整内容用 JSON 导出）';
}

/**
 * 造一段代码围栏，**按内容里的反引号串长度动态加长**。
 *
 * 这是本文件里唯一能**静默毁掉整个导出文件**的地方：正文里只要有一行 ``` 就会提前闭合围栏，
 * 后面所有内容都变成散装的 markdown 正文。取「内容里最长的反引号串 + 1」（下限 3）即可
 * —— 四连反引号也包得住。
 */
function fence(content: string, lang: string = ''): string {
  const longest = (content.match(/`+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${content}\n${ticks}`;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** 标题行恒为一行（换行折空格）且封顶，否则标题里的换行会把 `#` 行劈成两行。 */
function titleLine(title: string): string {
  const oneLine = (title ?? '').replace(/\s+/g, ' ').trim() || '（无标题）';
  if (oneLine.length <= TITLE_MAX_CHARS) {
    return oneLine;
  }
  let cut = oneLine.slice(0, TITLE_MAX_CHARS);
  // 截断点别落在代理对中间 —— 半个 emoji 在文件里是个乱码方块
  if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) {
    cut = cut.slice(0, -1);
  }
  return cut + '…';
}

function attachmentLine(a: Attachment): string {
  const flags: string[] = [];
  if (a.selection) {
    flags.push('编辑器选区');
  }
  if (a.truncated) {
    flags.push('已截断');
  }
  if (a.readError) {
    flags.push('读取失败：' + a.readError);
  }
  // 只列名字与路径 —— 附件正文可能极大，且它与 JSON 导出完全重复
  const where = a.path ? `（\`${a.path}\`）` : '';
  return `- \`${a.name}\`${where}${flags.length ? ' · ' + flags.join(' · ') : ''}`;
}

/** 非 done 的消息补一行状态说明，别让「中断的半句话」看起来像完整回复。 */
function statusNote(m: ChatMessage): string {
  switch (m.status) {
    case 'interrupted':
      return '\n\n> ⏹️ 这条回复被中断了。';
    case 'error':
      return '\n\n> ⚠️ 这条回复出错了。';
    case 'streaming':
      return '\n\n> ⏳ 导出时这条还在生成中。';
    default:
      return '';
  }
}

function toolStateLabel(m: ChatMessage): string {
  switch (m.toolState) {
    case 'ok':
      return '已完成';
    case 'error':
      return '失败';
    case 'running':
      return '导出时仍在运行';
    default:
      return '（无状态）';
  }
}

function renderMessage(m: ChatMessage): string {
  switch (m.role) {
    case 'note':
      return `> ℹ️ ${m.text ?? ''}`;

    case 'user': {
      const parts: string[] = ['## 你'];
      const body = (m.text ?? '').trim();
      if (body) {
        parts.push(body);
      }
      // 允许「只有附件、正文为空」的消息 → 附件列表就是这条的全部内容
      if (m.attachments?.length) {
        parts.push('附件：\n' + m.attachments.map(attachmentLine).join('\n'));
      }
      return parts.join('\n\n') + statusNote(m);
    }

    case 'assistant': {
      const body = (m.text ?? '').trim() || '（空回复）';
      return `## AlohaDSH\n\n${body}${statusNote(m)}`;
    }

    default: {
      // role === 'tool'
      const head = `> 🔧 \`${m.toolName ?? '工具'}\` —— ${toolStateLabel(m)}`;
      const blocks: string[] = [head];
      const input = (m.toolInput ?? '').trim();
      if (input) {
        // bash 给语言标注，其余工具不必（入参是 JSON 片段，标了反而误导）
        blocks.push(fence(clip(input), m.toolName === 'bash' ? 'bash' : ''));
      }
      const output = (m.toolOutput ?? '').trim();
      if (output) {
        blocks.push(fence(clip(output)));
      }
      return blocks.join('\n\n');
    }
  }
}

/**
 * 用量一行。三项（输入/缓存命中/输出）**互斥不可叠加**，所以分开写、并把缓存命中标成「其中」。
 *
 * 只有会话累计 —— `StoredSession.usage` 存的是 `UsageBuckets`（`UsageReadout` 的 turn 那半
 * 是「本轮」的瞬时读数，不落盘）。
 */
function usageLine(s: StoredSession): string | undefined {
  const u = s.usage;
  if (!u) {
    return undefined;
  }
  if (!u.inputTokens && !u.cacheReadTokens && !u.outputTokens) {
    return undefined; // 全 0 = 没有信息，整行不写
  }
  return `输入 ${u.inputTokens}（其中缓存命中 ${u.cacheReadTokens}）· 输出 ${u.outputTokens}`;
}

/**
 * 转写成 Markdown。
 *
 * 元信息用**列表**而不是引用块：引用块里想换行得靠行尾两个空格，那是不可见字符、
 * 被任何编辑器/格式化工具一碰就没了，渲染出的是一坨连在一起的文字。
 */
export function sessionToMarkdown(s: StoredSession): string {
  const meta: string[] = [
    `- **会话 ID**：\`${s.id}\``,
    `- **创建**：${fmtTime(s.createdAt)}`,
    `- **最后更新**：${fmtTime(s.updatedAt)}`,
  ];
  const usage = usageLine(s);
  if (usage) {
    meta.push(`- **本会话用量**：${usage}`);
  }
  if (s.dsh) {
    meta.push(`- **DSH 会话**：\`${s.dsh.id}\`（工作区 \`${s.dsh.cwd}\`）`);
  }
  if (s.deletedAt !== undefined) {
    meta.push(`- **已删除**：${fmtTime(s.deletedAt)}（本文件导出自回收站）`);
  }

  const head = [`# ${titleLine(s.title)}`, meta.join('\n')].join('\n\n');
  const body = s.messages.map(renderMessage).join('\n\n---\n\n');
  return body ? `${head}\n\n---\n\n${body}\n` : `${head}\n`;
}

/** Windows 保留名（不分大小写、比较的是**去掉扩展名后的主体**）。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeFileBase(title: string): string {
  return (title ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/[/\\:*?"<>|]/g, '_') // Windows 非法字符
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILE_BASE_MAX_CHARS)
    .replace(/[. ]+$/, ''); // 结尾的点/空格：Windows 会直接拒绝或悄悄改掉
}

/**
 * 生成保存对话框的默认文件名。
 *
 * 非做不可：`_renameSession` 用的是用户原样输入、长度不封顶，`titleFromText` 也保留 `?|:*"<>`
 * —— 直接拿标题当文件名，会在 Windows 上预填一个非法名，用户点保存就失败。
 *
 * @param ext 不带点，'md' 或 'json'
 */
export function suggestedFileName(s: StoredSession, ext: string): string {
  let base = sanitizeFileBase(s.title);
  if (!base) {
    base = `会话-${s.id.slice(0, 8)}`;
  } else if (RESERVED.test(base)) {
    base = `_${base}`; // 别丢掉用户起的名字，加个前缀绕开保留名
  }
  return `${base}.${ext}`;
}
