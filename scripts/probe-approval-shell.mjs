#!/usr/bin/env node
/**
 * C1 审批 hook 的 shell 形态自检 —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是 `_setupApproval` 那条「按顺序自检、哪个形态跑得通用哪个」所依赖的前提：
 *
 *   1. **至少有一种形态能跑通**（两种都跑不通 = 审批真的接不上，弹窗该出现）；
 *   2. **两种形态互斥**（A 形态的命令在 B 里必然 command not found）——
 *      正因为互斥，「谁过」才是无歧义的判据，而不是又一次猜测。
 *
 * 外加三件 2026-09-17 那次线上告警（`posix 形态：自检超时（15s）；wsl 形态：bash 退出码 1`）
 * 逼出来的判据，全部落在纯函数上、可以逐条钉：
 *
 *   - **探不到时的先验**：Windows 上超时 = WSL 正在冷启动（Git Bash 答 uname 约 130 ms，撞不到超时），
 *     所以回落必须是 `wsl` 而不是旧的 `posix` —— 后者把唯一跑不通的形态排到了第一个；
 *   - **「不可判」的失败**：超时、以及退出码非 0 却 stdout/stderr 全空，都不说明形态写错了，
 *     只说明 shell 没起来。形态真错时 bash 又快又响（实测 79–183 ms，退出码 127 + stderr 原文）；
 *   - **重试全局只给一次**：不可判的失败排到队尾再验一遍（冷启动走完了），但只有一次 ——
 *     否则真接不上的场景会变成「每发一条消息先干等两轮超时」。
 *
 * 顺带把 `testApprovalHook` 的失败话术也钉住：它必须同时报 stdout 与 stderr。
 * 这条不是洁癖 —— 线上那条 `bash 退出码 1` 之所以查不下去，就是因为当时只收集了 stderr，
 * 而 WSL shim 起不来时的错误话术是打在 **stdout** 上的。
 *
 * shell 形态本身用真实的 `probeShell()` 探（和扩展宿主同一个算法），所以本脚本跑在
 * 「扩展宿主的 bash 是 WSL shim」还是「Git Bash」的机器上，结论都对得上。
 *
 *   npm run compile && node scripts/probe-approval-shell.mjs
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const {
  classifyShell,
  nextShellCheck,
  probeShell,
  shellGuessOnTimeout,
  testApprovalHook,
  writeApprovalHookFiles,
} = await load('dshHooks.js');

// ---------- 断言小工具 ----------

let passed = 0;
const failures = [];

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

// ---------- 现场：一次性的 storageDir + 最小基础配置 ----------

const scratch = mkdtempSync(join(tmpdir(), 'hello-approval-shell-'));
// 根必须是块状序列（`-` 开头）才允许追加，否则 writeApprovalHookFiles 会拒绝生成
const baseConfigPath = join(scratch, 'base-cordis.yml');
writeFileSync(
  baseConfigPath,
  '# 自检用的最小基础配置：我们只验证「能不能跑起来」，不启动任何真插件\n- id: probe-base\n  name: \'@deepseek-ai/dsh-probe-placeholder\'\n',
  'utf8'
);

/** 按给定形态生成三件套并拿回 hook 命令。 */
function build(shellKind) {
  return writeApprovalHookFiles({
    storageDir: scratch,
    nodePath: process.execPath,
    shellKind,
    url: 'http://127.0.0.1:1', // 自检喂的是非 bash 工具，脚本不会去连它
    token: 'probe-token-not-a-secret',
    scriptTimeoutMs: 600000,
    hookTimeoutSec: 600,
    baseConfigPath,
  });
}

/** 排程用的假账：`w('wsl', true)` = 验过 wsl 形态、结论不可判。 */
const w = (kind, retriable) => ({ kind, retriable });

try {
  // ---------- 第一块：纯函数（形态怎么判、探不到时怎么先验、失败后怎么排下一次） ----------

  await check('classifyShell：WSL 的 uname 是 Linux', () => {
    ok(classifyShell('Linux\n') === 'wsl', `Linux → ${classifyShell('Linux\n')}`);
  });

  await check('classifyShell：MINGW/MSYS/CYGWIN 是 posix', () => {
    for (const s of ['MINGW64_NT-10.0-26100', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0']) {
      ok(classifyShell(s) === 'posix', `${s} → ${classifyShell(s)}`);
    }
  });

  await check('classifyShell：认不出来要返回 undefined，**不许**默认成 posix', () => {
    // 旧代码的 `else → posix` 就是把「不知道」当成「是 posix」，而这正好把唯一跑不通的形态排到第一个
    for (const s of ['', '   \n', 'Darwin', 'weird output']) {
      ok(classifyShell(s) === undefined, `${JSON.stringify(s)} → ${classifyShell(s)}`);
    }
  });

  await check('超时/无输出时的先验：win32 → wsl（超时是 WSL 冷启动的正面证据）', () => {
    ok(shellGuessOnTimeout('win32') === 'wsl', `win32 → ${shellGuessOnTimeout('win32')}`);
    ok(shellGuessOnTimeout('linux') === 'posix', `linux → ${shellGuessOnTimeout('linux')}`);
    ok(shellGuessOnTimeout('darwin') === 'posix', `darwin → ${shellGuessOnTimeout('darwin')}`);
  });

  await check('nextShellCheck：先按 order 逐个验一遍', () => {
    const order = ['wsl', 'posix'];
    ok(nextShellCheck(order, [], 0) === 'wsl', '第一发该是 order[0]');
    ok(nextShellCheck(order, [w('wsl', false)], 0) === 'posix', '第二个该是 order[1]');
    ok(nextShellCheck(['posix', 'wsl'], [], 0) === 'posix', 'order 反了就跟 order 走（不写死）');
  });

  await check('nextShellCheck：两种都**可判**地失败 → 结束，不给重试（重试是给冷启动的）', () => {
    ok(nextShellCheck(['wsl', 'posix'], [w('wsl', false), w('posix', false)], 0) === undefined);
  });

  await check('nextShellCheck：不可判的失败要排到队尾再验一次（本次修法的核心）', () => {
    // 线上症状：posix 超时(15s) + wsl 空手退出——两条都不说明形态错，却把审批整个关掉了
    ok(nextShellCheck(['posix', 'wsl'], [w('posix', true), w('wsl', true)], 0) === 'wsl', '重试顺序反转，最后一个先来');
    ok(nextShellCheck(['wsl', 'posix'], [w('wsl', true), w('posix', false)], 0) === 'wsl', '只重试不可判的那个');
  });

  await check('nextShellCheck：重试**全局只给一次**（否则用户每发一条消息干等两轮超时）', () => {
    ok(nextShellCheck(['posix', 'wsl'], [w('posix', true), w('wsl', true)], 1) === undefined);
    ok(nextShellCheck(['wsl', 'posix'], [w('wsl', true), w('posix', false), w('wsl', true)], 1) === undefined);
    // 一个形态验过两遍就绝不发第三遍（即便账没记上，也不该无限重试）
    ok(nextShellCheck(['wsl'], [w('wsl', true), w('wsl', true)], 0) === undefined);
  });

  await check('下一次排程不依赖 order 里有没有重复项（去重后行为不变）', () => {
    ok(nextShellCheck(['wsl', 'wsl', 'posix'], [], 0) === 'wsl');
    ok(nextShellCheck(['wsl', 'wsl', 'posix'], [w('wsl', false)], 0) === 'posix');
  });

  // ---------- 第二块：真的把自检跑起来（含 retriable 的分类） ----------

  await check('自检超时要标成 retriable（那一刻 shell 还没起来，形态对不对还没验）', async () => {
    const r = await testApprovalHook('sleep 30', repoRoot, 1200);
    ok(!r.ok, '居然通过了');
    ok(r.retriable === true, `retriable = ${r.retriable}`);
    ok(/自检超时（1s）/.test(r.detail), `detail 该按实际超时报秒数：${r.detail}`);
  });

  await check('退出码非 0 但 stdout/stderr 都空 → retriable（启动器半路熄火，不是形态错）', async () => {
    const r = await testApprovalHook('exit 1', repoRoot);
    ok(r.retriable === true, `retriable = ${r.retriable}`);
  });

  await check('形态写错要**可判**：快、响、exit 127 —— 绝不能标成 retriable', async () => {
    // 这条就是「为什么不可判要单独一档」的实证：真错的时候 bash 会立刻把话说清楚，
    // 而说不清话的那种失败只可能是启动器还没起来。拿一个必然不存在的命令精确复现。
    const r = await testApprovalHook('definitely-not-a-command-hello-9f3a', repoRoot);
    ok(!r.ok, '居然通过了');
    ok(r.retriable === false, `retriable = ${r.retriable}（可判的失败不该给重试）`);
    ok(/No such file or directory|not found/.test(r.detail), `detail 该带 bash 原文：${r.detail}`);
  });

  const guess = await probeShell(repoRoot);
  console.log(`probeShell 的首猜：${guess}\n`);

  const results = {};
  for (const kind of ['posix', 'wsl']) {
    const files = build(kind);
    const test = await testApprovalHook(files.hookCommand, repoRoot);
    ok(!test.ok || test.retriable === false, '形态对了能跑通的自检不该标 retriable');
    results[kind] = test;
    console.log(`  ${kind} 形态自检：${test.ok ? '通过' : '不过'}${test.ok ? '' : ` —— ${test.detail}`}`);
  }
  console.log('');

  const winners = ['posix', 'wsl'].filter((k) => results[k].ok);

  await check('至少有一种形态能跑通（否则审批真的接不上，扩展会弹窗）', () => {
    ok(winners.length > 0, `两种形态都没过：posix=${results.posix.detail}；wsl=${results.wsl.detail}`);
  });

  await check('两种形态互斥（不会同时通过 —— 谁过才是无歧义的判据）', () => {
    ok(winners.length <= 1, `两种形态都通过了：${winners.join('、')}`);
  });

  await check('首猜猜错时，另一种形态能救回来（这就是本次修法的全部意义）', () => {
    if (winners.length === 0) throw new Error('没有可用形态，跳过');
    console.log(`    首猜 ${guess}，实际可用 ${winners[0]}${guess === winners[0] ? '（猜对了）' : '（猜错了 → 靠自检兜住）'}`);
  });

  await check('失败话术带 stdout（只报 stderr 会让 WSL 的失败信息整个丢掉）', async () => {
    // 交给 bash -c 的是一整条命令，直接用它构造「有 stdout、退出码非 0」
    const r = await testApprovalHook('echo 出错了; exit 3', repoRoot);
    ok(!r.ok, '居然通过了');
    ok(/退出码 3/.test(r.detail), `detail 没提退出码：${r.detail}`);
    ok(/stdout：出错了/.test(r.detail), `detail 没带 stdout：${r.detail}`);
    ok(r.retriable === false, '带话的失败是可判的，不该给重试');
  });

  await check('失败话术带 stderr', async () => {
    const r = await testApprovalHook('echo 坏了 1>&2; exit 4', repoRoot);
    ok(!r.ok, '居然通过了');
    ok(/stderr：坏了/.test(r.detail), `detail 没带 stderr：${r.detail}`);
    ok(r.retriable === false, '带话的失败是可判的，不该给重试');
  });

  await check('两边都空时要明说（线上那条查不下去的 `bash 退出码 1` 就长这样）', async () => {
    const r = await testApprovalHook('exit 1', repoRoot);
    ok(!r.ok, '居然通过了');
    ok(r.detail === 'bash 退出码 1（stdout/stderr 都是空的）', `detail = ${r.detail}`);
  });

  await check('自检输出异常（stdout 有内容却 exit 0）要单独报，不能当成通过', async () => {
    const r = await testApprovalHook('echo 我不该说话', repoRoot);
    ok(!r.ok, '非 bash 工具本不该产生任何决策输出');
    ok(/自检输出异常/.test(r.detail), `detail = ${r.detail}`);
    ok(r.retriable === false, '这是可判的失败（脚本真跑起来了），不该给重试');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
if (failures.length === 0) {
  console.log(`✓ 全部通过：${passed}/${passed}`);
  process.exitCode = 0;
} else {
  console.log(`✗ ${failures.length} 项不过（共 ${passed + failures.length} 项）：\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}
