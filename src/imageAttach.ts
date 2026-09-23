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
 * ## 「通路开没开」是一个判定，不是一句写死的话（C20，2026-09-23）
 *
 * 上面那句「明说看不到」在两个世界里的**说法必须不同**，而这件事在 C17b 之后变得要紧：
 * 为了让 chip 那句话在 C17 的世界与多模态的世界里都为真，C17b 把它写成了「取用方式」
 * （**模型需自行读取**）—— 代价是**它再也不能跟着世界变**。而「agent 自己把画面读进上下文」
 * 这条路**不由我们决定**：运行时一挂上附件仓库，`read_image` 就会注册（`dsh-tool-fs` 把它注册在
 * `ctx.inject(['attachments'], …)` 里），那一刻模型真能看见画面。
 *
 * 所以这一版把它做成**一个判定、三处跟随**：
 *   · 判定 = `read_image` 在不在这一轮的 `request/header.header.tools` 里（扩展侧读，见
 *     `chatViewProvider` 的 `request/header` 那个 case；**今天实测不在** ⇒ 关）。
 *   · 三处 = chip、导出那一行、系统提示词那段，全部从下面这张 `IMAGE_ROUTE_TAGS` /
 *     `imagePromptText` 派生（webview 加载不了 TS，chip 是**镜像**，有探针两边对拍）。
 *   · **缺省一律按「关」**（fail-closed）：没有证据就是今天的行为，绝不替运行时吹牛。
 *
 * ## 那段文字住哪儿（C17b，2026-09-23 之后的形态）
 *
 * **不再拼进用户消息正文**，改由系统提示词承载（`imagePromptText` + `imagePromptPlugin.ts`）。
 * 起因是用户的一句话：「我不希望聊天气泡里有这些」。原来那条路是有意选的，但**说给模型听的话
 * 被 DSH 自己的转写面原样显示在用户气泡里**（转写是"所见即所发"），用户每贴一张图就要在自己的
 * 话下面读一遍机器告示。这条没有渲染层的解法 —— 要去掉只能不写进消息。
 *
 * 于是分工变成：**这个模块负责「说什么」**（纯函数、有探针钉着），
 * `imagePromptPlugin` 负责「把话说给模型听」（一个小节，按会话现读）。
 * 消息正文里从此**一个字节都不提图片**，模型看到的是一个正常的用户气泡。
 *
 * 四条实现约定（每条都有探针钉着）：
 *
 * 1. **魔数优先于扩展名**：`.png` 里装的可能是一段文本，`shot.txt` 里可能是张真 PNG。
 *    我们只在**嗅探结果**上做判断，扩展名只用来给落盘文件取名。
 * 2. **认不出来 = 不是图片**，绝不放行到「按文本读」那条路上去（今天最阴的缺陷就是小图标被
 *    `readFileSync(…, 'utf8')` 读成乱码喂进提示词）。
 * 3. **说明文字里绝不出现 `@"`**：DSH 的 `@` 语法只管**会话**引用（规范形
 *    `@[label](dsh-session:…)`），`@"D:\x.png"` 没有任何「这是图片」的语义，只会把 agent
 *    引向文本工具去读二进制。要发的是一段明说的说明。（C17b 换了投递通道，**这条理由一字不改**
 *    —— 它管的是文字本身，不是它搭哪趟车。）
 * 4. **路径给两读法**：盘符形态之外另附 WSL 里可执行的那个（`/mnt/d/…`），换算只借
 *    `dshHooks.toWslPath` 那一份。真机上 agent 拿 `d:\…` 去 `ls` 是「找不到文件」，白烧一轮。
 */

// 只借一个**纯函数**：`D:\a\b` → `/mnt/d/a/b`。`dshHooks` 不 import vscode（`shellDiag`/`contextWindow`
// 早就从它那儿借过东西），所以本模块「不 import vscode」这条不变量不受影响。
import { toWslPath } from './dshHooks';
// 只借**类型**（`import type` 编译期就抹掉）：`imagesInMessages` 要认「消息里的附件」这个形状，
// 而运行时一个字节都不需要 —— 本模块「能在扩展宿主之外被探针直接载入」那条不变量靠的就是它。
import type { ChatMessage } from './protocol';

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

/**
 * 系统提示词里**最多列几张图**（只留最新的，更早的写一行「已省略」）。
 *
 * 为什么要封顶：这一节是**每一轮都进系统提示词**的（C17b 之后），所以最坏情况必须可预期 ——
 * 12 行 ≈ 1.5 KB ≈ 500 token，**不随会话变长而涨**。代价是超出的那些图的路径模型就看不到了
 * （消息里已经没有说明），所以省略行必须点出目录让它自己 `ls`。
 */
export const MAX_IMAGES_IN_PROMPT = 12;

/** 整块的字符硬顶（防病态长路径）。与上面的张数上限**两道都可能在真机上先撞到**，不是二选一。 */
export const MAX_IMAGE_PROMPT_CHARS = 4000;

/** 单行的字符硬顶。病态长路径（探针里那条 5000 字符）就是靠它挡在句子层面，而不是把整块截断 ——
 *  截断整块会把后面那四句约束一起切掉，而那四句正是这个功能的全部意义。 */
export const MAX_IMAGE_LINE_CHARS = 400;

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

/** 一条图片附件的元数据（`imagePromptText` 需要的全部输入）。 */
export interface ImageMeta {
  name: string;
  path: string;
  bytes: number;
  mediaType: ImageMediaType;
}

/**
 * 路径的**WSL 第二读法**那一小段（没有第二读法时返回空串）。
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
function wslSuffix(p: string): string {
  const alt = toWslPath(p);
  return alt === p ? '' : `（bash 在 WSL 里时读作 ${alt}）`;
}

/** 一行一张图：`- shot.png · image/png · 1.2 MB · D:\…\shot.png（WSL 读法）`。
 *  单行有硬顶 —— 病态长路径在这里被截，而不是让整块被截（那会切掉后面那四句约束）。 */
function imageLine(a: ImageMeta): string {
  let line = `- ${a.name} · ${a.mediaType} · ${formatBytes(a.bytes)} · ${a.path}${wslSuffix(a.path)}`;
  if (line.length > MAX_IMAGE_LINE_CHARS) {
    line = line.slice(0, MAX_IMAGE_LINE_CHARS) + '…（路径过长，已截断）';
  }
  return line;
}

/**
 * C20：图片通路的两档 —— **`readable` 只有一个来源**：运行时把 `read_image` 注册出来了
 * （⟺ 挂上了附件仓库）。别处不许再出现第二份判断（见文件头那段）。
 */
export type ImageRoute = 'blind' | 'readable';

/**
 * C20：**两句话的唯一定义处**。chip（`media/chat.js` 里是**镜像字面量**，有探针两边对拍）、
 * 导出那一行（[sessionExport.ts](./sessionExport.ts) 直接 import 本表）、以及系统提示词那段的口径
 * （`imagePromptText` 的两个变体）都从它派生 —— 一个判据只有一个家。
 *
 * 措辞是**刻意**的，两句说的是**不同的主语**，别再拿其中一个去对另一个取证：
 * · `blind`——「图片输入未接通」。说的是**这份配置**的事实（运行时没挂附件仓库 ⇒ `read_image`
 *   根本不存在）。**绝不写「模型看不到」**：那是把部署的事实说成模型的属性，而模型完全可能是
 *   多模态的 —— C17 那条 chip 的老毛病就是它。
 * · `readable`——「模型需自行读取」。说的是**取用方式**：图片字节照样不随消息发送，画面得 agent
 *   自己用 `read_image` 读进来。这一档里运行时会不会答应，由它自己的能力闸说了算
 *   （`assertImageCapableRoute`），所以这句话**不承诺任何能力**，只指出正确的动作。
 */
export const IMAGE_ROUTE_TAGS: Record<ImageRoute, { tag: string; title: string }> = {
  blind: {
    tag: '图片输入未接通',
    // ⚠️ 这张表里**一个「模型看不到」都不许有**（两档都不许，有探针钉着）：那句话把**部署**的事实
    // 说成了**模型**的属性，而模型完全可能是多模态的 —— C17 那条 chip 的老毛病就是它。这里说的
    // 是「这份配置里没有通路」以及它的**后果**（画面到不了模型），理由摆在前面。
    title: '图片不随消息发送、只落成一个文件：这份配置里没有图片输入通路（运行时没挂附件仓库，read_image 工具不存在），画面也就到不了模型那里',
  },
  readable: {
    tag: '模型需自行读取',
    title: '图片不随消息发送、只落成一个文件：模型要看画面得自己用 read_image 读它',
  },
};

/** C20：`boolean` → 档位。**fail-closed**：只有**确证为真**才算开，其余（缺省 / 读不到 / 老会话）一律「关」。 */
export function imageRouteFrom(readable: boolean | undefined): ImageRoute {
  return readable === true ? 'readable' : 'blind';
}

/** C20：chip / 导出那一行用的标签。**这四个字只许从这里出去**（探针有「仅此一处」的结构守卫）。 */
export function imageRouteTag(route: ImageRoute): string {
  return IMAGE_ROUTE_TAGS[route].tag;
}

/**
 * C20：判定所依据的那个工具名。**`read_image` 是上游 `dsh-tool-fs` 注册的**，注册点在
 * `ctx.inject(['attachments'], …)` **内部**（`dsh-tool-fs/lib/index.js:1191` 注释、`:1204` 调用）
 * ⇒ 「它在」⟺「运行时挂上了附件仓库」。所以这个名字不是我们的约定，是**上游的事实**；
 * 上游哪天改名，这里就该跟着改（探针的变异测试会提醒：改错名 ⇒ 判定恒为「关」）。
 */
export const READ_IMAGE_TOOL = 'read_image';

/**
 * C20：从 `request/header` 的 header 里读出**这一轮的工具名表**（`canonicalHeader` 直出工具定义）。
 *
 * 元素形态兼容字符串与 `{name}` 两种 —— webview 那一侧没法验证，所以这里按「认得多少算多少」：
 * 认不出来的元素**丢掉而不是编一个名字**，整表读不出来就返回空数组（调用方 fail-closed 按「关」）。
 */
export function toolNamesInHeader(header: unknown): string[] {
  const tools = (header as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(tools)) return [];
  const out: string[] = [];
  for (const t of tools) {
    const name = typeof t === 'string' ? t : (t as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name) out.push(name);
  }
  return out;
}

/**
 * C20：**唯一的判定入口** —— `read_image` 在不在这一轮的工具表里。
 *
 * 为什么判定要落在**工具表**上、而不是插件侧问 `ctx.get('attachments')`：
 * · 工具表是**这一轮请求真的发出去**的样子，它看得见 C12 项目级 profile 的 `tools.deny`
 *   （deny 掉 `read_image` ⇒ 判定正确地变「关」）；插件侧那份会造出第二份会漂的真相，且看不见 deny 表。
 * · 它还不用新开通道：`request/header` 帧本来就在扩展的实时流里（`src/runInspector.ts:490` 点名列过它）。
 *
 * ⚠️ **它只回答「通路开没开」，不回答「模型认不认图片」**：后者是运行时自己的
 * `assertImageCapableRoute` 在调用那一刻判的，文案干净且模型看得见 ⇒ 不复制、不猜。
 */
export function imageRouteFromHeader(header: unknown): ImageRoute {
  return toolNamesInHeader(header).includes(READ_IMAGE_TOOL) ? 'readable' : 'blind';
}

/**
 * 写进**系统提示词**的那一段（C17b 之后的家）。这是本次降级的落点：agent 拿到的不是图片，
 * 是「这儿有这些图片文件、你看不见它们、请用工具处理它们」。
 *
 * 空数组 ⇒ **返回空串**，插件那边照原样交上去，`renderPrompt` 会把空小节整个丢掉
 * （`dsh-system-prompt/lib/index.js:66`）—— 也就是说**没有图片的会话，这一节一个字节都不存在**。
 *
 * **两个变体由 `route` 选**（C20）：`blind` 那版是下面这四句；`readable` 那版把
 * 「你看不到 / 不要试图用工具把它『看』出来」换成**指路**（用 `read_image` 读）—— 那两句在那一半
 * 世界里是假话，而第二句更坏：它禁掉的正是唯一正确的动作。两句共同的尾巴（不要凭文件名猜、
 * 用户点名才动它）两边都在。措辞与归属的全套理由见 `IMAGE_ROUTE_TAGS` 上面那段。
 *
 * 下面四句话是 `blind` 那版**必须**有的，各有探针钉着：
 * - 「看不到它们的内容」—— 不说这句，模型会对着一个 `.png` 路径一本正经地描述画面（它见过太多
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
export function imagePromptText(images: ImageMeta[], route: ImageRoute = 'blind'): string {
  const all = Array.isArray(images) ? images : [];
  if (all.length === 0) return '';
  // 两个变体（C20）。**共同的落点**：图片字节都不随消息走，上面这些只是**盘上的文件路径** ——
  // 这句话在两个世界里都为真，所以两句的抬头也共用它。
  const head = '用户在本会话附过这些图片（图片字节不随消息发送，下面只是它们在盘上的位置）：';
  const warn =
    route === 'readable'
      ? // C20「开」的那一半：**指路，不承诺**。运行时能不能答应由它自己的能力闸说
        // （`assertImageCapableRoute` 会回一句干净的「模型没声明图片输入」），所以这里只指出
        // 正确的动作 + 撞门之后怎么办。⚠️ 「不要试图用工具把它『看』出来」那句**必须不在**
        // —— 在这一半世界里它禁掉的正是唯一正确的动作。
        '注意：这些图可以用 `read_image` 工具读（用上面给的路径）。' +
        '如果你的路由不支持图片输入，read_image 会明确告诉你，那就照实说你读不了。' +
        '不要凭文件名猜测或描述画面。' +
        '只有用户明确要求对这些文件做某件事（复制、移动、交给别人）时，才用命令去动它。'
      : // 「关」的那一半（今天）：一个字节不动 —— 它是 2026-09-23 真机事故换来的那几句
        // （见下面的注释），而且真机验证过模型照着它说了「I can't see images」。
        // ⚠️ C20 只把**归因**改准了（「这次部署没开通」而不是「这个模型不支持」）：
        // 判定来自 `read_image` 在不在，那是**部署**的事实，不是模型的属性。
        '注意：这次部署没有开通图片输入 —— 你看不到这些图的画面内容，上面只是文件路径。' +
        '不要试图用工具把它「看」出来：读二进制、OCR、转格式、装识别工具都不会让你看见画面，' +
        '只会白烧时间与 token。直接告诉用户你看不到这些图就行。' +
        '只有用户明确要求对这些文件做某件事（复制、移动、交给别人）时，才用命令去动它。' +
        '不要凭文件名猜测或描述画面。';

  // 两道闸一起驱动这一个循环：张数（>12 只留最新的）与字符数（病态长路径撞硬顶）。
  // 省略的条数是**两者共同的账**，说给模型听时不必分因 —— 它只要知道「还有更早的」。
  let kept = all.slice(-MAX_IMAGES_IN_PROMPT);
  let omitted = all.length - kept.length;
  const render = (): string => {
    const lines = kept.map(imageLine).join('\n');
    const more = omitted > 0
      ? `\n（更早的 ${omitted} 张已省略 —— 用户粘贴来的图在工作区的 ${IMAGE_DIR_REL}/ 里）`
      : '';
    return `${head}\n${lines}${more}\n${warn}`;
  };
  let out = render();
  while (out.length > MAX_IMAGE_PROMPT_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    omitted = all.length - kept.length;
    out = render();
  }
  return out;
}

/**
 * 一个会话的消息里**所有**图片附件的元数据（按时间顺序，最旧的在前）。
 *
 * **表是 store 的纯函数**：C17b 每次发送都从会话消息重算整张表，所以「本会话附过哪些图」
 * 这件事没有第二份真相，也就不会与历史漂移 —— 与 `_writeEffortState` 同一条设计。
 *
 * 只收**真的落了盘**的图片：`path` 必须非空且没有 `readError`。被拒的图（超限 / 不是可用图片）
 * 在 `_sendUser` 那一步就整条拒发了，本来也进不了历史；这里的过滤是防御性的。
 *
 * 这个函数住在纯模块里，是为了让探针能在扩展宿主之外直接打它（C10b 的教训）。
 */
export function imagesInMessages(messages: readonly ChatMessage[]): ImageMeta[] {
  const out: ImageMeta[] = [];
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (a.kind !== 'image' || a.readError || !a.path) continue;
      if (!isImageMediaType(a.mediaType)) continue;
      out.push({
        name: a.name,
        path: a.path,
        bytes: typeof a.bytes === 'number' ? a.bytes : 0,
        mediaType: a.mediaType,
      });
    }
  }
  return out;
}

// ⚠️ **C20 删掉了 `describeImageAttachment`**：它写着「导出/展示用的一行摘要」，但 C17b 之后
// 一个消费者都没有（chip 在 webview 里是另一份镜像、导出行在 `sessionExport` 里自己拼），
// 于是它成了一段**没人读却看着权威**的旧文案 —— 上一轮改措辞时它就没人跟着改。
// 现在「那一行摘要」只有两个家：`IMAGE_ROUTE_TAGS`（标签）与各处的排版代码，判据由探针钉住。

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
