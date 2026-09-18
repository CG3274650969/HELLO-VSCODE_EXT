#!/usr/bin/env node
/**
 * C10 压缩说明自检 —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是 `readCompactionEvent` 的三条判据（见 `src/compactionNotice.ts` 的头注释）：
 *
 *   1. **压缩发生了就绝不沉默** —— 字段漂移时降级成"细节缺失"，而不是返回 undefined。
 *      静默正是这个功能要消灭的东西：模型记忆被折叠的那一刻，用户必须被告知。
 *   2. **成功只报一次** —— 成功路径上 `summary` 后面紧跟一个无 error 的 `end`，两边都报就重复了。
 *   3. **不读摘要正文** —— note 里不许出现 `data.summary` 的正文（那是往转写里灌二手记忆）。
 *
 * 载荷形状**逐字抄自** `dist-runtime/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`
 * 的 `commitCompactionBody` 与 `compactRegion` 的 catch 分支。用例里的字段名一旦与那里脱节，
 * 这个探针就该红 —— 它是我们与插件之间那份"口头契约"的唯一书面记录。
 *
 * 头半段是合成帧（字段漂移、降级、边界），后半段是**真帧对拍**（见文件末尾那一段）：
 * 把盘上 DSH 会话日志里的 `compaction/*` 帧解出来，逐条喂进 `readCompactionEvent`，
 * 要求产出与我们**落盘的 note 逐字相同**、且计数与 `compacted` 字段守恒。
 *
 *   2026-09-18 之前这条探针的头上写着「唯一一条没有真帧可回放的探针」—— `logs/dsh-frames/`
 *   里 5270 条已抓事件中**一条 `compaction/*` 都没有**（默认阈值 0.8 × 1M 从没触发过）。
 *   那天把阈值调到 0.02 跑了一轮，真帧就有了：6 次 start / 5 次 summary / 6 次 end（其中一次
 *   带 error 失败）。**那 5270 条的空缺因此不再成立**，本文件的后半段就是补上的那一条。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-compaction-notice.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findHarnessStore, readHarnessStore, readSessionEvents } from './dsh-session-log.mjs';

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

const { readCompactionEvent } = await load('compactionNotice.js');
const { logPath } = await load('dshPaths.js');

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

function eq(actual, expected, what) {
  ok(actual === expected, `${what}\n    期望 ${JSON.stringify(expected)}，实到 ${JSON.stringify(actual)}`);
}

/** 插件 `commitCompactionBody` 里那个 append 的载荷，逐字段照抄。 */
function summaryFrame(over = {}) {
  return {
    compactionId: 'c-1',
    summary: '## Primary Request and Intent\n用户要求……（这段正文绝不该出现在 note 里）',
    shadowedRange: { start: 3, end: 87 },
    shadowedSeqs: [3, 4, 5, 6, 7, 8],
    shadowedTokenCount: 12345,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxTokens: 8192,
    usage: { inputTokens: 900, cacheReadTokens: 0, outputTokens: 300 },
    ...over,
  };
}

try {
  // ---------- 成功路径 ----------

  await check('summary：报出条数 / token / 型号，且带"不可撤销 + 转写没少"那句', () => {
    const n = readCompactionEvent('compaction/summary', summaryFrame());
    eq(n.kind, 'done', 'kind');
    ok(n.text.includes('前 6 条事件'), `没报条数：${n.text}`);
    ok(n.text.includes('12.3K'), `没报 token：${n.text}`);
    ok(n.text.includes('deepseek-official/deepseek-v4-flash'), `没报型号：${n.text}`);
    ok(n.text.includes('不可撤销'), `没说不可以撤回：${n.text}`);
    ok(n.text.includes('一条没少'), `没说转写还在：${n.text}`);
  });

  await check('summary：**不读摘要正文**（note 里不许出现模型写的摘要内容）', () => {
    const n = readCompactionEvent('compaction/summary', summaryFrame());
    ok(!n.text.includes('Primary Request'), '把摘要正文灌进了 note');
    ok(!n.text.includes('用户要求'), '把摘要正文灌进了 note');
    ok(n.text.length < 300, `note 太长了，像是把正文抄进来了：${n.text.length} 字符`);
  });

  await check('end（无 error）：不发声 —— 成功路径由 summary 单独报，两边都报就重复了', () => {
    eq(readCompactionEvent('compaction/end', { compactionId: 'c-1', turn: 4 }), undefined, 'end 不该发声');
  });

  // ---------- 失败路径 ----------

  await check('end（有 error）：报失败，且明说记忆没动、可以继续', () => {
    const n = readCompactionEvent('compaction/end', {
      compactionId: 'c-1',
      turn: 4,
      error: 'LlmError: context window exceeded: requested 1200000 tokens',
    });
    eq(n.kind, 'failed', 'kind');
    ok(n.text.includes('context window exceeded'), `没带上原因：${n.text}`);
    ok(n.text.includes('没被改动'), `没说记忆没动：${n.text}`);
  });

  await check('end：error 是对象时取 message', () => {
    const n = readCompactionEvent('compaction/end', { compactionId: 'c-1', error: { message: 'boom', code: 'E1' } });
    ok(n.text.includes('boom'), `没取到 message：${n.text}`);
  });

  await check('end：error 长到离谱时截断（errorChain 会把 cause 链一路拼起来）', () => {
    const n = readCompactionEvent('compaction/end', { compactionId: 'c-1', error: 'x'.repeat(5000) });
    ok(n.text.length < 500, `没截断：${n.text.length} 字符`);
    ok(n.text.includes('…'), '截断了却没有省略号');
  });

  // ---------- 绝不沉默：字段漂移时的降级 ----------

  await check('summary 缺条数与 token：降级成"细节缺失"，仍然发声', () => {
    const n = readCompactionEvent('compaction/summary', { compactionId: 'c-1' });
    ok(n !== undefined && n.kind === 'done', '字段缺失就沉默 —— 这正是本功能要消灭的东西');
    ok(n.text.includes('细节缺失'), `没说明细节缺失：${n.text}`);
    ok(n.text.includes('不可撤销'), '降级路径丢了关键那句');
  });

  await check('summary 只缺型号：不谎报型号（不留空括号），其余照报', () => {
    const n = readCompactionEvent('compaction/summary', summaryFrame({ provider: undefined, model: undefined }));
    ok(n.text.includes('前 6 条事件'), '把能报的也丢了');
    ok(n.text.includes('12.3K'), '把 token 数也丢了');
    ok(!n.text.includes('（）'), `没型号却留了个空括号：${n.text}`);
    ok(!n.text.includes('undefined'), `把 undefined 写进了给用户看的话里：${n.text}`);
  });

  await check('summary 的 shadowedSeqs 不是数组：按"缺失"处理而不是崩', () => {
    const n = readCompactionEvent('compaction/summary', summaryFrame({ shadowedSeqs: 'nope' }));
    ok(n !== undefined && n.kind === 'done', '不该沉默');
    ok(n.text.includes('12.3K'), '把 token 数也一起丢了');
  });

  // ---------- 边界：不是压缩帧的一律不认 ----------

  await check('不认的帧类型：一律 undefined（别在事件通路上乱插话）', () => {
    const others = [
      'compaction/start',
      'assistant/chunk',
      'turn/end',
      'user/message',
      '',
    ];
    for (const t of others) {
      eq(readCompactionEvent(t, summaryFrame()), undefined, `${t} 不该发声`);
    }
  });

  await check('垃圾输入不抛（它跑在事件通路里，抛了会连累整轮帧处理）', () => {
    for (const bad of [undefined, null, 0, {}, [], Symbol('x'), ['compaction/summary']]) {
      eq(readCompactionEvent(bad, summaryFrame()), undefined, `type=${String(bad)} 应当安静返回`);
    }
    for (const bad of [undefined, null, 0, 'text', [], true]) {
      eq(readCompactionEvent('compaction/summary', bad), undefined, `data=${String(bad)} 应当安静返回`);
      eq(readCompactionEvent('compaction/end', bad), undefined, `data=${String(bad)} 应当安静返回`);
    }
  });

  await check('token 数的量级可读化（<1K 原样 / K / M）', () => {
    const t = (n) => {
      const r = readCompactionEvent('compaction/summary', summaryFrame({ shadowedTokenCount: n }));
      const m = r.text.match(/约 ([\d.]+[KM]?)/);
      return m ? m[1] : null;
    };
    eq(t(42), '42', '小数字');
    eq(t(999), '999', '999');
    eq(t(1961), '2.0K', '实测那次 1961');
    eq(t(123456), '123K', '十万级');
    eq(t(1234567), '1.2M', '百万级');
  });
} finally {
  /* 无现场要清 */
}

// ---------- 真帧对拍：盘上那份 DSH 会话日志里的 compaction/* ----------
//
// 上面那些用例守的是「函数对不对」，这一段守的是**整条链**：真帧 → 我们的判据 → 落盘的 note。
// 判据是**双向逐字**：wire 上有几条、按什么顺序，落盘的 note 就得有几条、按什么顺序、一字不差；
// 加上计数守恒（成功 note 数 == `compacted` 字段）。任何一处漂移都会当场红。
//
// ⚠️ 这里**不许打印任何消息正文**（`summary` 是模型写的摘要、note 是转写内容）—— 只报数字。

console.log('\n· 真帧对拍：DSH 会话日志里的 compaction/* ↔ 落盘的 note');

/** 从落盘的会话里挑「有压缩 note 且能定位到 DSH 日志」的那一个（note 最多的那个）。 */
function pickSession(storePath) {
  const sessions = readHarnessStore(storePath);
  const root = join(dirname(storePath), 'dsh-sessions');
  let best = null;
  for (const s of sessions) {
    const notes = (s.messages ?? []).filter((m) => m.role === 'note' && /压缩/.test(m.text ?? ''));
    if (!notes.length || !s.dsh?.id || !s.dsh?.cwd) continue;
    const log = logPath(root, s.dsh.cwd, s.dsh.id, 'zstd');
    if (!existsSync(log)) continue;
    if (!best || notes.length > best.notes.length) best = { store: s, notes, log };
  }
  return best;
}

{
  const storePath = findHarnessStore();
  const picked = storePath ? pickSession(storePath) : null;

  if (!picked) {
    console.log(
      '    ⚠ 跳过：本机没有「含压缩 note 且日志还在」的会话（压缩默认阈值下基本不会发生）。\n' +
        '      别把这次跳过当成验过了 —— 真帧那半段要等真机上压过一次才有得比。'
    );
  } else {
    const events = readSessionEvents(picked.log);
    const frames = events.filter((e) => String(e.type ?? '').startsWith('compaction/'));

    await check('真帧：日志里确实有 compaction/* 帧（否则这段等于空跑）', () => {
      ok(events.length > 0, '日志解出来 0 条事件（格式变了？）');
      ok(frames.length > 0, '日志里没有 compaction/* 帧 —— 这段对拍会变成假绿');
    });

    await check('真帧：每种类型的条数与插件行为对得上（start/summary/end 各几次）', () => {
      const n = (t) => frames.filter((f) => f.type === t).length;
      console.log(
        `    真帧 ${frames.length} 条：start ${n('compaction/start')} / summary ${n('compaction/summary')} / end ${n('compaction/end')}`
      );
      eq(n('compaction/start'), n('compaction/end'), 'start 与 end 必须成对（少了就是日志被截断）');
      ok(n('compaction/summary') <= n('compaction/end'), 'summary 比 end 还多 —— 载荷不对');
    });

    await check('真帧：start 一律不发声；无 error 的 end 不发声（成功只报一次）', () => {
      for (const f of frames) {
        const d = f.data ?? {};
        if (f.type === 'compaction/start') eq(readCompactionEvent(f.type, d), undefined, 'start 不该发声');
        if (f.type === 'compaction/end' && !d.error) {
          eq(readCompactionEvent(f.type, d), undefined, '无 error 的 end 不该发声（会与 summary 重复）');
        }
      }
    });

    const wireNotes = frames.map((f) => readCompactionEvent(f.type, f.data ?? {})).filter(Boolean);

    await check('★★ 真帧对拍：wire 上的 note 与落盘的 note **逐字**相同、条数与顺序也一样', () => {
      eq(wireNotes.length, picked.notes.length, 'note 条数对不上（漏报或重复报）');
      for (let i = 0; i < wireNotes.length; i++) {
        eq(wireNotes[i].text, picked.notes[i].text ?? '', `第 ${i + 1} 条 note 的正文与落盘的不一致`);
      }
    });

    await check('★★ 真帧对拍：成功 note 数 == 落盘的 compacted 计数（计数器没算漏也没算重）', () => {
      const done = wireNotes.filter((n) => n.kind === 'done').length;
      eq(picked.store.compacted, done, 'compacted 字段与成功 note 数对不上');
      console.log(`    成功 ${done} 次 / 失败 ${wireNotes.filter((n) => n.kind === 'failed').length} 次`);
    });

    await check('★★ 真帧对拍：note 里的条数与 token 数**确实来自帧上那两个字段**', () => {
      // 独立重算：条数 = shadowedSeqs.length；token = 把 note 里那个「约 X」解析回数值，
      // 与帧上的 shadowedTokenCount 比（K/M 量级换算后允许舍入误差，不复制我们的格式化规则）。
      const MUL = { '': 1, K: 1000, M: 1e6 };
      let checked = 0;
      for (const f of frames) {
        const note = readCompactionEvent(f.type, f.data ?? {});
        if (!note || note.kind !== 'done') continue;
        const d = f.data ?? {};
        const seqs = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : null;
        if (seqs !== null) {
          ok(note.text.includes(`前 ${seqs} 条事件`), `note 里的条数不是帧上的 shadowedSeqs.length(${seqs})`);
        }
        const m = note.text.match(/约 ([\d.]+)([KM]?)/);
        ok(m, `note 里没报 token 数`);
        const shown = Number(m[1]) * MUL[m[2]];
        const real = d.shadowedTokenCount;
        ok(
          Math.abs(shown - real) < Math.max(100, real * 0.01),
          `note 报的 ${m[1]}${m[2]} 与帧上的 shadowedTokenCount(${real}) 差太多`
        );
        checked += 1;
      }
      ok(checked > 0, '一条成功帧都没比到 —— 这段空转了');
    });

    await check('★ 真帧对拍：模型写的摘要正文一个字都没进 note（隐私与"二手记忆"两件事）', () => {
      for (const f of frames) {
        const d = f.data ?? {};
        const note = readCompactionEvent(f.type, d);
        if (!note || typeof d.summary !== 'string' || !d.summary) continue;
        // 取摘要里最长的一段「实词片段」来比 —— 短前缀可能恰好是标点/标题，比不出东西
        const probe = d.summary.replace(/\s+/g, ' ').slice(0, 40);
        ok(!note.text.includes(probe), 'note 里出现了摘要正文');
        ok(!note.text.includes(d.summary.slice(-40)), 'note 里出现了摘要正文（尾部）');
      }
    });

    await check('真帧：note 里不出现 shadowedRange（实测它可以是 反的：start > end）', () => {
      // 2026-09-18 那份日志的最后一次压缩给的是 range 36129-36125。我们**一个数字都没用**它，
      // 所以这条是"保持不用的现状"的守卫；哪天有人想往 note 里加区间，先看这里。
      const inverted = frames.filter((f) => {
        const r = f.data?.shadowedRange;
        return r && typeof r.start === 'number' && typeof r.end === 'number' && r.start > r.end;
      }).length;
      for (const n of wireNotes) ok(!/\d+\s*-\s*\d+/.test(n.text), `note 里出现了区间：${n.text.slice(0, 80)}`);
      console.log(`    帧上带区间且 start > end 的：${inverted} 条（我们一条都没用）`);
    });
  }
}

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
} else {
  // ⚠️ 这行必须在 else 里：它从前无条件打印，于是「有红 + ✓ 全部通过」同屏出现过。
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
// ⚠️ 不用 process.exit()：Windows 上被管道/文件重定向的 stdout 是**异步**写，退出会把还没
// 冲出去的结论行整段丢掉（C8 的 smoke-runtime 就是这么被抓到的：exit=0 却只有第一行）。
process.exitCode = failures.length ? 1 : 0;
