#!/usr/bin/env node
/**
 * C10 压缩阈值覆盖自检 —— **不需要 VS Code、不需要 API key、不发任何模型调用**。
 *
 * 守的是 `patchCompactionRatios` / `compactionOverride` / `writeDerivedConfig` 这三件纯东西。
 * 它们存在的理由：DSH 的 `@deepseek-ai/dsh-compaction-basic` 在压力超过
 * `floor(contextWindow × thresholdRatio)` 时会把旧事件摘要掉（**有损、不可撤销**），
 * 而默认线 0.8 × 1M = 80 万 token 在日常用法里一辈子碰不到 —— 用户要能把它压低。
 *
 * 为什么必须是"锚点补丁"而不是环境变量：**底本是盘上那份 `<runtimeDir>/cordis.yml`**
 * （构建期从 `runtime/cordis.default.yml` 拷出来的快照），不是仓库里那份原文 —— 改仓库的东西
 * 对用户已经建好的运行时目录无效。所以本脚本的金标准用例**直接读仓库里那份真文件**，
 * 而不是手写一段理想 YAML：手写的输入永远比真东西干净，也就永远验不出真问题。
 *
 * 三条纪律（与 `scripts/runtime-patch.mjs` 同款，任何一条不成立就 throw，不猜不部分应用）：
 *   1. 锚点唯一；2. 键行唯一且必须是 `config:` 的**直属子键**；3. 值必须是纯数字字面量。
 *
 *   npm run compile && ./dist-runtime/node/node.exe scripts/probe-compaction-override.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  compactionOverride,
  patchCompactionRatios,
  writeDerivedConfig,
  writeApprovalHookFiles,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  RETAIN_RATIO_OF_THRESHOLD,
} = await load('dshHooks.js');

// ---------- 断言小工具 ----------

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

/** 断言「抛了，且话术里带这段」。用 throw 的场合都必须报出可定位的信息，光抛不算数。 */
function throws(fn, fragment) {
  let got;
  try {
    fn();
  } catch (err) {
    got = err instanceof Error ? err.message : String(err);
  }
  ok(got !== undefined, '期望抛错，但没抛');
  if (fragment) ok(got.includes(fragment), `抛错话术里没有「${fragment}」：${got}`);
}

// ---------- 现场 ----------

const scratch = mkdtempSync(join(tmpdir(), 'hello-compaction-'));
const goldenPath = join(repoRoot, 'runtime', 'cordis.default.yml');
if (!existsSync(goldenPath)) {
  console.error(`缺少金标准输入：${goldenPath}`);
  process.exit(2);
}
const golden = readFileSync(goldenPath, 'utf8');
const linesOf = (s) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** 找出两段文本里所有不同的行下标（逐行比，行数必须相同）。 */
function differingLines(a, b) {
  const la = linesOf(a);
  const lb = linesOf(b);
  ok(la.length === lb.length, `行数变了：${la.length} → ${lb.length}（改写不许增删行）`);
  const out = [];
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) out.push(i);
  return out;
}

const countOf = (s, re) => (s.match(re) ?? []).length;

try {
  // ---------- 第一块：金标准 —— 拿仓库里那份真配置当输入 ----------

  await check('金标准：只差那两行的值，其余字节逐字节原样', () => {
    const out = patchCompactionRatios(golden, { thresholdRatio: 0.5, retainRatio: 0.1 });
    const diff = differingLines(golden, out);
    eq(diff.length, 2, `不同的行数（期望恰好 2 行）`);
    const changed = diff.map((i) => linesOf(out)[i].trim());
    ok(
      changed.some((l) => /^thresholdRatio:\s*0\.5$/.test(l)),
      `thresholdRatio 没被改成 0.5：${JSON.stringify(changed)}`
    );
    ok(
      changed.some((l) => /^retainRatio:\s*0\.1$/.test(l)),
      `retainRatio 没被改成 0.1：${JSON.stringify(changed)}`
    );
    // 行尾风格不许被顺手洗掉：整份文件的 CRLF/LF 计数前后必须相同
    eq(countOf(out, /\r\n/g), countOf(golden, /\r\n/g), 'CRLF 个数变了');
    eq(countOf(out, /\n/g), countOf(golden, /\n/g), '换行总数变了');
  });

  await check('金标准：同名的兄弟键（maxTokens / compactionRetries）一个字没动', () => {
    const out = patchCompactionRatios(golden, { thresholdRatio: 0.5, retainRatio: 0.1 });
    ok(out.includes('maxTokens: 8192'), 'maxTokens 被改掉了');
    ok(out.includes('compactionRetries: 1'), 'compactionRetries 被改掉了');
  });

  await check('幂等：patch(patch(x)) === patch(x)', () => {
    const once = patchCompactionRatios(golden, { thresholdRatio: 0.5, retainRatio: 0.1 });
    eq(patchCompactionRatios(once, { thresholdRatio: 0.5, retainRatio: 0.1 }), once, '第二次改写改变了内容');
  });

  // ---------- 第二块：缩进 / 行尾 / 注释 这些"脏但合法"的输入 ----------

  const SIMPLE = ['plugins:', '- id: compaction-basic', "  name: '@x'", '  config:', '    thresholdRatio: 0.8', '    retainRatio: 0.16', ''].join('\n');

  await check('CRLF：输出仍全 CRLF，且只差两行', () => {
    const crlf = SIMPLE.replace(/\n/g, '\r\n');
    const out = patchCompactionRatios(crlf, { thresholdRatio: 0.5, retainRatio: 0.1 });
    ok(!/(?<!\r)\n/.test(out), '输出里出现了裸 LF');
    eq(differingLines(crlf, out).length, 2, '不同的行数');
  });

  await check('末行无换行：join 能逐字节还原（不该凭空多出换行）', () => {
    const noEol = SIMPLE.slice(0, -1);
    const out = patchCompactionRatios(noEol, { thresholdRatio: 0.5, retainRatio: 0.1 });
    eq(differingLines(noEol, out).length, 2, '不同的行数');
    ok(!out.endsWith('\n'), '末尾凭空多出了换行');
  });

  await check('整体缩进：顶层项带两格缩进也照样只改那两行', () => {
    const indented = SIMPLE.split('\n')
      .map((l) => (l ? '  ' + l : l))
      .join('\n');
    const out = patchCompactionRatios(indented, { thresholdRatio: 0.5, retainRatio: 0.1 });
    eq(differingLines(indented, out).length, 2, '不同的行数');
    ok(out.includes('      thresholdRatio: 0.5'), '改写后的缩进不对');
  });

  await check('行内注释与行尾空格：保留，只换数字', () => {
    const annot = SIMPLE.replace(
      '    thresholdRatio: 0.8',
      '    thresholdRatio: 0.8   # 调低了才会真的压缩  '
    );
    const out = patchCompactionRatios(annot, { thresholdRatio: 0.5, retainRatio: 0.1 });
    ok(
      out.includes('    thresholdRatio: 0.5   # 调低了才会真的压缩  '),
      `注释或空格没保住：${JSON.stringify(out.split('\n').find((l) => l.includes('thresholdRatio')))}`
    );
  });

  await check('块内的注释行与空行：逐字节不变', () => {
    const withNoise = SIMPLE.replace(
      '    retainRatio: 0.16',
      '    # 保留量，按阈值 0.2 倍算\n\n    retainRatio: 0.16'
    );
    const out = patchCompactionRatios(withNoise, { thresholdRatio: 0.5, retainRatio: 0.1 });
    ok(out.includes('    # 保留量，按阈值 0.2 倍算\n\n'), '注释行/空行被动了');
    eq(differingLines(withNoise, out).length, 2, '不同的行数');
  });

  await check('值写成 0.80 / .8：规范化成 0.8，仍只动值 token', () => {
    for (const written of ['0.80', '.8']) {
      const src = SIMPLE.replace('thresholdRatio: 0.8', `thresholdRatio: ${written}`);
      const out = patchCompactionRatios(src, { thresholdRatio: 0.8, retainRatio: 0.16 });
      ok(out.includes('thresholdRatio: 0.8'), `${written} 没被规范成 0.8`);
    }
  });

  // ---------- 第三块：绝不能打错地方（这是最容易写错的一类） ----------

  await check('相邻块的同名键：一个字没动', () => {
    const two = SIMPLE + "- id: other-plugin\n  config:\n    thresholdRatio: 0.9\n    retainRatio: 0.5\n";
    const out = patchCompactionRatios(two, { thresholdRatio: 0.5, retainRatio: 0.1 });
    ok(out.includes('thresholdRatio: 0.9'), '打到了相邻块的同名键');
    ok(out.includes('retainRatio: 0.5'), '打到了相邻块的同名键');
    eq(differingLines(two, out).length, 2, '不同的行数');
  });

  await check('本块更深层的同名键（modelPolicies）：一个字没动', () => {
    const deep = SIMPLE.replace(
      '    retainRatio: 0.16',
      '    retainRatio: 0.16\n    modelPolicies:\n      - provider: p\n        model: m\n        thresholdRatio: 0.7'
    );
    const out = patchCompactionRatios(deep, { thresholdRatio: 0.5, retainRatio: 0.1 });
    ok(out.includes('        thresholdRatio: 0.7'), '打到了 modelPolicies 里的 per-model 阈值');
    eq(differingLines(deep, out).length, 2, '不同的行数');
  });

  await check('压缩块不是最后一条：后面的条目一个字没动', () => {
    const tail = SIMPLE + '- id: after-plugin\n  config:\n    x: 1\n';
    const out = patchCompactionRatios(tail, { thresholdRatio: 0.5, retainRatio: 0.1 });
    ok(out.includes('- id: after-plugin\n  config:\n    x: 1\n'), '块范围越界了');
  });

  await check('缺 retainRatio：补一行（不是拒改）—— 否则内置默认 0.16 会顶穿新阈值', () => {
    const missing = SIMPLE.replace('    retainRatio: 0.16\n', '');
    const out = patchCompactionRatios(missing, { thresholdRatio: 0.5, retainRatio: 0.1 });
    // 这一条与其余用例形状不同：它**注定**多一行，所以不能走「行数必须相同」的比对
    ok(out.includes('    thresholdRatio: 0.5\n    retainRatio: 0.1\n'), `补出来的那行不对：${JSON.stringify(out.split('\n'))}`);
    // 把那行补出来的删掉，剩下的必须与原文只差 1 行（即 thresholdRatio 的值）
    const back = out.replace('    retainRatio: 0.1\n', '');
    eq(differingLines(missing, back).length, 1, '除了补的那行，只该有 thresholdRatio 那一行不同');
  });

  // ---------- 第四块：该拒的一律拒（响亮，且话术可定位） ----------

  const REFUSE = [
    ['找不到 compaction-basic 块', SIMPLE.replace('- id: compaction-basic', '- id: something-else')],
    ['锚点出现两次', SIMPLE + '- id: compaction-basic\n  config:\n    thresholdRatio: 0.8\n    retainRatio: 0.16\n'],
    ['块里没有 config:', SIMPLE.replace('  config:\n', '')],
    ['没有 thresholdRatio:', SIMPLE.replace('    thresholdRatio: 0.8\n', '')],
    [
      'thresholdRatio 出现两次',
      SIMPLE.replace('    retainRatio: 0.16', '    retainRatio: 0.16\n    thresholdRatio: 0.7')
    ],
    ['值带引号 "0.8"', SIMPLE.replace('thresholdRatio: 0.8', 'thresholdRatio: "0.8"')],
    ['值是指数形式 8e-1', SIMPLE.replace('thresholdRatio: 0.8', 'thresholdRatio: 8e-1')],
    ['值是 !!js 表达式', SIMPLE.replace('thresholdRatio: 0.8', 'thresholdRatio: !!js process.env.X')],
    [
      '底本用 retainTokens（绝对值）',
      SIMPLE.replace('    retainRatio: 0.16', '    retainTokens: 1000')
    ],
  ];
  for (const [what, src] of REFUSE) {
    await check(`拒绝改写：${what}`, () => {
      throws(() => patchCompactionRatios(src, { thresholdRatio: 0.5, retainRatio: 0.1 }));
    });
  }

  await check('拒绝话术里带得上可定位的信息（不是光抛）', () => {
    throws(
      () => patchCompactionRatios(SIMPLE + '- id: compaction-basic\n  config:\n    thresholdRatio: 0.8\n', { thresholdRatio: 0.5, retainRatio: 0.1 }),
      '2 次'
    );
    throws(() => patchCompactionRatios(SIMPLE.replace('thresholdRatio: 0.8', 'thresholdRatio: "0.8"'), { thresholdRatio: 0.5, retainRatio: 0.1 }), 'thresholdRatio');
  });

  // ---------- 第五块：设置值 → 覆盖对象 ----------

  await check('compactionOverride：未设 / 非数 / 越界 → undefined（= 完全不派生）', () => {
    for (const bad of [undefined, null, NaN, Infinity, '0.5', {}, [], true]) {
      eq(compactionOverride(bad), undefined, `${JSON.stringify(bad)} 应当不产生覆盖`);
    }
  });

  await check('compactionOverride：0 与 >1 被挡在界面之外（插件加载期会 throw）', () => {
    for (const bad of [0, -0.1, 1.0001, 1.5]) {
      eq(compactionOverride(bad), undefined, `${bad} 应当不产生覆盖`);
    }
  });

  await check('compactionOverride：等于默认 0.8 → undefined（这条保证「默认无行为改变」）', () => {
    eq(compactionOverride(DEFAULT_COMPACTION_THRESHOLD_RATIO), undefined, '默认值产生了覆盖');
    eq(compactionOverride(0.5).thresholdRatio, 0.5, '0.5 没有被覆盖');
    eq(compactionOverride(0.5).retainRatio, 0.1, '0.5 的 retainRatio 不是 0.1');
  });

  await check('compactionOverride：全区间满足 retainRatio < thresholdRatio（插件的加载期硬约束）', () => {
    for (const t of [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.79, 0.9, 1]) {
      const o = compactionOverride(t);
      if (!o) continue;
      ok(
        o.retainRatio < o.thresholdRatio,
        `thresholdRatio=${t} 时 retainRatio=${o.retainRatio} 没有严格小于它 —— 插件会在加载期 throw`
      );
      eq(o.retainRatio, Math.round(t * RETAIN_RATIO_OF_THRESHOLD * 1e6) / 1e6, `${t} 的倍率不对`);
    }
  });

  // ---------- 第六块：合成（writeDerivedConfig —— 唯一的写手） ----------

  /** 落一份底本到临时目录 —— 走真实读盘路径，而不是把字符串直接喂进函数。 */
  const baseFile = (name, text) => {
    const p = join(scratch, name);
    writeFileSync(p, text, 'utf8');
    return p;
  };

  await check('writeDerivedConfig：带 hooks 块时 = 原文改两行 + 末尾一个 hooks 块', () => {
    const base = baseFile('base-full.yml', golden);
    const hooksPath = baseFile('hooks.json', '{}');
    const r = writeDerivedConfig({
      storageDir: scratch,
      baseConfigPath: base,
      hooksPath,
      compaction: { thresholdRatio: 0.5, retainRatio: 0.1 },
    });
    eq(r.warning, undefined, `不该有告警：${r.warning}`);
    const text = readFileSync(r.cordisPath, 'utf8');
    ok(text.startsWith(patchCompactionRatios(golden, { thresholdRatio: 0.5, retainRatio: 0.1 })), '前半段不是「原文改两行」');
    eq(countOf(text, /hello-chat-approval-hooks/g), 1, 'hooks 块的个数');
    ok(r.cordisPath.endsWith(join('dsh-config', 'cordis.yml')), `路径不对：${r.cordisPath}`);
  });

  await check('writeDerivedConfig：hooksPath 为空（审批关着）= 只有那两行不同，无 hooks 块', () => {
    const base = baseFile('base-nohooks.yml', golden);
    const r = writeDerivedConfig({
      storageDir: scratch,
      baseConfigPath: base,
      hooksPath: '',
      compaction: { thresholdRatio: 0.5, retainRatio: 0.1 },
    });
    const text = readFileSync(r.cordisPath, 'utf8');
    ok(!text.includes('hello-chat-approval-hooks'), '不该出现 hooks 块');
    eq(differingLines(golden, text).length, 2, '不同的行数');
  });

  await check('writeDerivedConfig：底本没有 compaction-basic 块 → 不抛，只回 warning，hooks 块照挂', () => {
    const base = baseFile('base-nocompaction.yml', "- id: only-one\n  name: '@x'\n");
    const hooksPath = baseFile('hooks2.json', '{}');
    const r = writeDerivedConfig({
      storageDir: scratch,
      baseConfigPath: base,
      hooksPath,
      compaction: { thresholdRatio: 0.5, retainRatio: 0.1 },
    });
    ok(typeof r.warning === 'string' && r.warning.length > 0, '覆盖没落上却没有告警（那就是静默失效）');
    const text = readFileSync(r.cordisPath, 'utf8');
    ok(text.includes('hello-chat-approval-hooks'), '审批块被连坐掉了');
    ok(text.includes('- id: only-one'), '底本原文没保住');
  });

  await check('writeApprovalHookFiles：底本根不是块状序列 / 无 compaction 块，两种情形互不连坐', () => {
    const flat = baseFile('flat.yml', 'plugins:\n  - a\n');
    // 要追加 hooks 块 → 根必须是块状序列：仍然 throw（C1 既有语义一字不变）
    throws(
      () =>
        writeApprovalHookFiles({
          storageDir: scratch,
          nodePath: process.execPath,
          shellKind: 'posix',
          url: 'http://127.0.0.1:1',
          token: 'probe-token-not-a-secret',
          scriptTimeoutMs: 1000,
          hookTimeoutSec: 1,
          baseConfigPath: flat,
        }),
      '块状列表'
    );
    // 不追加 hooks（只做比例覆盖）时，对根的形状没有要求 —— 不该抛
    const r = writeDerivedConfig({ storageDir: scratch, baseConfigPath: flat, hooksPath: '' });
    ok(readFileSync(r.cordisPath, 'utf8') === 'plugins:\n  - a\n', '没追加 hooks 时应当原样复制');
  });
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不算失败 */
  }
}

// ---------- 收尾 ----------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
}
console.log(`✓ 全部通过：${passed}/${passed}`);
// ⚠️ 不用 process.exit()：Windows 上被管道/文件重定向的 stdout 是**异步**写，退出会把还没
// 冲出去的结论行整段丢掉（C8 的 smoke-runtime 就是这么被抓到的：exit=0 却只有第一行）。
process.exitCode = failures.length ? 1 : 0;
