/**
 * C17「图片附件」的纯模块：**认得出图片、给得出一个够得着的落点、说得出「模型看不见它」**。
 *
 * **不 import vscode** —— 判据必须能在扩展宿主之外加载（C10b 的教训），
 * `scripts/probe-image-attach.mjs` 直接打编译产物。
 *
 * 先说清这个模块**不是**什么，免得后人把它当成多模态的脚手架：
 *
 * - **它不把图片发给模型**，也做不到。DSH 的 `session/prompt` 里确实有 `{type:'image'}` 块，但它
 *   携带的是**已落盘的引用**（`ImageAttachmentRef`），而能提交字节的那条路
 *   （`EncodedImageAttachment` → `admitEncodedImages`）只被 ACP 适配器与命令执行器消费，我们这条
 *   `dsh-sdk-jsonrpc-server` 的 `prompt()` 从不调它；我们的便携运行时也没挂附件仓库
 *   （`ctx.attachments` 是 undefined，`read_image` 工具根本没注册）；默认模型
 *   `deepseek-v4-flash` 更没声明 `inputModalities`。**三层墙，两层不在我们手里。**
 * - 所以这里做的是**诚实降级**：图片被认出来、落成一个 agent 用命令够得到的文件、气泡里有一枚
 *   说明它是图片的 chip、提示词里有一段**明说看不到**的文字。字节永远不发 —— 因为它到不了。
 *
 * 四条实现约定（每条都有探针钉着）：
 *
 * 1. **魔数优先于扩展名**：`.png` 里装的可能是一段文本，`shot.txt` 里可能是张真 PNG。
 *    我们只在**嗅探结果**上做判断，扩展名只用来给落盘文件取名。
 * 2. **认不出来 = 不是图片**，绝不放行到「按文本读」那条路上去（今天最阴的缺陷就是小图标被
 *    `readFileSync(…, 'utf8')` 读成乱码喂进提示词）。
 * 3. **说明文字里绝不出现 `@"`**：DSH 的 `@` 语法只管**会话**引用（规范形
 *    `@[label](dsh-session:…)`），`@"D:\x.png"` 没有任何「这是图片」的语义，只会把 agent
 *    引向文本工具去读二进制。要发的是一段明说的说明。
 * 4. **路径给两读法**：盘符形态之外另附 WSL 里可执行的那个（`/mnt/d/…`），换算只借
 *    `dshHooks.toWslPath` 那一份。真机上 agent 拿 `d:\…` 去 `ls` 是「找不到文件」，白烧一轮。
 */

// 只借一个**纯函数**：`D:\a\b` → `/mnt/d/a/b`。`dshHooks` 不 import vscode（`shellDiag`/`contextWindow`
// 早就从它那儿借过东西），所以本模块「不 import vscode」这条不变量不受影响。
import { toWslPath } from './dshHooks';

/** 上游认的图片类型，**恰这四种** —— 复刻自 `dsh-attachment` 的 `ImageMediaType` /
 *  `attachment-local/src/index.ts` 的准入集合。
 *
 *  ⚠️ **不要**复用 `fileSnapshot.BIN_EXT`：那回答的是另一个问题（「审阅时别按 utf8 预览」），
 *  集合里含 ico/bmp/pdf/zip，与这里的准入集合**概念与内容都不同** —— 借过来会放行一批
 *  上游根本不认的类型，那就是新的谎言（而且它们过不了本模块的嗅探，等于自相矛盾）。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** 单张图片字节上限。取值与 DSH 附件仓库的 `maxImageBytes` 同形（那个值由部署配置解析，
 *  `dsh-attachment/lib` 只声明接口）—— 这不是模型的要求，是我们对「一次贴图会把多少东西
 *  写进用户工作区」的约束。 */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

/** 单条消息的图片张数上限。同上：**它是落盘量的安全阀，不是模型要求** ——
 *  拖 50 张截图进来就是往用户工作区写一百多 MB。 */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** 落盘目录（工作区相对路径）。放在**工作区里**而不是 globalStorage：DSH agent 与工作区同盘、
 *  用命令直接读得到 —— 而「agent 能用命令碰它」是这次降级**唯一**的实际价值，放进 C:\ 就等于
 *  把唯一的价值扔掉（1.1 选区临时目录踩过同一个坑，见 `_writeSelectionTmp` 的注释）。
 *  该目录被 `fileSnapshot` 的 IGNORED_DIRS 整棵忽略，永远不会被当成 agent 的改动出现在审阅里。 */
export const IMAGE_DIR_REL = '.hello-chat/images';

/** 说明文字的字符上限。路径本身可能很长，但一段说明不该无限长 —— 超了就截路径。 */
export const MAX_IMAGE_NOTE_CHARS = 2000;

/** 落盘文件名的字符上限（不含扩展名）。 */
const FILE_BASE_MAX_CHARS = 80;

/** 真·图片的魔数。`RIFF????WEBP` 是唯一一个带跳段的（字节 4-7 是长度）。 */
function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[at + i] !== sig[i]) return false;
  }
  return true;
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/**
 * 从字节里嗅出图片类型；**认不出来返回 undefined**（调用方必须把它当成「不是图片」处理，
 * 绝不允许回退到「那就按文本读吧」）。
 *
 * 只看文件头，不解析尺寸/颜色/帧数 —— 那些需要一个真解码器（上游用的是 sharp，重原生依赖），
 * 而本仓库零第三方依赖，且**没有任何消费者**：没有 `<img>`，纯文本 agent 也用不上宽高。
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (!bytes || bytes.length < 8) return undefined;
  // PNG: 89 50 4E 47 0D 0A 1A 0A（那 8 个字节本身就是设计来检测传输损坏的）
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // JPEG: FF D8 FF（第三个字节是段标记，常见 E0/E1/DB，一律不看）
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // GIF: 'GIF87a' / 'GIF89a'
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  // WEBP: 'RIFF' + 4 字节长度 + 'WEBP'
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

/** 「看着像图片」的扩展名。**它只决定拒绝时的说法，永远不决定放行**（放行只看魔数）。
 *
 *  为什么需要它：一个 `.png` 里装着文本时，正确的答复是「不是可用的图片」，而不是把它当文本
 *  读进提示词 —— 用户以为自己贴的是一张图，读到一堆代码只会莫名其妙。集合里含 `svg`/`bmp`/`ico`
 *  这些上游不认的类型：它们**确实是图片**，只是送不进去，说「不是可用的图片（只支持 …）」
 *  比说「二进制文件」准确得多。 */
const IMAGE_EXT_HINTS = new Set([
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp',
  'bmp', 'ico', 'cur', 'svg', 'tif', 'tiff', 'avif', 'heic', 'heif',
]);

/** 文件名（或路径）的扩展名是否「看着像图片」。见 `IMAGE_EXT_HINTS` 的注释。 */
export function imageExtHint(name: string): boolean {
  const tail = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = tail.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXT_HINTS.has(tail.slice(dot + 1).toLowerCase());
}

/** 判定传入值是不是本模块承认的图片类型（协议字段来自 webview，**不是可信输入**）。 */
export function isImageMediaType(v: unknown): v is ImageMediaType {
  return typeof v === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(v);
}

/** 落盘用的扩展名。**由嗅探结果决定**，绝不采信原文件名（`.png` 里可能是 JPEG）。 */
export function extensionFor(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    default:
      return mediaType.slice('image/'.length);
  }
}

/** Windows 保留名（不区分大小写，且**带上扩展名也算**：`CON.png` 照样打不开）。 */
const RESERVED_BASE = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
  ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
]);

/**
 * 造一个安全的落盘文件名。**这个函数的输入来自 webview / 操作系统，是不可信输入** ——
 * 文件名可能是 `../../evil.png`、可能是 `a\b.png`、可能是 300 个字符、可能叫 `CON`。
 *
 * 依次做：剥目录 → 去控制字符与 Windows 非法字符 → 去尾部点与空格 → 空则取名 `image` →
 * 80 字符上限 → 保留名加前缀 → **扩展名由嗅探结果决定** → 与 `taken` 撞名就加 `-2`、`-3`…
 *
 * `taken` 是**已存在**的文件名集合（大小写不敏感比较 —— Windows 上 `A.png` 与 `a.png` 是同一个）。
 */
export function safeImageFileName(
  name: string,
  mediaType: ImageMediaType,
  taken?: Iterable<string>
): string {
  // 剥目录：两种分隔符都要剥。`path.basename` 在 win32 上认两种，但这个模块不许依赖平台行为。
  const raw = String(name ?? '');
  const tail = raw.split(/[\\/]/).pop() ?? '';
  // 控制字符（含换行/制表）与 Windows 非法字符一律换成 `_`
  let base = tail.replace(/[\p{Cc}\p{Cf}]+/gu, '').replace(/[<>:"|?*]/g, '_');
  // 去掉扩展名（扩展名由嗅探结果决定，原名的那一段不可信）。
  // `>= 0` 而不是 `> 0`：`.png` 这种「只剩扩展名」的名字（粘贴来的 Blob 有时就这样）该落成
  // 兜底名 `image`，而不是 `.png.png` 这种既难看又像隐藏文件的东西。
  const dot = base.lastIndexOf('.');
  if (dot >= 0) base = base.slice(0, dot);
  // Windows 上文件名不能以点或空格结尾（`a.png.` 这类名字实际打不开）
  base = base.replace(/[. ]+$/, '').trim();
  if (!base || base === '.' || base === '..') base = 'image';
  if (base.length > FILE_BASE_MAX_CHARS) base = base.slice(0, FILE_BASE_MAX_CHARS);
  if (RESERVED_BASE.has(base.toUpperCase())) base = `_${base}`;

  const ext = extensionFor(mediaType);
  const used = new Set<string>();
  if (taken) {
    for (const t of taken) used.add(String(t).toLowerCase());
  }
  let candidate = `${base}.${ext}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${base}-${n}.${ext}`;
  }
  return candidate;
}

/** 人读的字节数（`1.2 MB`）。**判据在扩展侧算**（同 C15/C16 的分工线），webview 只排版 ——
 *  那边的镜像实现见 `media/chat.js` 的 `formatBytes`（有一条探针对拍两边的口径）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * 单张图片是否在字节上限内。
 *
 * ⚠️ **恰好等于上限要放行** —— 上限的语义是「最多这么多」，不是「必须少于」。这条单独写成函数
 * 就是为了让它能在扩展宿主之外被钉住：一个 `>` 写成 `>=` 的笔误，现场表现是「某些截图莫名其妙
 * 被拒」，而那种事没有现场（用户只会换一张图试试）。
 */
export function imageBytesAllowed(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= MAX_IMAGE_BYTES;
}

/** 张数是否在上限内（同上的 `<=` 语义）。 */
export function imagesWithinCount(count: number): boolean {
  return Number.isFinite(count) && count >= 0 && count <= MAX_IMAGES_PER_MESSAGE;
}

/** 一条图片附件的元数据（`imageNote` 需要的全部输入）。 */
export interface ImageNoteInput {
  name: string;
  path: string;
  bytes: number;
  mediaType: ImageMediaType;
}

/**
 * 路径那一行，**带 WSL 第二读法**。
 *
 * 2026-09-23 真机：给出去的是 `d:\…`，而 agent 的 bash 在 WSL 里 —— 它的第一条命令
 * `ls -la "d:/…"` 就是 `No such file or directory`，直到 `pwd` 打出 `/mnt/d/…` 才找对，白烧一轮。
 * 这正是 C13 那次真事故的同一面墙（那时给批准条加的是「两读法说明」）。
 *
 * ⚠️ 换算**不在这里实现**：只有 `dshHooks.toWslPath` 那一份（hook 命令那边也要用它 —— 同一个坑的
 * 另一面）。本文件里**一个 `/mnt/` 字面量都不许有**，有探针钉着。
 *
 * 只在**两读法真的不同**时才写第二读法：非盘符路径（POSIX、UNC、相对路径）换算后原样返回，
 * 在 macOS/Linux 上凭空多出一行 `/mnt/…` 只会是噪音。
 */
function pathLine(p: string): string {
  const alt = toWslPath(p);
  return alt === p ? `文件路径：${p}` : `文件路径：${p}（bash 在 WSL 里时读作 ${alt}）`;
}

/**
 * 发给模型的**那段说明文字**。这是本次降级的落点：agent 拿到的不是图片，是「这儿有个图片文件、
 * 你看不见它、请用工具处理它」。
 *
 * 三句话是**必须**的，各有探针钉着：
 * - 「看不到它的内容」—— 不说这句，模型会对着一个 `.png` 路径一本正经地描述画面（它见过太多
 *   图文对话了，赌它会承认自己看不见是不现实的）。
 * - 「不要试图用工具把它『看』出来」—— **这句是 2026-09-23 真机加上的**：原话里那句
 *   「请用命令或工具处理这个文件（复制、**转换**、查看元数据…）」读起来就是一份行动许可，
 *   于是 agent 为了回答一句「这是什么东西」真去 WSL 里下了 `get-pip.py`、装了
 *   pip/Pillow/numpy/opencv/onnxruntime/rapidocr 一整套 OCR 栈（全程没有一次审批 ——
 *   bash 只按破坏性命令的正则判，`pip install` 不在其中），白烧十几轮。
 *   **「让它变得可读」是一条走不通的路**，必须明说；而**用户点名要做的文件操作**照旧放行
 *   （那一句是跟着补的，否则收得太紧，连「把这个文件挪到 X」都会被拒）。
 * - 「不要凭文件名猜测」—— 补上后半句，否则「看不到」会被理解成「那就按文件名想象一个」。
 *
 * **绝不出现 `@"`**：见文件头第 3 条约定。
 */
export function imageNote(a: ImageNoteInput): string {
  const head = `图片附件：${a.name}（${a.mediaType}，${formatBytes(a.bytes)}，共 ${a.bytes} 字节）`;
  const where = pathLine(a.path);
  const warn =
    '注意：当前模型不支持图片输入 —— 你看不到这张图的画面内容，上面只是一个文件路径。' +
    '不要试图用工具把它「看」出来：读二进制、OCR、转格式、装识别工具都不会让你看见画面，' +
    '只会白烧时间与 token。直接告诉用户你看不到这张图就行。' +
    '只有用户明确要求对这个文件做某件事（复制、移动、交给别人）时，才用命令去动它。' +
    '不要凭文件名猜测或描述画面。';
  let out = `${head}\n${where}\n${warn}`;
  if (out.length > MAX_IMAGE_NOTE_CHARS) {
    out = out.slice(0, MAX_IMAGE_NOTE_CHARS) + '…（说明过长，已截断）';
  }
  return out;
}

/** 从一条附件形状的对象里拿到**要发给它的那段说明**。
 *
 *  优先用扩展侧已经存好的 `note`（落盘时就写好了）；缺了（老会话里的数据、手写的测试对象）
 *  就现算 —— **绝不返回空串**：宁可只说「这儿有个图片文件」，也不能让模型面对一个它一无所知的
 *  `.png` 路径开始编。live 与 chat 两个模式都走这一个函数，不许各说各的话。 */
export function noteForAttachment(a: {
  name: string;
  path?: string;
  bytes?: number;
  mediaType?: string;
  note?: string;
}): string {
  if (a.note) return a.note;
  if (a.path && typeof a.bytes === 'number' && isImageMediaType(a.mediaType)) {
    return imageNote({ name: a.name, path: a.path, bytes: a.bytes, mediaType: a.mediaType });
  }
  return describeImageAttachment(a);
}

/** 导出/展示用的一行摘要（如 `图片 · shot.png · 1.2 MB · 模型看不到`）。
 *  ⚠️ 与 webview 的 chip 文案**同一口径但有各自实现**：webview 加载不了 TS，那边是镜像。 */
export function describeImageAttachment(a: {
  name: string;
  mediaType?: string;
  bytes?: number;
}): string {
  const bits = ['图片'];
  if (a.name) bits.push(a.name);
  if (typeof a.bytes === 'number') bits.push(formatBytes(a.bytes));
  bits.push('模型看不到');
  return bits.join(' · ');
}

// ---------- 三条拒绝文案（分开说，是本次要修的缺陷之一） ----------

/** 超上限的图片。**今天这条说的是「文件过大（>10KB）」** —— 对图片而言那句话是错的，
 *  而且给的建议（换个文件）也是错的：换多大都进不了模型。 */
export function imageTooLargeError(): string {
  return `图片过大（>${formatBytes(MAX_IMAGE_BYTES)}），未读取`;
}

/** 扩展名像图片、魔数不是。**绝不回退到按文本读** —— 那正是今天小图标变乱码的成因。 */
export function notAnImageError(): string {
  return `不是可用的图片（只支持 ${IMAGE_MEDIA_TYPES.map((t) => t.slice('image/'.length).toUpperCase()).join('/')}）`;
}

/** 非图片的二进制（PDF/ZIP/EXE…）。今天它会被 `readFileSync(…, 'utf8')` 读成乱码喂给模型。 */
export function binaryFileError(): string {
  return '二进制文件，模型读不了';
}

/** 超出张数上限。 */
export function tooManyImagesError(count: number): string {
  return `图片最多 ${MAX_IMAGES_PER_MESSAGE} 张（本条 ${count} 张），未读取`;
}
