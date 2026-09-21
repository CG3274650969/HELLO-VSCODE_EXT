#!/usr/bin/env node
/**
 * C14「事前 diff 预览（近似）」 —— **不需要 VS Code、不需要 API key、不发任何模型调用、碰不到盘**。
 *
 * 守的是那条验收：「写文件类工具调用前，能提前显示预计触及的路径」。
 *
 * 判据全在 `src/changeForecast.ts` 那个纯模块里（零 vscode 依赖 —— C10b 的教训：判据必须能在
 * 扩展宿主之外加载，否则只能靠肉眼）。盘上的内容由**注入的 IO** 给（`readText` / `exists`），
 * 所以 D、E 两组不建夹具文件、也不受本机 CRLF/LF 混排影响。
 *
 * 三件「照直觉写就会错」的事，每组都有反控钉着：
 *
 *   1. **工具名必须精确匹配**（B 组）：真实会话里有 `todo_write`，`includes('write')` 会假阳；
 *   2. **命中检查前必须归一化行尾**（E 组）：本仓库自己就是 CRLF/LF 混排，拿 LF 的 `old_string`
 *      去 `indexOf` 一个 CRLF 文件会**假报「找不到」**；
 *   3. **`diffs: []` 不是「读不懂」**（F 组）：DSH 在「新建文件」与「内容没变」两种情况下都给空数组，
 *      而「这份 meta 里压根没有 diffs」是另一回事 —— 前者要说话，后者要闭嘴。
 *
 *   ./dist-runtime/node/node.exe scripts/probe-change-forecast.mjs
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
  actualForecast,
  actualLine,
  FORECAST_FAILED_LINE,
  FORECAST_NO_DIFF_LINE,
  FORECAST_TOOLS,
  FORECAST_UNKNOWN_LINE,
  forecastFileChange,
  forecastLine,
  forecastProblem,
  isForecastTool,
  isPosixShapedPath,
  parseToolArgs,
  resolveTargetPath,
} = await load('changeForecast.js');
const { MAX_DIFF_ROWS } = await load('fileSnapshot.js');

// ---------- 断言小工具（体例同 probe-shell-diag） ----------

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

/** Windows 字面量路径（省得数反斜杠） */
const W = String.raw;
/** 一个假盘：给若干绝对路径 → 内容（不是在这张表里的算不存在） */
const fakeIo = (files) => ({
  readText: (abs) => (Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : undefined),
  exists: (abs) => Object.prototype.hasOwnProperty.call(files, abs),
});

const BASE = W`D:\proj`;
const ABS_TS = W`D:\proj\src\a.ts`;

// ---------- A · 入参解析（F2：wire 上 arguments 是 JSON 字符串） ----------

check('A `arguments` 是 JSON 字符串 ⇒ 解得出来（F2 的正面）', () => {
  const a = parseToolArgs('{"file_path":"src/a.ts","content":"x"}');
  eq(a && a.file_path, 'src/a.ts', '解析结果不对');
  eq(a && a.content, 'x', '解析结果不完整');
});

check('A 已经是个对象 ⇒ 直接用它（不是所有运行时都给字符串）', () => {
  const a = parseToolArgs({ file_path: 'b.ts' });
  eq(a && a.file_path, 'b.ts', '对象入参被丢了');
});

check('A 畸形 / 非对象 / 空 ⇒ 一律 undefined，**永不抛**', () => {
  for (const raw of ['', '   ', '{', 'not json', '3', '"a"', '[]', 'null', 'true', undefined, null]) {
    const r = parseToolArgs(raw);
    ok(r === undefined, `parseToolArgs(${JSON.stringify(raw)}) 应给 undefined，实到 ${JSON.stringify(r)}`);
  }
});

// ---------- B · 工具门（F5：todo_write 存在） ----------

check('B 精确匹配 write/edit；**todo_write 不许误伤**（子串判据的假阳）', () => {
  eq(FORECAST_TOOLS, ['write', 'edit'], '工具集合被改了');
  for (const n of ['write', 'edit']) ok(isForecastTool(n), `${n} 应被认作写文件的工具`);
  for (const n of ['todo_write', 'write_file', 'Write', 'WRITE', 'bash', 'read', 'multi_edit', '', undefined, 3, null]) {
    ok(!isForecastTool(n), `${JSON.stringify(n)} 被误认成写文件的工具 —— 它会在卡上写一行假的预计`);
  }
});

// ---------- C · 路径（POSIX 早退是「问但不抓快照」的全部依据） ----------

check('C 相对路径按 base 解析；绝对路径原样；POSIX / 空 ⇒ 拿不到；UNC 原样放行', () => {
  eq(resolveTargetPath('src/a.ts', BASE), ABS_TS, '相对路径解析不对');
  eq(resolveTargetPath(W`D:\other\b.ts`, BASE), W`D:\other\b.ts`, '绝对路径被改写了');
  eq(resolveTargetPath('/mnt/d/x/a.ts', BASE), undefined, 'POSIX 形态被解析成了盘上某个位置 —— 那正是事故的成因');
  // UNC **不按 POSIX 拒**（那不是「把 D:\x 写成了 POSIX」，是合法的绝对位置）⇒ 原样返回，
  // 越界与否交给 `_isInside`（跨根 ⇒ 按区外问一次）。
  eq(resolveTargetPath('//server/share/a.ts', BASE), '\\\\server\\share\\a.ts', 'UNC 没被当成绝对位置放行');
  for (const bad of ['', '   ', undefined, null]) eq(resolveTargetPath(bad, BASE), undefined, `空入参 ${JSON.stringify(bad)} 应有 undefined`);
  eq(resolveTargetPath('src/a.ts', ''), undefined, '没有 base 时不该瞎猜一个位置');
});

check('C POSIX 判据的形状：单斜杠是，双斜杠（UNC）不是', () => {
  ok(isPosixShapedPath('/mnt/d/x'), '单斜杠不认');
  ok(!isPosixShapedPath('//server/share'), 'UNC 被当成 POSIX 形态 —— 它会走进「按 Windows 相对根解析」那条错路');
  ok(!isPosixShapedPath(W`D:\x`), 'Windows 绝对路径被当成 POSIX');
  ok(!isPosixShapedPath('src/a.ts'), '相对路径被当成 POSIX');
});

check('C POSIX 形态的目标：拿得到 raw、拿不到 abs，并**明说为什么不预览**', () => {
  const f = forecastFileChange('write', { file_path: '/mnt/d/proj/src/a.ts', content: 'x' }, BASE, fakeIo({}));
  ok(f, 'POSIX 形态整条被丢了 —— 卡上会连「要动哪个文件」都不说');
  eq(f.raw, '/mnt/d/proj/src/a.ts', 'raw 应原样保留');
  eq(f.abs, undefined, '不该给出一个 abs（那会是个错位置）');
  ok(f.diffNote && f.diffNote.includes('无法解析'), `note 没说清「解析不出位置」：${f.diffNote}`);
  eq(f.diff, undefined, '解析不出位置却给了 diff');
});

// ---------- D · kind 与近似 diff ----------

check('D write：盘上没有 ⇒ 新建（无 diff，note 说「新建文件」）', () => {
  const f = forecastFileChange('write', { file_path: 'src/new.ts', content: 'a\n' }, BASE, fakeIo({}));
  eq(f.kind, 'create', 'kind 应是 create');
  eq(f.exists, false, 'exists 应是 false');
  eq(f.diff, undefined, '新建文件不该有 diff');
  eq(f.diffNote, '新建文件', 'note 不对');
});

check('D write：盘上有 ⇒ 相对**现在盘上**的内容算 diff（这是与轮尾审阅不同的那个读数）', () => {
  const io = fakeIo({ [ABS_TS]: 'const a = 1;\nconst b = 2;\n' });
  const f = forecastFileChange('write', { file_path: 'src/a.ts', content: 'const a = 1;\nconst b = 3;\n' }, BASE, io);
  eq(f.kind, 'modify', 'kind 应是 modify');
  eq(f.exists, true, 'exists 应是 true');
  ok(f.diff && f.diff.length >= 2, '应有的 diff 没算出来');
  eq(f.diff.filter((l) => l.kind === 'del').map((l) => l.text), ['const b = 2;'], '删除行不对');
  eq(f.diff.filter((l) => l.kind === 'add').map((l) => l.text), ['const b = 3;'], '新增行不对');
  eq(f.diffNote, '按现在盘上的内容算的', 'note 没交代这个 diff 的基准');
});

check('D write：三种「没法预览」各自有话说，且**不给空 diff 冒充**', () => {
  const cases = [
    ['内容与现在盘上完全一样 —— 这次调用不会改变它', { [ABS_TS]: 'x\n' }, 'x\n'],
    ['入参里没有可读的 content', { [ABS_TS]: 'x\n' }, undefined],
  ];
  for (const [want, files, content] of cases) {
    const f = forecastFileChange('write', { file_path: 'src/a.ts', content }, BASE, fakeIo(files));
    eq(f.diffNote, want, `note 不对（content=${JSON.stringify(content)}）`);
    eq(f.diff, undefined, '说不出所以然却给了一份 diff');
  }
  // 存在但读不出内容（二进制 / 超大）：exists 为真、readText 给 undefined
  const f = forecastFileChange('write', { file_path: 'src/a.ts', content: 'y\n' }, BASE, {
    readText: () => undefined,
    exists: () => true,
  });
  ok(f.diffNote && f.diffNote.includes('读不出来'), `读不出内容时 note 不对：${f.diffNote}`);
  eq(f.diff, undefined, '读不出盘上的内容却编出了 diff');
});

check('D edit：diff **只在替换片段上**算（不含上下文），kind 恒 modify', () => {
  const io = fakeIo({ [ABS_TS]: 'a\nb\nc\n' });
  const f = forecastFileChange('edit', { file_path: 'src/a.ts', old_string: 'b', new_string: 'B' }, BASE, io);
  eq(f.kind, 'modify', 'edit 恒 modify（它不建文件）');
  eq(f.diff.map((l) => l.kind), ['del', 'add'], '片段 diff 的行型不对');
  eq(f.diff.map((l) => l.text), ['b', 'B'], '片段 diff 的内容不对');
  ok(!f.diff.some((l) => l.text === 'a'), '把上下文行也算进来了 —— 那是「整文件 diff」，本次明确不做');
});

check('D 超长 diff ⇒ 截断标记（前段 + truncated）', () => {
  // 公共前缀造到 MAX_DIFF_ROWS 行以上：中段只有一行，LCS 不会爆炸，但总行数超限
  const head = Array.from({ length: MAX_DIFF_ROWS + 50 }, (_, i) => `line ${i}`).join('\n');
  const io = fakeIo({ [ABS_TS]: `${head}\nold\n` });
  const f = forecastFileChange('write', { file_path: 'src/a.ts', content: `${head}\nnew\n` }, BASE, io);
  eq(f.diffTruncated, true, '超长 diff 没置 truncated');
  eq(f.diff.length, MAX_DIFF_ROWS, `截断后的行数不对：${f.diff.length}`);
});

// ---------- E · old_string 的命中检查（事前就能说出「这次会失败」） ----------

check('E 命中 0 次 / 1 次 / 2 次（未开 replace_all）/ 2 次（开了）四种结论', () => {
  const io2 = fakeIo({ [ABS_TS]: 'x\nhit\nhit\n' });
  const mk = (old_string, replace_all) =>
    forecastFileChange(
      'edit',
      { file_path: 'src/a.ts', old_string, new_string: 'HIT', replace_all },
      BASE,
      io2
    );

  const zero = mk('不存在的片段', false);
  eq(zero.finding, { occurrences: 0, replaceAll: false }, '命中数不对');
  ok(forecastProblem(zero) && forecastProblem(zero).includes('找不到'), `命中 0 次的结论不对：${forecastProblem(zero)}`);

  const one = mk('x', false);
  eq(one.finding, { occurrences: 1, replaceAll: false }, '命中数不对');
  eq(forecastProblem(one), undefined, '唯一命中却被判成会失败');

  const two = mk('hit', false);
  eq(two.finding, { occurrences: 2, replaceAll: false }, '命中数不对');
  ok(
    forecastProblem(two) && forecastProblem(two).includes('2 处'),
    `命中 2 次且没开 replace_all 的结论不对：${forecastProblem(two)}`
  );

  const twoAll = mk('hit', true);
  eq(twoAll.finding, { occurrences: 2, replaceAll: true }, '命中数不对');
  eq(forecastProblem(twoAll), undefined, '开了 replace_all 却仍判成会失败');
});

check('E **CRLF 反控**：盘上是 CRLF、模型给的 old_string 是 LF ⇒ 仍算命中（不许假报「找不到」）', () => {
  const io = fakeIo({ [ABS_TS]: 'const a = 1;\r\nconst b = 2;\r\n' });
  const f = forecastFileChange(
    'edit',
    { file_path: 'src/a.ts', old_string: 'const a = 1;\nconst b = 2;\n', new_string: 'x' },
    BASE,
    io
  );
  eq(f.finding, { occurrences: 1, replaceAll: false }, '行尾没归一化 ⇒ 把一个能成功的编辑假报成「找不到」');
  eq(forecastProblem(f), undefined, 'CRLF 文件上的合法编辑被判成会失败');
});

check('E 不读盘就说得出的两种失败：old_string 与 new_string 相同、目标文件不存在', () => {
  const io = fakeIo({ [ABS_TS]: 'a\n' });
  const same = forecastFileChange('edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'a' }, BASE, io);
  eq(same.sameText, true, 'sameText 没标出来');
  ok(forecastProblem(same) && forecastProblem(same).includes('会被拒'), `同文本的结论不对：${forecastProblem(same)}`);

  const missing = forecastFileChange('edit', { file_path: 'src/gone.ts', old_string: 'a', new_string: 'b' }, BASE, fakeIo({}));
  eq(missing.exists, false, 'exists 不对');
  ok(forecastProblem(missing) && forecastProblem(missing).includes('盘上没有'), `文件不存在时的结论不对：${forecastProblem(missing)}`);
});

check('E 入参不完整（缺 old_string / new_string）⇒ 有话说、不抛', () => {
  const f = forecastFileChange('edit', { file_path: 'src/a.ts', old_string: 'a' }, BASE, fakeIo({}));
  eq(f.diff, undefined, '缺 new_string 却给了 diff');
  eq(f.diffNote, '入参不完整（缺 old_string / new_string）', 'note 不对');
});

check('E 盘上读不出内容 ⇒ **不给** finding（不猜），但仍给 kind', () => {
  const f = forecastFileChange('edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, BASE, {
    readText: () => undefined,
    exists: () => true,
  });
  eq(f.finding, undefined, '读不出内容却给出了命中数 —— 那是猜的');
  eq(f.kind, 'modify', 'kind 应仍给得出');
  eq(f.exists, true, 'exists 不对');
});

// ---------- F · 那行文案 ----------

check('F forecastLine：事前那行带路径、性质、增删数；有问题就升级成 warn', () => {
  const io = fakeIo({ [ABS_TS]: 'a\nb\n' });
  const good = forecastFileChange('write', { file_path: 'src/a.ts', content: 'a\nc\nd\n' }, BASE, io);
  const line = forecastLine(good);
  ok(line.text.startsWith('预计改动 '), `主文案不对：${line.text}`);
  ok(line.text.includes(ABS_TS), '主文案里没有路径 —— 那这行就没解决「看不出要动哪个文件」');
  ok(line.text.includes('修改'), '没写改动的性质');
  eq(line.level, 'ok', '没问题的预测不该是告警色');
  ok(line.title.includes('预测'), 'title 里没交代这是预测（口径全靠它）');

  const bad = forecastFileChange('edit', { file_path: 'src/gone.ts', old_string: 'a', new_string: 'b' }, BASE, fakeIo({}));
  const lineB = forecastLine(bad);
  eq(lineB.level, 'warn', '看出会失败的预测没升级成 warn');
  ok(lineB.title.includes('盘上没有'), `title 里没写出问题：${lineB.title}`);

  // 解析不出位置的（POSIX）也要 warn：它不会进审阅
  const posix = forecastFileChange('write', { file_path: '/mnt/d/x', content: 'a' }, BASE, fakeIo({}));
  eq(forecastLine(posix).level, 'warn', 'POSIX 形态没升级成 warn');
});

// ---------- G · 实际那半（tool/result.meta.diffs —— 一直在线上、此前没人读） ----------

check('G 正常一份：一个 hunk → path/hunks/diff 都在，纯插入的 oldText=null 当空串', () => {
  const a = actualForecast({ diffs: [{ path: 'src/a.ts', oldText: 'x\n', newText: 'y\n' }] });
  ok(a, '正常的一份被丢了');
  eq(a.path, 'src/a.ts', 'path 没取到');
  eq(a.hunks, 1, 'hunk 数不对');
  eq(a.diff.map((l) => l.kind), ['del', 'add'], 'diff 行型不对');
  eq(a.diffTruncated, false, '不该截断');

  const ins = actualForecast({ diffs: [{ path: 'n.ts', oldText: null, newText: 'a\nb\n' }] });
  eq(ins.diff.map((l) => l.kind), ['add', 'add'], '纯插入（oldText=null）没当成「从空到有」');
  eq(ins.diff.map((l) => l.text), ['a', 'b'], '纯插入的内容不对');
});

check('G 多 hunk：合并成一段并标出段数（DSH 是**每个 hunk 一条**，别把它当多文件）', () => {
  const a = actualForecast({
    diffs: [
      { path: 'src/a.ts', oldText: 'x\n', newText: 'y\n' },
      { path: 'src/a.ts', oldText: 'p\n', newText: 'q\n' },
    ],
  });
  eq(a.hunks, 2, 'hunk 数不对');
  eq(a.path, 'src/a.ts', 'path 不对');
  ok(
    a.diff.some((l) => l.kind === 'ctx' && l.text.includes('2 段改动')),
    '两段之间没有分隔标记 —— 读起来会像一段连续的改动'
  );
});

check('G `diffs: []` ⇒ 有结论但 hunks=0（新建 / 内容没变），**不是** undefined（读不懂）', () => {
  const a = actualForecast({ diffs: [] });
  ok(a !== undefined, '空 diffs 被当成「读不懂」了 —— 新建文件那条会变成「这次调用失败了」');
  eq(a.hunks, 0, 'hunk 数不对');
  eq(a.diff, [], 'diff 应是空的');
  const line = actualLine(a, ABS_TS);
  ok(line.text.includes('没报改动'), `文案不对：${line.text}`);
  ok(line.text.includes(ABS_TS), 'DSH 没给 path 时应沿用事前那个（否则「实际改动」后面空着一块）');
  ok(line.title.includes('新建') && line.title.includes('一样'), 'title 没说清空 diffs 的两种成因（分不出来就得说分不出来）');
});

check('G 读不懂的一份 ⇒ undefined，**永不抛**（老运行时 / 嵌套调用 / 失败路径压根不带 meta）', () => {
  for (const meta of [undefined, null, {}, { diffs: 'x' }, { diffs: [null] }, { diffs: [{}] }, { diffs: [1] }, [], 3, 'x']) {
    const r = actualForecast(meta);
    ok(r === undefined, `actualForecast(${JSON.stringify(meta)}) 应给 undefined，实到 ${JSON.stringify(r)}`);
  }
});

check('G actualLine：DSH 报的 path 优先于事前那个；超长置截断提示', () => {
  const a = actualForecast({ diffs: [{ path: 'DSH\\报的.ts', oldText: 'x\n', newText: 'y\n' }] });
  const line = actualLine(a, ABS_TS);
  ok(line.text.includes('DSH\\报的.ts'), `path 没优先用 DSH 报的那个：${line.text}`);
  ok(!line.text.includes(ABS_TS), '两处路径同时出现 —— 同一行里两个位置读数会互相打架');
  eq(line.level, 'ok', '正常一份应是 ok');

  const head = Array.from({ length: MAX_DIFF_ROWS + 20 }, (_, i) => `l${i}`).join('\n');
  const big = actualForecast({ diffs: [{ path: 'a.ts', oldText: `${head}\nold\n`, newText: `${head}\nnew\n` }] });
  eq(big.diffTruncated, true, '超长没置截断');
  ok(actualLine(big).title.includes('截断') || actualLine(big).title.includes('只保留'), 'title 里没提截断');
});

check('G 三条「预测作废」的话都在：各自说得出怎么了，且互不重复', () => {
  ok(FORECAST_FAILED_LINE.includes('失败了'), `失败那句没说是失败：${FORECAST_FAILED_LINE}`);
  ok(FORECAST_FAILED_LINE.includes('只是预测'), `失败那句没说「上面那行只是预测」：${FORECAST_FAILED_LINE}`);
  ok(FORECAST_NO_DIFF_LINE.includes('没带回'), `没 diff 那句没说清缺的是什么：${FORECAST_NO_DIFF_LINE}`);
  ok(FORECAST_NO_DIFF_LINE.includes('只是预测'), `没 diff 那句没说「上面那行只是预测」：${FORECAST_NO_DIFF_LINE}`);
  // 中断那句**不必**出现「预测」二字：它是**整句替换**掉那行预测的（同时不送 diff ⇒ 展开区也
  // 被收起），所以卡上已经不存在一条读起来像结果的「预计」—— 它要说的是「改没改不可知」，
  // 比再重复一句「那只是预测」有用。三句互不相同才是这里要钉的（重复 = 三种状态分不出）。
  ok(FORECAST_UNKNOWN_LINE.includes('未知'), `中断那句没说是未知：${FORECAST_UNKNOWN_LINE}`);
  eq(new Set([FORECAST_FAILED_LINE, FORECAST_UNKNOWN_LINE, FORECAST_NO_DIFF_LINE]).size, 3, '三句话里有重复');
});

// ---------- H · 结构守卫（判据不许漂回调用方 / 接线不许被拆掉） ----------

check('H `_fsTargetAbs` 必须是**委派**，且 POSIX 判据全仓只有两个「合法住户」', () => {
  const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8');
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.includes('private _fsTargetAbs('));
  ok(at >= 0, '找不到 _fsTargetAbs');
  const body = lines.slice(at, at + 20).join('\n');
  ok(/resolveTargetPath\(/.test(body), '_fsTargetAbs 没有委派给 changeForecast.resolveTargetPath');
  ok(
    !/startsWith\('\/'\)/.test(body),
    '_fsTargetAbs 体内又自己写了一份 POSIX 判据 —— 判据只准有一处（卡片与批准条必须是同一个函数）'
  );

  // `src/` 下允许有这份字面量的**只有两个**：changeForecast（拒绝）与 shellDiag（翻译）。
  // 两者的用途相反又必须同形 —— shellDiag 那边的注释里写着理由，别去「顺手合并」。
  const files = readdirSync(join(repoRoot, 'src')).filter((f) => f.endsWith('.ts')).sort();
  const holders = files.filter((f) => /startsWith\('\/'\)/.test(readFileSync(join(repoRoot, 'src', f), 'utf8')));
  eq(holders, ['changeForecast.ts', 'shellDiag.ts'], 'POSIX 判据的宿主变了 —— 这两份同形不同命，多一处就是第三个读数');
});

check('H 接线：事前在 `tool/call`、事后在 `tool/result` 与**两处 unknown 收尾**都在', () => {
  const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8');
  const callCase = src.indexOf("case 'tool/call':");
  const resultCase = src.indexOf("case 'tool/result':");
  ok(callCase > 0 && resultCase > callCase, '找不到那两个 case 分支');
  const callBody = src.slice(callCase, resultCase);
  ok(callBody.includes('this._forecastBefore('), '`tool/call` 分支里没有事前预测的接线');

  // 事后一共三处：tool/result（真结果）+ `_finishTurn` / `_surfaceLiveError` 的 unknown 循环。
  // **少一处就是一整类「预测永远挂在卡上」**（中断/出错那条路上没有任何 tool/result 会到）。
  const after = src.split('this._forecastAfter(').length - 1;
  eq(after, 3, `_forecastAfter 的调用点有 ${after} 处，应为 3 处（结果 + 两处 unknown 收尾）`);

  // 状态必须随轮清空：不清的话下一轮同 id 的卡会收到上一轮那条预测的收尾
  const base = src.indexOf('private _captureBaselineAtTurnStart(');
  const baseBody = src.slice(base, base + 900);
  ok(baseBody.includes('_forecastPaths.clear()'), '轮首没清预测表 —— 上一轮的键会留到下一轮');
});

check('H 预测**不落盘**：ChatMessage 里没有它的字段（它是直播提示，不是转录内容）', () => {
  const proto = readFileSync(join(repoRoot, 'src', 'protocol.ts'), 'utf8');
  const at = proto.indexOf('export interface ChatMessage');
  const body = proto.slice(at, proto.indexOf('\n}', at));
  ok(!/forecast/i.test(body), 'ChatMessage 里长出了 forecast 字段 —— 预测会跟着会话落盘、重放时变成「事实」');
  const store = readFileSync(join(repoRoot, 'src', 'sessionStore.ts'), 'utf8');
  ok(!/forecast/i.test(store), 'sessionStore 里出现了 forecast —— 同上');
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
