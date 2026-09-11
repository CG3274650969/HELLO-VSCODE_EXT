#!/usr/bin/env node
/**
 * 从一个 DSH 检出产出一份**便携运行时目录** —— C2 阶段一的分发单元。
 *
 * 为什么要有这一步：Windows 上今天没有任何可下载的 DSH 制品。
 *   - python/sdk-runtime/platforms.json 只列 linux-x64 / linux-arm64 / macos-arm64；
 *     单文件 exe 构建脚本里明写 "Windows is a documented non-goal"。
 *   - npm 轨未成熟（agent-spine 未发布、版本轨分裂、dsh-sdk-jsonrpc-server README 为空）。
 * 所以「用户装完即用」的前提是**有人先把字节做出来**。本脚本就是那个"做一次"。
 *
 * 做法复用 DSH 自己为 Python SDK 定义的零配置契约（scripts/build-exe-for-python-sdk.ts）：
 * deploy 出无符号链接的闭包 → 用纯 JS 的 packaged-bin.js 当入口（**不需要 tsx**）
 * → 配一份默认 cordis.yml。区别只有两点：不跑 pkg（那是 linux/macos 专有），以及
 * 默认配置用我们自己的（上游那份太精简，会丢掉 tool-fs 这批文件工具）。
 *
 * 产出布局（deploy 目标就是 <out> 本身，好让 packaged-bin.js 向上找得到 <out>/node_modules）：
 *   <out>/  runtime.json  cordis.yml  package.json  node/node.exe  node_modules/@deepseek-ai/…
 *
 *   node scripts/build-runtime.mjs --dsh D:\DSH\deepseek-harness --node D:\DSH\tools\node-v24.19.0-win-x64\node.exe
 */
import { spawn } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { PATCH_NAME, applyResumePatch } from './runtime-patch.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** deploy 根包：纯依赖清单，它的依赖闭包就是运行时的插件集。 */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg';
/** 闭包内的入口（纯 JS，`import.meta.url` 作 bare 插件解析基点）。 */
const ENTRY_REL = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js';
/** deploy 的源 node_modules：legacy hoist 漏掉的直接依赖要回这里补。 */
const DEPLOY_SOURCE_REL = 'python/sdk-runtime/node_modules';
/** deploy 专属的文档，不进运行时包。 */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml'];
/** 我们的默认配置（入库）。 */
const DEFAULT_CONFIG_REL = 'runtime/cordis.default.yml';
/** DSH 的 engines.node 要求（见检出根 package.json）。 */
const MIN_NODE = { major: 22, minor: 19 };
/** 扩展侧那个判据常量的出处（必须与 runtime-patch.mjs 的 PATCH_NAME 一字不差）。 */
const EXT_PATCH_CONST_FILE = 'src/chatViewProvider.ts';

const { values } = parseArgs({
  options: {
    dsh: { type: 'string' },
    out: { type: 'string', default: 'dist-runtime' },
    node: { type: 'string' },
    pnpm: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'skip-verify': { type: 'boolean', default: false },
    zip: { type: 'boolean', default: false },
    'skip-smoke': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help || !values.dsh) {
  console.log(
    [
      '用法：node scripts/build-runtime.mjs --dsh <DSH 检出根> [选项]',
      '',
      '  --out <目录>      产出目录（默认 dist-runtime/，已 gitignore）',
      '  --node <node.exe> 打进包的便携 node（默认 DSH_NODE → 检出旁 tools/node-v… 里的 node.exe → 当前 node）',
      '  --pnpm <路径>     指定 pnpm（默认取 PATH）',
      '  --skip-build      跳过 `pnpm run build`（要求检出里 lib/ 已就绪）',
      '  --skip-verify     跳过「检出锁在期望 tag 上」的断言',
      '  --skip-smoke      跳过收尾的裸冒烟',
      '  --zip             额外产出一个 .zip（阶段二分发用；需要系统有 tar）',
    ].join('\n')
  );
  process.exit(values.help ? 0 : 1);
}

const dshRoot = resolve(values.dsh);
const outDir = resolve(REPO_ROOT, values.out);

function log(msg) {
  console.log(`[build-runtime] ${msg}`);
}

function fail(msg) {
  console.error(`[build-runtime] ✗ ${msg}`);
  process.exit(1);
}

/**
 * 构建期一致性断言：扩展侧的判据常量必须与本模块的 PATCH_NAME 一字不差。
 *
 * 这两半是耦的却分居两个语言里：构建脚本往产物上打 `PATCH_NAME` 的补丁并写进 runtime.json，
 * 扩展靠自己的 `DSH_RESUME_PATCH` 去认。改了名字只改一边 → 补丁照样打、清单照样写，
 * 但扩展认不出来 → **表现是「续聊永远丢记忆」，全程不报一个错**。这种静默失败只能靠构建期钉死。
 */
async function assertPatchNameAgreesWithExtension() {
  const file = join(REPO_ROOT, EXT_PATCH_CONST_FILE);
  let src;
  try {
    src = await readFile(file, 'utf8');
  } catch (err) {
    fail(`读不到扩展侧常量文件 ${EXT_PATCH_CONST_FILE}：${err instanceof Error ? err.message : String(err)}`);
  }
  const m = /DSH_RESUME_PATCH\s*=\s*'([^']+)'/.exec(src);
  if (!m) {
    fail(`扩展侧 ${EXT_PATCH_CONST_FILE} 里找不到 \`DSH_RESUME_PATCH = '…'\` —— 判据常量没了或被改了写法。`);
  }
  if (m[1] !== PATCH_NAME) {
    fail(
      `补丁名漂了：runtime-patch.mjs 是 "${PATCH_NAME}"，扩展侧是 "${m[1]}"。\n` +
        '  两边必须一字不差，否则扩展认不出打了补丁的运行时（表现为「续聊永远丢记忆」且不报错）。'
    );
  }
  log(`补丁名一致：${PATCH_NAME}（runtime-patch.mjs ↔ ${EXT_PATCH_CONST_FILE}）`);
}

/** 跑一个子进程并把输出透传；非零退出即抛，且把原始命令打出来（别吞退出码）。 */
function run(label, argv, options = {}) {
  const [command, ...args] = argv;
  return new Promise((resolvePromise, rejectPromise) => {
    log(`${label}：${argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', (err) => rejectPromise(new Error(`${label} 无法启动：${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${label} 退出码 ${String(code)}`));
    });
  });
}

/** 捕获子进程 stdout（用于 `node -v` 这类小查询）。 */
function capture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', rejectPromise);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise(out.trim()) : rejectPromise(new Error(err.trim() || `退出码 ${String(code)}`))
    );
  });
}

/** 解析 node 路径：--node → DSH_NODE → 检出旁 tools/node-v…/node.exe → 当前 node。 */
async function resolveNode() {
  if (values.node) return resolve(values.node);
  if (process.env.DSH_NODE) return resolve(process.env.DSH_NODE);
  const toolsDir = join(dirname(dshRoot), 'tools');
  if (existsSync(toolsDir)) {
    const candidates = (await readdir(toolsDir)).filter((n) => n.startsWith('node-v')).sort().reverse();
    for (const name of candidates) {
      const exe = join(toolsDir, name, process.platform === 'win32' ? 'node.exe' : 'node');
      if (existsSync(exe)) return exe;
    }
  }
  return process.execPath;
}

/** 版本门槛检查：DSH 要求 ^22.19 || >=24（见检出根 package.json engines）。 */
async function assertNodeVersion(nodePath) {
  let version;
  try {
    version = await capture(nodePath, ['-v']);
  } catch (err) {
    fail(`无法执行 node 检查版本：${nodePath}（${err.message}）`);
  }
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) fail(`认不出 node 版本：${version}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const ok = major === 22 ? minor >= MIN_NODE.minor : major >= 24;
  if (!ok) {
    fail(
      `node ${version} 太旧：DSH 要求 ^${MIN_NODE.major}.${MIN_NODE.minor}.0 || >=24.0.0。` +
        `\n  用 --node 指向新版（如检出旁 tools/node-v24.*/node.exe），或设 DSH_NODE。`
    );
  }
  return version;
}

/**
 * 解析 pnpm 的调用方式，返回完整 argv 前缀。
 * 不能直接 spawn('pnpm')：Node 的 spawn 在 Windows 上跑不了 `.cmd`/`.bat`/sh 脚本
 * （要 shell:true 才行），而 pnpm 常常正是这种 shim（本机就是 node 目录下 corepack 的 shim）。
 * 所以优先用「我们已有的这个 node 去跑 corepack 的 pnpm.js」——同一套解释器，最稳。
 */
function resolvePnpm(nodePath) {
  if (values.pnpm) return [values.pnpm];
  const corepackPnpm = join(dirname(nodePath), 'node_modules', 'corepack', 'dist', 'pnpm.js');
  if (existsSync(corepackPnpm)) return [nodePath, corepackPnpm];
  // 真正独立的 pnpm.exe 才可能被 spawn 直接拉起；否则交给用户显式指定
  return ['pnpm'];
}

/**
 * 逐层找符号链接，一次返回全部。
 * 比"每次只找一个、再从头重扫"快得多 —— 闭包里有上万个条目，那样是 O(链接数 × 条目数)。
 * 注意 Windows 的 junction 在 lstat 下同样 isSymbolicLink() === true。
 */
async function findAllSymlinks(dir, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc; // 目录可能在上一轮里被删掉了
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let metadata;
    try {
      metadata = await lstat(full);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink()) {
      acc.push(full);
      continue;
    }
    if (metadata.isDirectory()) await findAllSymlinks(full, acc);
  }
  return acc;
}

/** 读 `<out>/package.json` 的 dependencies 名单（补漏用）。 */
async function stagedDependencies(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  return Object.keys(manifest.dependencies ?? {}).sort();
}

/**
 * 补上 pnpm legacy hoist 放到"deploy 源旁边"、没进目标的直接依赖。
 * 每个包都自带 node_modules 的话会形成多个 cordis 实例 —— 所以过滤掉嵌套的，
 * 保持"单一扁平实例 + 无符号链接"这个前提（pkg 路线与我们都依赖它）。
 */
async function restoreLegacyHoists(staging) {
  const sourceNodeModules = join(dshRoot, DEPLOY_SOURCE_REL);
  const restored = [];
  const missing = [];
  for (const dependency of await stagedDependencies(staging)) {
    const destination = join(staging, 'node_modules', dependency);
    if (existsSync(destination)) continue;
    const source = join(sourceNodeModules, dependency);
    if (!existsSync(source)) {
      missing.push(dependency);
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    const nested = join(source, 'node_modules');
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (p) => p !== nested && !p.startsWith(nested + sep),
    });
    restored.push(dependency);
  }
  if (missing.length > 0) {
    fail(`这些依赖在目标和 ${DEPLOY_SOURCE_REL} 里都找不到：${missing.join(', ')}（deploy 没产出完整闭包）`);
  }
  const gap = (await stagedDependencies(staging)).filter(
    (d) => !existsSync(join(staging, 'node_modules', d))
  );
  if (gap.length > 0) fail(`补漏后仍缺依赖：${gap.join(', ')}`);
  if (restored.length > 0) log(`补上 legacy hoist 漏掉的 ${restored.length} 个依赖：${restored.join(', ')}`);
}

/** 把 deploy 期产生的符号链接统统替换成真实文件，直到一个链接都不剩。 */
async function materializeStagedLinks(staging) {
  const nodeModules = join(staging, 'node_modules');
  let pass = 0;
  for (;;) {
    const links = await findAllSymlinks(nodeModules);
    if (links.length === 0) break;
    pass += 1;
    log(`第 ${pass} 轮：materialize ${links.length} 个符号链接`);
    for (const link of links) {
      let metadata;
      try {
        metadata = await lstat(link);
      } catch {
        continue; // 上一轮删掉某个 .bin 目录时一并没了
      }
      if (!metadata.isSymbolicLink()) continue;

      const segments = link.slice(nodeModules.length + 1).split(sep);
      const binIndex = segments.lastIndexOf('.bin');
      if (binIndex >= 0) {
        // 包管理器的 .bin 快捷方式：整目录扔掉，运行时不需要
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true });
        continue;
      }
      const source = await realpath(link);
      const nested = join(source, 'node_modules');
      await rm(link, { recursive: true, force: true });
      await cp(source, link, {
        recursive: true,
        dereference: true,
        filter: (p) => p !== nested && !p.startsWith(nested + sep),
      });
    }
  }
  log(`闭包已无符号链接（共 ${pass} 轮）`);
}

async function main() {
  // ---- 预检：这确实是 DSH 检出，且（默认）锁在期望的 tag 上 ----
  const dshPkgPath = join(dshRoot, 'package.json');
  if (!existsSync(dshPkgPath)) fail(`不是 DSH 检出（没有 package.json）：${dshRoot}`);
  const dshPkg = JSON.parse(await readFile(dshPkgPath, 'utf8'));
  if (dshPkg.name !== '@deepseek-ai/dsh-root') {
    fail(`package.json 的 name 是 "${dshPkg.name}"，期望 "@deepseek-ai/dsh-root" —— 这不像 DSH 检出`);
  }
  const dshVersion = String(dshPkg.version ?? '');
  log(`DSH 检出：${dshRoot}（${dshPkg.name} ${dshVersion}）`);

  if (!values['skip-verify']) {
    await run('锁点断言', [process.execPath, join(REPO_ROOT, 'scripts', 'update-dsh.mjs'), dshRoot, '--expected', dshVersion]);
  }

  // ---- node 与 pnpm：子进程的 PATH 必须让便携 node 在前 ----
  // pnpm 用 PATH 上的 node 去跑各包的 lifecycle script；PATH 若命中旧 node，
  // 会在 postinstall 里炸（实测：node16 没有 import.meta.resolve）。
  const nodePath = await resolveNode();
  const nodeVersion = await assertNodeVersion(nodePath);
  log(`便携 node：${nodePath}（${nodeVersion}）`);
  const childEnv = { ...process.env, PATH: `${dirname(nodePath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };
  const pnpm = resolvePnpm(nodePath);
  log(`pnpm：${pnpm.join(' ')}`);

  // ---- 构建 + deploy ----
  if (!values['skip-build']) {
    await run('构建检出', [...pnpm, 'run', 'build'], { cwd: dshRoot, env: childEnv });
  } else {
    log('跳过构建（--skip-build）—— 要求检出里各包 lib/ 已就绪');
  }

  if (outDir === dshRoot || dshRoot.startsWith(outDir + sep)) {
    fail(`拒绝清空产出目录 ${outDir}：它包含 DSH 检出根`);
  }
  // 清不掉多半不是权限问题，是**上一个运行时进程还活着**占着 outDir/node/node.exe
  // —— Windows 上运行中的映像文件是排他的。裸 EBUSY 完全看不出这一点，所以自己说清楚。
  // （实测踩过一次：遗留的运行时进程让整次构建在第一步就失败，报错里只有 rmdir 路径。）
  try {
    await rm(outDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  } catch (err) {
    const nodeInOut = join(outDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    fail(
      `清空产出目录失败：${outDir}\n  ${err instanceof Error ? err.message : String(err)}\n` +
        `  → 多半是残留的运行时进程正占着 ${nodeInOut}。\n` +
        '    先关掉在跑这个运行时的 VS Code 窗口，再按需 taskkill /F /PID <pid>（或 taskkill /F /IM node.exe），然后重跑。'
    );
  }
  await mkdir(outDir, { recursive: true });

  await run(
    'deploy 闭包',
    [
      ...pnpm,
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      outDir,
    ],
    { cwd: dshRoot, env: childEnv }
  );

  await restoreLegacyHoists(outDir);
  await materializeStagedLinks(outDir);

  for (const doc of DEPLOY_ONLY_DOCS) await rm(join(outDir, doc), { force: true });

  // ---- 入口必须在 ----
  const entryAbs = join(outDir, ENTRY_REL);
  if (!existsSync(entryAbs)) {
    fail(
      `闭包里没有入口 ${ENTRY_REL} —— 多半是检出没构建（去掉 --skip-build 重试）。` +
        `\n  入口来自 packages/examples/jsonrpc-demo/lib/，由 \`pnpm run build\` 的 build:lib 产出。`
    );
  }

  // ---- 打补丁：把「恢复已落盘的会话」接到 wire 上（C5）----
  // 只动**构建产物**，用户的 DSH 检出不受影响（补丁模块见 scripts/runtime-patch.mjs）。
  // 锚点漂移就当场失败，绝不静默放过：静默放过 = 交付出一个一 resume 就撞 id collision 的运行时。
  await assertPatchNameAgreesWithExtension();
  let patched = false;
  try {
    const result = applyResumePatch(outDir);
    patched = true;
    log(result.changed ? `已打补丁 ${PATCH_NAME} → ${result.file}` : `补丁 ${PATCH_NAME} 已在产物里（幂等）`);
  } catch (err) {
    fail(`resume 补丁打不上：${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- 补 node 与默认配置 ----
  const nodeDestDir = join(outDir, 'node');
  await mkdir(nodeDestDir, { recursive: true });
  const nodeDest = join(nodeDestDir, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(nodePath, nodeDest);
  // node 的 LICENSE 与其再分发声明：一起带上，别只搬二进制
  const nodeLicense = join(dirname(nodePath), 'LICENSE');
  if (existsSync(nodeLicense)) await copyFile(nodeLicense, join(nodeDestDir, 'LICENSE'));

  const defaultConfig = join(REPO_ROOT, DEFAULT_CONFIG_REL);
  if (!existsSync(defaultConfig)) fail(`仓库里缺少默认配置：${DEFAULT_CONFIG_REL}`);
  await copyFile(defaultConfig, join(outDir, 'cordis.yml'));

  // ---- 清单：扩展靠它把三个路径解析出来 ----
  const manifest = {
    formatVersion: 1,
    dshVersion,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion,
    node: `node/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
    entry: ENTRY_REL.split(sep).join('/'),
    config: 'cordis.yml',
    /** 我们对产物做的改动清单。扩展靠它判断「这个运行时能不能跨进程复用 DSH id」——
     *  没这个标记（开发者路径/外部运行时）就只能每次激活新铸 id，否则会撞 id collision。 */
    patches: patched ? [PATCH_NAME] : [],
  };
  await writeFile(join(outDir, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(`已写出 runtime.json（dsh ${dshVersion} · ${manifest.platform} · node ${nodeVersion} · patches ${JSON.stringify(manifest.patches)}）`);

  // ---- 可选 zip（阶段二的分发单元）----
  if (values.zip) {
    const zipPath = `${outDir}.zip`;
    await rm(zipPath, { force: true });
    await run('打包 zip', ['tar', '-a', '-c', '-f', zipPath, '-C', dirname(outDir), outDir.split(sep).pop()]);
  }

  // ---- 收尾冒烟：一条命令里两段 ----
  //   ① 裸 initialize —— 不需要 key，是整条 C2 路线的判定点；
  //   ② resume —— 跨进程续上同一个会话（C5），要真跑两轮模型，需要 key。
  // ② 拿不到 key 时会自己打一条醒目的 ⚠ 并以 0 退出：不假装验过，也不拦着没 key 的人构建。
  if (!values['skip-smoke']) {
    await run('冒烟（initialize + resume）', [nodePath, join(REPO_ROOT, 'scripts', 'smoke-runtime.mjs'), '--runtime', outDir, '--resume']);
  }

  log(`✓ 完成：${outDir}`);
}

await main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
