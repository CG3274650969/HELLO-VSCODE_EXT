#!/usr/bin/env node
/**
 * C17「图片附件（诚实降级）」的判据自检 —— **不需要 VS Code、不需要 API key、不弹任何条**。
 *
 * 守的是 [src/imageAttach.ts] 这一份纯判据。为什么它值得单独钉：图片这条路今天**注定送不到
 * 模型**（三层墙，见模块头注释），于是它唯一能出的错就是**安静地出错** ——
 * 一张 PNG 被当文本读成乱码喂进提示词、一个 `.png` 后缀骗过检查、说明文字里混进了 `@"`
 * 把 agent 引向文本工具。这些症状全都**没有现场**：用户看到的是「模型回答了，只是答得很怪」。
 *
 * 所以每一组都是反控（「假如判宽了会怎样」），而不是流程复述：
 *
 * - **A 识别**：魔数优先于扩展名（JPEG 字节配 `.png` 名仍判 jpeg），认不出来一律拒
 *   （含 SVG/ICO/BMP —— 它们「看起来像图」，但上游不认，多认一种就是新的谎言）。
 * - **B 上限**：`<=` 语义（恰好等于要放行）、张数、**与 webview 镜像字面量对拍**
 *   （两边各写一份常量，漂了要在这里红）。
 * - **C 文件名**：输入来自 webview/操作系统，是不可信输入（`../../evil.png`、`CON`、300 字符）。
 * - **D 说明文字**：路径/大小/MIME/「看不到」都要在，**`@"` 一定不能在**。
 *
 * **这份探针够不着的地方（写在这里，免得后人以为它全包了）**：`chatViewProvider.ts` 里那几段
 * 接线（`_readFileAttachment` 的分支顺序、`_resolveAttachments` 绝不抄 `dataBase64`、
 * `_runLive` 的图片分支排在 `<file>` 之前）**在扩展宿主之外加载不了**（它 `import vscode`）。
 * 所以 F 组是**结构守卫**（读源码文本），不是行为判据 —— 它抓得住「有人把顺序挪了」「有人加了
 * 一句赋值」，抓不住「有人用另一种写法达到同样的坏效果」。真正的行为判据只有 F5 真机那几条。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-image-attach.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'out');

async function load(file) {
  const p = join(outDir, file);
  if (!existsSync(p)) {
    console.error(`缺少编译产物：${p}\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
    process.exit(2);
  }
  return import(pathToFileURL(p).href);
}

const M = await load('imageAttach.js');
const {
  IMAGE_MEDIA_TYPES,
  IMAGE_DIR_REL,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_NOTE_CHARS,
  MAX_IMAGES_PER_MESSAGE,
  binaryFileError,
  describeImageAttachment,
  extensionFor,
  formatBytes,
  imageBytesAllowed,
  imageNote,
  imageTooLargeError,
  imagesWithinCount,
  isImageMediaType,
  notAnImageError,
  safeImageFileName,
  sniffImageMediaType,
  tooManyImagesError,
} = M;

// 非图片那条路要问的是 fileSnapshot 的同一份清单 —— 顺手钉住它没被改成第二份
const FS = await load('fileSnapshot.js');
const { binaryExt: fsBinaryExt, hasNulByte } = FS;

// E/G 组要起真存储、真导出、真检索（都是纯模块，不 import vscode）
const { SessionStore } = await load('sessionStore.js');
const { sessionToMarkdown } = await load('sessionExport.js');
const { searchSessions } = await load('sessionSearch.js');

// ---------- 断言小工具 ----------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('断言返回 false');
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`✗ ${name}\n    ${err && err.message ? err.message : err}`);
  }
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}：期望 ${e}，实得 ${a}`);
}

// ---------- 样本字节（手写文件头，不依赖任何图片文件） ----------

const bytesOf = (...xs) => Uint8Array.from(xs);
const asciiBytes = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
const concat = (...arrs) => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrs) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};

const PNG = concat(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), asciiBytes('....IHDR'));
const JPEG = concat(bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), asciiBytes('JFIF'));
const GIF87 = concat(asciiBytes('GIF87a'), bytesOf(0x01, 0x00));
const GIF89 = concat(asciiBytes('GIF89a'), bytesOf(0x01, 0x00));
// RIFF + 4 字节长度 + WEBP：长度那段是唯一带跳段的，故意写成非零，防实现只看前 4 字节
const WEBP = concat(asciiBytes('RIFF'), bytesOf(0x2a, 0x00, 0x00, 0x00), asciiBytes('WEBP'), asciiBytes('VP8 '));
const TEXT = asciiBytes('这是普通文本，不是图片，虽然它可能叫 .png');
const SVG = asciiBytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const ICO = concat(bytesOf(0x00, 0x00, 0x01, 0x00), bytesOf(0x01, 0x00));
const BMP = concat(asciiBytes('BM'), bytesOf(0x36, 0x00, 0x00, 0x00));
const PDF = asciiBytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');

// ---------- A 识别 ----------

console.log('\n--- A 识别（魔数优先于扩展名）---');

check('A1 四种真图片各自认出来', () => {
  eq(sniffImageMediaType(PNG), 'image/png');
  eq(sniffImageMediaType(JPEG), 'image/jpeg');
  eq(sniffImageMediaType(GIF87), 'image/gif');
  eq(sniffImageMediaType(GIF89), 'image/gif');
  eq(sniffImageMediaType(WEBP), 'image/webp');
});

check('A2 WEBP 的跳段真的跳了（只看前 4 字节的实现会在这里红）', () => {
  // 'RIFF' 开头但 8..11 不是 'WEBP'（比如一段 WAV）→ 不许认成图片
  const wav = concat(asciiBytes('RIFF'), bytesOf(0x2a, 0x00, 0x00, 0x00), asciiBytes('WAVE'));
  eq(sniffImageMediaType(wav), undefined);
});

check('A3 文本字节配 .png 名 ⇒ 仍然不是图片（扩展名不作数）', () => {
  eq(sniffImageMediaType(TEXT), undefined);
  eq(sniffImageMediaType(SVG), undefined);
  eq(sniffImageMediaType(PDF), undefined);
});

check('A4 ICO / BMP 一律拒（它们像图片，但上游只认四种）', () => {
  eq(sniffImageMediaType(ICO), undefined);
  eq(sniffImageMediaType(BMP), undefined);
});

check('A5 截断的文件头（不足 8 字节）⇒ 拒，而不是越界或误判', () => {
  eq(sniffImageMediaType(bytesOf(0x89, 0x50)), undefined);
  eq(sniffImageMediaType(new Uint8Array(0)), undefined);
});

check('A6 JPEG 字节配 .png 名 ⇒ 嗅探仍判 jpeg，落盘扩展名跟着嗅探走', () => {
  eq(sniffImageMediaType(JPEG), 'image/jpeg');
  eq(safeImageFileName('shot.png', sniffImageMediaType(JPEG)), 'shot.jpg');
  eq(safeImageFileName('SHOT.PNG', 'image/png'), 'SHOT.png');
  eq(extensionFor('image/jpeg'), 'jpg');
  eq(extensionFor('image/webp'), 'webp');
});

check('A7 isImageMediaType 只承认那四种（协议字段来自 webview，不可信）', () => {
  for (const t of IMAGE_MEDIA_TYPES) eq(isImageMediaType(t), true, t);
  eq(isImageMediaType('image/svg+xml'), false);
  eq(isImageMediaType('image/bmp'), false);
  eq(isImageMediaType('image/png '), false);
  eq(isImageMediaType('IMAGE/PNG'), false);
  eq(isImageMediaType(undefined), false);
  eq(isImageMediaType(null), false);
  eq(isImageMediaType(42), false);
});

// ---------- B 上限 ----------

console.log('\n--- B 上限（`<=` 语义 + 与 webview 的镜像对拍）---');

check('B1 恰好等于上限要放行（`>` 写成 `>=` 会在这里红）', () => {
  eq(imageBytesAllowed(MAX_IMAGE_BYTES), true, '恰好等于上限');
  eq(imageBytesAllowed(MAX_IMAGE_BYTES + 1), false, '多一个字节');
  eq(imageBytesAllowed(0), true, '空文件');
  eq(imageBytesAllowed(-1), false, '负数');
  eq(imageBytesAllowed(Number.NaN), false, 'NaN');
  eq(imageBytesAllowed(Number.POSITIVE_INFINITY), false, 'Infinity');
});

check('B2 张数上限同样是 `<=`', () => {
  eq(imagesWithinCount(MAX_IMAGES_PER_MESSAGE), true);
  eq(imagesWithinCount(MAX_IMAGES_PER_MESSAGE + 1), false);
  eq(imagesWithinCount(0), true);
  eq(imagesWithinCount(Number.NaN), false);
});

check('B3 上限不是从 fileSnapshot.BIN_EXT 借来的那份（10KB 那条是文件附件的，不是图片的）', () => {
  ok(MAX_IMAGE_BYTES > 10 * 1024, '图片上限必须明显大于文本附件的 10KB，否则截图全被拒');
  eq(MAX_IMAGE_BYTES, 3.5 * 1024 * 1024);
});

check('B4 与 webview 的镜像字面量对拍（两边各写一份常量，漂了要在这里红）', () => {
  const js = readFileSync(join(repoRoot, 'media', 'chat.js'), 'utf8');
  ok(
    js.includes('var MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;'),
    'media/chat.js 里的 MAX_IMAGE_BYTES 与扩展侧不是同一个字面量'
  );
  ok(
    js.includes(`var MAX_IMAGES_PER_MESSAGE = ${MAX_IMAGES_PER_MESSAGE};`),
    'media/chat.js 里的 MAX_IMAGES_PER_MESSAGE 与扩展侧不一致'
  );
  for (const t of IMAGE_MEDIA_TYPES) {
    ok(js.includes(`'${t}'`), `media/chat.js 没镜像图片类型 ${t}`);
  }
});

check('B5 落盘目录只在自己完全拥有的子目录里（不碰 .hello-chat 顶层的用户产物）', () => {
  eq(IMAGE_DIR_REL, '.hello-chat/images');
  ok(IMAGE_DIR_REL !== '.hello-chat', '不许用 .hello-chat 顶层：那里有 C12 的 profile.json');
  ok(!IMAGE_DIR_REL.startsWith('/') && !IMAGE_DIR_REL.startsWith('\\'), '必须是相对路径');
});

// ---------- C 文件名 ----------

console.log('\n--- C 文件名（输入不可信）---');

check('C1 剥目录：两种分隔符都要剥（`../../` 不许穿出去）', () => {
  eq(safeImageFileName('../../evil.png', 'image/png'), 'evil.png');
  eq(safeImageFileName('..\\..\\evil.png', 'image/png'), 'evil.png');
  eq(safeImageFileName('a/b/c.png', 'image/png'), 'c.png');
  eq(safeImageFileName('D:\\shots\\shot.png', 'image/png'), 'shot.png');
  eq(safeImageFileName('/tmp/x.gif', 'image/gif'), 'x.gif');
});

check('C2 Windows 保留名加前缀（CON.png 在 Windows 上根本打不开）', () => {
  eq(safeImageFileName('CON.png', 'image/png'), '_CON.png');
  eq(safeImageFileName('com1.jpeg', 'image/jpeg'), '_com1.jpg');
  eq(safeImageFileName('NUL', 'image/png'), '_NUL.png');
  eq(safeImageFileName('console.png', 'image/png'), 'console.png', '只是以 CON 开头不算保留名');
});

check('C3 超长名截到 80 字符（不含扩展名）', () => {
  const long = 'x'.repeat(300) + '.png';
  const out = safeImageFileName(long, 'image/png');
  eq(out.length, 80 + '.png'.length);
  eq(out.slice(-4), '.png');
});

check('C4 撞名加序号（大小写不敏感 —— Windows 上 A.png 与 a.png 是同一个）', () => {
  eq(safeImageFileName('shot.png', 'image/png', ['shot.png']), 'shot-2.png');
  eq(safeImageFileName('shot.png', 'image/png', ['shot.png', 'shot-2.png']), 'shot-3.png');
  eq(safeImageFileName('shot.png', 'image/png', ['SHOT.PNG']), 'shot-2.png');
  eq(safeImageFileName('shot.png', 'image/png', ['other.png']), 'shot.png');
});

check('C5 空名 / 全是点 / 全是非法字符 ⇒ 兜底名，绝不返回空串或 . 开头', () => {
  eq(safeImageFileName('', 'image/png'), 'image.png');
  eq(safeImageFileName('.', 'image/png'), 'image.png');
  eq(safeImageFileName('...', 'image/png'), 'image.png');
  eq(safeImageFileName('.png', 'image/png'), 'image.png', '只剩扩展名的名字');
  eq(safeImageFileName('/', 'image/png'), 'image.png');
});

check('C6 非法字符换成 _，尾部点与空格去掉（Windows 上 a.png. 打不开）', () => {
  eq(safeImageFileName('a<b>c:d"e|f?g*h.png', 'image/png'), 'a_b_c_d_e_f_g_h.png');
  eq(safeImageFileName('shot..png', 'image/png'), 'shot.png');
  eq(safeImageFileName('shot .png', 'image/png'), 'shot.png');
});

check('C7 控制字符（含 nul / 换行）一律去掉', () => {
  eq(safeImageFileName('a\u0000b.png', 'image/png'), 'ab.png');
  eq(safeImageFileName('a\nb\t.png', 'image/png'), 'ab.png');
});

check('C8 多段扩展名只剥最后一段（a.b.png ⇒ a.b）', () => {
  eq(safeImageFileName('a.b.png', 'image/png'), 'a.b.png');
  eq(safeImageFileName('archive.tar.gz', 'image/gif'), 'archive.tar.gif');
});

check('C9 非图片二进制问的是 fileSnapshot 那份清单（不许长出第二张表）', () => {
  eq(fsBinaryExt('a.pdf'), true);
  eq(fsBinaryExt('a.ZIP'), true, '大小写要折叠');
  eq(fsBinaryExt('a.txt'), false);
  eq(fsBinaryExt('noext'), false);
  eq(hasNulByte(Uint8Array.from([0x61, 0x00, 0x62])), true);
  eq(hasNulByte(asciiBytes('hello')), false);
});

check('C10 图片的准入集合与那张表**不是一回事**（借过来就是自相矛盾）', () => {
  // 表里有、图片不认：bmp/ico/pdf/zip 全部如此 —— 这正是「不许复用 BIN_EXT」的实证
  for (const n of ['a.bmp', 'a.ico', 'a.pdf', 'a.zip']) eq(fsBinaryExt(n), true, n);
  eq(sniffImageMediaType(BMP), undefined);
  eq(sniffImageMediaType(ICO), undefined);
  eq(sniffImageMediaType(PDF), undefined);
});

// ---------- D 说明文字 ----------

console.log('\n--- D 说明文字（发给模型的那段）---');

const NOTE_INPUT = {
  name: 'shot.png',
  path: 'D:\\proj\\.hello-chat\\images\\shot.png',
  bytes: 1258291,
  mediaType: 'image/png',
};

check('D1 路径 / 字节数 / MIME / 文件名都在', () => {
  const n = imageNote(NOTE_INPUT);
  ok(n.includes(NOTE_INPUT.path), '没有路径');
  ok(n.includes('1258291'), '没有原始字节数');
  ok(n.includes('1.2 MB'), '没有人读的大小');
  ok(n.includes('image/png'), '没有 MIME');
  ok(n.includes('shot.png'), '没有文件名');
});

check('D1b 盘符路径附 WSL 第二读法；非盘符路径**不附**（真机上那一轮白烧就是这么来的）', () => {
  // 正控：真机那次给的就是这个形态，agent 的 bash 在 WSL 里，`d:/…` 直接「找不到文件」
  const win = imageNote({ ...NOTE_INPUT, path: 'D:\\proj\\.hello-chat\\images\\shot.png' });
  ok(win.includes('/mnt/d/proj/.hello-chat/images/shot.png'), '没有给 WSL 里可执行的那一读');
  ok(win.includes('WSL'), '给了第二读法却没说它什么时候用得上');
  // 反控：POSIX 路径换算后原样返回 ⇒ 不该凭空多出一行 `/mnt/…`（macOS/Linux 上那是纯噪音）
  const posix = imageNote({ ...NOTE_INPUT, path: '/home/u/.hello-chat/images/shot.png' });
  ok(!posix.includes('/mnt/'), 'POSIX 路径上凭空长出了 WSL 读法');
  ok(!posix.includes('WSL'), 'POSIX 路径上多了一句 WSL 的话');
  // 反控 2：真·Windows 路径里本来就带 `mnt` 词（`D:\mnt\x`）时，第二读法要老实换算
  const odd = imageNote({ ...NOTE_INPUT, path: 'D:\\mnt\\a\\shot.png' });
  ok(odd.includes('/mnt/d/mnt/a/shot.png'), '带 mnt 段的路径换算错了');
});

check('D2 明说「模型看不到」与「不支持图片输入」', () => {
  const n = imageNote(NOTE_INPUT);
  ok(n.includes('不支持图片输入'), '没说清是模型不支持');
  ok(n.includes('看不到'), '没说「看不到」—— 模型会一本正经地描述画面');
  ok(n.includes('不要'), '没有「不要凭文件名猜测」那半句');
});

check('D2b 明说「别去『看』它」—— 真机上一句「这是什么东西」就让 agent 装了整套 OCR 栈', () => {
  const n = imageNote(NOTE_INPUT);
  ok(n.includes('不要试图用工具'), '没有拦「用工具把它看出来」这条路');
  ok(n.includes('OCR') && n.includes('装识别工具'), '没有点名那几种走不通的做法');
  ok(n.includes('直接告诉用户'), '只说了别做什么，没说该做什么');
  // 反控：正当的文件操作**必须仍然放行** —— 收得太紧会把「把这个文件挪到 X」也一起拒掉，
  // 那是另一个方向的错（把一个能用的工具变成不能用的）。
  ok(n.includes('只有用户明确要求'), '把用工具这条路整个堵死了 —— 正当的文件操作也会被拒');
});

check('D3 绝不出现 `@"`（DSH 的 @ 只管会话引用，发了等于把 agent 引向文本工具）', () => {
  const n = imageNote(NOTE_INPUT);
  ok(!n.includes('@"'), '说明文字里出现了 @"');
  ok(!/dsh-session:/.test(n), '混进了会话引用语法');
});

check('D4 超长路径 ⇒ 整段截到上限，不无限膨胀', () => {
  const n = imageNote({ ...NOTE_INPUT, path: 'D:\\' + 'x'.repeat(5000) + '.png' });
  ok(n.length <= MAX_IMAGE_NOTE_CHARS + 20, `长度 ${n.length} 超过上限 ${MAX_IMAGE_NOTE_CHARS}`);
  ok(n.includes('已截断'), '截断了却没说');
});

check('D5 formatBytes 的口径（webview 那份镜像要与它一致）', () => {
  eq(formatBytes(0), '0 B');
  eq(formatBytes(999), '999 B');
  eq(formatBytes(1024), '1.0 KB');
  eq(formatBytes(10 * 1024), '10 KB');
  eq(formatBytes(1024 * 1024), '1.0 MB');
  eq(formatBytes(MAX_IMAGE_BYTES), '3.5 MB');
  eq(formatBytes(Number.NaN), '0 B');
  eq(formatBytes(-5), '0 B');
});

check('D6 describeImageAttachment 一行摘要写得像「图片」而不是「文件」', () => {
  const line = describeImageAttachment({ name: 'shot.png', mediaType: 'image/png', bytes: 1258291 });
  ok(line.includes('图片'), '没写「图片」');
  ok(line.includes('模型看不到'), '没写「模型看不到」');
  ok(line.includes('1.2 MB'), '没有大小');
  ok(!line.includes('base64'), '摘要里混进了 base64');
});

console.log('\n--- D7 三条拒绝文案（分开说，是本次要修的缺陷之一）---');

check('D7a 图片过大：不再说成「文件过大（>10KB）」', () => {
  const e = imageTooLargeError();
  ok(e.includes('图片过大'), `实得「${e}」`);
  ok(e.includes('3.5 MB'), `没说清上限：${e}`);
  ok(!e.includes('10KB'), '还留着文本附件那条上限的文案');
});

check('D7b 不是可用的图片：列出真正支持的四种', () => {
  const e = notAnImageError();
  for (const t of ['PNG', 'JPEG', 'WEBP', 'GIF']) ok(e.includes(t), `没列出 ${t}`);
  ok(!e.includes('svg') && !e.includes('SVG'), '把 SVG 列进去了');
});

check('D7c 二进制与张数各有各的话', () => {
  ok(binaryFileError().includes('二进制'), binaryFileError());
  const e = tooManyImagesError(5);
  ok(e.includes('最多 4 张'), e);
  ok(e.includes('5'), '没说本条有几张');
});

// ---------- E 落盘反证 ----------

console.log('\n--- E 落盘反证（会话存储里一个字节的 base64 都不许有）---');

const scratch = mkdtempSync(join(tmpdir(), 'hello-c17-'));
const SESS_FILE = 'probe-c17-sessions.json';

const imgAttachment = (over = {}) => ({
  name: 'shot.png',
  path: 'D:\\proj\\.hello-chat\\images\\shot.png',
  kind: 'image',
  mediaType: 'image/png',
  bytes: 1258291,
  note: imageNote(NOTE_INPUT),
  ...over,
});

check('E1 图片附件的形状：有路径/类型/大小/说明，**没有 content**', () => {
  const a = imgAttachment();
  ok(a.kind === 'image', 'kind 不是 image');
  ok(typeof a.note === 'string' && a.note.length > 0, '没有说明文字');
  eq(a.content, undefined, '图片附件带了 content');
  ok(a.note.includes('看不到'), '说明里没有「看不到」');
});

check('E2 带图片附件的会话落盘再读回：字段一个不少、base64 一个字节没有', () => {
  const store = new SessionStore(scratch, SESS_FILE);
  store.add({
    id: 's1',
    title: '贴了一张图',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: 'm1', role: 'user', text: '看看这张图', status: 'done', attachments: [imgAttachment()] },
    ],
  });
  store.persist();

  const raw = readFileSync(join(scratch, SESS_FILE), 'utf8');
  ok(!raw.includes('base64'), 'sessions JSON 里出现了 base64 字样');
  ok(!raw.includes('dataBase64'), 'sessions JSON 里出现了 dataBase64 字段');
  ok(!raw.includes('iVBORw0KGgo'), 'sessions JSON 里出现了 PNG 的 base64 头');

  // 再开一个 store 读回来（走的是真实的构造 → 解析路径，不是我自己 JSON.parse）
  const again = new SessionStore(scratch, SESS_FILE);
  const s = again.all().find((x) => x.id === 's1');
  ok(s, '会话没被读回来');
  const a = s.messages[0].attachments[0];
  eq(a.kind, 'image');
  eq(a.mediaType, 'image/png');
  eq(a.bytes, 1258291);
  eq(a.content, undefined, '读回来竟然是文本内容');
  ok(a.note.includes('看不到'), '说明文字丢了');
});

check('E3 导出成 Markdown：写着「图片」与大小，且不带正文', () => {
  const md = sessionToMarkdown({
    id: 's1',
    title: '贴了一张图',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: 'm1', role: 'user', text: '看看这张图', status: 'done', attachments: [imgAttachment()] },
    ],
  });
  ok(md.includes('图片'), '导出里没写「图片」');
  ok(md.includes('1.2 MB'), '导出里没有大小');
  ok(!md.includes('base64'), '导出里混进了 base64');
  ok(md.includes('shot.png'), '导出里没有文件名');
});

// ---------- F 源码结构守卫 ----------

console.log('\n--- F 源码结构守卫（顺序与出口都是判据）---');

const readSrc = (f) => readFileSync(join(repoRoot, 'src', f), 'utf8');
const providerSrc = readSrc('chatViewProvider.ts');

check('F1 `readFileAttachment` 的图片分支**先于** 10KB 那道闸（否则截图永远是「文件过大」）', () => {
  const body = providerSrc.slice(providerSrc.indexOf('private _readFileAttachment'));
  // ⚠️ 锚点必须是**那条返回图片的分支**（`if (mediaType) {`），不是嗅探那一行：把闸插在
  // 「嗅探之后、判分支之前」这种写法，锚在 sniff 上会看走眼（实测漏过一次）。
  const imgAt = body.indexOf('if (mediaType) {');
  const sizeAt = body.indexOf('st.size > MAX_FILE_BYTES');
  ok(imgAt > 0, '正文里找不到图片分支了');
  ok(sizeAt > 0, '正文里找不到 10KB 那道闸了');
  ok(imgAt < sizeAt, '图片分支排到 10KB 那道闸后面去了 —— 截图会被判成「文件过大（>10KB）」');
  // 图片分支里**不许**出现按 utf8 读：那是今天最阴的那个缺陷
  const imgBlock = body.slice(imgAt, sizeAt);
  ok(!imgBlock.includes("readFileSync"), '图片分支里出现了 readFileSync');
  // 准入只看**魔数**。这条是结构守卫（不是行为判据）：扩展宿主之外加载不了 provider，
  // 所以「改成采信扩展名」这个变异只能在这里被抓住 —— 详见探针头部的局限说明。
  //
  // ⚠️ 嗅探那一行在 `if (mediaType) {` **上面**（先算出 mediaType 才判分支），所以它不在
  // `imgBlock` 里 —— 上面那个锚点是为了抓住「把闸插在嗅探与分支之间」才挪到分支行的，
  // 挪完就不能再拿 `imgBlock` 去问嗅探（实测自己把自己绊倒过一次：假红）。
  const sniffAt = body.indexOf('sniffImageMediaType(head)');
  ok(sniffAt > 0, '正文里找不到魔数嗅探了 —— 准入不再按魔数判');
  ok(sniffAt < imgAt, '魔数嗅探排到了分支之后（走到分支时 mediaType 还没算出来）');
});

check('F2 `_runLive` 的图片分支在 `<file` 那行**之前**（否则图片拼出一个空块）', () => {
  const body = providerSrc.slice(providerSrc.indexOf('private async _runLive'));
  const imgAt = body.indexOf("a.kind === 'image'");
  const fileAt = body.indexOf('<file name=');
  ok(imgAt > 0, '_runLive 里找不到图片分支');
  ok(fileAt > 0, '_runLive 里找不到 <file> 那行');
  ok(imgAt < fileAt, '图片分支排到 <file> 后面了 —— 模型会以为那个文件是空的');
});

check('F3 chat 模式的 `_buildPrompt` 也有一份（两个模式不许说两套）', () => {
  const body = providerSrc.slice(providerSrc.indexOf('private _buildPrompt'));
  const imgAt = body.indexOf("a.kind === 'image'");
  const fileAt = body.indexOf('<file name=');
  ok(imgAt > 0 && fileAt > 0 && imgAt < fileAt, '_buildPrompt 里没有图片分支（或排到了 <file> 后面）');
  ok(body.includes('noteForAttachment(a)'), '没有走共用的 noteForAttachment');
});

check('F4 `dataBase64` 只在协议里声明、只在解析处被读 —— 没有任何地方把它抄进 Attachment', () => {
  // 图片字节进正文/落盘存储的唯一通路就是「抄」，所以钉住「抄」这个动作本身。
  // ⚠️ `(?!=)` 不能省：少了它，`typeof r.dataBase64 === 'string'` 这个**比较**也会被当成赋值
  //   （实测踩过 —— 那正是本文件里唯一该出现 dataBase64 的地方）。
  ok(!/\.dataBase64\s*=(?!=)/.test(providerSrc), '有人把 dataBase64 赋给了附件');
  ok(!/\.\.\.r[,}]/.test(providerSrc), '出现了对象展开把整条引用抄进附件的写法');
  ok(readSrc('sessionStore.ts').indexOf('base64') < 0, 'sessionStore 里出现了 base64（存储层不该认识它）');
});

check('F6 WSL 换算只有一份实现 —— imageAttach 的**代码**里不许出现 `/mnt/`', () => {
  // 结构守卫（同 C13/C14 那条「一份实现」的体例）：判据必须**委派**给 dshHooks.toWslPath，
  // 否则 hook 命令那边与这里会各算各的，两边迟早漂。第二读法的**行为**由 D1b 钉着。
  const raw = readSrc('imageAttach.ts');
  // ⚠️ 只在**剥掉注释之后**找：`/mnt/d/…` 正是这条约定要解释的东西，注释里出现是对的
  //   —— 第一版忘了剥，于是这条守卫把自己旁边那段解释判成了红（实测踩过）。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(code.length > 0 && code.length < raw.length, '剥注释没剥动 —— 下面的断言等于没查');
  ok(code.includes('export function sniffImageMediaType'), '剥注释把代码也剥掉了（判据失效）');
  ok(!/\/mnt\//.test(code), 'imageAttach 的代码里自己写了一份 /mnt/ 换算');
  ok(/import \{[^}]*toWslPath[^}]*\} from '\.\/dshHooks'/.test(code), '没有从 dshHooks 借 toWslPath');
});

check('F5 图片附件永远不带 content（协议里写死的不变量）', () => {
  const decl = providerSrc.slice(providerSrc.indexOf('private _resolveImageRef'));
  const end = decl.indexOf('private _existingNames');
  const body = decl.slice(0, end > 0 ? end : decl.length);
  ok(!/content\s*:/.test(body), '_resolveImageRef 里给附件写了 content');
  ok(body.includes('sniffImageMediaType(buf)'), '没有对解出来的字节重新嗅探 —— webview 报的类型不可信');
  ok(body.includes('imageBytesAllowed(buf.length)'), '没有按**解码后**的长度重新查上限');
});

check('F6 postMessage 出口只有一个（任何"就地盖章"都得先过这道门）', () => {
  const hits = [...providerSrc.matchAll(/webview\.postMessage\(/g)].length;
  eq(hits, 1, 'webview.postMessage 出现了不止一处');
  const at = providerSrc.indexOf('webview.postMessage(');
  const before = providerSrc.slice(0, at);
  const fnAt = before.lastIndexOf('private _post(');
  ok(fnAt > 0 && at - fnAt < 400, '唯一的出口不在 _post 里');
});

check('F7 C17 的新落点被快照忽略（绝不当成 agent 的改动出现在审阅里）', () => {
  const snap = readSrc('fileSnapshot.ts');
  ok(snap.includes("'.hello-chat',"), '.hello-chat 不在 IGNORED_DIRS 里了');
});

// ---------- G 与既有功能对账 ----------

console.log('\n--- G 与既有功能对账（图片不许把老功能带坏）---');

check('G1 全文检索能用文件名搜到「只带图片」的那条消息', () => {
  const msg = { id: 'm1', role: 'user', text: '', status: 'done', attachments: [imgAttachment()] };
  const hits = searchSessions(
    [{ id: 's1', title: '贴了一张图', createdAt: 1, updatedAt: 1, messages: [msg] }],
    'shot'
  );
  eq(hits.length, 1, '搜不到');
  ok(hits[0].count > 0, '命中了却计数为 0');
});

check('G2 只带图片、没有文字时检索也不许炸（正文是空串）', () => {
  const msg = { id: 'm1', role: 'user', text: '', status: 'done', attachments: [imgAttachment()] };
  const hits = searchSessions(
    [{ id: 's1', title: '', createdAt: 1, updatedAt: 1, messages: [msg] }],
    'zzz-不存在'
  );
  eq(hits.length, 0);
});

check('G3 旧数据（没有 kind 字段）一律照旧当普通附件（向后兼容）', () => {
  const legacy = { name: 'note.txt', path: 'D:\\proj\\note.txt', content: 'hello', truncated: true };
  const line = sessionToMarkdown({
    id: 's2',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: 'm2', role: 'user', text: 'x', status: 'done', attachments: [legacy] }],
  });
  ok(!line.includes('图片'), '老的文本附件被当成了图片');
  ok(line.includes('已截断'), '老的截断标记丢了');
  ok(line.includes('note.txt'), '文件名没写出来');
});

// ---------- 收尾 ----------

try {
  rmSync(scratch, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

if (failures.length) {
  console.log(`\n✗ ${failures.length} 条没过（共 ${passed + failures.length} 条）`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ 全部通过（${passed} 条）`);
  process.exitCode = 0;
}
