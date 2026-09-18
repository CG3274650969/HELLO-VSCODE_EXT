#!/usr/bin/env node
/**
 * 派生配置**真的被 DSH 用上了吗** —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是 C1（事前审批）与 C10（压缩阈值覆盖）共用的那条命脉：
 * 扩展 spawn 便携运行时时，**位置参数给的是基础 cordis.yml，派生文件只走 `DSH_CORDIS_CONFIG`**
 * （见 `src/chatViewProvider.ts` 的 `_makeSpawnRequest`：`args: [runtime.entry, runtime.config]`，
 * 同时 `_dshEnv()` 把 `env.DSH_CORDIS_CONFIG` 指到派生文件）。
 *
 * ⚠️ **也就是说：env 赢则 C1 与 C10 都活着，env 输则两个一起静默失效** ——
 * 而且失效的样子是「一切正常，只是那条护栏/那个旋钮从不生效」，没有任何报错。
 * 这件事在 2026-09-18 之前从没被单独钉过（`packaged-bin.js` 里写着"优先"，但那是它的注释，不是我们的证据）。
 *
 * 判据是**一正一反**，缺一不可：
 *   · 正控：派生文件里把比例改成有效值 → initialize 成功（这份配置能加载）。
 *   · 反控：派生文件里故意违反插件的**加载期**硬约束（`retainRatio >= thresholdRatio`，
 *     见 `@deepseek-ai/dsh-compaction-basic` 的 `validateRatioRetention`）→ **必须起不来**。
 *     反控才是真正的那一问：如果 DSH 其实在读位置参数那份基础配置，反控会和正控一样成功，
 *     于是这个探针当场变红 —— 而不是等哪天有人发现审批弹不出来。
 *
 * 用的是**编译产物里的真函数**（`out/dshHooks.js` 的 `writeDerivedConfig`），不是重写一遍补丁逻辑：
 * 探针要验的是「这一份文件 DSH 认不认」，补丁本身的正确性归 `probe-compaction-override.mjs`。
 *
 *   node scripts/probe-derived-config-boot.mjs [--runtime dist-runtime]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTurn } from './dsh-turn.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---- 参数：--runtime（默认 dist-runtime，仓库外/没建就响亮跳过） ----
const argv = process.argv.slice(2);
let runtimeDir = 'dist-runtime';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--runtime') runtimeDir = argv[++i];
}
const runtimeAbs = resolve(repoRoot, runtimeDir);
const manifestPath = join(runtimeAbs, 'runtime.json');
/** 编译产物：探针要调的是**真函数**，不是重写一遍补丁逻辑 */
const hooksJs = join(repoRoot, 'out', 'dshHooks.js');
if (!existsSync(manifestPath)) {
  console.log(`⚠ 跳过：${manifestPath} 不存在（先跑 node scripts/build-runtime.mjs），别把这次通过当成验过了`);
  process.exitCode = 0;
} else if (!existsSync(hooksJs)) {
  console.error(`缺少编译产物：${hooksJs}\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
  process.exitCode = 2;
} else {
  await main();
}

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const node = join(runtimeAbs, manifest.node);
  const entry = join(runtimeAbs, manifest.entry);
  const baseConfig = join(runtimeAbs, manifest.config);

  // 派生文件写临时目录：不污染仓库，也不碰任何人的真配置
  const storageDir = mkdtempSync(join(tmpdir(), 'hello-derived-config-'));
  const { writeDerivedConfig, patchCompactionRatios, DEFAULT_COMPACTION_THRESHOLD_RATIO, compactionOverride } =
    await import(pathToFileURL(hooksJs).href);

  console.log(`运行时：${runtimeAbs}（dsh ${manifest.dshVersion ?? '?'}）`);
  console.log(`  底本 ${baseConfig}`);
  console.log(`  派生 ${storageDir}`);

  await check('前提：底本里确实有 compaction-basic 块（否则 D3 的锚点补丁无事可做）', () => {
    const base = readFileSync(baseConfig, 'utf8');
    ok(base.includes('compaction-basic'), '底本没有 compaction-basic —— 换一份运行时再跑');
    ok(/thresholdRatio/.test(base) && /retainRatio/.test(base), '底本缺 thresholdRatio / retainRatio 行');
  });

  await check('前提：默认阈值（0.8）下不产生覆盖 —— C1 的派生文件与今天逐字节一致', () => {
    ok(
      compactionOverride(DEFAULT_COMPACTION_THRESHOLD_RATIO) === undefined,
      '默认值居然产生了覆盖：C1 的零回归就没了构造保证'
    );
  });

  // ---- 正控：一份合法的低压阈值覆盖 ----
  const good = writeDerivedConfig({
    storageDir,
    baseConfigPath: baseConfig,
    hooksPath: '',
    compaction: { thresholdRatio: 0.02, retainRatio: 0.004 },
  });
  ok(good.cordisPath && existsSync(good.cordisPath), '正控的派生文件没写出来');
  ok(!good.warning, `正控不该有告警：${good.warning}`);

  await check('正控：派生配置能加载（比例改写合法，且 DSH 真的读了这份文件）', async () => {
    const r = await spawnInit(node, entry, baseConfig, good.cordisPath, storageDir);
    ok(r.ok, `合法派生配置起不来：${r.reason}`);
  });

  // ---- 反控：故意违反插件的加载期硬约束 ----
  const badDir = join(storageDir, 'bad');
  const badPath = join(badDir, 'cordis.yml');
  {
    // 直接手写一份"比例非法"的派生文件：thresholdRatio 0.02 + retainRatio 0.5
    // （插件 `validateRatioRetention`：retainRatio >= thresholdRatio → 加载期 throw）
    const patched = patchCompactionRatios(readFileSync(baseConfig, 'utf8'), {
      thresholdRatio: 0.02,
      retainRatio: 0.5,
    });
    // 防呆：真写对了才继续，否则反控会因为"文件没写坏"而假绿
    ok(/retainRatio:\s*0\.5/.test(patched), '反控文件没写成非法比例，这条断言本身失效了');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(badPath, patched, 'utf8');
  }

  await check('反控：非法比例必须让运行时起不来（证明 env 赢过位置参数）', async () => {
    const r = await spawnInit(node, entry, baseConfig, badPath, storageDir, 45_000);
    if (r.ok) {
      throw new Error(
        '非法派生配置竟然也起得来 —— DSH 没在读 DSH_CORDIS_CONFIG，' +
          '它读的是位置参数那份基础配置。**C1 与 C10 会一起静默失效**（护栏不弹、阈值不生效，且无任何报错）。'
      );
    }
    console.log(`    反控如实失败：${r.reason}`);
  });

  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
    for (const f of failures) console.log(`   · ${f}`);
  } else {
    console.log(`✓ 全部通过：${passed}/${passed}`);
  }
  console.log(`  （派生文件留在 ${storageDir}，排查用）`);
  // ⚠️ 不用 process.exit()：Windows 上被管道/文件重定向的 stdout 是**异步**写，退出会把还没
  // 冲出去的结论行整段丢掉（C8 的 smoke-runtime 就是这么被抓到的：exit=0 却只有第一行）。
  process.exitCode = failures.length ? 1 : 0;
}

/**
 * **按扩展的 spawn 形状**起一次运行时：位置参数给基础配置，派生文件只走 env。
 * 与 `_makeSpawnRequest` 的便携分支逐字对齐 —— 这里要是偷偷改成两个都给派生文件，
 * 反控就永远验不出"env 被忽略"这件事了。
 */
function spawnInit(node, entry, baseConfig, derivedPath, storageDir, bootTimeoutMs) {
  return runTurn({
    node,
    entry,
    config: baseConfig, // 位置参数：基础配置（扩展就是这样）
    cwd: storageDir,
    sessionRoot: join(storageDir, 'sessions'),
    env: { DSH_CORDIS_CONFIG: derivedPath }, // 派生文件只从这里进
    bootTimeoutMs,
  });
}
