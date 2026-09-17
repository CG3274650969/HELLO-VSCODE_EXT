#!/usr/bin/env node
/**
 * C8 前提探针 —— 「运行可靠性」这套设计压在三条运行时事实上，先复验再写代码。
 *
 *   ① 对同一个 sessionId 的第二次 `session/prompt` 不会并发、不会报错，而是**排队成新的一轮**；
 *   ② 一轮跑到一半硬杀子进程之后，用同一个 id 重新 boot 能 resume（不报 corruption），
 *      且持久化层会把未闭合的尾 turn **补平**（合成 tool/result + turn/end reason=interrupted）；
 *   ③ `stdin.end()` 优雅退出（`--kill-compare` 才跑）比直接 `child.kill()` 多落盘若干事件。
 *
 * 做法：绝不改用户那份 cordis.yml —— 一律**复制**到临时目录；会话根、工作区也都用临时目录。
 * 用便携运行时自带的 node 跑（解压 zstd 日志需要 Node ≥ 22.15，宿主 node 太老会响亮失败）：
 *
 *   ./dist-runtime/node/node.exe scripts/probe-c8-runtime.mjs
 *     [--runtime <目录>] [--base-config <cordis.yml>] [--api-key-file <yaml>]
 *     [--kill-compare] [--keep]
 *
 * 退出码：0 = 全部前提成立；1 = 有前提不成立（打印是哪一条）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const RESPONSE_TIMEOUT_MS = 60_000;
/** 一轮的等待上限：本探针的提示词都是十几秒级的短任务，给足余量。 */
const TURN_TIMEOUT_MS = 300_000;
/** 「安静」判定：最后一次状态是 idle，且这么久没有任何新帧 → 认为真的跑完了。 */
const QUIET_MS = 3000;

const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: 'dist-runtime' },
    'base-config': { type: 'string' },
    'api-key-file': { type: 'string', default: join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml') },
    'kill-compare': { type: 'boolean', default: false },
    only: { type: 'string', default: '' },
    keep: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

/** `--only 2,3` 只跑指定前提 —— 调探针本身时省掉没动的那些真实模型轮。 */
const only = new Set(
  values.only
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const wants = (n) => only.size === 0 || only.has(String(n));

if (values.help) {
  console.log(
    [
      '用法：./dist-runtime/node/node.exe scripts/probe-c8-runtime.mjs [选项]',
      '',
      '  --runtime <目录>       便携运行时目录（默认 dist-runtime/）',
      '  --base-config <yml>    用哪份 cordis.yml 当基础（默认运行时自带的 cordis.yml）',
      '  --api-key-file <yaml>  从哪读 key（默认 ~/.dsh/.credentials.yaml）；读不到只做 boot 检查',
      '  --kill-compare         额外跑「优雅退出 vs 硬杀」的落盘对比（多花两轮模型调用）',
      '  --only <1,2,3>         只跑指定前提（调探针自身时省掉没动的真实模型轮）',
      '  --keep                 保留临时目录',
      '',
      '必须用运行时自带的 node 跑（解压 zstd 日志需要 Node ≥ 22.15）。',
    ].join('\n')
  );
  process.exit(0);
}

const repoRoot = resolve(import.meta.dirname, '..');
const runtimeDir = resolve(repoRoot, values.runtime);
const log = (m) => console.log(`[probe] ${m}`);

// ---------------------------------------------------------------- 前置检查

const manifestPath = join(runtimeDir, 'runtime.json');
if (!existsSync(manifestPath)) {
  console.error(`✗ 没有 runtime.json：${manifestPath}（先跑 scripts/build-runtime.mjs）`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const nodeExe = resolve(runtimeDir, manifest.node);
const entry = resolve(runtimeDir, manifest.entry);
for (const [k, p] of Object.entries({ node: nodeExe, entry })) {
  if (!existsSync(p)) {
    console.error(`✗ runtime.json 的 ${k} 不存在：${p}`);
    process.exit(1);
  }
}
if (!manifest.patches?.includes('resume-first-session')) {
  console.error('✗ 这个运行时没有 resume-first-session 补丁 —— 前提 ② 根本无从谈起，先重建运行时');
  process.exit(1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 15)) {
  console.error(
    `✗ 当前 node 是 v${process.versions.node}，解压 zstd 日志需要 ≥ 22.15。\n` +
      '  请改用：./dist-runtime/node/node.exe scripts/probe-c8-runtime.mjs'
  );
  process.exit(1);
}

const baseConfig = values['base-config']
  ? resolve(values['base-config'])
  : join(runtimeDir, manifest.config ?? 'cordis.yml');
if (!existsSync(baseConfig)) {
  console.error(`✗ 基础配置不存在：${baseConfig}`);
  process.exit(1);
}

const dshPathsOut = join(repoRoot, 'out', 'dshPaths.js');
if (!existsSync(dshPathsOut)) {
  console.error(`✗ 没有 ${dshPathsOut} —— 先 npm run compile`);
  process.exit(1);
}
const { sessionDir, logPath } = await import(pathToFileURL(dshPathsOut).href);

// ---------------------------------------------------------------- API key

/** 从 credentials yaml 里抠 key。**只回值、绝不打印**；找不到返回空串。 */
function readApiKey(file) {
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:DEEPSEEK_API_KEY|deepseek[_-]?api[_-]?key|api[_-]?key)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (raw) return raw;
  }
  return '';
}
const apiKey = readApiKey(values['api-key-file']);
if (apiKey) log(`API key 从 ${values['api-key-file']} 读到（${apiKey.length} 字符，不打印）`);
else log('⚠ 没读到 API key —— 只能做 boot 检查，跑不了真实轮次');

// ---------------------------------------------------------------- 临时区

const scratch = mkdtempSync(join(tmpdir(), 'dsh-c8-spike-'));
const configPath = join(scratch, 'cordis.probe.yml');
// 复制而非改动：用户那份 cordis.yml 一个字节都不能动
writeFileSync(configPath, readFileSync(baseConfig, 'utf8'), 'utf8');
log(`临时区   ${scratch}`);
log(`配置副本 ${configPath}  ← 抄自 ${baseConfig}`);

const MODEL = 'deepseek-v4-flash';

// ---------------------------------------------------------------- 起一个可观测的运行时进程

function boot(label, { wsDir, sessionRoot }) {
  const child = spawn(nodeExe, [entry, configPath], {
    cwd: wsDir,
    env: {
      ...process.env,
      DSH_CORDIS_CONFIG: configPath,
      DSH_CWD: wsDir,
      DSH_SESSION_ROOT: sessionRoot,
      ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const state = {
    label,
    child,
    events: [],
    statuses: [],
    responses: [],
    stderr: '',
    exits: [],
    exited: false,
    touched: Date.now(),
  };

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += String(d);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let f;
      try {
        f = JSON.parse(line);
      } catch {
        continue;
      }
      state.touched = Date.now();
      if (f.method === 'session.event') state.events.push(f.params?.event ?? {});
      else if (f.method === 'session.status') state.statuses.push(f.params?.status);
      else if (f.id !== undefined) state.responses.push(f);
    }
  });
  child.stderr.on('data', (d) => {
    state.stderr += String(d);
  });
  child.on('exit', (code) => {
    state.exited = true;
    state.exits.push(code);
  });

  state.send = (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  };
  state.prompt = (id, sessionId, text) =>
    state.send(id, 'session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] });

  const poll = (fn, ms) =>
    new Promise((res) => {
      const t0 = Date.now();
      const tick = () => {
        const v = fn();
        if (v !== undefined) return res(v);
        if (Date.now() - t0 > ms) return res(undefined);
        setTimeout(tick, 100);
      };
      tick();
    });

  /** 等某个响应（按 id）。 */
  state.waitResponse = (id, ms = RESPONSE_TIMEOUT_MS) =>
    poll(() => state.responses.find((x) => x.id === id), ms);
  /** 等出现第一个某类型事件（证明「那一轮确实在跑」）。 */
  state.waitEvent = (type, ms = TURN_TIMEOUT_MS) =>
    poll(() => state.events.find((x) => x.type === type), ms);
  /**
   * 等「真跑完」：已收到 ≥ minTurnEnds 个 turn/end、最后一次状态是 idle、
   * 且安静了 QUIET_MS 没有新帧。只看 idle 是不够的 —— 连发两条时中途也会经过 idle。
   */
  state.waitQuiet = (minTurnEnds, ms = TURN_TIMEOUT_MS) =>
    new Promise((res) => {
      const t0 = Date.now();
      const tick = () => {
        const ends = state.events.filter((e) => e.type === 'turn/end').length;
        const idle = state.statuses[state.statuses.length - 1] === 'idle';
        if (state.exited) return res(`exited(${state.exits.join(',')})`);
        if (ends >= minTurnEnds && idle && Date.now() - state.touched > QUIET_MS) return res('quiet');
        if (Date.now() - t0 > ms) return res('timeout');
        setTimeout(tick, 150);
      };
      tick();
    });

  /** 硬杀：与扩展今天的 kill() 同款 —— stdin.end 与 child.kill 背靠背。 */
  state.killHard = () => {
    try {
      child.stdin.end();
    } catch {
      /* 已关 */
    }
    try {
      child.kill();
    } catch {
      /* 已退 */
    }
  };
  /** 优雅：只关 stdin，等它自己 disposeAndExit。返回是否按时退出。 */
  state.killGraceful = (ms = 8000) =>
    new Promise((res) => {
      try {
        child.stdin.end();
      } catch {
        /* 已关 */
      }
      const t0 = Date.now();
      const tick = () => {
        if (state.exited) return res(true);
        if (Date.now() - t0 > ms) {
          try {
            child.kill();
          } catch {
            /* 已退 */
          }
          return res(false);
        }
        setTimeout(tick, 50);
      };
      tick();
    });

  return state;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 读一条会话在盘上的日志。
 *
 * ⚠️ 文件是**一串拼接的 zstd 帧**（每批落盘写一个帧，硬杀会留下十几个），而
 * `zstdDecompressSync` 与 `createZstdDecompress` **都只解第一帧就收工**（实测：15 帧的文件
 * 两者都只吐 1 行）。所以必须自己按魔数切帧 —— 前提就是「杀掉之后盘上还有什么」，
 * 读错了这份探针等于没跑。
 *
 * 切帧是启发式的（帧内容理论上可能恰好包含魔数），所以每一片都**试解**：
 * 解不开就把终点往后挪一帧（最多 4 帧），仍解不开才记为失败。
 */
function readSessionLog(sessionRoot, cwd, id) {
  const p = logPath(sessionRoot, cwd, id, 'zstd');
  if (!existsSync(p)) return { path: p, events: [], error: '日志不存在' };
  const buf = readFileSync(p);
  const offs = [];
  for (let i = 0; ; ) {
    const j = buf.indexOf(ZSTD_MAGIC, i);
    if (j < 0) break;
    offs.push(j);
    i = j + 1;
  }
  if (offs.length === 0) return { path: p, events: [], error: '没有找到 zstd 帧魔数' };

  const text = [];
  const skipped = [];
  for (let k = 0; k < offs.length; k += 1) {
    let done = false;
    for (let span = 1; span <= 4 && k + span <= offs.length && !done; span += 1) {
      const end = k + span < offs.length ? offs[k + span] : buf.length;
      try {
        text.push(zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'));
        k += span - 1;
        done = true;
      } catch {
        /* 这一片不是完整帧（或被魔数误切）→ 往后多要一帧再试 */
      }
    }
    if (!done) skipped.push(offs[k]);
  }
  try {
    const events = text
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const err = skipped.length ? `有 ${skipped.length} 片解不开（偏移 ${skipped.join(',')}）` : '';
    return { path: p, events, frames: offs.length, error: err };
  } catch (err) {
    return { path: p, events: [], error: String(err?.message ?? err) };
  }
}

const summarize = (events) =>
  events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {});
const turnEndReasons = (events) =>
  events.filter((e) => e.type === 'turn/end').map((e) => e.data?.reason?.kind ?? '?');

const results = [];
function record(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 提示词

/** 刻意做成「要跑十几秒」：这样第二条 prompt 必然落在第一轮**还在跑**的窗口里。 */
const LONG_PROMPT =
  '用 bash 工具依次执行 4 次 `sleep 3`（可以写成一条循环命令），每次打印一行进度。全部完成后只回复 DONE。';
const SHORT_PROMPT = '只回复两个字：收到';

function makeScratch(tag) {
  const wsDir = join(scratch, `${tag}-ws`);
  const sessionRoot = join(scratch, `${tag}-sessions`);
  mkdirSync(wsDir, { recursive: true });
  mkdirSync(sessionRoot, { recursive: true });
  return { wsDir, sessionRoot };
}

/** 起进程 + initialize；失败时 record 一条并返回 undefined。 */
async function bootReady(tag, dirs) {
  const rt = boot(tag, dirs);
  rt.send(1, 'initialize', { cwd: dirs.wsDir, provider: 'deepseek-official', model: MODEL });
  const init = await rt.waitResponse(1);
  if (!init || init.error) {
    record(false, `[${tag}] initialize`, JSON.stringify(init?.error ?? '无响应') + (rt.stderr ? ` stderr=${rt.stderr.slice(0, 200)}` : ''));
    rt.killHard();
    return undefined;
  }
  return rt;
}

// ---------------------------------------------------------------- 前提 ①

async function premise1() {
  console.log('\n=== 前提 ①：running 期间再发一条 prompt，是排队成新一轮还是并发/报错？===');
  const sid = 'probe-c8::1';
  const dirs = makeScratch('p1');
  const rt = await bootReady('p1', dirs);
  if (!rt) return;

  rt.prompt(2, sid, LONG_PROMPT);
  const ackA = await rt.waitResponse(2, 45_000);
  console.log(`  第一轮回执：${ackA ? JSON.stringify(ackA.result ?? ackA.error).slice(0, 140) : '(45s 内无回执)'}`);

  const firstCall = await rt.waitEvent('tool/call', 90_000);
  const runningNow = rt.statuses.includes('running');
  console.log(`  第一轮已起工具：${!!firstCall}；此前的状态序列=${JSON.stringify(rt.statuses)}`);

  // 就在「还在跑」的时候插第二条
  rt.prompt(3, sid, SHORT_PROMPT);
  const ackB = await rt.waitResponse(3, 45_000);
  console.log(`  第二条回执：${ackB ? JSON.stringify(ackB.result ?? ackB.error).slice(0, 140) : '(45s 内无回执)'}`);

  const end = await rt.waitQuiet(2);
  const types = summarize(rt.events);
  const reasons = turnEndReasons(rt.events);
  const errs = rt.responses.filter((r) => r.error).map((r) => JSON.stringify(r.error).slice(0, 140));
  console.log(`  轮次统计：turn/start=${types['turn/start'] ?? 0}  turn/end=${reasons.length}(${JSON.stringify(reasons)})  结束=${end}`);
  console.log(`  事件摘要：${JSON.stringify(types)}`);
  console.log(`  状态序列：${JSON.stringify(rt.statuses)}`);
  if (errs.length) console.log(`  ⚠ 响应错误：${errs.join(' | ')}`);
  rt.killHard();

  const ok = !!ackA && !ackA.error && !!ackB && !ackB.error && (types['turn/start'] ?? 0) >= 2 && reasons.length >= 2 && errs.length === 0;
  record(
    ok,
    '前提 ①（第二次 prompt 排队成新一轮、不并发不报错）',
    ok
      ? `两轮都跑完：turn/start=${types['turn/start']}，reason=${JSON.stringify(reasons)}`
      : `turn/start=${types['turn/start'] ?? 0} turn/end=${reasons.length} 响应错误=${errs.length}${runningNow ? '' : '（第一轮跑时未观测到 running）'}`
  );
}

// ---------------------------------------------------------------- 前提 ②

async function premise2() {
  console.log('\n=== 前提 ②：一轮跑一半硬杀 → 同一 id 重新 boot 能否 resume 且补平尾 turn？===');
  const sid = 'probe-c8::2';
  const dirs = makeScratch('p2');

  // --- 第一次：工具起来后硬杀 ---
  const rt1 = await bootReady('p2-a', dirs);
  if (!rt1) return;
  rt1.prompt(2, sid, LONG_PROMPT);
  const firstCall = await rt1.waitEvent('tool/call', 90_000);
  console.log(`  第一轮工具已起：${firstCall ? String(firstCall.data?.name ?? '').slice(0, 40) : '（没等到 tool/call）'}`);
  await new Promise((r) => setTimeout(r, 2500)); // 让它多写几条，制造真实的「未闭合」
  console.log(`  杀前线上事件数：${rt1.events.length}`);
  rt1.killHard();
  await new Promise((r) => setTimeout(r, 1000));

  const dir = sessionDir(dirs.sessionRoot, dirs.wsDir, sid);
  console.log(`  会话目录：${dir}${existsSync(dir) ? '' : '  ← 不存在！'}`);

  // --- 第二次：同 id resume ---
  const rt2 = await bootReady('p2-b', dirs);
  if (!rt2) return;
  rt2.prompt(2, sid, '用一句话说明你刚才那件事做到哪一步了。');
  const ack2 = await rt2.waitResponse(2, 90_000);
  const ackErr = ack2?.error ? JSON.stringify(ack2.error).slice(0, 300) : '';
  console.log(`  resume 回执：${ack2 ? ackErr || JSON.stringify(ack2.result).slice(0, 140) : '(90s 内无回执)'}`);
  const end2 = await rt2.waitQuiet(1);
  const errs2 = rt2.responses.filter((r) => r.error).map((r) => JSON.stringify(r.error).slice(0, 240));
  if (errs2.length) console.log(`  ⚠ 第二次响应错误：${errs2.join(' | ')}`);
  console.log(`  第二次结束=${end2}，事件摘要=${JSON.stringify(summarize(rt2.events))}`);
  rt2.killHard();
  await new Promise((r) => setTimeout(r, 800));

  // --- 看盘上那份日志：有没有被补平 ---
  const logRead = readSessionLog(dirs.sessionRoot, dirs.wsDir, sid);
  const closers = logRead.events.filter((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'interrupted');
  const unknownTool = JSON.stringify(logRead.events).includes('TOOL_OUTCOME_UNKNOWN');
  console.log(
    `  盘上日志：${logRead.error || `${logRead.frames} 帧 → ${logRead.events.length} 条`} ` +
      JSON.stringify(summarize(logRead.events))
  );
  console.log(`  补平的 interrupted turn/end = ${closers.length}；含 TOOL_OUTCOME_UNKNOWN = ${unknownTool}`);

  const blob = ackErr + ' ' + errs2.join(' ');
  const corruption = /corrupt|torn|AggregateError/i.test(blob);
  const ok = !corruption && !!ack2 && !ack2.error && end2 !== 'timeout' && closers.length >= 1;
  record(
    ok,
    '前提 ②（硬杀后 resume 不报 corruption，且尾 turn 被补平）',
    ok
      ? `resume 成功，补平 ${closers.length} 个 interrupted turn/end${unknownTool ? '（含 TOOL_OUTCOME_UNKNOWN）' : ''}`
      : `corruption=${corruption} 回执错误=${ackErr || '无'} 补平数=${closers.length} 结束=${end2}`
  );
}

// ---------------------------------------------------------------- 前提 ③（可选）

async function premise3() {
  console.log('\n=== 前提 ③：优雅退出（stdin.end）比硬杀多落盘多少？（指示性对比，不判成败）===');
  const out = {};
  for (const mode of ['hard', 'graceful']) {
    const sid = `probe-c8::3-${mode}`;
    const dirs = makeScratch(`p3-${mode}`);
    const rt = await bootReady(`p3-${mode}`, dirs);
    if (!rt) return;
    rt.prompt(2, sid, LONG_PROMPT);
    await rt.waitEvent('tool/call', 90_000);
    await new Promise((r) => setTimeout(r, 2000));
    const wire = rt.events.length;
    if (mode === 'hard') {
      rt.killHard();
    } else {
      const clean = await rt.killGraceful(8000);
      console.log(`  优雅退出：${clean ? '按时 exit(0)' : '8s 内没退，已强杀'}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    const r = readSessionLog(dirs.sessionRoot, dirs.wsDir, sid);
    out[mode] = { wire, durable: r.events.length, err: r.error };
    console.log(`  ${mode}: 线上 ${wire} 条 → 盘上 ${r.events.length} 条${r.error ? `  读日志失败：${r.error}` : ''}`);
  }
  record(true, '前提 ③（指示性）', `硬杀落盘 ${out.hard.durable} 条 / 优雅落盘 ${out.graceful.durable} 条`);
}

// ---------------------------------------------------------------- 跑

console.log('='.repeat(72));
console.log('C8 前提探针 —— 三条设计前提的运行时复验');
console.log('='.repeat(72));

if (!apiKey) {
  const dirs = makeScratch('boot');
  const rt = await bootReady('boot', dirs);
  console.log('\n⚠ 没有 API key → 前提 ①②③ 全部**未验证**（不假装验过）。');
} else {
  if (wants(1)) await premise1();
  if (wants(2)) await premise2();
  if (wants(3) && values['kill-compare']) await premise3();
  else if (wants(3)) console.log('\n（跳过前提 ③ —— 加 --kill-compare 才跑）');
}

console.log('\n' + '='.repeat(72));
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✓ 全部前提成立' : `✗ ${failed.length} 条前提不成立`}`);

if (!values.keep) {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* 删不掉就留着 */
  }
} else {
  console.log(`临时区保留在：${scratch}`);
}
// 同 smoke-runtime.mjs：不用 process.exit()（Windows 上重定向的 stdout 是异步写，
// 退出会把还没冲出去的结论行丢掉）。设 exitCode，让事件循环自己收尾。
process.exitCode = failed.length === 0 ? 0 : 1;
