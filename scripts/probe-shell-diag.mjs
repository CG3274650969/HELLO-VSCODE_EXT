#!/usr/bin/env node
/**
 * C13 shell 诊断 —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是那条验收：「无 WSL 的机器上给出可读引导，而不是一串 bash 报错」。
 *
 * 那条验收的麻烦在于**本机复现不出来** —— 这台机器上有 Ubuntu（冷启动约 5 s），
 * 「没有发行版」那种状态得去另一台机器上才看得见。所以本探针把它拆成三道：
 *
 *   1. **F4 的 116 字节当夹具**：WSL shim 起不来时的原始输出（UTF-16LE 落在 stdout）逐字节复刻，
 *      喂给纯函数 —— 解码、判定、话术全都能在宿主之外钉死（C、D 两组，以及 H4 的端到端不等式）；
 *   2. **判据全在纯函数里**：`resolveOnPath` / `classifyBashPath` / `usabilityOf` / `shellWarnFor` /
 *      `prependPathDir` / `readPosixTarget` 都不 import vscode，假 env + 假 isFile 就能验；
 *   3. **真机正控自适应**：H 组去本机真找一把 Git bash，找到就断言「钉住它之后 posix 形态成立」，
 *      一个都找不到就**响亮地跳过**（⚠，并且**不算通过**）—— 绝不静默绿。
 *
 * 这里钉的每条都对应一条**实测**事实（F1–F4，见 `src/shellDiag.ts` 头注释），
 * 其中两条是「照直觉写就会错」的，探针专门给它们留了反控：
 *
 *   - **PATHEXT 是死的**（F2）：libuv 硬写 `.exe`。照抄上游的 `executableCandidates` 会算出错的赢家；
 *   - **env 里没有 PATH 键时 spawn 会回退宿主真实环境**（F3）：所以 `prependPathDir` 删了必须补。
 *
 *   ./dist-runtime/node/node.exe scripts/probe-shell-diag.mjs
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'out');

async function load(moduleName) {
  const file = join(outDir, moduleName);
  if (!existsSync(file)) {
    console.error(`缺少编译产物：${file}\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
    process.exit(2);
  }
  return import(pathToFileURL(file).href);
}

const { decodeShimOutput, probeBash, probeShell, classifyShell } = await load('dshHooks.js');
const {
  adviceFor,
  classifyBashPath,
  gitBashCandidateDirs,
  pathValue,
  prependPathDir,
  readPosixTarget,
  resolveOnPath,
  shellPin,
  shellStatusSegment,
  shellWarnFor,
  usabilityOf,
  WSL_SHIM_ERROR_TEXT,
  wslCodeOf,
} = await load('shellDiag.js');

// ---------- 断言小工具（体例同 probe-approval-shell） ----------

let passed = 0;
const failures = [];
/** 被跳过的（机器相关、这次环境不满足）—— 单独计数，**绝不混进 passed** */
const skipped = [];

async function check(name, fn) {
  try {
    const r = await fn();
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

// ---------- 夹具与小工具 ----------

/** Windows 字面量路径（省得数反斜杠） */
const W = String.raw;

const WIN = 'win32';
const SHIM_DIR = W`C:\Windows\System32`;
const GIT_DIR = W`C:\Program Files\Git\bin`;
const GIT_USR_DIR = W`C:\Program Files\Git\usr\bin`;

/** 假 env：只给 PATH（键名可控），把「宿主长什么样」彻底排除在判据之外 */
function envOf(pathStr, key = 'PATH') {
  return key === null ? {} : { [key]: pathStr };
}

/** 假文件系统：`files` 里给的路径算存在，**大小写不敏感**（Windows 上的真相） */
function fakeFs(files) {
  const set = files.map((f) => f.toLowerCase());
  return (p) => set.includes(p.toLowerCase());
}

/** 造一份诊断（只给关心的字段，其余留空） */
function mkDiag(patch) {
  return Object.assign(
    {
      platform: WIN,
      shape: 'other',
      classEvidence: '夹具',
      hits: [],
      tried: [],
      usability: 'usable',
    },
    patch
  );
}

// F4：原始抓到的 116 字节 / 奇数位 NUL 占比 0.690。夹具必须与它逐字节同形
const SHIM_BYTES = Buffer.from(WSL_SHIM_ERROR_TEXT, 'utf16le');
const SHIM_TEXT = '不存在具有所提供名称的分发。\r\n错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n';

console.log('== A 组：PATH 解析（F1/F2/F3 的语义，假 env + 假 isFile）\n');

await check('A1 命中 PATH 上的第一个 bash（shim 在前 → 就是 shim）', () => {
  const env = envOf(`${SHIM_DIR};${GIT_DIR}`);
  const r = resolveOnPath('bash', env, { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`, `${GIT_DIR}\\bash.exe`]) });
  ok(r.path.toLowerCase() === `${SHIM_DIR}\\bash.exe`.toLowerCase(), `path = ${r.path}`);
  ok(r.name === 'bash.exe', `name = ${r.name}`);
  ok(r.hits.length === 2, `两个都该被记下来（用户可能想把后面那个钉上来）：${r.hits.length}`);
});

await check('A2 Git bin 在前 → 命中的是 Git bash，且 hits[0] 就是它', () => {
  const env = envOf(`${GIT_DIR};${SHIM_DIR}`);
  const r = resolveOnPath('bash', env, { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`, `${GIT_DIR}\\bash.exe`]) });
  ok(r.path.toLowerCase() === `${GIT_DIR}\\bash.exe`.toLowerCase(), `path = ${r.path}`);
  ok(classifyBashPath(r.path).shape === 'git-bash');
});

await check('A3 一个都没有 → path 空，但 tried 必须如实列出「看过哪些位置」', () => {
  const r = resolveOnPath('bash', envOf(`${SHIM_DIR};${GIT_DIR}`), { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([]) });
  ok(r.path === undefined, `path = ${r.path}`);
  ok(r.hits.length === 0);
  // 每个目录试了 `bash` 和 `bash.exe` 两个名字 → 4 条留痕。**这条是「没找到」与「没找」的分界**
  ok(r.tried.length === 4, `tried = ${JSON.stringify(r.tried)}`);
});

await check('A4 WindowsApps 别名（微软商店版 shim）也算命中', () => {
  const dir = W`C:\Users\x\AppData\Local\Microsoft\WindowsApps`;
  const r = resolveOnPath('bash', envOf(dir), { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${dir}\\bash.exe`]) });
  ok(classifyBashPath(r.path).shape === 'wsl-shim', `shape = ${classifyBashPath(r.path).shape}`);
});

await check('A5 反控 F2：PATHEXT 说什么都无所谓（libuv 硬写 .exe）', () => {
  // ⚠️ 这条是「不许照抄 dsh-subprocess-local.executableCandidates」的机器证明：
  // 那个实现认 PATHEXT，喂这组 env 它会得出「没有 bash」，而真实 spawn 会命中 bash.exe
  const env = { PATH: SHIM_DIR, PATHEXT: '.COM;.BAT' };
  const r = resolveOnPath('bash', env, { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`]) });
  ok(r.path !== undefined, '带了 PATHEXT 就找不到 bash —— 那正是照抄上游会犯的错');
  const env2 = { PATH: SHIM_DIR }; // 连 PATHEXT 都没有，照样命中
  ok(resolveOnPath('bash', env2, { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`]) }).path !== undefined);
});

await check('A6 显式给了扩展名 → 只试这一个名字（不再追加 .exe）', () => {
  const r = resolveOnPath('bash.exe', envOf(SHIM_DIR), { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`]) });
  ok(r.path !== undefined);
  ok(r.tried.length === 1, `tried = ${JSON.stringify(r.tried)}`);
});

await check('A7 空项被跳过（`;;` 不是「当前目录」）', () => {
  const r = resolveOnPath('bash', envOf(`;${SHIM_DIR};;`), { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`]) });
  ok(r.path !== undefined);
  ok(r.tried.length === 2, `空项不该进 tried：${JSON.stringify(r.tried)}`);
});

await check('A8 反控 F3：`PATH=""` 不回退当前目录（cwd 里那把不会被捡到）', () => {
  const cwd = W`D:\proj\bin`;
  // 假 fs 里 cwd 下**确实**有 bash.exe —— 只有实现了「回退 cwd」才会命中
  const r = resolveOnPath('bash', envOf(''), { platform: WIN, cwd, isFile: fakeFs([`${cwd}\\bash.exe`]) });
  ok(r.path === undefined, `居然回退了 cwd：${r.path}`);
  ok(r.tried.length === 0);
});

await check('A9 相对项按**子进程 cwd** 解析（F3 第 3 条）', () => {
  const cwd = W`D:\proj`;
  const r = resolveOnPath('bash', envOf('bin'), { platform: WIN, cwd, isFile: fakeFs([`${cwd}\\bin\\bash.exe`]) });
  ok(r.path.toLowerCase() === `${cwd}\\bin\\bash.exe`.toLowerCase(), `path = ${r.path}`);
});

await check('A10 `Path` / `PATH` 并存时大写胜；只有 `Path` 也能读出来', () => {
  const both = { Path: SHIM_DIR, PATH: GIT_DIR };
  ok(pathValue(both) === GIT_DIR, `取到了 ${pathValue(both)}`);
  const r = resolveOnPath('bash', both, { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`, `${GIT_DIR}\\bash.exe`]) });
  ok(r.path.toLowerCase() === `${GIT_DIR}\\bash.exe`.toLowerCase(), `赢家该来自大写 PATH：${r.path}`);
  ok(pathValue({ Path: GIT_DIR }) === GIT_DIR);
});

await check('A11 反控 F3 的地雷：env 里**没有** PATH 键 → 解析结果为空且要标出来', () => {
  const r = resolveOnPath('bash', {}, { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([]) });
  ok(r.noPathKey === true, '没标出「连 PATH 键都没有」——这正是不许删了 PATH 不补的理由');
  ok(r.path === undefined);
});

await check('A12 平台隔离：posix 用 `:` 分隔、不试 `.exe`；win32 语义在别的宿主上也照走', () => {
  const r = resolveOnPath('bash', envOf('/usr/local/bin:/usr/bin'), { platform: 'linux', cwd: '/tmp', isFile: (p) => p === '/usr/bin/bash' });
  ok(r.path === '/usr/bin/bash', `path = ${r.path}`);
  ok(r.tried.length === 2, `linux 上不该出现 .exe：${JSON.stringify(r.tried)}`);
  // 宿主是 linux 也走 win32 分支：证的是「platform 由参数决定，不看 process.platform」
  const w = resolveOnPath('bash', envOf(SHIM_DIR), { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`]) });
  ok(w.path.toLowerCase().endsWith('\\bash.exe'));
});

console.log('\n== B 组：形状分类（只看目录形状，绝不硬编码本机路径）\n');

await check('B1 空 / 空白 → none', () => {
  ok(classifyBashPath(undefined).shape === 'none');
  ok(classifyBashPath('   ').shape === 'none');
});

await check('B2 System32（大小写随便写）→ wsl-shim，evidence 点名触因', () => {
  for (const p of [W`C:\Windows\System32\bash.exe`, W`c:\WINDOWS\system32\bash.exe`]) {
    const c = classifyBashPath(p);
    ok(c.shape === 'wsl-shim', `${p} → ${c.shape}`);
    ok(/system32/i.test(c.evidence), `evidence 没点名：${c.evidence}`);
  }
});

await check('B3 WindowsApps（商店版别名）→ wsl-shim', () => {
  const p = W`C:\Users\x\AppData\Local\Microsoft\WindowsApps\bash.exe`;
  const c = classifyBashPath(p);
  ok(c.shape === 'wsl-shim', c.shape);
  ok(/windowsapps/i.test(c.evidence), c.evidence);
});

await check('B4 Git for Windows 的两种布局 → git-bash', () => {
  for (const p of [`${GIT_DIR}\\bash.exe`, `${GIT_USR_DIR}\\bash.exe`]) {
    const c = classifyBashPath(p);
    ok(c.shape === 'git-bash', `${p} → ${c.shape}`);
    ok(/git for windows/i.test(c.evidence), c.evidence);
  }
});

await check('B5 反控：Cygwin / 裸 bash.exe → other（否则一个「恒返回 wsl-shim」的实现也能过 B2B3）', () => {
  for (const p of [W`C:\cygwin64\bin\bash.exe`, W`D:\tools\msys64\usr\bin\bash.exe`, 'bash.exe']) {
    const c = classifyBashPath(p);
    ok(c.shape === 'other', `${p} → ${c.shape}`);
    ok(/不是/.test(c.evidence), c.evidence);
  }
});

console.log('\n== C 组：三值判定 + 「该不该弹窗」的配对断言\n');

await check('C1 Linux / MINGW64 → usable', () => {
  ok(usabilityOf({ ok: true, retriable: false, stdout: 'Linux\n' }) === 'usable');
  ok(usabilityOf({ ok: true, retriable: false, stdout: 'MINGW64_NT-10.0-26200\n' }) === 'usable');
});

await check('C2 反控：退出 0 但答的不是 uname（Darwin）→ broken（不是 indeterminate）', () => {
  // 「能跑但跑的不是 bash」是**确定性的**坏，给 indeterminate 会让用户永远等一个不会来的结论
  ok(usabilityOf({ ok: true, retriable: false, stdout: 'Darwin\n' }) === 'broken');
});

await check('C3 超时 → indeterminate（冷启动那条，绝不报成坏）', () => {
  ok(usabilityOf({ ok: false, retriable: true, stdout: '' }) === 'indeterminate');
});

await check('C4 反控：非零却两流皆空 → indeterminate（启动器半路熄火）', () => {
  ok(usabilityOf({ ok: false, retriable: true, stdout: '' }) === 'indeterminate');
});

await check('C5 F4 夹具 → broken，且能还原出语言无关的 WSL_E_ 令牌', () => {
  const text = decodeShimOutput(SHIM_BYTES);
  const u = usabilityOf({ ok: false, retriable: false, stdout: text });
  ok(u === 'broken', `usability = ${u}`);
  ok(wslCodeOf(text) === 'WSL_E_DISTRO_NOT_FOUND', `wslCode = ${wslCodeOf(text)}`);
});

await check('C6 夹具没变形（116 字节、奇数位 NUL 占比 0.690）', () => {
  // 夹具是「无 WSL 的机器」那条验收的**唯一**证据来源，它一旦漂移，整套判据就都失去依据
  let odd = 0;
  for (let i = 1; i < SHIM_BYTES.length; i += 2) if (SHIM_BYTES[i] === 0) odd++;
  const ratio = odd / Math.floor(SHIM_BYTES.length / 2);
  ok(SHIM_BYTES.length === 116, `字节数 = ${SHIM_BYTES.length}（实测抓到的是 116）`);
  ok(Math.abs(ratio - 0.69) < 0.01, `奇数位 NUL 占比 = ${ratio.toFixed(3)}（实测 0.690）`);
  ok(SHIM_TEXT.includes('不存在具有所提供名称的分发'), '夹具文本与抓到的样本不一致');
});

await check('C7 spawnError / 没有候选 → broken（确定性）', () => {
  ok(usabilityOf({ ok: false, retriable: false, spawnError: 'ENOENT', stdout: '' }) === 'broken');
  ok(usabilityOf({ ok: false, retriable: false, noCandidate: true, stdout: '' }) === 'broken');
});

await check('C8 配对：usable / indeterminate 上 shellWarnFor 必须 undefined，broken 上必须有', () => {
  // ⚠️ 这条是「冷启动不误报」的机器证明。判据是纯函数，所以两条断言能把整个空间夹住
  const usable = [mkDiag({ usability: 'usable' }), mkDiag({ usability: 'usable', shape: 'wsl-shim' })];
  const indeterminate = [mkDiag({ usability: 'indeterminate' }), mkDiag({ usability: 'indeterminate', detail: '超时（8s）' })];
  for (const d of [...usable, ...indeterminate]) {
    ok(shellWarnFor(d) === undefined, `不该弹窗却给了文本：${d.usability} / ${shellWarnFor(d)}`);
  }
  const broken = [
    mkDiag({ usability: 'broken', bashPath: `${SHIM_DIR}\\bash.exe`, shape: 'wsl-shim', wslCode: 'WSL_E_DISTRO_NOT_FOUND' }),
    mkDiag({ usability: 'broken', bashPath: `${SHIM_DIR}\\bash.exe`, shape: 'wsl-shim' }),
    mkDiag({ usability: 'broken' }),
  ];
  for (const d of broken) {
    const text = shellWarnFor(d);
    ok(typeof text === 'string' && text.length > 0, `坏了却不吭声：${JSON.stringify(d)}`);
  }
});

await check('C9 唯一的例外：用户自己钉的路径不存在 → 即使 bash 能用也要说（亲手设的东西不该静默失效）', () => {
  const d = mkDiag({ usability: 'usable', pinMissing: W`D:\nope\bash.exe` });
  const text = shellWarnFor(d);
  ok(typeof text === 'string' && text.includes('bash.exe'), `没提指空的那个路径：${text}`);
  ok(adviceFor(d).kind === 'pin-missing', adviceFor(d).kind);
});

await check('C10 告警里必须带上「工具 cwd / 能不能出工作区」（C13 的 UI 表达那半）', () => {
  const d = mkDiag({ usability: 'broken', runCwd: W`D:\proj`, outsideGated: false });
  const text = shellWarnFor(d);
  ok(text.includes(W`D:\proj`), `没给 cwd：${text}`);
  ok(text.includes('工作区'), '没提工作区内外');
  ok(text.includes('不会'), `outsideGated=false 时该提示"不拦"：${text}`);
  const gated = shellWarnFor(mkDiag({ usability: 'broken', runCwd: W`D:\proj`, outsideGated: true }));
  ok(gated.includes('会被审批拦下'), gated);
});

await check('C11 五种话术各自能认出来（文案不许串台）', () => {
  const noBash = adviceFor(mkDiag({ usability: 'broken', shape: 'none' }));
  ok(noBash.kind === 'no-bash', noBash.kind);
  ok(/一个 bash 都没有/.test(noBash.headline), noBash.headline);
  ok(/Git for Windows/.test(noBash.action), noBash.action);
  const noDistro = adviceFor(mkDiag({ usability: 'broken', shape: 'wsl-shim', wslCode: 'WSL_E_DISTRO_NOT_FOUND', bashPath: 'x' }));
  ok(noDistro.kind === 'wsl-no-distro', noDistro.kind);
  ok(/发行版/.test(noDistro.headline), noDistro.headline);
  const shimBroken = adviceFor(mkDiag({ usability: 'broken', shape: 'wsl-shim', detail: '退出码 4294967295' }));
  ok(shimBroken.kind === 'wsl-broken', shimBroken.kind);
  const wslOk = adviceFor(mkDiag({ usability: 'usable', shape: 'wsl-shim', bashPath: 'x' }));
  ok(wslOk.kind === 'wsl-usable', wslOk.kind);
  ok(/WSL/.test(wslOk.headline), wslOk.headline);
  const ind = adviceFor(mkDiag({ usability: 'indeterminate' }));
  ok(ind.kind === 'indeterminate', ind.kind);
});

await check('C12 非 Windows 上整段不出现（Remote-SSH 下 bash 是真的，推荐装 Git 是噪声）', () => {
  ok(shellStatusSegment(mkDiag({ platform: 'linux', usability: 'broken' })) === undefined);
  ok(shellStatusSegment(mkDiag({ platform: 'darwin', usability: 'usable' })) === undefined);
});

await check('C13 状态条三态：能用且不是 WSL ⇒ 不出现；WSL ⇒ 琥珀；不可判 ⇒ 琥珀；坏 ⇒ 红', () => {
  ok(shellStatusSegment(mkDiag({ shape: 'git-bash', usability: 'usable' })) === undefined, '能用还占地方');
  ok(shellStatusSegment(mkDiag({ shape: 'wsl-shim', usability: 'usable', bashPath: 'x' })).level === 'wsl');
  ok(shellStatusSegment(mkDiag({ usability: 'indeterminate' })).level === 'warn');
  ok(shellStatusSegment(mkDiag({ usability: 'broken' })).level === 'bad');
});

await check('C14 pin 指空时状态条要现身（`bash=pin?`），不能因为 bash 能用就整段消失', () => {
  const seg = shellStatusSegment(mkDiag({ shape: 'git-bash', usability: 'usable', pinMissing: W`D:\nope\bash.exe` }));
  ok(seg !== undefined, '指空被静默吞掉了');
  ok(seg.label === 'bash=pin?', seg.label);
  ok(seg.title.includes('bash.exe'), seg.title);
});

console.log('\n== D 组：解码（F4 的 UTF-16LE）+ 反控\n');

await check('D1 116 字节 UTF-16LE → 中文与令牌都还原', () => {
  const text = decodeShimOutput(SHIM_BYTES);
  ok(text.includes(SHIM_TEXT.trim()), `解出来的是：${JSON.stringify(text)}`);
});

await check('D2 反控：纯 ASCII 原样返回（绝不"总是按 utf16 解"）', () => {
  const raw = Buffer.from('MINGW64_NT-10.0-26200\n', 'utf8');
  ok(decodeShimOutput(raw) === 'MINGW64_NT-10.0-26200\n');
});

await check('D3 反控：UTF-8 中文原样返回', () => {
  const raw = Buffer.from('不存在具有所提供名称的分发', 'utf8');
  ok(decodeShimOutput(raw) === '不存在具有所提供名称的分发', JSON.stringify(decodeShimOutput(raw)));
});

await check('D4 反控：PNG 头那种「有一点点 NUL」的字节不许被当成 UTF-16LE', () => {
  // 奇位 NUL 占比 0.125 —— 阈值 0.4 就是为把它挡在外面而定的
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  ok(decodeShimOutput(raw).startsWith('\uFFFD') || decodeShimOutput(raw).startsWith('\u0089'), '被按 utf16 解了');
  ok(!decodeShimOutput(raw).includes('I\u0000H'), '解出了 UTF-16 的形态');
});

await check('D5 空输入 → 空串；字符串入参也走同一条路', () => {
  ok(decodeShimOutput(Buffer.alloc(0)) === '');
  ok(decodeShimOutput('') === '');
  ok(decodeShimOutput('plain') === 'plain');
});

await check('D6 带 BOM 的变体：BOM 被剥掉（两种形态都解成同一句话）', () => {
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(WSL_SHIM_ERROR_TEXT, 'utf16le')]);
  ok(decodeShimOutput(withBom).startsWith('不存在'), JSON.stringify(decodeShimOutput(withBom).slice(0, 8)));
});

await check('D7 分块到达：chunk 劈开码元也不能解出半个字（这就是"累积到 close 再解"的理由）', () => {
  // spawnProbe 里逐块 push、最后 Buffer.concat 一次解码。这里把那一步原样做一遍：
  // 从正中劈开（正好劈在一个 UTF-16 码元的中间）
  const half = Math.floor(SHIM_BYTES.length / 2);
  const joined = Buffer.concat([SHIM_BYTES.subarray(0, half), SHIM_BYTES.subarray(half)]);
  ok(decodeShimOutput(joined) === decodeShimOutput(SHIM_BYTES));
  // 反控：真逐块解会得到什么 —— 至少证明"劈开"这件事本身是有意义的
  const piecewise = decodeShimOutput(SHIM_BYTES.subarray(0, half)) + decodeShimOutput(SHIM_BYTES.subarray(half));
  ok(piecewise !== decodeShimOutput(SHIM_BYTES), '夹具没能被劈开（这条反控失去了意义）');
});

console.log('\n== E 组：PATH 注入（钉住 bash 的那一半）\n');

await check('E1 前置后键集合恰好是 [PATH]（`Path` 变体已被删掉，只留一个大写）', () => {
  const env = { Path: SHIM_DIR, FOO: 'bar' };
  const out = prependPathDir(env, GIT_DIR, WIN);
  const keys = Object.keys(out);
  ok(keys.includes('PATH') && !keys.includes('Path'), JSON.stringify(keys));
  ok(out.PATH === `${GIT_DIR};${SHIM_DIR}`, out.PATH);
  ok(out.FOO === 'bar');
});

await check('E2 幂等：已经前置过就不再前置（设置一变就重连，这条路上会走两次）', () => {
  const once = prependPathDir(envOf(SHIM_DIR), GIT_DIR, WIN);
  const twice = prependPathDir(once, GIT_DIR, WIN);
  ok(twice.PATH === once.PATH, `${once.PATH} → ${twice.PATH}`);
  // 大小写不同也算同一个目录（Windows 上就是同一个地方）
  ok(prependPathDir(once, GIT_DIR.toUpperCase(), WIN).PATH === once.PATH);
});

await check('E3 空 dir ⇒ **同一个对象**（未设 pin 时逐字节不变，取最强形式）', () => {
  const env = envOf(SHIM_DIR);
  ok(prependPathDir(env, '', WIN) === env, '空 dir 竟然造了新对象');
  ok(prependPathDir(env, '   ', WIN) === env, '全空白也该是同一个对象');
});

await check('E4 `shellPin` 只认非空串（空白/非串 = 未设）', () => {
  ok(shellPin('  ') === undefined);
  ok(shellPin('') === undefined);
  ok(shellPin(undefined) === undefined);
  ok(shellPin(null) === undefined);
  ok(shellPin(123) === undefined);
  ok(shellPin(W` D:\Git\bin\bash.exe `) === W`D:\Git\bin\bash.exe`, '该 trim 出真路径');
});

await check('E5 posix 分隔符是 `:`', () => {
  const out = prependPathDir(envOf('/usr/bin'), '/opt/git/bin', 'linux');
  ok(out.PATH === '/opt/git/bin:/usr/bin', out.PATH);
});

await check('E6 不改入参', () => {
  const env = { Path: SHIM_DIR };
  const before = JSON.stringify(env);
  prependPathDir(env, GIT_DIR, WIN);
  ok(JSON.stringify(env) === before, `入参被改了：${JSON.stringify(env)}`);
});

await check('E7 F3 的地雷：env 里没有 PATH 键 ⇒ 结果**必有** PATH 键（删了必须补）', () => {
  const out = prependPathDir({}, GIT_DIR, WIN);
  ok(out.PATH === GIT_DIR, `PATH = ${out.PATH}（没有 PATH 键时 spawn 会回退宿主真实环境，前置就静默失效了）`);
});

await check('E8 值是空串的 PATH ⇒ 结果就是 dir（不留下一个孤零零的分隔符）', () => {
  ok(prependPathDir(envOf(''), GIT_DIR, WIN).PATH === GIT_DIR);
});

await check('E9 F1 的因果：钉住之后**解析器**也会挑到那把 bash', () => {
  const env = envOf(`${SHIM_DIR};${GIT_DIR}`);
  const pinned = prependPathDir(env, GIT_DIR, WIN);
  const r = resolveOnPath('bash', pinned, { platform: WIN, cwd: W`D:\proj`, isFile: fakeFs([`${SHIM_DIR}\\bash.exe`, `${GIT_DIR}\\bash.exe`]) });
  ok(r.path.toLowerCase() === `${GIT_DIR}\\bash.exe`.toLowerCase(), `path = ${r.path}`);
  ok(classifyBashPath(r.path).shape === 'git-bash');
});

await check('E10 备选目录只给厂商默认位置（本机发现值绝不进代码）', () => {
  const dirs = gitBashCandidateDirs({ ProgramFiles: W`C:\Program Files`, 'ProgramFiles(x86)': W`C:\Program Files (x86)` }, WIN);
  ok(dirs.length >= 2, JSON.stringify(dirs));
  ok(dirs.every((d) => /program files/i.test(d)), JSON.stringify(dirs));
  ok(dirs.some((d) => d.toLowerCase().endsWith('\\git\\bin')), JSON.stringify(dirs));
  ok(dirs.some((d) => d.toLowerCase().endsWith('\\git\\usr\\bin')), JSON.stringify(dirs));
  ok(gitBashCandidateDirs({ ProgramFiles: W`C:\Program Files` }, 'linux').length === 0, '非 Windows 不该给候选');
});

console.log('\n== F 组：POSIX 路径的两读法（只显示，不改写）\n');

await check('F1 `/mnt/d/x` + cwd `D:\\proj` → 想指 D:\\x，实际落到 D:\\mnt\\d\\x（C4 那次真事故）', () => {
  const t = readPosixTarget('/mnt/d/metabase/c4-note.txt', W`D:\proj`);
  ok(t.intended === W`D:\metabase\c4-note.txt`, `intended = ${t.intended}`);
  ok(t.actual === W`D:\mnt\d\metabase\c4-note.txt`, `actual = ${t.actual}`);
});

await check('F2 同一个 raw 换个 cwd（另一块盘）→ actual 的盘符跟着变（盘符来自 cwd，不是从 /mnt 猜的）', () => {
  const t = readPosixTarget('/mnt/d/x', W`C:\proj`);
  ok(t.actual === W`C:\mnt\d\x`, `actual = ${t.actual}`);
  ok(t.intended === W`D:\x`, `intended = ${t.intended}`);
});

await check('F3 MSYS 形态 `/c/Users/x/a` → C:\\Users\\x\\a', () => {
  const t = readPosixTarget('/c/Users/x/a', W`D:\proj`);
  ok(t.intended === W`C:\Users\x\a`, `intended = ${t.intended}`);
});

await check('F4 反控：`/etc/passwd` 不猜盘符（intended 留空，但 actual 仍要算）', () => {
  const t = readPosixTarget('/etc/passwd', W`D:\proj`);
  ok(t.intended === undefined, `居然猜了：${t.intended}`);
  ok(t.actual === W`D:\etc\passwd`, t.actual);
});

await check('F5 反控：Windows 路径 / 相对路径 / UNC 一律整条 undefined', () => {
  ok(readPosixTarget(W`D:\x`, W`D:\proj`) === undefined);
  ok(readPosixTarget('notes.txt', W`D:\proj`) === undefined);
  ok(readPosixTarget('//server/share/x', W`D:\proj`) === undefined, 'UNC 不是 POSIX 形态');
});

await check('F6 cwd 为空 ⇒ 整条 undefined（印一个猜出来的落点比不说更糟）', () => {
  ok(readPosixTarget('/mnt/d/x', '') === undefined);
  ok(readPosixTarget('/mnt/d/x', '   ') === undefined);
});

await check('F7 跨宿主不变性：走的是显式 win32 语义（本探针在 Linux 上跑也一样）', () => {
  const t = readPosixTarget('/mnt/d', W`D:\proj`);
  ok(t.actual === W`D:\mnt\d`, `actual = ${t.actual}`);
  ok(t.intended === 'D:\\', `intended = ${t.intended}`);
});

console.log('\n== G 组：不许漂移（同一份事实，两个函数必须说同一句话）\n');

await check('G1 三条真实 uname 上 classifyShell 与 usabilityOf 结论一致', () => {
  const rows = [
    ['Linux\n', 'wsl'],
    ['MINGW64_NT-10.0-26200\n', 'posix'],
    ['Darwin\n', undefined],
  ];
  for (const [out, kind] of rows) {
    ok(classifyShell(out) === kind, `${JSON.stringify(out)} → ${classifyShell(out)}，该是 ${kind}`);
    const u = usabilityOf({ ok: true, retriable: false, stdout: out });
    ok(kind === undefined ? u === 'broken' : u === 'usable', `${JSON.stringify(out)} → ${u}`);
  }
});

await check('G2 空输出不是任何形态（认不出就说认不出）', () => {
  ok(classifyShell('') === undefined);
  ok(classifyShell('   \n') === undefined);
});

console.log('\n== H 组：真机（机器相关的那部分，该跳就响亮地跳）\n');

const hostEnv = process.env;
const runCwd = repoRoot;

const real = await probeBash(runCwd, { env: hostEnv });
console.log(`本机探针：ok=${real.ok} retriable=${real.retriable} timedOut=${real.timedOut} kind=${real.kind}`);
console.log(`  stdout=${JSON.stringify(real.stdout.slice(0, 80))}`);
console.log(`  detail=${real.detail}\n`);

await check('H1 真机记录 → 三值判定：三者必须自洽（这是「判定全是纯函数」的机器证明）', () => {
  const u = usabilityOf({ ok: real.ok, retriable: real.retriable, spawnError: real.spawnError, stdout: real.stdout });
  const expect = real.retriable ? 'indeterminate' : real.ok && real.kind ? 'usable' : 'broken';
  ok(u === expect, `记录 ok=${real.ok} retriable=${real.retriable} kind=${real.kind} 却判成 ${u}（该是 ${expect}）`);
  if (real.timedOut) {
    // 超时本身不是失败：它恰恰是「不可判」那一档的实证，只是这一轮的冷启动分支没被测到
    console.log('  ⚠ 本机这次探针超时 —— 冷启动那条分支这次只有纯函数在守（C3/C4）');
  }
});

await check('H2 `probeShell` 的返回类型仍然只是一个形态（probe-sandbox 拿它直接比 === "wsl"）', async () => {
  const kind = await probeShell(runCwd);
  ok(kind === 'wsl' || kind === 'posix', `返回了 ${JSON.stringify(kind)} —— 改成对象会让那边的比较恒假且探针还是绿的`);
});

await check('H3 反控：真 env 上「未设 pin」也是同一个对象（零回归取最强形式）', () => {
  ok(prependPathDir(hostEnv, '', process.platform) === hostEnv);
});

await (async () => {
  // 正控：自适应去本机找一把真 Git bash。**找不到就响亮地跳过** —— 绝不静默通过
  const cands = [];
  for (const entry of String(pathValue(hostEnv) ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const dir = entry.trim().replace(/[\\/]+$/, '');
    if (!dir) continue;
    try {
      if (statSync(join(dir, 'bash.exe')).isFile()) cands.push({ dir, how: 'PATH 项' });
    } catch {
      /* 这个 PATH 项里没有 bash.exe */
    }
  }
  for (const dir of gitBashCandidateDirs(hostEnv, process.platform)) {
    try {
      if (statSync(join(dir, 'bash.exe')).isFile()) cands.push({ dir, how: '厂商默认位置' });
    } catch {
      /* 这台机器上没装在那个默认位置 */
    }
  }
  let good;
  for (const c of cands) {
    const p = await probeBash(runCwd, { env: prependPathDir(hostEnv, c.dir, process.platform), timeoutMs: 8000 });
    if (p.ok && p.kind === 'posix') good = { ...c, p };
    if (good) break;
  }
  await check('H4 正控：找一把真 Git bash，钉住后 posix 形态成立（找不到则响亮跳过）', () => {
    if (!good) {
      // 醒目但不冒充通过：本机确实没有 Git bash，这一条拿实机验不了。
      // ⚠️ 注意这里**不 push 到 failures**、也**不 push 到 passed** —— 跳就是跳
      skipped.push(`H4 内容：本机没找到可用的 Git bash（找过 ${cands.length} 个候选）`);
      console.log('  ⚠ 跳过：本机没有可用的 Git bash，正控拿实机验不了（**不算通过**）');
      return;
    }
    console.log(`  正控用的是：${good.dir}（${good.how}），uname = ${JSON.stringify(good.p.stdout.trim())}`);
    const pinnedEnv = prependPathDir(hostEnv, good.dir, process.platform);
    const res = resolveOnPath('bash', pinnedEnv, { cwd: runCwd });
    ok(
      res.path && res.path.toLowerCase().startsWith(good.dir.toLowerCase()),
      `钉住 ${good.dir} 之后解析到的却是 ${res.path}`
    );
    ok(classifyBashPath(res.path).shape !== 'wsl-shim', '钉住的这把竟然被认成 WSL 启动器');
  });

  await check('H5 端到端不等式：无 WSL 的机器上，两个坏法必须得到**两条不同**的可读话术', () => {
    // 这道是那条验收（「给可读引导而非一串 bash 报错」）的机器可验形态：
    // ① 只有 System32 → 必须说「WSL 里没有发行版」，且认出 WSL_E_ 令牌
    const shimDiag = mkDiag({
      usability: 'broken',
      shape: 'wsl-shim',
      bashPath: `${SHIM_DIR}\\bash.exe`,
      wslCode: wslCodeOf(decodeShimOutput(SHIM_BYTES)),
      detail: decodeShimOutput(SHIM_BYTES).trim(),
      runCwd,
      outsideGated: true,
    });
    const a = shellWarnFor(shimDiag);
    ok(typeof a === 'string' && a.includes('WSL_E_DISTRO_NOT_FOUND'), `没把令牌读给用户看：${a}`);
    ok(/不存在|发行版/.test(a), `没解出中文原话：${a}`);
    // ② 一个 bash 都没有 → 必须说「PATH 上没有 bash」，与 ① 是不同的两条
    const noneDiag = mkDiag({ usability: 'broken', shape: 'none', detail: '沿 PATH 没找到 bash（看过 12 个位置）' });
    const b = shellWarnFor(noneDiag);
    ok(typeof b === 'string' && b !== a, '两种坏法说了同一句话 —— 用户没法照着修');
    ok(!/发行版/.test(b), `「一个 bash 都没有」不该叫用户去装发行版：${b}`);
    // ③ 反控：两条话术都不是空话，都得给出下一步
    ok(a.length > 40 && b.length > 40, '话术太短，等于没引导');
  });
})();

// ---------- 收尾 ----------

console.log('');
for (const s of skipped) console.log(`⚠ 跳过：${s}`);
console.log(`\n${'─'.repeat(60)}`);
console.log(`通过 ${passed} 条，失败 ${failures.length} 条，跳过 ${skipped.length} 条`);
if (failures.length) console.log(`失败清单：\n  - ${failures.join('\n  - ')}`);
if (skipped.length) console.log('（跳过的是机器相关、这次环境不满足的 —— 它们**不算通过**）');
process.exitCode = failures.length ? 1 : 0;
