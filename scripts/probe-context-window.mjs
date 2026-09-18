#!/usr/bin/env node
/**
 * C10 占用指示的分母判据自检 —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是 `src/contextWindow.ts` 的两件事：
 *
 *   1. **分母从哪来**（`resolveContextWindow`）：活值优先，缺了用会话记住的那个。
 *      这条里藏着 C10 唯一一个**被 F5 漏掉的真 bug**（2026-09-18）：续聊时 DSH 一条
 *      `request/context` 都不发（emit 前拿从日志折出来的 previousContext 比对，三者相同就跳过），
 *      于是活值恒为 undefined ⇒ 整条占用读数在「继续旧会话」这条最常见的路径上**安静地不存在**
 *      （没有百分比、没有 ⚠）。当时判据全在 import vscode 的类里，400+ 条既有断言一条都够不着它。
 *      「活值缺席、只有记住的那个」就是**那次事故的回归用例**。
 *   2. **算不算接近**（`contextStateOf`）：阈值 × 余量那条线，以及阈值被写坏时的兜底。
 *
 * 顺带守会话字段的落盘往返（分母与那次读数都得活着回来）——它俩丢了的话上面两条再对也没用。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-context-window.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const { CONTEXT_WARN_MARGIN, contextStateOf, resolveContextWindow } = await load('contextWindow.js');
const { SessionStore } = await load('sessionStore.js');
const { DEFAULT_COMPACTION_THRESHOLD_RATIO } = await load('dshHooks.js');

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

const M = 1000000;

// ---------- 一、分母：活值优先 ----------

check('活值在场就用活值（模型/路由一变，DSH 会重发 request/context，读数立刻跟上）', () => {
  eq(resolveContextWindow(2000000, M), 2000000, '活值被记住的那个盖住了');
});

check('活值与记住的不同：以活值为准，不做「取大/取小」这类自作聪明', () => {
  eq(resolveContextWindow(128000, M), 128000, '活值比记住的小，却没用它');
  eq(resolveContextWindow(M, 128000), M, '活值比记住的大，却没用它');
});

// ---------- 二、★ 回归：活值缺席 ----------

check('★★ 活值缺席、会话记住了 ⇒ 仍然拿得到分母（2026-09-18 那次事故的回归用例）', () => {
  ok(resolveContextWindow(undefined, M) === M, '续聊时又拿不到分母了 —— 占用读数会整段消失');
});

check('活值缺席且会话也没记过（旧数据）⇒ undefined，不猜一个默认窗口', () => {
  eq(resolveContextWindow(undefined, undefined), undefined, '凭空造了个分母');
  eq(resolveContextWindow(undefined, 0), undefined, '把 0 当成了分母');
});

check('坏值一律当「不知道」（手改坏了 sessions-harness.json 也别让读数变成 NaN）', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity, null, '1000000', {}, [], true]) {
    eq(resolveContextWindow(bad, M), M, `活值是 ${String(bad)} 时没回落到记住的那个`);
    eq(resolveContextWindow(M, bad), M, `记住的是 ${String(bad)} 时被它盖住了`);
    eq(resolveContextWindow(bad, bad), undefined, `${String(bad)} 两个位置都该当缺`);
  }
});

// ---------- 三、警告线的算术 ----------

check(`默认阈值 ${DEFAULT_COMPACTION_THRESHOLD_RATIO} × 余量 ${CONTEXT_WARN_MARGIN} ⇒ 1M 窗口上的线是 680000`, () => {
  const line = M * DEFAULT_COMPACTION_THRESHOLD_RATIO * CONTEXT_WARN_MARGIN;
  eq(line, 680000, '线算错了');
  eq(contextStateOf(679999, M, DEFAULT_COMPACTION_THRESHOLD_RATIO), 'ok', '线下方就喊了');
  eq(contextStateOf(680000, M, DEFAULT_COMPACTION_THRESHOLD_RATIO), 'near', '线上（含等号）没喊');
});

check('阈值 0.02（那次真机的设定）⇒ 线在 17000：65.5K 那次**本该**是 near', () => {
  eq(contextStateOf(65500, M, 0.02), 'near', '真机那次的分母一到位就该显示 ⚠');
  eq(contextStateOf(16999, M, 0.02), 'ok', '线下方就喊了');
});

check('分母越大越难喊（比例判据，不是绝对阈值）', () => {
  eq(contextStateOf(700000, M, 0.8), 'near', '1M 窗口');
  eq(contextStateOf(700000, 2000000, 0.8), 'ok', '2M 窗口同一用量不该喊');
});

check('阈值被写坏（0 / >1 / NaN / 字符串 / 缺失）⇒ 按默认阈值算，不是当成 0 或 1', () => {
  for (const bad of [0, -0.5, 1.5, NaN, Infinity, '0.5', null, undefined, {}]) {
    eq(
      contextStateOf(680000, M, bad),
      contextStateOf(680000, M, DEFAULT_COMPACTION_THRESHOLD_RATIO),
      `阈值是 ${String(bad)} 时没按默认值算（当成 0 会永远喊，当成 1 会永远不喊）`
    );
  }
  // 边界：恰好 1 是合法值。⚠️ 不是「到满窗口才喊」—— 余量照样乘上去，线在 85%：
  // 阈值说的是 DSH 何时动手，余量说的是我们何时先吭声，两件事互不替代。
  eq(contextStateOf(M, M, 1), 'near', 'ratio=1 被当成了非法值');
  eq(contextStateOf(M * 0.85, M, 1), 'near', 'ratio=1 时线上（含等号）没喊');
  eq(contextStateOf(M * 0.85 - 1, M, 1), 'ok', 'ratio=1 时线下方就喊了');
});

check('分母不可用时不谎报 near（调用方应由 resolveContextWindow 兜住，这里是最后一道）', () => {
  eq(contextStateOf(12345, 0, 0.8), 'ok', '分母是 0 却喊了 near —— 每一条读数都会常亮');
  eq(contextStateOf(12345, NaN, 0.8), 'ok', '分母是 NaN 却喊了 near');
});

// ---------- 四、落盘往返：分母与那次读数都得活着回来 ----------

const dir = mkdtempSync(join(tmpdir(), 'hello-c10b-'));
try {
  const FILE = 'sessions-harness.json';
  const store = new SessionStore(dir, FILE);
  // ⚠️ 会话必须**带一条消息**：加载期会 `.filter(s => s.messages.length > 0)`（空会话本来
  // 也进不了列表），不带的话读回来是 undefined —— 那是 C6 的既定行为，不是本项要验的东西。
  const s = store.create('分母往返');
  s.messages.push({ id: 'm1', role: 'user', text: '分母往返' });
  s.contextWindow = M;
  s.context = { usedTokens: 65500, contextWindow: M, at: 1789711698676 };
  store.replace(s);
  store.persist();

  check('落盘往返：会话记住的分母与那次读数都还在（少一个，上面两条判据就都白对了）', () => {
    const back = new SessionStore(dir, FILE).get(s.id);
    ok(back, '会话没读回来');
    eq(back.contextWindow, M, '分母没往返回来');
    eq(back.context?.usedTokens, 65500, '那次读数的分子没往返回来');
    eq(back.context?.contextWindow, M, '那次读数的分母没往返回来');
  });

  check('旧格式（两个字段都没有）读进来不炸，且分母仍是 undefined（向后兼容）', () => {
    const old = store.create('旧数据');
    old.messages.push({ id: 'm2', role: 'user', text: '旧数据' });
    store.replace(old);
    store.persist();
    const back = new SessionStore(dir, FILE).get(old.id);
    ok(back, '旧格式会话没读回来');
    eq(resolveContextWindow(undefined, back.contextWindow), undefined, '旧会话凭空有了分母');
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 五、静态守卫 ----------

check('contextWindow.ts 不带 vscode（带了就只能在扩展宿主里加载，探针从此够不着它）', () => {
  const src = readFileSync(join(repoRoot, 'src', 'contextWindow.ts'), 'utf8');
  ok(!/from 'vscode'|require\('vscode'\)/.test(src), '这个文件 import vscode 了 —— 判据又会变回「只有肉眼能验」');
});

check('编译产物只依赖纯模块（能在这里 import 成功本身就是证据）', () => {
  ok(typeof contextStateOf === 'function' && typeof resolveContextWindow === 'function', '导出不见了');
});

// ---------- 收尾 ----------

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
} else {
  // ⚠️ 这行必须在 else 里：C10 的另两条探针都曾无条件打印它，于是「有红 + ✓ 全部通过」同屏出现过。
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
// ⚠️ 不用 process.exit()：Windows 上被重定向的 stdout 是异步写，退出会丢掉还没冲出去的结论行。
process.exitCode = failures.length ? 1 : 0;
