#!/usr/bin/env node
/**
 * C7 自检 —— DSH 日志路径复刻 / 受控删除 / 回收站留存，**不需要 VS Code、不需要 API key**。
 *
 *   npm run compile && node scripts/probe-purge.mjs
 *
 * ⚠️ **路径对账那一段需要 Node ≥ 22.15 / 24**：插件 `node:zlib` 的 zstd API。宿主 node 太老时
 * 它会**响亮地失败**并告诉你去用运行时自带的那个：
 *
 *   ./dist-runtime/node/node.exe scripts/probe-purge.mjs
 *
 * 故意不静默跳过 —— 对账是「我们复刻的路径算法和插件逐字相同」这句声明的唯一证据。
 * 只有**根本没有 dist-runtime**（便携运行时未构建）时才跳过，并打醒目 ⚠ + 退出 0。
 *
 * 三段：
 * 1. 路径复刻：拿插件公开且无副作用的 `locate()` 当**对账预言机**（`Object.create(Impl.prototype)`
 *    绕过构造函数：不建 coordinator、不碰 fs），外加版本/哈希冻结闸门。
 * 2. 受控删除：合成树 + 穿越 + 内容闸门 + 符号链接。
 * 3. 留存判据与引用计数。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'out');

// .mjs 里没有 require —— 用动态 import 加载编译产物（同 scripts/probe-sandbox.mjs 的写法）。
// 顺带成为一条守卫：dshPaths.ts 哪天长出 `import vscode`，这里当场加载失败。
async function load(moduleName) {
  const file = join(outDir, moduleName);
  if (!existsSync(file)) {
    console.error(`缺少编译产物：${file}\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
    process.exit(2);
  }
  return import(pathToFileURL(file).href);
}

const {
  encodeSegment,
  projectKey,
  projectDir,
  sessionDir,
  logPath,
  logSuffix,
  removeDshSessionDir,
} = await load('dshPaths.js');
const { SessionStore, isExpired, dshStillReferenced, RETENTION_DAY_MS } = await load('sessionStore.js');

// ---------- 断言小工具（同 probe-session-tools.mjs 的体例） ----------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) {
      throw new Error('断言返回 false');
    }
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`✗ ${name}\n    ${err && err.message ? err.message : err}`);
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${what}期望 ${e}，实得 ${a}`);
  }
}

function ok(cond, msg = '') {
  if (!cond) {
    throw new Error(msg || '断言失败');
  }
}

// ============================================================
console.log('\n【路径复刻 · dshPaths.ts ↔ 插件 locate()】');
// ============================================================

const PLUGIN_DIR = join(repoRoot, 'dist-runtime', 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl');
const PLUGIN_ENTRY = join(PLUGIN_DIR, 'lib', 'index.js');
/** 冻结闸门：复刻的是**这一份**算法。上游改版 → 这里响亮地失败，而不是悄悄删错地方。 */
const FROZEN_VERSION = '0.1.0-rc.8';
const FROZEN_SHA256 = '8b6ebc4509a3e969ab3ad6e0dfb553ae4861e5b101831afed23e593d148d97f3';

let Plugin = null;
let skipReason = null;
let loadError = null;

if (!existsSync(PLUGIN_ENTRY)) {
  skipReason = '没有 dist-runtime（便携运行时未构建）—— 路径对账整段跳过';
} else {
  try {
    Plugin = (await import(pathToFileURL(PLUGIN_ENTRY).href)).default;
  } catch (err) {
    loadError = err;
  }
}

// 插件在、却加载不了 → 环境问题（宿主 node 太老）。不计入失败名单的话整段会被静默跳过。
if (!skipReason) {
  check('插件可加载（Node ≥ 22.15 / 24：插件的 node:zlib zstd API）', () => {
    ok(
      !loadError,
      `加载 ${PLUGIN_ENTRY} 失败：${loadError && loadError.message}\n    多半是 node 太老 —— 换运行时自带的：./dist-runtime/node/node.exe scripts/probe-purge.mjs`
    );
    ok(typeof Plugin === 'function', '插件默认导出不是构造函数');
  });
}

/** 对账预言机：绕过构造函数，只借它的 `locate()`（公开、无副作用、方法体就是 logPath）。 */
function oracle(root, compression = 'zstd') {
  const spy = Object.create(Plugin.prototype);
  spy.root = root;
  spy.compression = compression;
  return (meta) => spy.locate(meta).path;
}

function requirePlugin() {
  ok(Plugin, `路径对账需要插件：${skipReason || (loadError && loadError.message)}`);
}

const PARITY_ROOT = resolve(join(tmpdir(), 'probe-purge-parity-root'));

check('插件版本 + lib/index.js 哈希冻结（复刻对象没被换过）', () => {
  requirePlugin();
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  eq(pkg.version, FROZEN_VERSION, '插件版本：');
  const sha = createHash('sha256').update(readFileSync(PLUGIN_ENTRY)).digest('hex');
  eq(sha, FROZEN_SHA256, 'lib/index.js 的 sha256：');
  return true;
});

check('路径逐字对账（含非 ASCII / 连续分隔符 / 超长截断 / 危险 id）', () => {
  requirePlugin();
  const locate = oracle(PARITY_ROOT);
  const uuid = '6e7d6f6b-50d5-4e24-99c5-950770e51d8f::9b31de9f';
  const vectors = [
    ['D:\\hello-vscode-ext', uuid],
    ['D:\\项目\\foo', uuid], // 非 ASCII
    ['//a\\\\b::c', 'a::b'], // 连续混合分隔符 → 折叠成一个 -
    ['D:/x', '..'], // 危险 id：. 与 ..
    ['D:/x', '.'],
    ['D:/x', '...'],
    ['D:/x', 'a/b\\c~d.e'], // id 里带分隔符与 ~ → 全转义
    ['C:\\', '  空格  '],
    ['relative/path', '😀id'], // 代理对：两个码元各自转义
    ['D:\\' + 'z'.repeat(300), 'x'.repeat(300)], // 项目名截断 251
    ['\\\\?\\D:\\long', 'a::b::c'],
    ['D:\\hello-vscode-ext', uuid + '::' + 'y'.repeat(300)],
  ];
  for (const [cwd, id] of vectors) {
    eq(logPath(PARITY_ROOT, cwd, id, 'zstd'), locate({ id, cwd }), `cwd=${JSON.stringify(cwd)} id=${JSON.stringify(id.slice(0, 40))}：`);
  }
  return true;
});

check('路径逐字对账：边界与异常（undefined cwd / compression / 空串抛）', () => {
  requirePlugin();
  const locate = oracle(PARITY_ROOT);
  // cwd 为 undefined → 插件的 _no-cwd 兜底桶（Harness 还没定工作区时会是这种）
  eq(logPath(PARITY_ROOT, undefined, 'abc', 'zstd'), locate({ id: 'abc', cwd: undefined }), 'cwd=undefined：');
  // 压缩档位切换（`compression: 'none'` → 明文 .jsonl）
  const locateNone = oracle(PARITY_ROOT, 'none');
  eq(logPath(PARITY_ROOT, 'D:/x', 'a', 'none'), locateNone({ id: 'a', cwd: 'D:/x' }), 'compression=none：');
  eq(logSuffix('none'), '.jsonl', 'logSuffix(none)：');
  eq(logSuffix('zstd'), '.jsonl.zstd', 'logSuffix(zstd)：');

  // 空串两边都抛（空 id 是调用方的 bug，绝不能变成一个指向项目目录本身的路径）
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  ok(throws(() => encodeSegment('')), '空 id 必须抛');
  ok(throws(() => projectKey('')), '空 cwd 必须抛');
  ok(!throws(() => encodeSegment('D:/x')), '正常 id 不该抛');
  return true;
});

check('结构 fuzz：一万次随机 id/cwd 绝不产出分隔符或越狱路径', () => {
  // 不需要插件 —— 它守的是「编码器的输出永远只有一层」，与插件在不在无关
  const alphabet = ['a', 'Z', '9', '.', '-', '_', '~', ':', '/', '\\', ' ', '中', '\uD83D', '\uDE00'];
  let n = 0;
  for (let i = 0; i < 10000; i++) {
    let s = '';
    const len = 1 + Math.floor(Math.random() * 8);
    for (let j = 0; j < len; j++) {
      s += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const seg = encodeSegment(s);
    ok(seg !== '.' && seg !== '..', `编码后的片段是 ${seg}（输入 ${JSON.stringify(s)}）`);
    ok(!/[/\\]/.test(seg), `编码后的片段含分隔符：${seg}（输入 ${JSON.stringify(s)}）`);
    ok(!/[/\\]/.test(projectKey(s)), `projectKey 含分隔符：${projectKey(s)}`);
    const rel = relative(PARITY_ROOT, sessionDir(PARITY_ROOT, s, s));
    ok(!!rel && !rel.startsWith('..') && !isAbsolute(rel), `会话目录越狱：${rel}`);
    n++;
  }
  eq(n, 10000, 'fuzz 次数：');
  return true;
});

// ============================================================
console.log('\n【受控删除 · removeDshSessionDir】');
// ============================================================

const base = mkdtempSync(join(tmpdir(), 'probe-purge-'));
const root = join(base, 'dsh-sessions');
const outside = join(base, 'outside'); // root 之外的哨兵：任何穿越都必须够不到它

const ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa::deadbeef';
const ID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ID_TMP = 'cccccccc-3333-4333-8333-cccccccccccc';
const ID_JUNK = 'dddddddd-4444-4444-8444-dddddddddddd';
const ID_EMPTY = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const CWD = 'D:\\hello-vscode-ext';

/** 建一条会话的叶子目录，内容由 files 决定。 */
function plant(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f), 'x');
  }
}

try {
  const sessA = sessionDir(root, CWD, ID_A);
  const sessB = sessionDir(root, CWD, ID_B);
  const sessTmp = sessionDir(root, CWD, ID_TMP);
  const sessJunk = sessionDir(root, CWD, ID_JUNK);
  const sessEmpty = sessionDir(root, CWD, ID_EMPTY);

  plant(sessA, ['session.jsonl.zstd']);
  plant(sessB, ['session.jsonl']);
  plant(sessTmp, ['session.jsonl.zstd.abcdef123456.tmp']); // 只有 tmp：不像正常会话目录
  plant(sessJunk, ['session.jsonl.zstd', 'notes.txt']); // 有认不出的条目
  mkdirSync(sessEmpty, { recursive: true });
  plant(join(outside, 'sentinel'), ['session.jsonl.zstd']);

  check('删掉叶子：只少这一个目录，项目目录 / root / 兄弟会话全在', () => {
    const r = removeDshSessionDir(root, CWD, ID_A);
    eq(r, { removed: true }, '结果：');
    ok(!existsSync(sessA), '叶子目录该没了');
    ok(existsSync(projectDir(root, CWD)), '项目目录必须还在（同 cwd 的所有会话共用）');
    ok(existsSync(root), 'root 必须还在');
    ok(existsSync(sessB), '兄弟会话必须还在');
    return true;
  });

  check('不存在 → missing（正常情况，不是错误）', () => {
    eq(removeDshSessionDir(root, CWD, ID_A), { removed: false, reason: 'missing' }, '结果：');
    return true;
  });

  check('内容闸门：认不出的条目 → refused，目录原封不动', () => {
    const r = removeDshSessionDir(root, CWD, ID_JUNK);
    eq(r.reason, 'refused', '原因：');
    ok(r.detail.includes('notes.txt'), `detail 该点名那个文件：${r.detail}`);
    ok(existsSync(sessJunk), '目录必须还在');
    return true;
  });

  check('内容闸门：只有 .tmp 没有主日志 → refused', () => {
    const r = removeDshSessionDir(root, CWD, ID_TMP);
    eq(r.reason, 'refused', '原因：');
    ok(existsSync(sessTmp), '目录必须还在');
    return true;
  });

  check('内容闸门：空目录 → refused', () => {
    eq(removeDshSessionDir(root, CWD, ID_EMPTY).reason, 'refused', '原因：');
    ok(existsSync(sessEmpty), '空目录也留着（那是给人看的信号，不是让我们自作主张清掉）');
    return true;
  });

  check('穿越：危险 id / cwd 一律删不掉，root 外的哨兵活着', () => {
    for (const id of ['..', '.', '../../outside/sentinel', 'a/b', 'a\\b', '', '   ']) {
      const r = removeDshSessionDir(root, CWD, id);
      ok(r.removed === false, `id=${JSON.stringify(id)} 竟然 removed=true`);
    }
    for (const cwd of ['..', '../..', '', 'D:\\hello-vscode-ext\\..\\..\\outside']) {
      const r = removeDshSessionDir(root, cwd, 'x'.repeat(8));
      ok(r.removed === false, `cwd=${JSON.stringify(cwd)} 竟然 removed=true`);
    }
    ok(existsSync(join(outside, 'sentinel', 'session.jsonl.zstd')), 'root 外的哨兵必须活着');
    ok(existsSync(join(outside, 'sentinel')), '哨兵目录必须活着');
    return true;
  });

  check('空 root → refused（绝不把相对路径当 root 用）', () => {
    eq(removeDshSessionDir('', CWD, ID_A).reason, 'refused', '原因：');
    return true;
  });

  check('叶子是符号链接 → refused（junction 能让递归删穿出去）', () => {
    const link = sessionDir(root, CWD, 'ffffffff-6666-4666-8666-ffffffffffff');
    try {
      symlinkSync(join(outside, 'sentinel'), link, 'junction');
    } catch (err) {
      console.log(`   ⚠ Windows 上建 junction 失败（${err.code}）—— 这条跳过`);
      return true;
    }
    const r = removeDshSessionDir(root, CWD, 'ffffffff-6666-4666-8666-ffffffffffff');
    eq(r.reason, 'refused', '原因：');
    ok(existsSync(join(outside, 'sentinel', 'session.jsonl.zstd')), '链接指向的目录必须活着');
    rmSync(link, { recursive: true, force: true });
    return true;
  });

  check('绝不抛：所有输入都返回结果对象', () => {
    for (const args of [[], [root], [root, CWD], [null, null, null], [root, CWD, 'x']]) {
      const r = removeDshSessionDir(...args);
      ok(typeof r.removed === 'boolean', `${JSON.stringify(args)} 没返回结果对象`);
    }
    return true;
  });

  // ---------- 引用计数：fork 与源共享同一份日志 ----------

  check('引用计数：fork 共享 {id,cwd} → 删分支不删日志，删到最后一个才删', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-purge-ref-'));
    try {
      const chat = new SessionStore(dir);
      const harness = new SessionStore(dir, 'sessions-harness.json');
      const dsh = { id: 'shared-dsh-id', cwd: 'D:\\hello-vscode-ext' };
      const leaf = sessionDir(root, CWD, 'shared-dsh-id');
      plant(leaf, ['session.jsonl.zstd']);

      const src = chat.create('源');
      src.messages.push({ id: 'm', role: 'user', text: 'hi', status: 'done' });
      src.dsh = dsh;
      chat.add(src);
      // C5：`_forkSession` 里 `fork.dsh = src.dsh` —— **同一个对象引用**
      const fork = chat.create('分支');
      fork.messages.push({ id: 'm2', role: 'user', text: 'hi', status: 'done' });
      fork.dsh = src.dsh;
      chat.add(fork);
      // 跨 store 的第三条（harness 库）：两个 store 都要扫
      const cross = harness.create('跨库');
      cross.messages.push({ id: 'm3', role: 'user', text: 'hi', status: 'done' });
      cross.dsh = dsh;
      harness.add(cross);

      const all = () => [...chat.all(), ...harness.all()];
      /** 与 `chatViewProvider._purgeOne` 同一条链：先读 dsh，再 purge，再判引用。 */
      const purgeOne = (store, id) => {
        const s = store.get(id);
        const d = s && s.dsh;
        if (!store.purge(id)) {
          return;
        }
        if (d && !dshStillReferenced(all(), d, id)) {
          removeDshSessionDir(root, d.cwd, d.id);
        }
      };

      chat.softDelete(src.id);
      chat.softDelete(fork.id);
      harness.softDelete(cross.id);

      purgeOne(chat, fork.id);
      ok(existsSync(leaf), '删第一个引用者时日志必须还在（源还要用）');
      ok(dshStillReferenced(all(), dsh, fork.id), 'fork 之后仍有引用者');

      purgeOne(chat, src.id);
      ok(existsSync(leaf), '删第二个引用者时日志必须还在（跨库那条还要用）');

      purgeOne(harness, cross.id);
      ok(!existsSync(leaf), '最后一个引用者被删掉，日志才该没');
      ok(!dshStillReferenced(all(), dsh, 'no-such-id'), '没有引用者了');

      // 同 id 但**不同 cwd** 不算共享（DSH 的日志按 cwd 归属，换工作区身份就作废了）
      const other = { id: 'shared-dsh-id', cwd: 'D:\\other' };
      const fake = chat.create('别处');
      fake.messages.push({ id: 'm4', role: 'user', text: 'hi', status: 'done' });
      fake.dsh = other; // 只有它自己引用 {shared-dsh-id, D:\other}
      chat.add(fake);
      ok(!dshStillReferenced(chat.all(), other, fake.id), 'cwd 不同的同 id 不算共享');
      ok(
        !dshStillReferenced(chat.all(), { id: 'shared-dsh-id', cwd: 'D:\\elsewhere' }, fake.id),
        '同 id 但 cwd 谁也不匹配时不算引用'
      );

      const twin = chat.create('同在 D:\\other');
      twin.messages.push({ id: 'm5', role: 'user', text: 'hi', status: 'done' });
      twin.dsh = { id: 'shared-dsh-id', cwd: 'D:\\other' }; // 与 fake 同 {id, cwd}
      chat.add(twin);
      ok(dshStillReferenced(chat.all(), other, fake.id), '同 id 同 cwd 才算引用（哪怕对象不是同一个）');
      return true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (skipReason) {
  console.log(`\n⚠⚠ 路径对账整段被跳过：${skipReason}`);
  console.log('   下面没有一条能证明「我们算的路径和插件一样」—— 别把这次通过当成验过了。\n');
}

// ============================================================
console.log('\n【回收站留存 · isExpired / expired()】');
// ============================================================

const DAY = RETENTION_DAY_MS;
const NOW = 1_700_000_000_000;

function sess(o) {
  return Object.assign(
    { id: 's1', title: '', createdAt: NOW, updatedAt: NOW, messages: [{ id: 'm', role: 'user', text: 'x' }] },
    o
  );
}

check('边界：恰好 N 天 → false，N 天 +1ms → true', () => {
  eq(isExpired(sess({ deletedAt: NOW - 7 * DAY }), NOW, 7), false, '恰好 7 天：');
  eq(isExpired(sess({ deletedAt: NOW - 7 * DAY - 1 }), NOW, 7), true, '7 天零 1 毫秒：');
  eq(isExpired(sess({ deletedAt: NOW }), NOW, 7), false, '刚删的：');
  return true;
});

check('⚠ days 不是正数 → 一律 false（0 = 关闭，少了这道闸会清空回收站）', () => {
  const justDeleted = sess({ deletedAt: NOW });
  for (const days of [0, -1, -7, NaN, Infinity, -Infinity]) {
    eq(isExpired(justDeleted, NOW, days), false, `days=${days}：`);
  }
  return true;
});

check('deletedAt 缺失 / 损坏 / 在未来 → false（失败一律朝「看得见」倒）', () => {
  for (const at of [undefined, null, 'yes', {}, 0, -1, NaN, Infinity]) {
    eq(isExpired(sess({ deletedAt: at }), NOW, 7), false, `deletedAt=${JSON.stringify(at)}：`);
  }
  eq(isExpired(sess({ deletedAt: NOW + 30 * DAY }), NOW, 7), false, '未来时间（时钟回拨）：');
  eq(isExpired(sess({}), NOW, 7), false, '在列会话（没有 deletedAt）：');
  return true;
});

check('expired() 只从回收站里挑：在列会话再老也不入选', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-purge-ret-'));
  try {
    const store = new SessionStore(dir);
    const old = sess({ id: 'old', updatedAt: NOW - 900 * DAY, deletedAt: NOW - 30 * DAY });
    const fresh = sess({ id: 'fresh', deletedAt: NOW - 1 * DAY });
    const alive = sess({ id: 'alive', updatedAt: NOW - 900 * DAY }); // 一年没动，但从没被删过
    store.add(old);
    store.add(fresh);
    store.add(alive);

    eq(store.expired(7, NOW).map((s) => s.id), ['old'], '过期的：');
    eq(store.expired(60, NOW).map((s) => s.id), [], '口径放大到 60 天：');
    eq(store.expired(7, NOW).length, store.trashed().filter((s) => isExpired(s, NOW, 7)).length, '计数与判据同源：');
    eq(store.expired(0, NOW).length, 0, '关闭时恒为 0（按钮据此禁用）：');

    // 与真正的删除串起来：persist → 重载，回收站与判据都还在
    store.persist();
    const reloaded = new SessionStore(dir);
    eq(reloaded.expired(7, NOW).map((s) => s.id), ['old'], '重载后仍认得出过期条目：');
    eq(reloaded.active().map((s) => s.id).sort(), ['alive'], '重载后在列的：');
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('DELETED-AT 语义：恢复（还原）后立刻不再过期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-purge-restore-'));
  try {
    const store = new SessionStore(dir);
    const s = sess({ id: 's', deletedAt: NOW - 30 * DAY });
    store.add(s);
    eq(store.expired(7, NOW).length, 1, '删了 30 天：');
    store.restore('s');
    eq(store.expired(7, NOW).length, 0, '恢复后：');
    eq(s.deletedAt, undefined, 'deletedAt 必须被摘掉：');
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 收尾 ----------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) {
    console.log(`   · ${f}`);
  }
  process.exit(1);
}
console.log(`✓ 全部通过：${passed}/${passed}`);
