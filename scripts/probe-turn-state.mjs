#!/usr/bin/env node
/**
 * C8 轮次状态自检 —— `needsContinue` / `readLastTurn` / `TurnStatus` 的边界，
 * **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 与 probe-session-tools.mjs 同一个道理：turnState.ts 是有意做成零 `vscode` 依赖的纯模块，
 * 所以能在这里直接加载编译产物跑边界用例。本脚本是那条约束的守门人 —— 谁哪天在
 * turnState.ts 里 `import * as vscode`，这里当场加载失败。`_onDshStatus` 本身 import vscode
 * 加载不了，所以它的判断逻辑才被抽到这里来（这正是 TurnStatus 存在的理由）。
 *
 *   npm run compile && node scripts/probe-turn-state.mjs
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

const { needsContinue, readLastTurn, TurnStatus } = await load('turnState.js');
const { SessionStore } = await load('sessionStore.js');

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

/** 造一条最小会话（只关心 lastTurn；messages 不参与判定）。 */
const sess = (lastTurn) => ({
  id: 's1',
  title: 't',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  ...(lastTurn === undefined ? {} : { lastTurn }),
});

// ---------- 字段读取 ----------
console.log('· lastTurn 读取');

check('readLastTurn：两个合法值原样返回', () => {
  eq(readLastTurn({ lastTurn: 'interrupted' }), 'interrupted');
  eq(readLastTurn({ lastTurn: 'error' }), 'error');
});

check('readLastTurn：缺省 / 垃圾值一律 undefined', () => {
  eq(readLastTurn({}), undefined);
  eq(readLastTurn({ lastTurn: undefined }), undefined);
  eq(readLastTurn({ lastTurn: null }), undefined);
  eq(readLastTurn({ lastTurn: '' }), undefined);
  eq(readLastTurn({ lastTurn: 'completed' }), undefined, '正常跑完不是终态：');
  eq(readLastTurn({ lastTurn: 'running' }), undefined);
  eq(readLastTurn({ lastTurn: 1 }), undefined);
  eq(readLastTurn({ lastTurn: {} }), undefined);
  eq(readLastTurn({ lastTurn: ['interrupted'] }), undefined);
});

// ---------- 按钮判据 ----------
console.log('\n· needsContinue（「继续」按钮的唯一判据）');

check('无异常终态 → 不显示', () => {
  eq(needsContinue(sess(undefined)), false);
  eq(needsContinue(sess('completed')), false, '垃圾值：');
});

check('interrupted / error → 显示', () => {
  eq(needsContinue(sess('interrupted')), true);
  eq(needsContinue(sess('error')), true);
});

check('判据只看 lastTurn，不看消息形状', () => {
  // 反例就是为这个存在的：agent 只跑工具、一句话没说就正常收尾，末尾是张状态正常的工具卡；
  // 或者最后一张工具卡合理失败（命令非零退出）而这一轮正常跑完 —— 两种都不该出现「继续」。
  const onlyTools = {
    ...sess(undefined),
    messages: [
      { role: 'user', text: 'go' },
      { role: 'tool', name: 'bash', toolState: 'success', toolInput: 'x' },
    ],
  };
  eq(needsContinue(onlyTools), false, '只跑工具的正常轮：');
  const failedTool = {
    ...sess(undefined),
    messages: [
      { role: 'user', text: 'go' },
      { role: 'tool', name: 'bash', toolState: 'error', toolInput: 'x' },
    ],
  };
  eq(needsContinue(failedTool), false, '工具卡合理失败的正常轮：');
  // 反过来：lastTurn 有值时不看消息 —— 哪怕末条消息看起来好端端的
  const interrupted = {
    ...sess('interrupted'),
    messages: [{ role: 'assistant', text: '好', status: 'complete' }],
  };
  eq(needsContinue(interrupted), true, 'lastTurn 优先于消息形状：');
});

// ---------- 线上状态跟踪 ----------
console.log('\n· TurnStatus（只用来放宽判断，绝不用来认定完成）');

check('初始：未认领、不认为在跑', () => {
  const t = new TurnStatus();
  eq(t.id, undefined);
  eq(t.running, false);
});

check('首条通知认领会话 id 并置状态', () => {
  const t = new TurnStatus();
  eq(t.apply({ sessionId: 'a', status: 'running' }), true, '翻转：');
  eq(t.id, 'a');
  eq(t.running, true);
});

check('重复通知幂等（返回 false，别让调用方重复收尾）', () => {
  const t = new TurnStatus();
  t.apply({ sessionId: 'a', status: 'running' });
  eq(t.apply({ sessionId: 'a', status: 'running' }), false);
  eq(t.running, true);
  eq(t.apply({ sessionId: 'a', status: 'idle' }), true, 'running→idle 算翻转：');
  eq(t.running, false);
  eq(t.apply({ sessionId: 'a', status: 'idle' }), false, '重复 idle：');
});

check('别的会话的通知一律忽略', () => {
  const t = new TurnStatus();
  t.apply({ sessionId: 'a', status: 'running' });
  eq(t.apply({ sessionId: 'b', status: 'idle' }), false);
  eq(t.running, true, 'a 仍在跑：');
  eq(t.id, 'a');
  // 反过来也一样：认领了 idle 之后，别的会话的 running 不能把它叫醒
  const t2 = new TurnStatus();
  t2.apply({ sessionId: 'a', status: 'idle' });
  eq(t2.apply({ sessionId: 'b', status: 'running' }), false);
  eq(t2.running, false);
});

check('形状不对的通知忽略（不改状态、也不认领 id）', () => {
  const t = new TurnStatus();
  eq(t.apply({ sessionId: 'a', status: 'weird' }), false);
  eq(t.apply({ sessionId: 42, status: 'running' }), false);
  eq(t.apply(undefined), false);
  eq(t.apply(null), false);
  eq(t.id, undefined, '不该被垃圾通知认领：');
  eq(t.running, false);
});

check('reset(id) 换会话：认领新 id 但状态归零', () => {
  const t = new TurnStatus();
  t.apply({ sessionId: 'a', status: 'running' });
  t.reset('b');
  eq(t.id, 'b');
  eq(t.running, false, '上一个会话的 running 不能继承（否则 _sendUser 会把用户挡在门外）：');
});

check('reset() 无线参：彻底忘记', () => {
  const t = new TurnStatus();
  t.apply({ sessionId: 'a', status: 'running' });
  t.reset();
  eq(t.id, undefined);
  eq(t.running, false);
  // 忘记之后能重新认领
  eq(t.apply({ sessionId: 'z', status: 'running' }), true);
  eq(t.id, 'z');
});

check('「已知 idle」不是完成信号：认领过 idle 后仍能被 running 翻转', () => {
  // 这一条守的是文档里那句话 —— session.status 只在翻转时发、漏收不可补拉，
  // 所以它只能放宽判断。真完成信号是 idle 通知本身或子进程退出，不是这个字段的值。
  const t = new TurnStatus();
  t.apply({ sessionId: 'a', status: 'idle' });
  eq(t.running, false);
  eq(t.apply({ sessionId: 'a', status: 'running' }), true, '还能再翻成 running：');
  eq(t.running, true);
});

// ---------- 与落盘打通 ----------
console.log('\n· 落盘往返（按钮要能活过窗口重载 / 重启）');

const dir = mkdtempSync(join(tmpdir(), 'probe-turn-state-'));
try {
  const FILE = 'probe-sessions.json';
  const store = new SessionStore(dir, FILE);
  const s = store.create();
  s.messages.push({ role: 'user', text: 'go' });
  store.add(s);
  store.persist();
  eq(needsContinue(store.active()[0]), false, '正常轮落盘后不该有按钮：');

  // 模拟 _finishTurn('interrupted') 之后的样子
  store.active()[0].lastTurn = 'interrupted';
  store.persist();

  const reopened = new SessionStore(dir, FILE);
  eq(needsContinue(reopened.active()[0]), true, '重开之后按钮还在：');
  eq(readLastTurn(reopened.active()[0]), 'interrupted');

  // 模拟 _sendUser 清字段（persist 走 JSON.stringify，undefined 值不落盘 → 等于删掉）
  reopened.active()[0].lastTurn = undefined;
  reopened.persist();
  const again = new SessionStore(dir, FILE);
  eq(needsContinue(again.active()[0]), false, '发了新消息 → 按钮消失：');

  // 坏值：写进文件的垃圾在加载时被丢掉
  writeFileSync(
    join(dir, FILE),
    JSON.stringify([
      { id: 'x', title: 'x', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', text: 'q' }], lastTurn: 'yes' },
      { id: 'y', title: 'y', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', text: 'q' }], lastTurn: 'error' },
    ])
  );
  const dirty = new SessionStore(dir, FILE);
  eq(readLastTurn(dirty.active()[0]), undefined, '垃圾值当没有：');
  eq(readLastTurn(dirty.active()[1]), 'error', '合法值保留：');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 收尾 ----------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部通过：${passed}/${passed}`);
