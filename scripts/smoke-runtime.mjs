#!/usr/bin/env node
/**
 * 便携运行时的冒烟，两段：
 *
 *   ① 裸 initialize（默认就跑）—— 不依赖扩展、不依赖 F5：spawn 包内的 node + 入口 + 配置，
 *      喂一条 `initialize`，看是否回一条 id 对得上的 JSON-RPC 响应。
 *      **这是整条 C2 路线的分离器**：`packaged-bin.js` 在 Windows 上能不能跑、
 *      闭包的裸插件名能不能解析、默认 cordis.yml 能不能 boot —— 全在这一个断言里。
 *      initialize 不调模型，**不需要 DEEPSEEK_API_KEY**。
 *
 *   ② resume（`--resume`）—— C5 的回归闸门：同一个 sessionId 跨**两个进程**、同一个
 *      `DSH_SESSION_ROOT`，第二轮必须记得第一轮埋的暗号。要真跑两轮模型 → **需要 key**；
 *      拿不到 key 就打一条醒目的 ⚠ 并跳过（以 0 退出，不假装验过）。
 *
 *   node scripts/smoke-runtime.mjs --runtime <便携运行时目录> [--resume] [--keep-session]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CREDENTIALS_FILE, readApiKey, runTurn } from './dsh-turn.mjs';

/** resume 场景埋的暗号；纯数字，避免模型改写格式。 */
const NONCE = '7413';
const SESSION_ID = 'smoke-resume::1';

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    resume: { type: 'boolean', default: false },
    'api-key-file': { type: 'string', default: DEFAULT_CREDENTIALS_FILE },
    'keep-session': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (values.help || (!values.runtime && process.argv.length < 3)) {
  console.log(
    [
      '用法：node scripts/smoke-runtime.mjs --runtime <便携运行时目录> [--resume] [--keep-session]',
      '',
      '目录里应有 runtime.json（由 scripts/build-runtime.mjs 产出）。',
      '  --resume          额外验「跨进程续上同一会话」（C5）；需要 API key，读不到会 ⚠ 跳过',
      '  --api-key-file    从哪读 key（默认 ~/.dsh/.credentials.yaml）',
      '  --keep-session    保留临时会话目录便于排查',
    ].join('\n')
  );
  process.exit(values.help ? 0 : 1);
}

const runtimeDir = resolve(values.runtime ?? process.argv[2]);

/** 读清单并把三个相对路径解析成绝对路径，逐个验存在。 */
async function resolveRuntime(dir) {
  const manifestPath = join(dir, 'runtime.json');
  if (!existsSync(manifestPath)) throw new Error(`运行时目录里没有 runtime.json：${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const abs = (rel) => (rel ? resolve(dir, rel) : '');
  const resolved = {
    manifest,
    node: abs(manifest.node),
    entry: abs(manifest.entry),
    config: abs(manifest.config),
  };
  for (const key of ['node', 'entry', 'config']) {
    if (!resolved[key]) throw new Error(`runtime.json 缺少 "${key}" 字段`);
    if (!existsSync(resolved[key])) throw new Error(`runtime.json 指向的 ${key} 不存在：${resolved[key]}`);
  }
  return resolved;
}

const resolved = await resolveRuntime(runtimeDir);
console.log(`运行时：${runtimeDir}`);
console.log(`  node   ${resolved.node}`);
console.log(`  entry  ${resolved.entry}`);
console.log(`  config ${resolved.config}`);
console.log(
  `  清单   dsh ${resolved.manifest.dshVersion ?? '?'} · ${resolved.manifest.platform ?? '?'} · node ${
    resolved.manifest.nodeVersion ?? '?'
  } · patches ${JSON.stringify(resolved.manifest.patches ?? [])}`
);

// 会话落在临时目录：冒烟不该污染任何人的真实会话，也不该落在仓库里
const sandbox = mkdtempSync(join(tmpdir(), 'hello-runtime-smoke-'));
console.log(`  会话   ${sandbox}`);

const common = {
  node: resolved.node,
  entry: resolved.entry,
  config: resolved.config,
  cwd: sandbox,
  sessionRoot: join(sandbox, 'sessions'),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 逐段收集结论，最后一起判定 —— 先给结论再清理，清理失败不该盖掉结论。 */
const results = [];

// ---- ① 裸 initialize ----
results.push({ name: '裸 initialize', ...(await runTurn(common)) });

// ---- ② resume：同一个 sessionId 跨两个进程 ----
let resumeSkipped = false;
let skippedWhy = '';
if (values.resume) {
  const apiKey = readApiKey(values['api-key-file']);
  if (!apiKey) {
    resumeSkipped = true;
    skippedWhy = values['api-key-file'];
  } else {
    console.log(`  key    已读到（${apiKey.length} 字符，不打印）`);
    const r1 = await runTurn({
      ...common,
      sessionId: SESSION_ID,
      apiKey,
      prompt: `记住这个数字：${NONCE}。只需要回复「好的」，不要做别的。`,
    });
    await sleep(600); // 让上一个进程与它的句柄彻底退干净

    const r2 = await runTurn({
      ...common,
      sessionId: SESSION_ID,
      apiKey,
      prompt: '我刚才让你记住的数字是多少？只回复那个数字，不要解释。',
    });

    const errors = r2.frames.filter((f) => f.error).map((f) => JSON.stringify(f.error).slice(0, 300));
    results.push({ name: 'resume 轮 1', ...r1 });
    results.push({ name: `resume 轮 2（应记得 ${NONCE}）`, ...r2 });
    console.log(`  resume 轮 1 ${r1.ok ? '✓' : '✗'} ${r1.reason}${r1.assistant.trim() ? ` —— 模型说：${r1.assistant.trim().slice(0, 80)}` : ''}`);
    console.log(`  resume 轮 2 ${r2.ok ? '✓' : '✗'} ${r2.reason} —— 模型说：${r2.assistant.trim().slice(0, 120) || '(无)'}`);

    const resumeOk = r1.ok && r2.ok && errors.length === 0 && r2.assistant.includes(NONCE);
    results.push({
      name: 'resume',
      ok: resumeOk,
      reason: resumeOk
        ? `跨进程续上，模型答出 ${NONCE}`
        : `轮 1 ${r1.ok ? 'ok' : '失败'}；轮 2 ${r2.ok ? 'ok' : '失败'}；错误帧 ${errors.length} 条` +
          `${errors.length ? `（${errors[0]}）` : ''}；回复里有暗号=${r2.assistant.includes(NONCE)}`,
    });
  }
}

// ---- 判定 ----
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name} —— ${r.reason}`);
  else console.error(`✗ ${r.name} —— ${r.reason}`);
}
if (resumeSkipped) {
  console.log(
    `\n⚠ resume 冒烟**未跑**：读不到 API key（${skippedWhy}，也没有 DEEPSEEK_API_KEY）。\n` +
      '  → 「会话记忆跨重启」这一条本次**未经验证**。要验就给它一把 key，或先跑 scripts/probe-resume.mjs。'
  );
}

if (!values['keep-session']) {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 删不掉只是留了个临时目录，不影响判定；失败时留着反而便于排查
    console.log(`（临时会话目录没删掉，可自行清理：${sandbox}）`);
  }
}

process.exit(failed.length > 0 ? 1 : 0);
