#!/usr/bin/env node
/**
 * C1 审批 hook 的 shell 形态自检 —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是 `_setupApproval` 那条「首猜不过就换另一种形态再自检」所依赖的两个前提：
 *
 *   1. **至少有一种形态能跑通**（两种都跑不通 = 审批真的接不上，弹窗该出现）；
 *   2. **两种形态互斥**（A 形态的命令在 B 里必然 command not found）——
 *      正因为互斥，「谁过」才是无歧义的判据，而不是又一次猜测。
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

const { probeShell, testApprovalHook, writeApprovalHookFiles } = await load('dshHooks.js');

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

try {
  const guess = await probeShell(repoRoot);
  console.log(`probeShell 的首猜：${guess}\n`);

  const results = {};
  for (const kind of ['posix', 'wsl']) {
    const files = build(kind);
    const test = await testApprovalHook(files.hookCommand, repoRoot);
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
  });

  await check('失败话术带 stderr', async () => {
    const r = await testApprovalHook('echo 坏了 1>&2; exit 4', repoRoot);
    ok(!r.ok, '居然通过了');
    ok(/stderr：坏了/.test(r.detail), `detail 没带 stderr：${r.detail}`);
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
