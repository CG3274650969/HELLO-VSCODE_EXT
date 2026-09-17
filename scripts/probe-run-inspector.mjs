#!/usr/bin/env node
/**
 * C9 运行检查器自检 —— `RunInspector` / `toolKeyFrom` / `toolResultFailed` 的边界，
 * **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 与 probe-turn-state.mjs 同一个道理：runInspector.ts 是有意做成零 `vscode` 依赖的纯模块，
 * 所以能在这里直接加载编译产物跑边界用例。本脚本是那条约束的守门人 —— 谁哪天在
 * runInspector.ts 里 `import * as vscode`（或 import 任何会拖进 vscode 的东西），这里当场加载失败。
 * `_onDshEvent` 本身 import vscode 加载不了，所以它的累积逻辑才被抽到这里来
 * （这正是 RunInspector 存在的理由）。
 *
 * 最后一节拿 `logs/dsh-frames/*.jsonl` 的**真帧**回放，并与一条**独立的**直算式 oracle 对拍 ——
 * 用另一条代码路径验证状态机，而不是硬编码一个数字。logs/ 是 gitignored，没有就跳过（会响亮地说）。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-run-inspector.mjs
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  RunInspector,
  MAX_RUNS,
  MAX_TOOL_ROWS,
  MAX_STEPS,
  MAX_ERRORS,
  toolKeyFrom,
  toolResultFailed,
} = await load('runInspector.js');

// ---------- 断言小工具 ----------

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

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}期望 ${e}，实得 ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || '断言不成立');
}

// ---------- 帧构造 ----------

/** 一帧最小信封。`opts.dshId` 换会话、`opts.seq` 无用（我们只读 time）。 */
const f = (type, data, t, opts = {}) => ({
  sessionId: opts.dshId === undefined ? 'dsh1' : opts.dshId,
  event: { type, seq: opts.seq ?? 0, time: t, data },
});

const UI = 'ui-1';

/** 造一次工具调用 + 结果的成对帧。 */
const callFrame = (callId, t, step = 1, name = 'bash', turn = 1) =>
  f('tool/call', { turn, step, callId, name, arguments: '{"command":"x"}' }, t);
const resultFrame = (callId, t, isError = false, step = 1, turn = 1) =>
  f(
    'tool/result',
    {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }],
      },
    },
    t
  );

/** 把一帧序列灌进去，返回 inspector。 */
function feed(frames, ui = UI) {
  const insp = new RunInspector();
  for (const fr of frames) insp.apply(fr, ui);
  return insp;
}

/** 深扫一个对象树里有没有 NaN / Infinity（耗时的硬底线：宁可缺省，也绝不给 NaN）。 */
function hasNonFinite(v) {
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(hasNonFinite);
  if (v && typeof v === 'object') return Object.values(v).some(hasNonFinite);
  return false;
}

// ---------- A. 计时 ----------
console.log('· 计时（全部来自帧信封的 time，本模块一次 Date.now() 都不调）');

check('工具耗时 = result.time − call.time', () => {
  const insp = feed([callFrame('c1', 1000), resultFrame('c1', 3610)]);
  const row = insp.details(UI)[0].tools[0];
  eq(row.durationMs, 2610, '耗时：');
  eq(row.startedAt, 1000);
  eq(row.endedAt, 3610);
  eq(row.state, 'ok');
});

check('步耗时 = step/end − step/start；没有工具的步也有耗时', () => {
  const insp = feed([
    f('turn/start', { turn: 1 }, 100),
    f('step/start', { turn: 1, step: 1 }, 200),
    f('step/end', { turn: 1, step: 1 }, 5429),
    f('step/start', { turn: 1, step: 2 }, 6000),
    f('step/end', { turn: 1, step: 2 }, 7433), // 无工具的纯模型步
    f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 8000),
  ]);
  const steps = insp.details(UI)[0].steps;
  eq(steps.map((s) => s.step), [1, 2]);
  eq(steps[0].durationMs, 5229, '步 1：');
  eq(steps[1].durationMs, 1433, '步 2（无工具）：');
  eq(insp.readout(UI).runs[0].stepCount, 2);
});

check('轮耗时 = turn/end − turn/start', () => {
  const insp = feed([
    f('turn/start', { turn: 1 }, 1788841049498),
    f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1788841060724),
  ]);
  eq(insp.details(UI)[0].durationMs, 11226);
});

// ---------- B. 帧过滤（载荷最重的一条：819 条 chunk 一次都不该入账） ----------
console.log('\n· 帧过滤（这是本功能全部的体积故事）');

check('5000 条 assistant/chunk：每次返回 false，且记录逐字节不变', () => {
  const insp = feed([
    f('turn/start', { turn: 1 }, 100),
    callFrame('c1', 200, 1),
    resultFrame('c1', 400, false, 1),
  ]);
  const before = JSON.stringify(insp.details(UI));
  for (let i = 0; i < 5000; i++) {
    const r = insp.apply(
      f('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' } }, 300 + i),
      UI
    );
    ok(r === false, `第 ${i} 条 chunk 竟然返回了 true`);
  }
  eq(JSON.stringify(insp.details(UI)), before, '记录被 chunk 改动了：');
});

check('其余噪声帧一律不入账（含 usage 的 assistant/message）', () => {
  const insp = feed([f('turn/start', { turn: 1 }, 100), callFrame('c1', 200)]);
  const before = JSON.stringify(insp.details(UI));
  const noise = [
    ['assistant/message', { turn: 1, step: 1, usage: { inputTokens: 1 } }],
    ['assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: {} } }],
    ['request/context', { provider: 'deepseek', model: 'm', contextWindow: 1000 }],
    ['request/header', { turn: 1 }],
    ['user/message', { turn: 1, text: 'hi' }],
    ['session/title', { title: 'x' }],
    ['agent/inbox/spliced', { target: 'next-turn', inserted: [] }],
    ['tool-call-delta', { turn: 1, step: 1, delta: 'x' }],
    ['reasoning-delta', { turn: 1, step: 1, delta: 'x' }],
    ['subagent/start', { id: 's' }],
  ];
  for (const [type, data] of noise) {
    const r = insp.apply(f(type, data, 300), UI);
    ok(r === false, `${type} 竟然返回了 true`);
  }
  eq(JSON.stringify(insp.details(UI)), before, '记录被噪声帧改动了：');
});

// ---------- C. 配对（载荷最重） ----------
console.log('\n· 工具 call/result 配对');

check('★ 两个 callId 的结果逆序到达 → 各回各家（配对第 ① 步的意义）', () => {
  const insp = feed([
    f('turn/start', { turn: 1 }, 0),
    callFrame('c1', 1000, 1),
    callFrame('c2', 1100, 2),
    resultFrame('c2', 1200, false, 2), // 先到的是后一次调用的结果
    resultFrame('c1', 9000, false, 1),
  ]);
  const [t1, t2] = insp.details(UI)[0].tools;
  eq([t1.key, t1.durationMs], ['c:c1', 8000], '工具 1：');
  eq([t2.key, t2.durationMs], ['c:c2', 100], '工具 2：');
  eq([t1.state, t2.state], ['ok', 'ok']);
  eq(insp.details(UI)[0].unmatched, 0);
});

check('两边都没有 callId → 都退 ts:<turn>:<step> 仍能配上', () => {
  const insp = feed([
    f('turn/start', { turn: 3 }, 0),
    f('tool/call', { turn: 3, step: 1, name: 'read', arguments: '{}' }, 500),
    f('tool/result', { turn: 3, step: 1, message: { content: [{ type: 'tool-result', content: [] }] } }, 700),
  ]);
  const run = insp.details(UI)[0];
  eq(run.tools[0].key, 'ts:3:1');
  eq(run.tools[0].durationMs, 200);
  eq(run.unmatched, 0);
});

check('孤零零的 tool/result → unmatched++，不建行、不报错', () => {
  const insp = feed([f('turn/start', { turn: 1 }, 0), resultFrame('ghost', 500)]);
  const run = insp.details(UI)[0];
  eq(run.unmatched, 1);
  eq(run.tools.length, 0);
  eq(run.errors.length, 0, '不该上浮成错误：');
});

check('★ call 有、result 没有 → unknown，且不折成 error', () => {
  const insp = feed([
    f('turn/start', { turn: 1 }, 0),
    callFrame('c1', 1000, 1),
    f('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 5000),
  ]);
  insp.endRun('interrupted', UI);
  const row = insp.details(UI)[0].tools[0];
  eq(row.state, 'unknown', '结果未知 ≠ 失败：');
  eq(row.durationMs, undefined, '没有终点就不给耗时：');
  eq(insp.readout(UI).runs[0].toolErrors, 0, '不能算作失败：');
  eq(insp.readout(UI).runs[0].toolUnknown, 1);
});

check('★★ 150 次调用 → 留 100 行，被丢掉的 result 绝不许错关留存的行', () => {
  const frames = [f('turn/start', { turn: 1 }, 0)];
  for (let i = 1; i <= 150; i++) frames.push(callFrame(`c${i}`, 1000 + i, 1));
  for (let i = 1; i <= 150; i++) frames.push(resultFrame(`c${i}`, 5000 + i, false, 1));
  const insp = feed(frames);
  const run = insp.details(UI)[0];
  eq(run.tools.length, MAX_TOOL_ROWS, '留存行数：');
  eq(run.toolsDropped, 50, '丢掉的次数：');
  eq(run.unmatched, 50, '被丢掉的 50 条结果应当落进 unmatched：');
  // 留存的 100 行必须各自配到自己那条 —— 键逐一对上，耗时全是 5000+i-(1000+i)=4000
  for (let i = 0; i < MAX_TOOL_ROWS; i++) {
    eq(run.tools[i].key, `c:c${i + 1}`, `第 ${i + 1} 行键：`);
    eq(run.tools[i].durationMs, 4000, `第 ${i + 1} 行耗时：`);
    eq(run.tools[i].state, 'ok', `第 ${i + 1} 行状态：`);
  }
  eq(insp.readout(UI).runs[0].toolCount, 150, '计数要继续涨：');
  eq(insp.readout(UI).runs[0].truncated, true);
});

check('toolKeyFrom / toolResultFailed 与 provider 的判据同源', () => {
  eq(toolKeyFrom({ callId: 'a' }), 'c:a');
  eq(toolKeyFrom({ message: { content: [{ type: 'tool-result', toolCallId: 'b' }] } }), 'c:b');
  eq(toolKeyFrom({ turn: 2, step: 3 }), 'ts:2:3');
  eq(toolKeyFrom({}), 'ts::');
  eq(toolKeyFrom(undefined), 'ts::');
  eq(toolResultFailed({ error: { name: 'x' } }), true, '结构性 error：');
  eq(toolResultFailed({ message: { content: [{ type: 'tool-result', isError: true }] } }), true, 'isError：');
  eq(toolResultFailed({ message: { content: [{ type: 'tool-result', isError: false }] } }), false);
  eq(toolResultFailed({ message: { content: [{ type: 'text' }] } }), false, '非 tool-result 块不算：');
  eq(toolResultFailed({}), false);
  eq(toolResultFailed(undefined), false);
});

// ---------- D. 终态 ----------
console.log('\n· 本轮终态（优先级表逐行）');

check('turn/end 的 kind → 终态映射，reasonKind 原样留档', () => {
  const cases = [
    ['completed', 'completed'],
    ['aborted', 'aborted'],
    ['interrupted', 'interrupted'],
    ['weird-error', 'error'],
  ];
  for (const [kind, want] of cases) {
    const insp = feed([
      f('turn/start', { turn: 1 }, 0),
      f('turn/end', { turn: 1, reason: { kind } }, 100),
    ]);
    const run = insp.details(UI)[0];
    eq(run.outcome, want, `kind=${kind}：`);
    eq(run.reasonKind, kind, `kind=${kind} 的原值：`);
  }
});

check('★ 优先级：wire 的中止/完成不会被后来的收尾洗掉', () => {
  // wire aborted + idle 还是来了（endRun('done')）→ 保留 aborted
  const a = feed([f('turn/start', { turn: 1 }, 0), f('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 9)]);
  a.endRun('done', UI);
  eq(a.details(UI)[0].outcome, 'aborted', '线上确实被中止过：');

  // wire completed + 用户在 idle 到达之前按了停止 → interrupted（与转写里那个气泡同一口径，
  // 见 OUTCOME_RANK 的注释：一边说「已完成」一边画成被打断才是没法解释）
  const b = feed([
    f('turn/start', { turn: 1 }, 0),
    f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9),
  ]);
  b.endRun('interrupted', UI);
  eq(b.details(UI)[0].outcome, 'interrupted', '停止优先于线上的 completed：');
  eq(b.details(UI)[0].reasonKind, 'completed', '但线上的原值留着，好排查：');

  // 反过来：真的跑完了、idle 也来了 → endRun('done') 不许把它洗掉（它本来就相等）
  const b2 = feed([
    f('turn/start', { turn: 1 }, 0),
    f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9),
  ]);
  eq(b2.endRun('done', UI), false, '终态没变就不该有变更：');
  eq(b2.details(UI)[0].outcome, 'completed');

  // error 永远赢，且带上原文
  const c = feed([
    f('turn/start', { turn: 1 }, 0),
    f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9),
  ]);
  c.endRun('error', UI, 'DSH 子进程意外退出（code=1）');
  eq(c.details(UI)[0].outcome, 'error');
  eq(c.details(UI)[0].errors.map((e) => e.message), ['DSH 子进程意外退出（code=1）']);

  // 没有 turn/end（被杀）→ running 落成 interrupted
  const d = feed([f('turn/start', { turn: 1 }, 0)]);
  d.endRun('interrupted', UI);
  eq(d.details(UI)[0].outcome, 'interrupted');
});

check('★ 收尾后没有 turn/end 时，用最后一帧的 time 当终点（仍不调 Date.now()）', () => {
  const insp = feed([f('turn/start', { turn: 1 }, 1000), callFrame('c1', 1500, 1)]);
  insp.endRun('interrupted', UI);
  const run = insp.details(UI)[0];
  eq(run.endedAt, 1500, '最后一帧的时间：');
  eq(run.durationMs, 500);
});

check('endRun 幂等：重复调用返回 false 且记录不变', () => {
  const insp = feed([f('turn/start', { turn: 1 }, 0)]);
  eq(insp.endRun('interrupted', UI), true);
  const after = JSON.stringify(insp.details(UI));
  eq(insp.endRun('interrupted', UI), false);
  eq(JSON.stringify(insp.details(UI)), after, '重复收尾改动了记录：');
});

check('★ 一轮都没开始就出错 → 补一条记录；正常收尾则什么都不建', () => {
  // spawn 失败 / prompt RPC 失败：一帧都没来过，却正是最需要看到的那次失败
  const bad = new RunInspector();
  eq(bad.endRun('error', UI, 'DSH 未就绪：找不到运行时入口'), true);
  const runs = bad.details(UI);
  eq(runs.length, 1);
  eq(runs[0].outcome, 'error');
  eq(runs[0].turn, 0);
  eq(runs[0].errors.map((e) => e.message), ['DSH 未就绪：找不到运行时入口']);
  eq(bad.endRun('error', UI, 'DSH 未就绪：找不到运行时入口'), false, '重复上浮同一个错误：');
  eq(bad.details(UI).length, 1, '不许凭空空开第二条：');

  // 没有开着的轮、又是正常收尾（_runLive 的 finally 兜底会走到）→ 当作没事发生
  const quiet = new RunInspector();
  eq(quiet.endRun('done', UI), false);
  eq(quiet.endRun('interrupted', UI), false);
  eq(quiet.details(UI).length, 0);
});

// ---------- E. 有界 / 过滤 / 垃圾 ----------
console.log('\n· 有界、按会话过滤、垃圾输入');

check(`环：${MAX_RUNS} 轮上限，最新在前，最老的从尾部淘汰`, () => {
  const insp = new RunInspector();
  for (let turn = 1; turn <= 25; turn++) {
    insp.apply(f('turn/start', { turn }, turn * 100), UI);
    insp.apply(f('turn/end', { turn, reason: { kind: 'completed' } }, turn * 100 + 50), UI);
    insp.endRun('done', UI);
  }
  const runs = insp.readout(UI).runs;
  eq(runs.length, MAX_RUNS);
  eq(runs[0].turn, 25, '最新在前：');
  eq(runs[MAX_RUNS - 1].turn, 6, '最老的是第 6 轮：');
});

check('环淘汰不扰乱「开着的那一轮」的身份', () => {
  const insp = new RunInspector();
  for (let turn = 1; turn <= MAX_RUNS; turn++) {
    insp.apply(f('turn/start', { turn }, turn * 10), UI);
    insp.apply(f('turn/end', { turn, reason: { kind: 'completed' } }, turn * 10 + 5), UI);
    insp.endRun('done', UI);
  }
  // 第 21 轮只开不收 —— 它会挤掉最老的一条，但自己必须还是 endRun 关的那一条
  insp.apply(f('turn/start', { turn: 21 }, 100000), UI);
  insp.endRun('done', UI);
  const runs = insp.readout(UI).runs;
  eq(runs.length, MAX_RUNS);
  eq(runs[0].turn, 21);
  eq(runs[0].outcome, 'completed');
  eq(runs[MAX_RUNS - 1].turn, 2, '第 1 轮被挤掉了：');
});

check(`步上限 ${MAX_STEPS}：超出的只计数不建行`, () => {
  const frames = [f('turn/start', { turn: 1 }, 0)];
  for (let i = 1; i <= 150; i++) {
    frames.push(f('step/start', { turn: 1, step: i }, i * 10));
    frames.push(f('step/end', { turn: 1, step: i }, i * 10 + 5));
  }
  const run = feed(frames).details(UI)[0];
  eq(run.steps.length, MAX_STEPS);
  eq(run.stepsDropped, 50);
  const summary = feed(frames).readout(UI).runs[0];
  eq(summary.stepCount, 150, '计数继续涨：');
  eq(summary.truncated, true);
});

check('按 UI 会话过滤：别人的轮次看不见，没跑过的是空数组不是 undefined', () => {
  const insp = feed([f('turn/start', { turn: 1 }, 0), f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9)], 'ui-a');
  eq(insp.readout('ui-b').runs, [], '别的会话：');
  eq(insp.readout('never-opened').runs, []);
  eq(insp.details('ui-b'), []);
  eq(insp.details('ui-a').length, 1);
});

check('★ 同一个 DSH 会话、同一个 turn 号，换了 UI 会话就是两条（键含 uiSessionId）', () => {
  // DSH 身份丢失后新会话的轮号会从 1 重数 —— 两路键会把它们折成一条
  const insp = new RunInspector();
  insp.apply(f('turn/start', { turn: 1 }, 0), 'ui-a');
  insp.apply(f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9), 'ui-a');
  insp.apply(f('turn/start', { turn: 1 }, 100), 'ui-b');
  insp.apply(f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 109), 'ui-b');
  eq(insp.details('ui-a').length, 1);
  eq(insp.details('ui-b').length, 1);
  eq(insp.readout('ui-a').runs[0].id !== insp.readout('ui-b').runs[0].id, true, '两条不同记录：');
});

check('★ 换 DSH 会话后 turn 号重数 → 两路之外的第三路键把它分开', () => {
  const insp = new RunInspector();
  insp.apply(f('turn/start', { turn: 1 }, 0, { dshId: 'dsh-old' }), UI);
  insp.apply(f('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9, { dshId: 'dsh-old' }), UI);
  insp.apply(f('turn/start', { turn: 1 }, 100, { dshId: 'dsh-new' }), UI);
  const runs = insp.details(UI);
  eq(runs.length, 2, '不许折成一条：');
  eq(runs[0].dshSessionId, 'dsh-new');
  eq(runs[1].dshSessionId, 'dsh-old');
});

check('垃圾输入不抛、不改状态', () => {
  const insp = new RunInspector();
  const junk = [
    null,
    undefined,
    {},
    { event: {} },
    { event: { type: 123 } },
    { event: { type: '' } },
    { event: { type: 'tool/call', data: null } },
    { event: { type: 'tool/call', data: {} } },
    { event: { type: 'turn/start', data: { turn: 'x' } } },
    { event: { type: 'tool/result', data: { message: 'not-an-object' } } },
    { event: { type: 'step/end', data: { step: null } } },
  ];
  for (const j of junk) insp.apply(j, UI);
  const runs = insp.details(UI);
  ok(runs.length > 0, '至少该留下那些 data 可宽化的轮');
  ok(!hasNonFinite(runs), '垃圾输入产出了 NaN / Infinity');
  // 名字有兜底，耗时为缺省而非 0 或 NaN
  for (const r of runs) {
    for (const t of r.tools) {
      ok(typeof t.name === 'string' && t.name.length > 0, '工具名兜底失效');
      ok(t.durationMs === undefined || Number.isFinite(t.durationMs), '耗时不是有限数');
    }
  }
});

check('★ 缺 time / 时间倒流 → 耗时缺省，绝不出现负数或 NaN', () => {
  const insp = feed([
    f('turn/start', { turn: 1 }, undefined),
    f('tool/call', { turn: 1, step: 1, callId: 'a', name: 'x' }, undefined), // 没有起点
    f('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'a' }] } }, 500),
    callFrame('b', 9000, 2),
    resultFrame('b', 100, false, 2), // 时间倒流
  ]);
  const run = insp.details(UI)[0];
  eq(run.startedAt, undefined);
  eq(run.tools[0].durationMs, undefined, '只有终点：');
  eq(run.tools[1].durationMs, undefined, '终点早于起点：');
  eq(run.tools.every((t) => t.durationMs === undefined || t.durationMs >= 0), true);
  ok(!hasNonFinite(run), '出现了 NaN / Infinity');
});

check('reset() 整片清掉', () => {
  const insp = feed([f('turn/start', { turn: 1 }, 0), callFrame('c1', 10)]);
  eq(insp.details(UI).length, 1);
  insp.reset();
  eq(insp.details(UI).length, 0);
  eq(insp.readout(UI).runs, []);
  // 清完之后能重新开始，且不会把老的那条 endRun 回来
  insp.apply(f('turn/start', { turn: 1 }, 100), UI);
  insp.endRun('done', UI);
  eq(insp.details(UI).length, 1);
});

// ---------- F. 真帧回放（与独立 oracle 对拍） ----------
console.log('\n· 真帧回放（与另一条代码路径对拍，不是硬编码数字）');

const framesDir = join(repoRoot, 'logs', 'dsh-frames');

check('★ 最新一份抓帧：RunInspector 与直算式 oracle 全等', () => {
  if (!existsSync(framesDir)) {
    console.log('    ⚠ 跳过：没有抓帧（logs/ 是 gitignored），别把这次通过当成验过了');
    return 'skipped';
  }
  const files = readdirSync(framesDir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => ({ n, m: statSync(join(framesDir, n)).mtimeMs }))
    .sort((a, b) => a.m - b.m);
  if (files.length === 0) {
    console.log('    ⚠ 跳过：抓帧目录是空的');
    return 'skipped';
  }
  const file = join(framesDir, files[files.length - 1].n);

  // 抓帧文件是 JSON-RPC 外层包装：首行是握手响应（没有 params.event），
  // 会话 id 在 params.sessionId、帧在 params.event。
  const raw = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o && o.params;
    if (!p || !p.event || typeof p.event.type !== 'string') continue;
    raw.push({ dshId: p.sessionId, ev: p.event });
  }
  ok(raw.length > 0, '抓帧里一帧都没解析出来（格式变了？）');

  // 灌进被测模块
  const insp = new RunInspector();
  for (const { dshId, ev } of raw) {
    insp.apply({ sessionId: dshId, event: ev }, UI);
  }
  const mine = insp.details(UI);

  // ---- oracle：完全独立地直接从原始 JSON 重算 ----
  // 只认这六种帧 —— 这是**规格**（哪些帧算数），不是抄实现；时间与计数的推导仍然是独立的一条路。
  // 少了这道过滤，`session/title` 这类没有 turn 的帧会被当成 turn 0 而凭空多出一轮。
  const RECORDED = new Set(['turn/start', 'step/start', 'step/end', 'tool/call', 'tool/result', 'turn/end']);
  const byTurn = new Map(); // `${dshId}#${turn}` → { start, end, calls: Map(callId→t), res: Map(callId→t), steps: Map(step→{s,e}) }
  const key = (dshId, turn) => `${dshId}#${turn}`;
  const slot = (dshId, turn) => {
    const k = key(dshId, turn);
    if (!byTurn.has(k)) byTurn.set(k, { calls: new Map(), res: new Map(), steps: new Map() });
    return byTurn.get(k);
  };
  for (const { dshId, ev } of raw) {
    if (!RECORDED.has(ev.type)) continue;
    const d = ev.data ?? {};
    const turn = typeof d.turn === 'number' ? d.turn : 0;
    const s = slot(dshId, turn);
    const t = typeof ev.time === 'number' ? ev.time : undefined;
    // ⚠️ 每条分支都带大括号。省略过一版 `else if (T) if (C) …` —— 那是个 dangling-else：
    // 后面的 tool/result 与 step/* 全被挂到了内层 if 上，于是 oracle 悄悄只剩 turn/call 两路，
    // 表现为「对拍失败、而实现是对的」。对拍脚本自己也要写对。
    if (ev.type === 'turn/start') {
      s.start = s.start === undefined ? t : Math.min(s.start, t);
    } else if (ev.type === 'turn/end') {
      s.end = s.end === undefined ? t : Math.max(s.end, t);
    } else if (ev.type === 'tool/call') {
      if (typeof d.callId === 'string') s.calls.set(d.callId, t);
    } else if (ev.type === 'tool/result') {
      // 独立取 callId：不调 toolKeyFrom，直接按抓帧里实测的形状读
      const cid =
        d.message && Array.isArray(d.message.content) && d.message.content[0]
          ? d.message.content[0].toolCallId
          : undefined;
      if (typeof cid === 'string') s.res.set(cid, t);
    } else if (ev.type === 'step/start' || ev.type === 'step/end') {
      const n = typeof d.step === 'number' ? d.step : 0;
      const cur = s.steps.get(n) ?? {};
      if (ev.type === 'step/start') cur.s = cur.s === undefined ? t : Math.min(cur.s, t);
      else cur.e = cur.e === undefined ? t : Math.max(cur.e, t);
      s.steps.set(n, cur);
    }
  }

  // 比：轮数
  eq(mine.length, byTurn.size, `轮数（${file.split(/[\\/]/).pop()}）：`);
  ok(mine.length > 0, '抓帧里没有完整的轮');

  // 比：每轮的耗时、工具序列、步
  let totalTools = 0;
  for (const run of mine) {
    const o = byTurn.get(key(run.dshSessionId, run.turn));
    ok(o !== undefined, `oracle 里没有这一轮 ${run.dshSessionId}#${run.turn}`);
    eq(run.durationMs, o.end - o.start, `第 ${run.turn} 轮耗时：`);
    eq(run.tools.length, o.calls.size, `第 ${run.turn} 轮工具数：`);
    eq(run.unmatched, 0, `第 ${run.turn} 轮有配不上的结果：`);
    totalTools += run.tools.length;
    // 工具序列与逐条耗时：按 callId 一一对上
    for (const row of run.tools) {
      const cid = row.key.startsWith('c:') ? row.key.slice(2) : undefined;
      ok(cid !== undefined && o.calls.has(cid), `工具键不是 callId：${row.key}`);
      const want = o.res.get(cid);
      if (want !== undefined) {
        eq(row.durationMs, want - o.calls.get(cid), `工具 ${cid} 耗时：`);
        ok(row.state === 'ok' || row.state === 'error', `工具 ${cid} 状态没收尾：${row.state}`);
      } else {
        eq(row.state, 'unknown', `工具 ${cid} 没有结果，应当是 unknown：`);
      }
    }
    // 步：逐号比对（oracle 只记有 step/start 或 step/end 的号）
    const wantSteps = [...o.steps.keys()].sort((a, b) => a - b);
    eq(run.steps.map((s) => s.step).sort((a, b) => a - b), wantSteps, `第 ${run.turn} 轮的步号：`);
    for (const st of run.steps) {
      const o2 = o.steps.get(st.step);
      if (o2.s !== undefined && o2.e !== undefined) {
        eq(st.durationMs, o2.e - o2.s, `步 ${st.step} 耗时：`);
      }
    }
  }
  console.log(
    `    对拍通过：${mine.length} 轮 / ${totalTools} 次工具 / ` +
      `轮耗时 ${mine.map((r) => r.durationMs ?? '—').join(', ')} ms（真帧 ${file.split(/[\\/]/).pop()}）`
  );
  return true;
});

// ---------- 收尾 ----------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f2 of failures) console.log(`   · ${f2}`);
}
console.log(`✓ 全部通过：${passed}/${passed}`);
// ⚠️ 不用 process.exit()：Windows 上被管道/文件重定向的 stdout 是**异步**写，退出会把还没
// 冲出去的结论行整段丢掉（C8 的 smoke-runtime 就是这么被抓到的：exit=0 却只有第一行）。
process.exitCode = failures.length ? 1 : 0;
