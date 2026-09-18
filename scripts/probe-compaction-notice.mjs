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
 * ⚠️ 这是**唯一**一条没有真帧可回放的探针：`logs/dsh-frames/` 里 5270 条已抓事件中
 * **一条 `compaction/*` 都没有**（默认阈值太高，从没触发过）。所以这里的用例全是合成帧，
 * 「压缩事件到底会不会透传到扩展」只能靠真机 F5 盖（见 docs/backlog.md 的 C10 节）。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-compaction-notice.mjs
 */
import { existsSync } from 'node:fs';
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

const { readCompactionEvent } = await load('compactionNotice.js');

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

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
}
console.log(`✓ 全部通过：${passed}/${passed}`);
// ⚠️ 不用 process.exit()：Windows 上被管道/文件重定向的 stdout 是**异步**写，退出会把还没
// 冲出去的结论行整段丢掉（C8 的 smoke-runtime 就是这么被抓到的：exit=0 却只有第一行）。
process.exitCode = failures.length ? 1 : 0;
