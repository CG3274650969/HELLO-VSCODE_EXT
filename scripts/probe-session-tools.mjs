#!/usr/bin/env node
/**
 * C6 会话工具自检 —— 全文检索 / 导出 / 软删除生命周期，**不需要 VS Code、不需要 API key**。
 *
 * 这三个模块是有意做成「零 `vscode` 依赖」的纯函数（见各自文件头），所以能在这里直接加载
 * 编译产物跑边界用例；本脚本是这套约束的**唯一守卫** —— 谁哪天在 sessionSearch.ts 里
 * `import * as vscode`，这里当场加载失败。
 *
 *   npm run compile && node scripts/probe-session-tools.mjs
 *
 * `out/` 是 gitignored 的编译产物，先 tsc 再跑（缺文件会给一句人话）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'out');

// .mjs 里没有 require —— 用动态 import 加载编译产物（同 scripts/probe-sandbox.mjs 的写法）
async function load(moduleName) {
  const file = join(outDir, moduleName);
  if (!existsSync(file)) {
    console.error(`缺少编译产物：${file}\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
    process.exit(2);
  }
  return import(pathToFileURL(file).href);
}

const { searchSessions, SEARCH_TOOL_INPUT_CHARS } = await load('sessionSearch.js');
const { sessionToMarkdown, sessionToJson, suggestedFileName, MD_EMBED_MAX_CHARS } = await load('sessionExport.js');
const { capToolInput, MAX_TOOL_INPUT_CHARS, SessionStore, STALE_TMP_MS } = await load('sessionStore.js');

// ---------- 断言小工具 ----------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) {
      throw new Error('断言返回 false');
    }
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
  if (a !== e) {
    throw new Error(`${what}期望 ${e}，实得 ${a}`);
  }
}

function ok(cond, msg = '') {
  if (!cond) {
    throw new Error(msg || '断言失败');
  }
}

// ---------- 造数据 ----------

const T0 = 1_700_000_000_000; // 固定时间戳：导出内容要可复现

function msg(o) {
  return Object.assign({ id: 'm1', role: 'user', text: '', status: 'done' }, o);
}

function sess(o) {
  return Object.assign({ id: 's1', title: '', createdAt: T0, updatedAt: T0, messages: [] }, o);
}

/** 一段前后各 30 个 x/y 的正文，用来精确断言片段的下标没失位。 */
function padded(needle) {
  return 'x'.repeat(30) + needle + 'y'.repeat(30);
}

// ============================================================
console.log('\n【检索 · sessionSearch.ts】');
// ============================================================

check('空串 / 纯空白查询 → 空结果（webview 空查询走本地列表，不该发请求）', () => {
  const s = sess({ messages: [msg({ text: 'hello world' })] });
  eq(searchSessions([s], ''), []);
  eq(searchSessions([s], '   \t\n '), []);
});

check('★ 只出现在正文里的词能命中（backlog 的验收那条）', () => {
  const s = sess({
    title: '无关标题',
    messages: [msg({ role: 'user', text: '帮我看看这个报错' }), msg({ role: 'assistant', text: '这是空指针解引用' })],
  });
  const hits = searchSessions([s], '空指针');
  eq(hits.length, 1, '命中条数：');
  eq(hits[0].count, 1, 'count：');
  ok(hits[0].snippet, '应当带片段');
  eq(hits[0].snippet.match, '空指针');
});

check('标题命中但正文不命中 → 进结果集、count 为 0、无片段', () => {
  const s = sess({ title: '数据库迁移方案', messages: [msg({ text: '完全无关的正文' })] });
  const hits = searchSessions([s], '迁移');
  eq(hits.length, 1);
  eq(hits[0].count, 0, 'count：');
  eq(hits[0].snippet, undefined, 'snippet：');
});

check('命中工具名（toolName）', () => {
  const s = sess({ messages: [msg({ role: 'assistant', text: '好的' }), msg({ role: 'tool', toolName: 'bash', toolInput: 'ls', toolState: 'ok' })] });
  eq(searchSessions([s], 'bash').length, 1);
});

check('命中工具入参（toolInput）', () => {
  const s = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolInput: 'rm -v "test.py"', toolState: 'ok' })] });
  const hits = searchSessions([s], 'test.py');
  eq(hits.length, 1);
  eq(hits[0].count, 1);
});

check('★ 工具输出（toolOutput）里的词**搜不到**（用户拍板的检索范围的反向断言）', () => {
  const s = sess({
    messages: [msg({ role: 'tool', toolName: 'bash', toolInput: 'ls', toolOutput: 'ONLY_IN_OUTPUT_zzz', toolState: 'ok' })],
  });
  eq(searchSessions([s], 'ONLY_IN_OUTPUT_zzz'), []);
});

check('★ note 消息**不参与检索**（全库 note 都是我们自己写的状态播报，搜「会话」会命中每一条）', () => {
  const s = sess({
    messages: [
      msg({ role: 'note', text: '已开启全新 DSH 会话 —— 模型只记得本条消息之后的内容，不再拥有此前对话的记忆。' }),
      msg({ role: 'assistant', text: '正文' }),
    ],
  });
  eq(searchSessions([s], '全新 DSH 会话'), [], '模板句不该命中');
  eq(searchSessions([s], '不再拥有'), [], '模板句片段不该命中');
});

check(`★ toolInput 只搜前 ${SEARCH_TOOL_INPUT_CHARS} 字符（write/edit 的入参里是整份文件正文）`, () => {
  const head = 'HEAD_MARKER';
  const tail = 'TAIL_MARKER_zzz';
  const s = sess({
    messages: [msg({ role: 'tool', toolName: 'write', toolInput: head + ' '.repeat(SEARCH_TOOL_INPUT_CHARS) + tail, toolState: 'ok' })],
  });
  eq(searchSessions([s], head).length, 1, '窗口内的标记：');
  eq(searchSessions([s], tail), [], '窗口外的标记：');
});

check('附件名可搜（含「只有附件、正文为空」的消息）', () => {
  const s = sess({
    messages: [msg({ text: '', attachments: [{ name: '季度报表.xlsx', path: 'D:\\data\\季度报表.xlsx' }] })],
  });
  eq(searchSessions([s], '季度报表').length, 1, '按名字：');
  eq(searchSessions([s], 'D:\\data').length, 1, '按路径：');
});

check('★ 正则元字符被转义：搜 `a.c` 不该命中 `abc`', () => {
  const s = sess({ messages: [msg({ text: 'abc' })] });
  eq(searchSessions([s], 'a.c'), [], '元字符当字面量：');
  const s2 = sess({ messages: [msg({ text: 'a.c 是真的点号' })] });
  eq(searchSessions([s2], 'a.c').length, 1, '字面命中：');
});

check('大小写不敏感，且片段回的是原文大小写', () => {
  const s = sess({ messages: [msg({ text: 'The DeepSeek Harness is here' })] });
  const hits = searchSessions([s], 'deepseek');
  eq(hits.length, 1);
  eq(hits[0].snippet.match, 'DeepSeek', '片段应是原文：');
});

check('count 统计全部字段的出现总数；片段恒取第一条命中消息的第一次出现（确定性）', () => {
  const s = sess({
    messages: [
      msg({ role: 'user', text: 'AAA 第一次' }),
      msg({ role: 'assistant', text: 'AAA 第二次 AAA 第三次' }),
    ],
  });
  const hits = searchSessions([s], 'AAA');
  eq(hits[0].count, 3, 'count：');
  eq(hits[0].snippet.match, 'AAA', 'match：');
  eq(hits[0].snippet.before, '', '首条消息的开头命中 → before 为空：');
  const again = searchSessions([s], 'AAA');
  eq(again[0].snippet, hits[0].snippet, '两次调用片段应一致：');
});

check('★ 下标不失位：`İ`(U+0130) 这类小写后长度会变的字符前面，片段照样切得准', () => {
  // 用 toLowerCase()+indexOf 的实现会在这里整体错位一格（'İ'.toLowerCase() 是 2 个码元）
  const hay = 'İ' + 'x'.repeat(30) + 'NEEDLE' + 'y'.repeat(30);
  const s = sess({ messages: [msg({ text: hay })] });
  const hits = searchSessions([s], 'needle');
  eq(hits.length, 1);
  eq(hits[0].snippet.match, 'NEEDLE', 'match：');
  eq(hits[0].snippet.before, '…' + 'x'.repeat(24), 'before（错位实现会多出一个 x 或带上半个词）：');
  eq(hits[0].snippet.after, 'y'.repeat(30), 'after：');
  // 再直接验一次「片段就是原文的一段」
  ok(hay.includes(hits[0].snippet.match), 'match 必须是原文的子串');
});

check('片段边界：串首命中 / 串尾命中（含命中恰在最后一个字符）', () => {
  const head = sess({ messages: [msg({ text: 'NEEDLE' + 'z'.repeat(100) })] });
  const h1 = searchSessions([head], 'needle')[0].snippet;
  eq(h1.before, '', '串首 before：');
  eq(h1.after, 'z'.repeat(60) + '…', '串首 after 被截断加省略号：');

  const tailHay = 'q'.repeat(100) + 'NEEDLE';
  const tail = sess({ messages: [msg({ text: tailHay })] });
  const h2 = searchSessions([tail], 'needle')[0].snippet;
  eq(h2.after, '', '串尾 after：');
  eq(h2.before, '…' + 'q'.repeat(24), '串尾 before：');

  const one = sess({ messages: [msg({ text: 'NEEDLE' })] });
  const h3 = searchSessions([one], 'needle')[0].snippet;
  eq([h3.before, h3.match, h3.after], ['', 'NEEDLE', ''], '整串就是命中：');
});

check('片段里的换行折成空格（命中常落在多行正文里）', () => {
  const s = sess({ messages: [msg({ text: '第一行\n第二行 NEEDLE\n第三行' })] });
  const sn = searchSessions([s], 'needle')[0].snippet;
  ok(!sn.before.includes('\n') && !sn.after.includes('\n'), '片段里不该有裸换行');
  eq(sn.before, '第一行 第二行 ');
});

check('★ emoji / CJK 边界不切出落单的半个代理项', () => {
  // 前面堆满 emoji，让 SNIPPET_BEFORE 的切口必然落在代理对中间
  const hay = '😀'.repeat(30) + 'NEEDLE' + '😀'.repeat(30);
  const sn = searchSessions([sess({ messages: [msg({ text: hay })] })], 'needle')[0].snippet;
  const bad = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  ok(!bad.test(sn.before), `before 有落单代理项：${JSON.stringify(sn.before)}`);
  ok(!bad.test(sn.after), `after 有落单代理项：${JSON.stringify(sn.after)}`);
});

check('回收站里的会话不参与检索', () => {
  const s = sess({ messages: [msg({ text: 'UNIQUE_WORD' })], deletedAt: T0 });
  eq(searchSessions([s], 'UNIQUE_WORD'), []);
});

check('结果按 updatedAt 倒序', () => {
  const a = sess({ id: 'a', updatedAt: T0 + 1, messages: [msg({ text: 'X' })] });
  const b = sess({ id: 'b', updatedAt: T0 + 2, messages: [msg({ text: 'X' })] });
  eq(searchSessions([a, b], 'x').map((h) => h.id), ['b', 'a']);
});

// ============================================================
console.log('\n【导出 · sessionExport.ts】');
// ============================================================

check('空会话不炸（只有头与元信息）', () => {
  const md = sessionToMarkdown(sess({ title: '空' }));
  ok(md.startsWith('# 空'), '应以标题开头');
  ok(md.includes('**会话 ID**'), '应含元信息');
  ok(!md.includes('undefined'), '不该出现 undefined');
});

check('工具卡无输入 / 无输出 → 不出现 undefined，也不留空围栏', () => {
  const s = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolState: 'ok' })] });
  const md = sessionToMarkdown(s);
  ok(!md.includes('undefined'), '不该出现 undefined');
  ok(!/```\s*```/.test(md), '不该出现空围栏');
  ok(md.includes('🔧 `bash` —— 已完成'), '工具头按状态渲染');
});

check('工具卡状态：失败 / 仍在运行', () => {
  const bad = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolState: 'error', toolInput: 'x' })] });
  ok(sessionToMarkdown(bad).includes('—— 失败'));
  const running = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolState: 'running', toolInput: 'x' })] });
  ok(sessionToMarkdown(running).includes('—— 导出时仍在运行'));
});

check('★ 围栏穿透：内容含 ``` 时外层围栏必须更长，且内容逐字节保留', () => {
  const inner = 'before\n```\nthis looks like a fence\n```\nafter';
  const s = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolState: 'ok', toolInput: 'ls', toolOutput: inner })] });
  const md = sessionToMarkdown(s);
  // 内容被原样包住（去掉两端空白后仍是原文）
  ok(md.includes(inner), '内容应逐字节保留');
  ok(md.includes('````\n' + inner + '\n````'), '外层围栏应为 4 个反引号');
  // 按行判：紧邻内容上/下那两行必须是 ≥4 个反引号的围栏（子串匹配会被 4 个反引号本身骗过）
  const lines = md.split('\n');
  const at = lines.indexOf('before');
  ok(at > 0, '应找得到内容首行');
  ok(/^`{4,}$/.test(lines[at - 1]), `开围栏应是 ≥4 个反引号，实得 ${JSON.stringify(lines[at - 1])}`);
  const end = lines.indexOf('after');
  ok(/^`{4,}$/.test(lines[end + 1]), `闭围栏应是 ≥4 个反引号，实得 ${JSON.stringify(lines[end + 1])}`);
});

check('★ 围栏穿透：内容本身就是一行围栏 / 含四连反引号', () => {
  const s1 = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolState: 'ok', toolOutput: '```' })] });
  ok(sessionToMarkdown(s1).includes('````\n```\n````'), '整串就是围栏 → 外层 4 个');
  const s2 = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolState: 'ok', toolOutput: 'a ```` b' })] });
  ok(sessionToMarkdown(s2).includes('`````\n'), '四连反引号 → 外层 5 个');
});

check('超长工具输出被截断并留话（JSON 导出不截）', () => {
  const long = 'A'.repeat(MD_EMBED_MAX_CHARS + 500);
  const s = sess({ messages: [msg({ role: 'tool', toolName: 'bash', toolState: 'ok', toolOutput: long })] });
  const md = sessionToMarkdown(s);
  ok(md.includes('（已截断'), '应标出截断');
  ok(md.length < long.length, 'md 应短于原始内容');
  ok(sessionToJson(s).includes(long), 'JSON 导出必须无损');
});

check('附件：有 path / 无 path / 截断 / 读取失败 都只列名字', () => {
  const s = sess({
    messages: [
      msg({
        text: '看看这几个文件',
        attachments: [
          { name: 'a.txt', path: 'D:\\ws\\a.txt' },
          { name: 'b.txt' },
          { name: 'c.bin', path: 'D:\\ws\\c.bin', truncated: true },
          { name: 'd.txt', path: 'D:\\ws\\d.txt', readError: 'ENOENT' },
        ],
      }),
    ],
  });
  const md = sessionToMarkdown(s);
  ok(md.includes('- `a.txt`（`D:\\ws\\a.txt`）'), '带路径');
  ok(md.includes('- `b.txt`\n') || md.includes('- `b.txt`'), '无路径');
  ok(md.includes('编辑器选区') === false, '没标 selection 就不该出现这个词');
  ok(md.includes('`c.bin`（`D:\\ws\\c.bin`） · 已截断'), '截断标记');
  ok(md.includes('`d.txt`（`D:\\ws\\d.txt`） · 读取失败：ENOENT'), '读取失败标记');
  ok(!md.includes('undefined'), '不该出现 undefined');
});

check('只有附件、正文为空的用户消息 → `## 你` + 附件列表', () => {
  const s = sess({ messages: [msg({ text: '', attachments: [{ name: 'only.txt', path: 'D:\\only.txt' }] })] });
  const md = sessionToMarkdown(s);
  ok(md.includes('## 你'), '');
  ok(md.includes('- `only.txt`'), '');
});

check('编辑器选区附件标出来源', () => {
  const s = sess({ messages: [msg({ text: '解释这段', attachments: [{ name: 'x.ts', path: 'p', selection: true }] })] });
  ok(sessionToMarkdown(s).includes('编辑器选区'));
});

check('★ 标题含 `#` / 换行 / emoji / 超长 → `#` 行恒为一行且封顶', () => {
  const s = sess({ title: '# 标题\n第二行 ' + '😀'.repeat(5) + ' ' + 'x'.repeat(500) });
  const first = sessionToMarkdown(s).split('\n')[0];
  ok(first.startsWith('# '), '');
  ok(first.includes('😀'), 'emoji 保留');
  ok(first.endsWith('…'), '超长应有省略号');
  // '# ' 前缀 2 + 封顶 120 + 省略号 1
  ok(first.length <= 123, `标题行封顶后长度异常：${first.length}`);

  const empty = sessionToMarkdown(sess({ title: '' })).split('\n')[0];
  eq(empty, '# （无标题）');

  // 截断点正落在 emoji 代理对中间时，也不能切出半个
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const cutMid = sessionToMarkdown(sess({ title: 'a'.repeat(119) + '😀'.repeat(20) })).split('\n')[0];
  ok(!lone.test(cutMid), `标题切出了落单代理项：${JSON.stringify(cutMid)}`);
});

check('空回复 / 中断 / 出错各有一行状态说明', () => {
  ok(sessionToMarkdown(sess({ messages: [msg({ role: 'assistant', text: '' })] })).includes('（空回复）'));
  ok(sessionToMarkdown(sess({ messages: [msg({ role: 'assistant', text: '半句', status: 'interrupted' })] })).includes('被中断'));
  ok(sessionToMarkdown(sess({ messages: [msg({ role: 'assistant', text: 'x', status: 'error' })] })).includes('出错了'));
});

check('note 渲染成灰字引用块', () => {
  const s = sess({ messages: [msg({ role: 'note', text: '已开启全新 DSH 会话' })] });
  ok(sessionToMarkdown(s).includes('> ℹ️ 已开启全新 DSH 会话'));
});

check('用量：无 usage / 全 0 / 有值 三种口径', () => {
  ok(!sessionToMarkdown(sess({})).includes('用量'), '没存过 usage → 不写这行');
  const zero = sess({ usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } });
  ok(!sessionToMarkdown(zero).includes('用量'), '全 0 = 没有信息 → 不写');
  const real = sess({ usage: { inputTokens: 900, cacheReadTokens: 200, outputTokens: 300 } });
  const md = sessionToMarkdown(real);
  ok(md.includes('**本会话用量**：输入 900（其中缓存命中 200）· 输出 300'), '口径：输入不含缓存读、缓存读单列');
});

check('有 dsh 身份才写 DSH 行；回收站导出标明已删除', () => {
  ok(!sessionToMarkdown(sess({})).includes('DSH 会话'));
  const s = sess({ dsh: { id: 'abc::1', cwd: 'd:\\ws' } });
  ok(sessionToMarkdown(s).includes('**DSH 会话**：`abc::1`（工作区 `d:\\ws`）'));
  const t = sess({ deletedAt: T0 });
  ok(sessionToMarkdown(t).includes('（本文件导出自回收站）'));
});

check('同一输入两次调用字节相同（导出要可复现）', () => {
  const s = sess({
    title: '复现',
    usage: { inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 },
    dsh: { id: 'i', cwd: 'c' },
    messages: [msg({ text: '你好' }), msg({ role: 'tool', toolName: 'bash', toolInput: 'ls', toolOutput: 'ok', toolState: 'ok' })],
  });
  eq(sessionToMarkdown(s), sessionToMarkdown(s));
  eq(sessionToJson(s), sessionToJson(s));
  ok(sessionToMarkdown(s).endsWith('\n'), 'md 以换行收尾');
});

check('★ JSON 往返：深等 + 显式确认 undefined 字段被丢掉（收件人要能指望这个）', () => {
  const s = sess({
    title: '往返',
    usage: { inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 },
    dsh: { id: 'i', cwd: 'c' },
    messages: [
      msg({ text: 'hi', attachments: [{ name: 'a.txt', content: '附件正文' }] }),
      msg({ role: 'tool', toolName: 'bash', toolInput: null, toolState: 'ok' }),
    ],
  });
  eq(JSON.parse(sessionToJson(s)), JSON.parse(JSON.stringify(s)), '往返应深等：');
  const round = JSON.parse(sessionToJson(s));
  ok(!('deletedAt' in round), 'undefined 的 deletedAt 应被丢掉（不是 null）');
  ok(round.messages[0].attachments[0].content === '附件正文', '附件正文无损');
});

check('★ 文件名消毒：非法字符 / 结尾点空格 / 空标题 / Windows 保留名', () => {
  const pick = (title, ext = 'md') => suggestedFileName(sess({ title, id: 'abcdef1234567890' }), ext);
  eq(pick('讨论 v1.2'), '讨论 v1.2.md', '点在中间是合法的，别乱改：');
  eq(pick('a|b:c*d?e"f<g>h\\i/j'), 'a_b_c_d_e_f_g_h_i_j.md');
  eq(pick('第一行\n第二行'), '第一行 第二行.md');
  eq(pick('结尾有点...'), '结尾有点.md', '结尾的点 Windows 会拒：');
  eq(pick('结尾有空格   '), '结尾有空格.md');
  eq(pick(''), '会话-abcdef12.md', '空标题回退：');
  eq(pick('   '), '会话-abcdef12.md', '纯空白也算空：');
  eq(pick('CON'), '_CON.md', '保留名加前缀而不是丢掉名字：');
  eq(pick('com1'), '_com1.md');
  eq(pick('console'), 'console.md', '只有精确的保留名才处理：');
  eq(pick('x'.repeat(200)).length <= 84, true, '长度封顶：');
  eq(pick('报告', 'json'), '报告.json');
});

// ============================================================
console.log('\n【软删除生命周期 · sessionStore.ts】');
// ============================================================

const dir = mkdtempSync(join(tmpdir(), 'hello-c6-'));
const FILE = 'probe-sessions.json';

function newStore() {
  return new SessionStore(dir, FILE);
}

/** 从干净状态起步的 store。**每条用例都要用它** —— 直接 newStore() 会把上一条用例落盘的数据
 *  一起读进来（曾经因此让 purgeTrashed 少清出 2 条而假失败）。 reopened/直接写文件的用例才用 newStore()。
 *
 *  ⚠️ C8c 起**必须连 `.bak` 与 `.tmp` 一起清**：有了上一代备份之后，「主文件不存在」不再等于
 *  「没有历史」—— 构造会回退到备份，把上一条用例的数据原样读回来，于是一整片用例连环假失败。
 *  `FILE + '.'` 前缀一把罩住 `.bak`、`<hex>.tmp`、`bak.<hex>.tmp` 三种名字。 */
function scratchStore() {
  for (const name of readdirSync(dir)) {
    if (name === FILE || name.startsWith(FILE + '.')) {
      rmSync(join(dir, name), { force: true });
    }
  }
  return newStore();
}

function withMessage(store, title, extra = {}) {
  const s = store.create(title);
  s.messages = [msg({ text: title })];
  s.title = title;
  Object.assign(s, extra);
  store.add(s);
  return s;
}

function readFileJson() {
  return JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
}

try {
  check('softDelete → 从 active() 消失、进 trashed()', () => {
    const store = scratchStore();
    const s = withMessage(store, '待删');
    withMessage(store, '留下');
    eq(store.softDelete(s.id), true, '返回值：');
    eq(store.active().map((x) => x.title), ['留下']);
    eq(store.trashed().map((x) => x.title), ['待删']);
  });

  check('★ 重复 softDelete 不刷新 deletedAt（幂等）', () => {
    const store = scratchStore();
    const s = withMessage(store, '重复删');
    store.softDelete(s.id, 111);
    store.softDelete(s.id, 999);
    eq(store.get(s.id).deletedAt, 111, '第二次不该覆盖：');
  });

  check('未知 id 的 softDelete / restore 不抛、不改变任何状态', () => {
    const store = scratchStore();
    withMessage(store, 'a');
    eq(store.softDelete('不存在'), false);
    eq(store.restore('不存在'), false);
    eq(store.active().length, 1);
  });

  check('restore：未删的 / 未知的都是空操作', () => {
    const store = scratchStore();
    const a = withMessage(store, '在列的');
    eq(store.restore(a.id), false);
    eq(store.get(a.id).deletedAt, undefined);
  });

  check('★ restore 会把 updatedAt 顶到最新（列表按 updatedAt 倒序，不顶就等于没恢复）', () => {
    const store = scratchStore();
    const s = withMessage(store, '老会话');
    s.updatedAt = T0; // 钉成「很久以前」，否则 create() 与 restore() 可能落在同一毫秒（测出假失败）
    store.softDelete(s.id);
    store.restore(s.id);
    eq(s.deletedAt, undefined, '标记清掉：');
    ok(store.get(s.id).updatedAt > T0, `updatedAt 应被顶起来（T0 → ${store.get(s.id).updatedAt}）`);
    ok(store.get(s.id).updatedAt <= Date.now() + 1, '不该顶到未来');
  });

  check('★★ 软删后持久化 → 新建 store 指向同目录 → 仍在回收站且 deletedAt 不变（真回归闸门）', () => {
    const store = scratchStore();
    const s = withMessage(store, '活过重启');
    store.softDelete(s.id, 777);
    store.persist();
    const reopened = newStore();
    eq(reopened.active().map((x) => x.title), [], '重启后不该自己回到列表：');
    eq(reopened.trashed().map((x) => x.title), ['活过重启'], '重启后回收站该还在：');
    eq(reopened.get(s.id).deletedAt, 777, 'deletedAt 应原样保留：');
  });

  check('★ 软删标记是坏值时一律当「未删除」（宁可可见，不可永久藏起来）', () => {
    for (const bad of ['yes', null, {}, 0, -5, NaN]) {
      writeFileSync(
        join(dir, FILE),
        JSON.stringify([{ id: 'x', title: '坏标记', createdAt: T0, updatedAt: T0, messages: [msg({ text: 'a' })], deletedAt: bad }]),
        'utf8'
      );
      const store = newStore();
      eq(store.active().length, 1, `deletedAt=${JSON.stringify(bad)} 应回到列表：`);
      eq(store.trashed().length, 0, `deletedAt=${JSON.stringify(bad)} 不该进回收站：`);
      ok(!('deletedAt' in store.get('x')), '坏值应被清掉，不是留着：');
    }
  });

  check('_load 的「必须有消息」对回收站条目同样生效（空会话不因软删就复活）', () => {
    writeFileSync(
      join(dir, FILE),
      JSON.stringify([
        { id: 'empty', title: '空的', createdAt: T0, updatedAt: T0, messages: [], deletedAt: T0 },
        { id: 'ok', title: '有内容', createdAt: T0, updatedAt: T0, messages: [msg({ text: 'a' })], deletedAt: T0 },
      ]),
      'utf8'
    );
    const store = newStore();
    eq(store.trashed().map((x) => x.id), ['ok']);
  });

  check('★ purge 只删回收站里的：对在列会话静默拒绝（写错调用点也不会销毁用户在用的会话）', () => {
    const store = scratchStore();
    const alive = withMessage(store, '在用的');
    eq(store.purge(alive.id), false, '在列会话：');
    eq(store.active().length, 1, '必须原封不动：');
  });

  check('purge 之后文件里再也找不到该 id', () => {
    const store = scratchStore();
    const s = withMessage(store, '彻底删');
    store.softDelete(s.id);
    store.persist();
    eq(store.purge(s.id), true);
    store.persist();
    eq(store.get(s.id), undefined);
    ok(!readFileJson().some((x) => x.id === s.id), '落盘文件里也不该有：');
  });

  check('purgeTrashed 清空回收站并返回条数；空回收站时文件字节不变', () => {
    const store = scratchStore();
    const a = withMessage(store, 'a');
    const b = withMessage(store, 'b');
    const keep = withMessage(store, 'keep');
    store.softDelete(a.id);
    store.softDelete(b.id);
    store.persist();
    eq(store.purgeTrashed(), 2, '清掉的条数：');
    eq(store.active().map((x) => x.title), ['keep'], '在列的不受影响：');
    store.persist();
    const once = readFileSync(join(dir, FILE), 'utf8');
    eq(store.purgeTrashed(), 0, '再清一次：');
    eq(readFileSync(join(dir, FILE), 'utf8'), once, '空回收站时不该动文件（调用方据此跳过 persist）：');
    ok(keep.id.length > 0);
  });

  // C7 起「删会话要连 DSH 日志一起删」已经是现实 —— 但**不在这一层做**：SessionStore 只管
  // 会话数组，碰磁盘日志是调用方 `chatViewProvider._purgeOne` 的职责（它才拿得到 `dsh`，
  // 也才扫得动两个 store 的引用计数）。见 scripts/probe-purge.mjs。这条断言留着守的就是
  // 「别把 fs 删除塞回 SessionStore」。
  check('dsh-sessions/ 零改动（SessionStore 层不做任何 dsh 目录操作）', () => {
    const entries = readdirSync(dir);
    eq(entries.filter((e) => e.includes('dsh')), [], '存储目录里不该出现 dsh-* 目录：');
  });

  // ============================================================
  console.log('\n【C8c 落盘加固 · sessionStore.ts】');
  // ============================================================

  // 为什么值得这一整节：C7 的「彻底删除」会把会话的 DSH 日志一起删掉，于是主文件里那份转写
  // 成了**删除后的唯一副本** —— 从前它是 `writeFileSync` 直接覆盖、`_load` 遇坏文件 catch 成
  // 空数组，一次写崩 = 历史全失且无人察觉。这一节守的就是「那条路已经不存在」。

  const MAIN_P = join(dir, FILE);
  const BAK_P = MAIN_P + '.bak';
  const OTHER_FILE = 'probe-other.json';
  const OTHER_MAIN = join(dir, OTHER_FILE);
  const OTHER_BAK = OTHER_MAIN + '.bak';

  const readMain = () => readFileSync(MAIN_P, 'utf8');
  const readBak = () => readFileSync(BAK_P, 'utf8');
  const tmpLeftovers = () => readdirSync(dir).filter((n) => n.startsWith(FILE + '.') && n.endsWith('.tmp'));
  /** 落两代：主 = 第二代，`.bak` = 第一代（含 title 那条会话）。 */
  function twoGenerations(title = '要救的') {
    const store = scratchStore();
    withMessage(store, title);
    store.persist();
    withMessage(store, '第二代');
    store.persist();
    return store;
  }

  check('★ persist 不留 .tmp 残骸（原子写的中间态必须自己收干净）', () => {
    const store = scratchStore();
    withMessage(store, 'A');
    store.persist();
    eq(tmpLeftovers(), [], '主文件之外不该有 tmp：');
  });

  check('连续两次 persist 字节完全相同（序列化稳定，不掺时间戳之类的抖动）', () => {
    const store = scratchStore();
    withMessage(store, 'A');
    store.persist();
    const first = readMain();
    store.persist();
    ok(readMain() === first, '第二次写出来的字节应当和第一次逐字节相同：');
  });

  check('首次写不产生 .bak（盘上还没有「上一代」可备）', () => {
    const store = scratchStore();
    withMessage(store, 'A');
    store.persist();
    eq(existsSync(BAK_P), false, '.bak 不该存在：');
  });

  check('★ .bak 恒为上一代（必须在 rename **之前**滚动；写后再复制就等于没有备份）', () => {
    const store = scratchStore();
    withMessage(store, '第一代');
    store.persist();
    const gen1 = readMain();
    withMessage(store, '第二代');
    store.persist();
    ok(readBak() === gen1, '备份应当逐字节等于上一代的主文件：');
    ok(readMain() !== gen1, '主文件应当已经换成新一代：');
  });

  check('★ 主文件损坏 → 回退备份，报告 source=backup / reason=corrupt', () => {
    twoGenerations();
    writeFileSync(MAIN_P, '{"半截的 JSON', 'utf8');
    const reopened = newStore();
    eq(reopened.loadReport.source, 'backup', '来源：');
    eq(reopened.loadReport.reason, 'corrupt', '原因：');
    eq(reopened.active().map((x) => x.title), ['要救的'], '救回来的内容：');
  });

  check('顶层是合法 JSON 但不是数组 → notArray（别和「JSON 语法坏了」混为一谈）', () => {
    twoGenerations();
    writeFileSync(MAIN_P, '{"sessions":[]}', 'utf8');
    const reopened = newStore();
    eq(reopened.loadReport.source, 'backup', '来源：');
    eq(reopened.loadReport.reason, 'notArray', '原因：');
  });

  check('主文件与备份都坏 → 空列表且不抛（构造绝不能把扩展宿主带崩）', () => {
    twoGenerations();
    writeFileSync(MAIN_P, 'x', 'utf8');
    writeFileSync(BAK_P, 'y', 'utf8');
    const reopened = newStore();
    eq(reopened.all(), [], '列表：');
    eq(reopened.loadReport.source, 'empty', '来源：');
  });

  check('★ 文件不存在 → missing（首次运行必须与损坏分开，否则干净 profile 一开就误报）', () => {
    const store = scratchStore();
    eq(store.loadReport.source, 'empty', '来源：');
    eq(store.loadReport.reason, 'missing', '原因：');
    eq(store.all(), []);
  });

  // 这一条钉的是**告警接线**的判据：主文件没了、却从备份捞回来时 `reason` 同样是 `missing`，
  // 所以「reason === 'missing' 就静默」会把一次货真价实的恢复吞掉（被人手删了/被安全软件隔离了
  // 都长这样）。判据必须挂在 `source` 上：`empty + missing` 才是「首次运行」。
  check('★ 主文件不存在但有备份 → source=backup / reason=missing（别把它误当首次运行而静默）', () => {
    twoGenerations();
    rmSync(MAIN_P, { force: true });
    const reopened = newStore();
    eq(reopened.loadReport.source, 'backup', '来源：');
    eq(reopened.loadReport.reason, 'missing', '原因：');
    eq(reopened.active().map((x) => x.title), ['要救的'], '内容照旧救得回来：');
  });

  check('★★ 从备份回退之后，第一次 persist 不许把备份冲掉（否则备份在最需要它的时刻自杀）', () => {
    twoGenerations();
    const goodBak = readBak(); // 含「要救的」，是现在唯一一份好数据
    writeFileSync(MAIN_P, '坏掉的字节', 'utf8');

    const reopened = newStore();
    eq(reopened.loadReport.source, 'backup', '先确认确实走了回退：');
    withMessage(reopened, '新加的');
    reopened.persist(); // ⚠️ 此刻盘上主文件仍是坏字节，滚动备份会把好数据覆盖成坏字节

    ok(readBak() === goodBak, '备份必须原封不动：');
    eq(JSON.parse(readMain()).map((x) => x.title), ['要救的', '新加的'], '主文件已是新内容：');
  });

  check('回退后的**第二次** persist 恢复正常滚动（写成功即解除「别滚备份」）', () => {
    twoGenerations();
    writeFileSync(MAIN_P, '坏掉的字节', 'utf8');
    const reopened = newStore();
    withMessage(reopened, '新加的');
    reopened.persist(); // 跳过滚动
    const afterFirst = readMain();
    withMessage(reopened, '再加一条');
    reopened.persist(); // 这次该滚了
    ok(readBak() === afterFirst, '第二次写之前的那一代应当已经进备份：');
  });

  check('.bak 不跨文件串（chat / harness 共处一目录也各备各的）', () => {
    for (const f of [OTHER_MAIN, OTHER_BAK]) rmSync(f, { force: true });
    const a = scratchStore(); // FILE
    withMessage(a, 'A 的');
    a.persist();
    withMessage(a, 'A 的第二代');
    a.persist();

    const b = new SessionStore(dir, OTHER_FILE);
    withMessage(b, 'B 的');
    b.persist();
    withMessage(b, 'B 的第二代');
    b.persist();

    ok(readBak().includes('A 的') && !readBak().includes('B 的'), 'FILE 的备份里只该有 A 的数据：');
    ok(readFileSync(OTHER_BAK, 'utf8').includes('B 的'), '另一个 store 有自己的备份：');
  });

  check('构造时清掉**陈旧**的 .tmp，新鲜的一个不碰（另一个 VS Code 窗口可能正写着）', () => {
    const store = scratchStore();
    withMessage(store, 'A');
    store.persist();
    const stale = join(dir, `${FILE}.aaaabbbbcccc.tmp`);
    const fresh = join(dir, `${FILE}.dddd11112222.tmp`);
    writeFileSync(stale, '崩溃残骸', 'utf8');
    writeFileSync(fresh, '可能有人在写', 'utf8');
    const old = (Date.now() - STALE_TMP_MS - 60_000) / 1000;
    utimesSync(stale, old, old);
    newStore(); // 构造即扫
    eq(existsSync(stale), false, '陈旧残骸该清：');
    eq(existsSync(fresh), true, '新鲜的可能正被别的窗口写着，必须留下：');
    rmSync(fresh, { force: true });
  });

  check('扫 .tmp 只认自己文件名的前缀（chat store 不许碰 harness store 的残骸）', () => {
    const foreign = join(dir, `${OTHER_FILE}.aaaabbbbcccc.tmp`);
    writeFileSync(foreign, '别人的残骸', 'utf8');
    const old = (Date.now() - STALE_TMP_MS - 60_000) / 1000;
    utimesSync(foreign, old, old);
    newStore(); // 只扫 FILE.*
    eq(existsSync(foreign), true, '别的 store 的残骸不归它管：');
    rmSync(foreign, { force: true });
  });

  check('capToolInput：恰好等于上限原样通过，超一个字符才截（判据是 > 不是 >=）', () => {
    const exact = 'x'.repeat(MAX_TOOL_INPUT_CHARS);
    eq(capToolInput(exact), exact, '等于上限：');
    const input = 'x'.repeat(MAX_TOOL_INPUT_CHARS + 1);
    const over = capToolInput(input);
    ok(over !== input, '超一个字符就该截：');
    ok(over.startsWith(exact), '保留前 20000 字符原样：');
    ok(over.includes('入参过长'), '要带上截断标记：');
  });

  // 注意别拿「刚过界」当有界性的证据：刚好超 1 个字符时，结果反而**更长**（标记本身要占字）。
  // 保险丝要挡的是病态输入（几 MB 正文），不是省那几个字节。
  check('capToolInput 有界：再长的入参也只留上限 + 标记那点长度（这才是「保险丝」的意思）', () => {
    const huge = capToolInput('z'.repeat(MAX_TOOL_INPUT_CHARS * 100));
    ok(huge.length - MAX_TOOL_INPUT_CHARS < 32, '结果长度应当只比上限多出一个标记：');
  });

  check('capToolInput 幂等：截断结果再喂进去不再变（否则每轮转写都要「再截一次」）', () => {
    const once = capToolInput('y'.repeat(MAX_TOOL_INPUT_CHARS * 2));
    eq(capToolInput(once), once, '第二次：');
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 收尾 ----------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) {
    console.log(`   · ${f}`);
  }
  process.exit(1);
}
console.log(`✓ 全部通过：${passed}/${passed}`);
