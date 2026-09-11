#!/usr/bin/env node
/**
 * C5 阶段 0 闸门 —— 「新进程 + 旧 sessionId + 同一个 DSH_SESSION_ROOT」到底能不能续上？
 *
 * 这条不通过，C5 后面全部作废，所以它一次跑两个对照组（同一套流程，只差补丁）：
 *
 *   对照组 A（产物原样，不打补丁）
 *     轮 1 让模型记一个数字 → 杀进程 → 轮 2 问它那个数字
 *     → 期望轮 2 **报错**（id collision）。把「wire 上没有 resume，硬复用旧 id 会炸」钉死。
 *   对照组 B（产物打上 runtime-patch.mjs 的 resume-first 补丁）
 *     同样两轮 → 期望轮 2 **无错误帧**，且模型回复里出现轮 1 埋的那个数字。
 *     要的是「真记得」，不是「没报错」—— 所以断言落在回复内容上。
 *
 * 补丁只落在**构建产物**（dist-runtime 这类 gitignored 目录）上，用户的 DSH 检出一个字不动。
 * 退出时按结论归位：B 过了就把补丁留着（可以直接 F5 用），B 没过就还原成未打补丁的样子。
 *
 *   node scripts/probe-resume.mjs [--runtime dist-runtime] [--api-key-file <yaml>] [--keep]
 *
 * 需要 API key（要真跑两轮模型）。默认从 ~/.dsh/.credentials.yaml 抠，读不到直接拒绝运行
 * —— 这条闸门不许静默跳过。key 只进子进程 env，绝不打印。
 *
 * 实证记录（2026-09-11，DSH 0.1.0-rc.8 / win32-x64）：
 *   A：轮 1「好的」→ 轮 2 id collision（零输出）
 *   B：轮 1「好的」→ 轮 2「7413」
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CREDENTIALS_FILE, readApiKey, runTurn } from './dsh-turn.mjs';
import { applyResumePatch, revertResumePatch } from './runtime-patch.mjs';

/** 两轮用**同一个** sessionId：对照组 A 要炸的就是它。 */
const SESSION_ID = 'probe-resume::1';
/** 轮 1 埋、轮 2 要答出来的暗号。刻意用纯数字，避免模型改写格式。 */
const NONCE = '7413';

const ROUND1_PROMPT = `记住这个数字：${NONCE}。只需要回复「好的」，不要做别的。`;
const ROUND2_PROMPT = '我刚才让你记住的数字是多少？只回复那个数字，不要解释。';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: 'dist-runtime' },
    'api-key-file': { type: 'string', default: DEFAULT_CREDENTIALS_FILE },
    keep: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(
    [
      '用法：node scripts/probe-resume.mjs [--runtime <目录>] [--api-key-file <yaml>] [--keep]',
      '',
      '  --runtime <目录>       便携运行时目录（默认 dist-runtime/）',
      '  --api-key-file <yaml>  从哪读 key（默认 ~/.dsh/.credentials.yaml）',
      '  --keep                 保留临时会话目录',
      '',
      '跑两个对照组：不打补丁（期望 id collision）vs 打上 resume-first 补丁（期望真记得）。',
    ].join('\n')
  );
  process.exit(0);
}

const repoRoot = resolve(import.meta.dirname, '..');
const runtimeDir = resolve(repoRoot, values.runtime);

function log(msg) {
  console.log(`[probe-resume] ${msg}`);
}

// ---------------------------------------------------------------- 运行时清单

const manifestPath = join(runtimeDir, 'runtime.json');
if (!existsSync(manifestPath)) {
  console.error(`✗ 没有 runtime.json：${manifestPath}（先跑 scripts/build-runtime.mjs）`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rt = {
  node: resolve(runtimeDir, manifest.node ?? ''),
  entry: resolve(runtimeDir, manifest.entry ?? ''),
  config: resolve(runtimeDir, manifest.config ?? ''),
};
for (const [key, p] of Object.entries(rt)) {
  if (!p || !existsSync(p)) {
    console.error(`✗ runtime.json 的 ${key} 不存在：${p}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- API key

const apiKey = readApiKey(values['api-key-file']);
if (!apiKey) {
  console.error(`✗ 读不到 API key（${values['api-key-file']}）—— 这条闸门要真跑两轮模型，不能跳过。`);
  process.exit(1);
}
log(`API key 已读到（${apiKey.length} 字符，不打印）`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 一个对照组

async function runPhase({ label, sandbox }) {
  console.log(`\n──────────────── ${label} ────────────────`);
  const common = {
    node: rt.node,
    entry: rt.entry,
    config: rt.config,
    cwd: sandbox,
    sessionRoot: join(sandbox, 'sessions'),
    sessionId: SESSION_ID,
    apiKey,
  };

  const r1 = await runTurn({ ...common, prompt: ROUND1_PROMPT });
  console.log(`  轮 1  ${r1.ok ? '✓' : '✗'} ${r1.reason}`);
  if (r1.assistant.trim()) console.log(`        模型说：${r1.assistant.trim().slice(0, 160)}`);

  await sleep(600); // 让上一个进程与它的句柄彻底退干净，别互染

  const r2 = await runTurn({ ...common, prompt: ROUND2_PROMPT });
  console.log(`  轮 2  ${r2.ok ? '✓' : '✗'} ${r2.reason}`);
  console.log(`        模型说：${r2.assistant.trim().slice(0, 300) || '(无)'}`);
  console.log(`        事件类型：${r2.eventTypes.join(', ') || '(无)'}`);

  const errors = r2.frames.filter((f) => f.error).map((f) => JSON.stringify(f.error).slice(0, 300));
  return {
    r1,
    r2,
    errors,
    collision: r2.collision === true,
    remembers: r2.assistant.includes(NONCE),
  };
}

// ---------------------------------------------------------------- 跑

const sandboxes = [];
const makeSandbox = (tag) => {
  const dir = mkdtempSync(join(tmpdir(), `hello-resume-${tag}-`));
  sandboxes.push(dir);
  return dir;
};

log(`运行时 ${runtimeDir}`);
log(`  node   ${rt.node}`);
log(`  entry  ${rt.entry}`);
log(`  config ${rt.config}`);
log(`  清单   dsh ${manifest.dshVersion ?? '?'} · ${manifest.platform ?? '?'} · patches=${JSON.stringify(manifest.patches ?? [])}`);

// 对照组 A 必须跑在**真原始**产物上：上一轮探针可能把补丁留在产物里了，先摘掉。
try {
  const reverted = revertResumePatch(runtimeDir);
  if (reverted.changed) log('产物上残留着上一次的补丁，已先摘掉（对照组 A 需要原始产物）');
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

const A = await runPhase({ label: '对照组 A · 产物原样（无补丁）', sandbox: makeSandbox('A') });

console.log('\n→ 打上 resume-first 补丁…');
let patchFile;
try {
  const patched = applyResumePatch(runtimeDir);
  patchFile = patched.file;
  log(patched.changed ? `已改动 ${patched.file}` : '产物上已经有补丁了（幂等）');
} catch (err) {
  console.error(`✗ 补丁打不上：${err.message}`);
  process.exit(1);
}

const B = await runPhase({ label: '对照组 B · 打上 resume-first 补丁', sandbox: makeSandbox('B') });

// ---------------------------------------------------------------- 结论

const aOk = A.collision;
const bOk = B.errors.length === 0 && B.remembers;

console.log('\n================ 结论 ================');
console.log(`对照组 A（无补丁）  期望「撞 id」          实得：${aOk ? '✓ 撞了' : '✗ 没撞'} —— ${A.collision ? 'id collision' : A.r2.reason}`);
console.log(
  `对照组 B（有补丁）  期望「记得 ${NONCE}」      实得：${bOk ? '✓ 记得' : '✗ 没答对'}` +
    ` —— 错误帧 ${B.errors.length} 条${B.errors.length ? `：${B.errors[0]}` : ''}；回复里有暗号=${B.remembers}`
);
console.log(`\n判定：${aOk && bOk ? '✓ 闸门通过 —— resume-first 补丁确实把记忆接上了。' : '✗ 闸门未通过。'}`);
if (!aOk) console.log('  · 对照组 A 没撞 id：说明「不补丁也能续」—— 该结论会推翻 C5 的前提，先别往下做。');
if (!bOk) console.log('  · 对照组 B 没答对：补丁方向或写法有问题，见上面的轮 2 详情。');

// 归位：B 过了就把补丁留着（可以直接 F5 用），没过就还原成未打补丁的样子
if (!bOk) {
  try {
    revertResumePatch(runtimeDir);
    console.log(`\n（补丁未通过验证，已把 ${patchFile} 还原成未打补丁的样子）`);
  } catch (err) {
    console.error(`\n✗ 还原失败：${err.message}`);
  }
} else {
  console.log(`\n（补丁已留在产物里：${patchFile} —— 可以直接把 hello.dsh.runtimeDir 指过来 F5）`);
}

if (!values.keep) {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.log(`（临时目录没删掉，可自行清理：${dir}）`);
    }
  }
} else {
  console.log(`（--keep：临时目录留着）\n  ${sandboxes.join('\n  ')}`);
}

process.exit(aOk && bOk ? 0 : 1);
