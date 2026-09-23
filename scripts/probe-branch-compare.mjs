#!/usr/bin/env node
/**
 * C15「分支对照视图」的判据自检 —— **不需要 VS Code、不需要 API key、不发任何模型调用、碰不到盘**。
 *
 * 守的是那条验收：「并排渲染两条分支转写；明确标注共享记忆的串话风险」。
 *
 * 判据全在 `src/branchCompare.ts` 那个纯模块里（零 vscode 依赖 —— C10b 的教训：判据必须能在
 * 扩展宿主之外加载，否则只能靠肉眼）。A–F 组喂的都是**内存里造出来的会话**，不建夹具文件。
 *
 * 三件「照直觉写就会错」的事，每组都有反控钉着：
 *
 *   1. **共同前缀为 0 不能说成「分叉点在第 1 条」**（A 组）：那读起来像一次正常的分支，
 *      实际是「这两条根本不是同一次分支的结果」。
 *   2. **串话判据不能只看盘**（D 组）：补丁不可用时 `_ensureDshSession` 从不写盘，两侧盘上都没有
 *      身份却是**真串话** —— 只看盘会静默漏报，正是本项要防的那件事。
 *   3. **同 id 不同 cwd 不该警示**（D 组）：DSH 的会话日志按 cwd 归属，它俩不会落到同一份记忆。
 *
 *   ./dist-runtime/node/node.exe scripts/probe-branch-compare.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  crossTalkLine,
  crossTalkOf,
  crossTalkTitle,
  divergenceLine,
  divergenceOf,
  divergenceTitle,
  FORK_SUFFIX,
  frozenTail,
  pickCounterpart,
  sharedPrefixNote,
} = await load('branchCompare.js');

// ---------- 断言小工具（体例同 probe-change-forecast） ----------

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

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${what}\n    期望 ${e}，实到 ${a}`);
}

// ---------- 造会话的小工具 ----------

/** n 条消息，id 形如 `S#1`…（**照抄运行时**：id 里嵌着产生它的会话 uuid） */
function mkMsgs(sid, n, start = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${sid}#${start + i}`,
      role: i % 2 ? 'assistant' : 'user',
      text: `m${start + i}`,
      status: 'done',
    });
  }
  return out;
}

function mkSession(id, title, messages, extra = {}) {
  return { id, title, createdAt: 1, updatedAt: 1, messages, ...extra };
}

/** fork 的真语义：深拷贝（消息 id 逐字带过来）—— `_forkSession` 就是这么干的 */
const clone = (msgs) => JSON.parse(JSON.stringify(msgs));

// ---------- A · 分叉点（共同前缀） ----------

check('A 分支是深拷贝 ⇒ 共同前缀 = 源当时的长度，此后一正一零', () => {
  const src = mkSession('S', '源', mkMsgs('S', 4));
  const forkMsgs = clone(src.messages).concat(mkMsgs('F', 2, 5));
  const fork = mkSession('F', '源（分支）', forkMsgs);

  // ⚠️ 先自证造出来的数据真是「逐字同 id」——否则这条测试测的不是分叉点
  eq(src.messages.map((m) => m.id), ['S#1', 'S#2', 'S#3', 'S#4'], '源 id 形状不对，本条无效');
  eq(forkMsgs.slice(0, 4).map((m) => m.id), src.messages.map((m) => m.id), '副本不是逐字同 id，本条无效');

  const d = divergenceOf(src, fork);
  eq(d.kind, 'fork', '应认成分支');
  eq(d.shared, 4, '共同前缀应等于源当时的长度');
  eq(d.aAfter, 0, '源此后没有新消息');
  eq(d.bAfter, 2, '分支此后 2 条');
  eq(d.drifted, 0, '刚拷完，不该有偏移');
});

check('A 源在分叉后又长了 ⇒ 分叉点**不漂**（前缀不受对侧变长影响）', () => {
  const fork = mkSession('F', 'b', clone(mkMsgs('S', 3)).concat(mkMsgs('F', 1, 4)));
  const src = mkSession('S', 'a', mkMsgs('S', 3).concat(mkMsgs('S', 3, 4)));
  eq(src.messages.length, 6, '源应长到 6 条，本条才有效');
  const d = divergenceOf(src, fork);
  eq(d.shared, 3, '源长到 6 条，共同前缀仍是 3');
  eq(d.aAfter, 3, '源此后 3 条');
  eq(d.bAfter, 1, '分支此后 1 条');
});

check('A 两条**无关**会话 ⇒ 0 条 + kind:none（**反控**：不是「分叉点在第 1 条」）', () => {
  const a = mkSession('A', 'a', mkMsgs('A', 3));
  const b = mkSession('B', 'b', mkMsgs('B', 3));
  const d = divergenceOf(a, b);
  eq(d.kind, 'none', '无关会话不该被认成分支');
  eq(d.shared, 0, '无关会话没有共同前缀');
  // 文案里绝不能出现「分叉点在第 1 条」那种读起来像正常分支的话
  ok(!/分叉点在第 1 条/.test(divergenceLine(d)), '把「没有共享消息」说成了「分叉点在第 1 条」');
  ok(/没有共享消息/.test(divergenceLine(d)), '没有共享消息这条必须直说');
});

check('A 同一条会话 ⇒ kind:same（否则会被读成「完全一致的分支」）', () => {
  const a = mkSession('S', 'a', mkMsgs('S', 3));
  const d = divergenceOf(a, a);
  eq(d.kind, 'same', '同一条会话必须自己认得 —— 否则 shared===|a|===|b| 会被读成一条完美的分支');
  ok(/同一条会话/.test(divergenceLine(d)), '要说清是「同一条会话」');
});

check('A 一侧为空 ⇒ 0 条 + none，且不抛', () => {
  const empty = mkSession('E', 'e', []);
  const d = divergenceOf(empty, mkSession('S', 's', mkMsgs('S', 2)));
  eq([d.kind, d.shared, d.aAfter, d.bAfter], ['none', 0, 0, 2], '空会话的结果不对');
});

check('A **跨代**分支与源比，前缀仍是源那一段（uuid 一路拷下来）', () => {
  // S(3) → F 从 S 分出来再长 2 条 → F2 从 F 分出来再长 1 条
  const s = mkSession('S', 'S', mkMsgs('S', 3));
  const fMsgs = clone(s.messages).concat(mkMsgs('F', 2, 4));
  const f2Msgs = clone(fMsgs).concat(mkMsgs('F2', 1, 6));
  eq(f2Msgs.map((m) => m.id), ['S#1', 'S#2', 'S#3', 'F#4', 'F#5', 'F2#6'], '跨代 id 形状不对，本条无效');
  const d = divergenceOf(mkSession('F2', 'F2', f2Msgs), s);
  eq(d.shared, 3, '与源头比，共同前缀仍是源那一段');
  eq(d.aAfter, 3, 'F2 此后 3 条');
  eq(d.bAfter, 0, '源此后 0 条');
});

// ---------- B · drifted（同 id 但内容不同） ----------

check('B 同 id 但 status 不同 ⇒ drifted 计 1（源被原地归一化、副本没有）', () => {
  const src = mkSession('S', 's', mkMsgs('S', 2));
  const copy = clone(src.messages);
  copy[1].status = 'interrupted'; // 模拟：源那条已被 freezeTranscript 改过
  const fork = mkSession('F', 'f', copy.concat(mkMsgs('F', 1, 3)));
  const d = divergenceOf(src, fork);
  eq(d.shared, 2, 'id 一样就是共同前缀 —— 内容不同不影响分叉点');
  eq(d.drifted, 1, '一条内容不同应计 1');
  ok(/同 id 但内容已被改动/.test(divergenceLine(d)), 'drifted>0 时必须点出来（否则「两侧逐字相同」是谎话）');
});

check('B 逐字相同 ⇒ drifted 0；toolState 不同 ⇒ 1', () => {
  const src = mkSession('S', 's', [
    { id: 'S#1', role: 'tool', text: '', status: 'done', toolName: 'bash', toolState: 'ok' },
  ]);
  eq(divergenceOf(src, mkSession('F', 'f', clone(src.messages))).drifted, 0, '完全一样不该算偏移');
  const other = clone(src.messages);
  other[0].toolState = 'unknown';
  eq(divergenceOf(src, mkSession('F', 'f', other)).drifted, 1, 'toolState 不同应算偏移');
});

check('B **反控**：id 不同但正文完全相同 ⇒ 不进共同前缀（判据是 id 不是正文）', () => {
  const a = mkSession('A', 'a', [{ id: 'A#1', role: 'user', text: '同一句话', status: 'done' }]);
  const b = mkSession('B', 'b', [{ id: 'B#1', role: 'user', text: '同一句话', status: 'done' }]);
  const d = divergenceOf(a, b);
  eq([d.kind, d.shared, d.drifted], ['none', 0, 0], '按正文相似度猜是错的 —— 手工复制粘贴的两条会话应算不出来');
});

// ---------- C · 冻结（只读的正面证明） ----------

check('C frozenTail 把 streaming→interrupted、running→unknown，并报出条数', () => {
  const s = mkSession('S', 's', [
    { id: 'S#1', role: 'assistant', text: 'a', status: 'streaming' },
    { id: 'S#2', role: 'tool', text: '', status: 'done', toolName: 'bash', toolState: 'running' },
    { id: 'S#3', role: 'user', text: 'u', status: 'done' },
  ]);
  const t = frozenTail(s, 0);
  eq(t.messages.map((m) => m.status), ['interrupted', 'done', 'done'], 'streaming 没被冻结');
  eq(t.messages[1].toolState, 'unknown', 'running 应落成 unknown（不是 error —— 跑没跑完不可知）');
  eq(t.frozen, 2, '被冻结的条数不对');
});

check('C **只读的正面证明**：原 StoredSession 一个字段都没变', () => {
  const s = mkSession('S', 's', [
    { id: 'S#1', role: 'assistant', text: 'a', status: 'streaming' },
    { id: 'S#2', role: 'tool', text: '', status: 'done', toolName: 'bash', toolState: 'running' },
  ]);
  const before = JSON.stringify(s);
  frozenTail(s, 0);
  eq(JSON.stringify(s), before, '面板改了 _store 里那份 —— 等于替用户改了会话');
  // 返回的尾段也必须是**副本**：改它不许回写
  const t = frozenTail(s, 0);
  t.messages[0].text = '改了副本';
  eq(s.messages[0].text, 'a', '尾段不是副本，改它会回写原会话');
});

check('C `aAfter` 与真下发的尾段长度**同源**（探针钉这条等式）', () => {
  const s = mkSession('S', 's', mkMsgs('S', 5));
  const fork = mkSession('F', 'f', clone(s.messages).concat(mkMsgs('F', 2, 6)));
  const d = divergenceOf(s, fork);
  eq(frozenTail(s, d.shared).messages.length, d.aAfter, '源的尾段长度与 aAfter 对不上');
  eq(frozenTail(fork, d.shared).messages.length, d.bAfter, '分支的尾段长度与 bAfter 对不上');
});

// ---------- D · 串话（双证据） ----------

const withDsh = (id, cwd) => ({ dsh: { id, cwd } });
const CT_A = mkSession('A', 'a', mkMsgs('A', 1), withDsh('ds1', 'D:\\proj'));
const CT_B = mkSession('B', 'b', mkMsgs('B', 1), withDsh('ds1', 'D:\\proj'));

check('D 盘上同 id 同 cwd ⇒ shared（by:disk）', () => {
  const c = crossTalkOf(CT_A, CT_B);
  eq([c.kind, c.by, c.dshId], ['shared', 'disk', 'ds1'], '真 fork 应判共享');
});

check('D **同 id 不同 cwd ⇒ unknown/cwd-differs**（反控：这不该警示）', () => {
  const b = mkSession('B', 'b', mkMsgs('B', 1), { dsh: { id: 'ds1', cwd: 'D:\\other' } });
  const c = crossTalkOf(CT_A, b);
  eq([c.kind, c.why], ['unknown', 'cwd-differs'], '同 id 不同 cwd 不会落到同一份记忆，不该报 shared');
  ok(c.kind !== 'shared', '同 id 不同 cwd 报了警示 —— 那是假阳');
});

check('D 盘上不同 id ⇒ distinct；两侧都无 dsh ⇒ unknown/no-identity；只一侧有 ⇒ unknown/one-side', () => {
  eq(crossTalkOf(CT_A, mkSession('B', 'b', mkMsgs('B', 1), withDsh('ds2', 'D:\\proj'))).kind, 'distinct', '不同 id 应判分开');
  const bare = mkSession('B', 'b', mkMsgs('B', 1));
  eq(crossTalkOf(mkSession('A', 'a', mkMsgs('A', 1)), bare).why, 'no-identity', '两侧都没身份');
  eq(crossTalkOf(CT_A, bare).why, 'one-side', '只有一侧有身份');
  eq(crossTalkOf(CT_A, bare).kind, 'unknown', '无从判断时不许给 shared');
});

check('D **live 证据优先**（反控：调换优先级这条会红）', () => {
  // 盘上两份身份不同，但本次运行里两条 UI 会话共用一个 DSH id —— 这才是当下的事实。
  // 场景：补丁不可用 / hello.dsh.command 覆盖 ⇒ `_ensureDshSession` 绝不写盘，只挂 _dshSessions。
  const a = mkSession('A', 'a', mkMsgs('A', 1), withDsh('ds-a', 'D:\\proj'));
  const b = mkSession('B', 'b', mkMsgs('B', 1), withDsh('ds-b', 'D:\\proj'));
  const c = crossTalkOf(a, b, { a: 'shared-live', b: 'shared-live' });
  eq([c.kind, c.by, c.dshId], ['shared', 'live', 'shared-live'], 'live 证据必须优先于盘 —— 否则真串话会漏报');
  eq(crossTalkOf(a, b).kind, 'distinct', '同样的两条会话，只看盘会判成「已分开」（这就是漏报的那条路）');
});

check('D live 两侧不同 ⇒ distinct/by:live；只有一侧 ⇒ 退回盘', () => {
  eq(crossTalkOf(CT_A, CT_B, { a: 'x', b: 'y' }).kind, 'distinct', 'live 不同应判分开');
  eq(crossTalkOf(CT_A, CT_B, { a: 'x', b: 'y' }).by, 'live', 'live 两个值都在时要用 live');
  const c = crossTalkOf(CT_A, CT_B, { a: 'x', b: undefined });
  eq([c.kind, c.by], ['shared', 'disk'], 'live 只有一侧时应退回盘上那份');
});

// ---------- E · 文案 ----------

check('E 三句 unknown 文案**两两不同**，且都不说「共享」', () => {
  const lines = ['no-identity', 'one-side', 'cwd-differs'].map((why) =>
    crossTalkLine({ kind: 'unknown', by: 'none', why })
  );
  eq(new Set(lines).size, 3, `三句 unknown 必须两两不同，实到 ${JSON.stringify(lines)}`);
  for (const l of lines) ok(!/共享同一份/.test(l), `unknown 的文案断言了共享：${l}`);
});

check('E 三种分叉文案两两不同；无关会话不出警示色', () => {
  const same = divergenceLine(divergenceOf(mkSession('S', 's', mkMsgs('S', 2)), mkSession('S', 's', mkMsgs('S', 2))));
  const none = divergenceLine(divergenceOf(mkSession('A', 'a', mkMsgs('A', 1)), mkSession('B', 'b', mkMsgs('B', 1))));
  const fork = divergenceLine(divergenceOf(mkSession('S', 's', mkMsgs('S', 2)), mkSession('F', 'f', clone(mkMsgs('S', 2)))));
  eq(new Set([same, none, fork]).size, 3, '三种情形的文案必须两两不同');
  // warn 的唯一来源是 crossTalk.kind === 'shared'（provider 那条判据）
  const unrelated = crossTalkOf(mkSession('A', 'a', mkMsgs('A', 1)), mkSession('B', 'b', mkMsgs('B', 1)));
  ok(unrelated.kind !== 'shared', '两条无关会话被判成共享 —— 面板会无端飘一条警示');
  ok(/没有共享消息/.test(sharedPrefixNote(0, 0)), '前缀为 0 时那句说明不对');
  ok(/共同前缀 3 条/.test(sharedPrefixNote(3, 0)), '前缀说明里的条数不对');
  ok(/已改动/.test(sharedPrefixNote(3, 1)), 'drifted>0 时说明里要点出来');
});

check('E 悬停 title 里把**判据与证据来源**说出来（否则用户以为是按正文猜的）', () => {
  const d = divergenceOf(mkSession('S', 's', mkMsgs('S', 2)), mkSession('F', 'f', clone(mkMsgs('S', 2))));
  ok(/消息 id/.test(divergenceTitle(d)), '分叉点的 title 没说判据是消息 id');
  ok(/复制粘贴/.test(divergenceTitle(d)), '分叉点的 title 没说清哪一类算不出来');
  ok(/本次运行/.test(crossTalkTitle({ kind: 'shared', by: 'live', dshId: 'x' })), 'live 证据来源没说出来');
  ok(/盘上保存/.test(crossTalkTitle({ kind: 'shared', by: 'disk', dshId: 'x' })), '盘证据来源没说出来');
});

// ---------- F · 默认对侧 ----------

check('F 自己是分支 ⇒ 默认对侧是它的**源**（标题后缀这一条痕迹）', () => {
  const src = mkSession('S', '重构登录', mkMsgs('S', 3));
  const fork = mkSession('F', '重构登录' + FORK_SUFFIX, clone(src.messages));
  const other = mkSession('X', '别的事', mkMsgs('X', 3));
  eq(pickCounterpart(fork, [src, other]).id, 'S', '从分支打开面板时，默认应是它的源头');
});

check('F 对方是分支 ⇒ 默认对侧是那条分支', () => {
  const src = mkSession('S', '重构登录', mkMsgs('S', 3));
  const fork = mkSession('F', '重构登录' + FORK_SUFFIX, clone(src.messages));
  eq(pickCounterpart(src, [mkSession('X', '别的事', mkMsgs('X', 3)), fork]).id, 'F', '从源头打开时应给出它的分支');
});

check('F 没有标题关系 ⇒ 共同前缀最长的那条；都没有共享 ⇒ 最近更新的那条', () => {
  const src = mkSession('S', '甲', mkMsgs('S', 4));
  const near = mkSession('N', '乙', clone(mkMsgs('S', 4)).concat(mkMsgs('N', 1, 5))); // 前缀 4
  const far = mkSession('R', '丙', mkMsgs('R', 4)); // 前缀 0
  eq(pickCounterpart(src, [far, near]).id, 'N', '应挑共同前缀最长的那条');
  const oldOne = mkSession('O', '丁', mkMsgs('O', 2), { updatedAt: 10 });
  const newOne = mkSession('P', '戊', mkMsgs('P', 2), { updatedAt: 99 });
  eq(pickCounterpart(src, [oldOne, newOne]).id, 'P', '都没有共享时应挑最近更新的');
});

check('F 对侧永不是自己；只有自己一条 ⇒ undefined', () => {
  const only = mkSession('S', 's', mkMsgs('S', 2));
  eq(pickCounterpart(only, [only]), undefined, '不该把自己当对侧');
  eq(pickCounterpart(only, []), undefined, '没有对侧时应给 undefined（面板自己解释）');
});

// ---------- G · 结构守卫（读源码，防漂移） ----------

const readSrc = (f) => readFileSync(join(repoRoot, 'src', f), 'utf8');

/** 抠出一个方法体（到下一个 sibling 成员为止） */
function methodBody(src, name) {
  const at = src.indexOf(name);
  ok(at >= 0, `源码里找不到 ${name}`);
  const cands = [src.indexOf('\n  // ----------', at + name.length), src.indexOf('\n  private ', at + name.length)];
  let end = src.length;
  for (const c of cands) if (c > at && c < end) end = c;
  return src.slice(at, end);
}

check('G 冻结规则**只此一处**：provider 里 freezeTranscript 恰好 1 处（_openSession 的委派）', () => {
  const src = readSrc('chatViewProvider.ts');
  const n = src.split('freezeTranscript(').length - 1;
  eq(n, 1, `freezeTranscript 在 provider 里出现 ${n} 次，应为 1 次（唯一调用点是 _openSession）`);
  const body = methodBody(src, 'private _openSession(');
  ok(body.includes('freezeTranscript('), '_openSession 没委派给 freezeTranscript');
  // 归一化的两个判据不许在 provider 里复活 —— 复活就是第二套规则
  ok(!/'streaming'/.test(body), '_openSession 里又出现了 streaming 字面量 —— 第二套冻结规则');
  ok(!/'unknown'/.test(body), '_openSession 里又出现了 unknown 字面量 —— 第二套冻结规则');
});

check('G 只发尾段：_comparePane 必须走 frozenTail；compare-set **只由 _postCompare 构造**', () => {
  const src = readSrc('chatViewProvider.ts');
  ok(methodBody(src, 'private _comparePane(').includes('frozenTail('), '_comparePane 没走 frozenTail（会发整份转写）');
  // 数的是「构造点」不是「字面量出现次数」：同一个 payload 有两条分支（两侧都解出来 / 有一侧解不出来）
  // 是正常的，多了**第二个方法**在构造它才是漂移。
  const lit = "type: 'compare-set'";
  const total = src.split(lit).length - 1;
  const inMethod = methodBody(src, 'private _postCompare(').split(lit).length - 1;
  ok(inMethod >= 1, '_postCompare 里没有构造 compare-set');
  eq(inMethod, total, `有 ${total - inMethod} 处 compare-set 构造在 _postCompare 之外 —— 第二个构造点`);
});

check('G 不落新盘上状态：sessionStore / ChatMessage / StoredSession 里没有 compare 或 forkedFrom', () => {
  ok(!/compare/i.test(readSrc('sessionStore.ts')), 'sessionStore 里出现了 compare —— 对照不该落盘');
  const proto = readSrc('protocol.ts');
  const cm = proto.slice(proto.indexOf('export interface ChatMessage'), proto.indexOf('\n}', proto.indexOf('export interface ChatMessage')));
  ok(!/compare|forkedFrom/i.test(cm), 'ChatMessage 里长出了字段 —— 面板状态会跟着会话落盘');
  const ss = readSrc('sessionStore.ts');
  const stored = ss.slice(ss.indexOf('export interface StoredSession'), ss.indexOf('\n}', ss.indexOf('export interface StoredSession')));
  ok(!/forkedFrom/i.test(stored), 'StoredSession 里加了 forkedFrom —— C15 有意只靠消息 id 与标题后缀识别分支');
});

check('G `side` 只有两侧（不做第三栏）；FORK_SUFFIX 全仓唯一定义', () => {
  const proto = readSrc('protocol.ts');
  ok(/'a' \| 'b'/.test(proto), 'compare-pick 的 side 形状不对（应只有 a/b）');
  ok(!/'c'/.test(proto.slice(proto.indexOf("compare-pick"), proto.indexOf("compare-pick") + 200)), 'compare-pick 那边长出了第三侧');

  // 后缀字面量只准在 branchCompare.ts 里出现一次；provider 必须引用常量
  let hits = [];
  for (const f of readdirSync(join(repoRoot, 'src'))) {
    if (!f.endsWith('.ts')) continue;
    const n = readSrc(f).split(`'${FORK_SUFFIX}'`).length - 1;
    if (n) hits.push(`${f}×${n}`);
  }
  eq(hits, ['branchCompare.ts×1'], `分支后缀字面量应只在 branchCompare.ts 出现一次，实到 ${JSON.stringify(hits)}`);
  ok(methodBody(readSrc('chatViewProvider.ts'), 'private _forkSession(').includes('FORK_SUFFIX'), '_forkSession 没引用 FORK_SUFFIX —— 后缀会漂');
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
  // 有未过时**不打**「✓ 全部通过」—— 同一屏里既报失败又报全过，读的人只会记住后一句。
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
// ⚠️ 不用 process.exit()：Windows 上被管道重定向的 stdout 是**异步**写，退出会把还没冲出去的
// 结论行整段丢掉（C8 的 smoke-runtime 就是这么被抓到的）。
process.exitCode = failures.length ? 1 : 0;
