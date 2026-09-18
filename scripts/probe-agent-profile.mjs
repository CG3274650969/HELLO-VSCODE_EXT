#!/usr/bin/env node
/**
 * C12 项目级 agent profile 的自检 —— **不需要 VS Code、不需要真 API key**。
 *
 * 它守的是四件事：
 *   一、**解析**：profile.json 的每一种坏法都只该变成一行错误，绝不该抛、绝不该整体作废；
 *   二、**「只能加严」**（`compileProfile`）—— **这一段是本功能的命门**。profile 是工作区里的
 *       一个文件，agent 的 write 工具技术上能改它（工作区内的写按 C1 的设计不弹条）。整个设计
 *       就建立在"这份文件的全部语义只能是收紧"之上，所以它必须有一组表驱动的正反双控盯着；
 *   三、**插件本体的决策表**：把生成出来的插件文件当纯模块直接 `import()`，喂一个假 ctx 抓住它的
 *       `agent/created` 监听器逐条喂载荷。零成本，而且**条条都是真跑那段代码**；
 *   四、**端到端启动一次真运行时**：派生配置挂上真插件 → 真跑一轮 → 读盘上 `request/header` 的
 *       `header.tools`，断言被禁的工具**真的不在**模型视野里 —— 而且是**反控**着断言
 *       （不带 profile 那轮里它必须在），否则"没有 bash"可能只是这一轮压根没装配工具。
 *
 * 为什么第四段值得跑：`request/header` 里带 `tools`（`dsh-agent-loop` 的 `canonicalHeader`），
 * 而 `dsh-tools` 的 `wireSchemas` 读的是**加了限制之后**的视图（`this.view(scope).visible`）——
 * 所以"工具从视野里消失"这件事**在盘上就有证据**，不必靠肉眼问 agent「你能用 bash 吗」。
 *
 * ⚠️ 第四段**刻意用假 key**（`sk-000…`）：请求会 401 失败，但 `request/header` 是在请求**构建期**
 * 就落盘的，所以断言照样成立、且**不花真钱**。反过来，「压根没跑起来」必须响亮报错 ——
 * 绝不能把"没跑起来"读成"验过了"。
 *
 *   node scripts/probe-agent-profile.mjs [--runtime dist-runtime]
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTurn } from './dsh-turn.mjs';
import { readSessionEvents } from './dsh-session-log.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  if (actual !== expected) throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 递归列出目录下所有文件（读不到就跳过）。 */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else {
      try {
        statSync(p);
        out.push(p);
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return out;
}

// ---- 参数：--runtime（默认 dist-runtime，仓库外/没建就响亮跳过） ----
const argv = process.argv.slice(2);
let runtimeDir = 'dist-runtime';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--runtime') runtimeDir = argv[++i];
}
const runtimeAbs = resolve(repoRoot, runtimeDir);
const manifestPath = join(runtimeAbs, 'runtime.json');
const profileJs = join(repoRoot, 'out', 'agentProfile.js');
const pluginJs = join(repoRoot, 'out', 'toolPolicyPlugin.js');
const hooksJs = join(repoRoot, 'out', 'dshHooks.js');

if (!existsSync(manifestPath)) {
  console.log(`⚠ 跳过：${manifestPath} 不存在（先跑 node scripts/build-runtime.mjs），别把这次通过当成验过了`);
  process.exitCode = 0;
} else if (!existsSync(profileJs) || !existsSync(pluginJs) || !existsSync(hooksJs)) {
  console.error(`缺少编译产物（${profileJs} / ${pluginJs} / ${hooksJs}）\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
  process.exitCode = 2;
} else {
  await main();
}

async function main() {
  const prof = await import(pathToFileURL(profileJs).href);
  const pol = await import(pathToFileURL(pluginJs).href);
  const hooks = await import(pathToFileURL(hooksJs).href);
  const { readProfileFile, parseProfileFile, compileProfile, profileSummary, noProfile, KNOWN_TOOL_NAMES } = prof;
  const { writeToolPolicyPluginFiles } = pol;
  const { writeDerivedConfig } = hooks;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const node = join(runtimeAbs, manifest.node);
  const entry = join(runtimeAbs, manifest.entry);
  const baseConfig = join(runtimeAbs, manifest.config);

  console.log('C12 项目级 agent profile —— 四段：解析 / 只能加严 / 插件决策表 / 真运行时端到端');
  console.log(`  运行时 ${runtimeAbs}（dsh ${manifest.dshVersion ?? '?'}）`);
  console.log('');

  // 派生文件写临时目录：不污染仓库，也不碰任何人的真配置
  const dir = mkdtempSync(join(tmpdir(), 'hello-profile-'));

  const SETTINGS = { enabled: true, outsideWorkspace: true, patterns: ['\\brm\\b', '\\bdrop\\b'] };

  // ==================== 一、解析：任何坏法都只该变成一行错误 ====================

  await check('readProfileFile：读不到 / 不是文件 / 超大 ⇒ 一律当"没有这个文件"，绝不抛', () => {
    const missing = readProfileFile(join(dir, 'nope', 'profile.json'));
    eq(missing.text, '', '不存在的文件竟然读出了内容');
    eq(missing.missing, true, '不存在的文件没标 missing');

    const good = join(dir, 'ok.json');
    writeFileSync(good, '{"profiles":{}}', 'utf8');
    eq(readProfileFile(good).missing, false, '存在的文件被当成没有');

    // 目录当文件读 → 该走 missing 分支而不是抛
    eq(readProfileFile(dir).missing, true, '目录没被当成"读不到"');

    // 一个几 MB 的 JSON 只会是写坏了或写错了地方 —— 直接当没有，别把扩展卡在解析上
    const huge = join(dir, 'huge.json');
    writeFileSync(huge, '{"profiles":{}}' + ' '.repeat(300 * 1024), 'utf8');
    eq(readProfileFile(huge).missing, true, '超大文件没被挡住');
    eq(readProfileFile(huge, 1024).missing, true, '缩小的上限没生效');
  });

  await check('parseProfileFile：好文件原样读出来（名字顺序 == 声明顺序）', () => {
    const r = parseProfileFile(
      JSON.stringify({
        active: '严格',
        profiles: {
          严格: { model: 'deepseek-reasoner', approval: { patterns: ['x'] }, tools: { deny: ['bash'] } },
          省钱: { model: 'deepseek-chat' },
        },
      })
    );
    eq(r.errors.length, 0, `不该有错：${r.errors.join('；')}`);
    eq(r.names.join(','), '严格,省钱', '名字顺序不对（菜单顺序靠它）');
    eq(r.recommended, '严格', 'active 没认出来');
    eq(r.profiles['严格'].model, 'deepseek-reasoner', 'model 没读出来');
    eq(r.profiles['省钱'].approval.patterns.length, 0, '没写 approval 的 profile 该得到空清单');
  });

  await check('parseProfileFile：空/空白文本 → 空表，且没有错误（文件不存在是最正常的状态）', () => {
    for (const text of ['', '   \n\t ']) {
      const r = parseProfileFile(text);
      eq(r.names.length, 0, '空白文本竟然读出了 profile');
      eq(r.errors.length, 0, `空白文本不该报错：${r.errors.join('；')}`);
    }
  });

  await check('parseProfileFile：不是 JSON / 根不是对象 → 报一条错，不抛', () => {
    const bad = parseProfileFile('{ not json');
    eq(bad.names.length, 0, '坏 JSON 读出了 profile');
    ok(bad.errors.length === 1 && /JSON/.test(bad.errors[0]), `没有报 JSON 错：${bad.errors.join('；')}`);
    for (const text of ['[1,2]', '"x"', '42', 'null']) {
      const r = parseProfileFile(text);
      eq(r.names.length, 0, `${text} 竟然读出了 profile`);
      ok(r.errors.length >= 1, `${text} 没有报错`);
    }
  });

  await check('parseProfileFile：**好的部分照用，坏的部分逐条报错**（不做整体作废）', () => {
    const r = parseProfileFile(
      JSON.stringify({
        profiles: {
          ok: { model: 'm1' },
          bad: 42,
          good2: { model: 'm2', approval: { patterns: ['p'] } },
        },
      })
    );
    eq(r.names.join(','), 'ok,good2', '一个坏 profile 把整份文件带塌了');
    eq(r.profiles['good2'].approval.patterns[0], 'p', '同一条里的好字段没被保住');
    ok(r.errors.some((e) => /bad/.test(e)), '没说清是哪个 profile 坏了');
  });

  await check('parseProfileFile：未知字段逐条报错（含顶层 / profile / approval / tools 四层）', () => {
    const r = parseProfileFile(
      JSON.stringify({
        nope: 1,
        profiles: { a: { model: 'm', wat: 2, approval: { nope: 3 }, tools: { allow: ['read'], nope: 4 } } },
      })
    );
    for (const key of ['nope', 'wat', 'allow']) {
      ok(r.errors.some((e) => e.includes(key)), `未知字段 ${key} 没被报出来：${r.errors.join('；')}`);
    }
    // 未知字段不阻断：认得的那部分照常生效
    eq(r.profiles['a'].model, 'm', '有未知字段就把整份 profile 丢了');
  });

  await check('parseProfileFile：字段类型不对 → 逐条报错，不抛', () => {
    const r = parseProfileFile(
      JSON.stringify({
        profiles: {
          a: { model: 7, approval: 'x', tools: [] },
          b: { approval: { patterns: 'not-an-array' } },
          c: { approval: { patterns: ['ok', 5, ''] } },
        },
      })
    );
    ok(r.errors.length >= 4, `类型错没报全：${r.errors.join('；')}`);
    eq(r.profiles['c'].approval.patterns.join(','), 'ok', 'patterns 里的坏条目没被挑掉');
  });

  await check('parseProfileFile：tools.deny 里的未知工具名在**编译前**就被丢掉并报错', () => {
    // 这条非有不可：运行期 `tools.restrict()` 是**整批**校验名字的，一个未知名字会让
    // **整张 deny 表**一起抛掉 —— 「禁 bash」会因为旁边写错一个词而静默失效。
    const r = parseProfileFile(JSON.stringify({ profiles: { a: { tools: { deny: ['bash', 'rm_rf', 'read'] } } } }));
    eq(r.profiles['a'].tools.deny.join(','), 'bash,read', '未知工具名没被过滤掉');
    ok(r.errors.some((e) => e.includes('rm_rf')), `没说清哪个名字不对：${r.errors.join('；')}`);
  });

  await check('parseProfileFile：deny 去重；已知工具名的清单本身不为空', () => {
    const r = parseProfileFile(JSON.stringify({ profiles: { a: { tools: { deny: ['bash', 'bash'] } } } }));
    eq(r.profiles['a'].tools.deny.length, 1, 'deny 没去重');
    ok(KNOWN_TOOL_NAMES.includes('bash') && KNOWN_TOOL_NAMES.includes('read'), '已知工具名清单不完整');
  });

  await check('parseProfileFile：active 指向不存在的 profile → 报错但不当致命（它只是建议项）', () => {
    const r = parseProfileFile(JSON.stringify({ active: 'nope', profiles: { a: {} } }));
    eq(r.recommended, undefined, '指向不存在的项竟然还给了建议');
    eq(r.names.join(','), 'a', '一条 active 错误把 profiles 带塌了');
    ok(r.errors.some((e) => e.includes('nope')), '没报 active 的问题');
  });

  await check('parseProfileFile：profile 名空/超长 → 丢掉并报错', () => {
    const r = parseProfileFile(JSON.stringify({ profiles: { '  ': {}, ['x'.repeat(70)]: {}, ok: {} } }));
    eq(r.names.join(','), 'ok', '坏名字没被丢掉');
    eq(r.errors.length, 2, `坏名字的报错条数不对：${r.errors.join('；')}`);
  });

  await check('profileSummary：每个覆盖方向都要在摘要里露出来', () => {
    const s = profileSummary({
      model: 'm',
      approval: { enabled: true, outsideWorkspace: true, patterns: ['a', 'b'] },
      tools: { deny: ['bash'] },
    });
    for (const bit of ['m', '审批强制开', '+2 条', 'bash']) ok(s.includes(bit), `摘要里没有「${bit}」：${s}`);
    eq(profileSummary({ approval: { patterns: [] }, tools: { deny: [] } }), '', '什么都没覆盖却给了非空摘要');
  });

  // ==================== 二、只能加严（本功能的命门） ====================

  await check('compileProfile：没给 profile → 逐字等于设置本身（零回归的根据）', () => {
    const e = compileProfile(undefined, SETTINGS);
    eq(e.name, null, 'name 该是 null');
    eq(e.model, undefined, '没 profile 却给了 model');
    eq(e.approval.enabled, SETTINGS.enabled, 'enabled 被改了');
    eq(e.approval.outsideWorkspace, SETTINGS.outsideWorkspace, 'outsideWorkspace 被改了');
    eq(e.approval.patterns.join(','), SETTINGS.patterns.join(','), 'patterns 被改了');
    eq(e.toolDeny.length, 0, '没 profile 却给了 deny');
    // noProfile() 是同一个形状 —— 两处各写一遍的话迟早会漂
    eq(noProfile(SETTINGS).approval.patterns.join(','), SETTINGS.patterns.join(','), 'noProfile 与设置不一致');
  });

  await check('**只能加严 · enabled**：设置关 + profile 开 ⇒ 开；设置开 + profile 不写 ⇒ 开；写 false 根本进不来', () => {
    const off = { ...SETTINGS, enabled: false };
    eq(compileProfile({ approval: { patterns: [] }, tools: { deny: [] } }, SETTINGS).approval.enabled, true, '设置开着却不生效');
    eq(
      compileProfile({ approval: { enabled: true, patterns: [] }, tools: { deny: [] } }, off).approval.enabled,
      true,
      '设置关着 + profile 要求开 ⇒ 该开（这是"加严"）'
    );
    // 想"关掉"的唯一写法是把 false 写进文件 —— 那是**解析期的一条错**，根本到不了这里。
    const parsed = parseProfileFile(JSON.stringify({ profiles: { a: { approval: { enabled: false } } } }));
    eq(parsed.profiles['a'].approval.enabled, undefined, 'false 竟然进了 spec（那就能关掉审批了）');
    ok(parsed.errors.some((e) => e.includes('只能')), `没报"只能加严"：${parsed.errors.join('；')}`);
    // 端到端地走一遍：文件里写 false，编译结果的 enabled 仍是设置里的 true
    eq(
      compileProfile(parsed.profiles['a'], SETTINGS).approval.enabled,
      true,
      '文件里写了 false，编译后竟然真的关掉了审批'
    );
  });

  await check('**只能加严 · outsideWorkspace**：同款正反双控', () => {
    const off = { ...SETTINGS, outsideWorkspace: false };
    eq(compileProfile({ approval: { patterns: [] }, tools: { deny: [] } }, SETTINGS).approval.outsideWorkspace, true, '设置开着却不生效');
    eq(
      compileProfile({ approval: { outsideWorkspace: true, patterns: [] }, tools: { deny: [] } }, off).approval.outsideWorkspace,
      true,
      '设置关着 + profile 要求开 ⇒ 该开'
    );
    const parsed = parseProfileFile(JSON.stringify({ profiles: { a: { approval: { outsideWorkspace: false } } } }));
    eq(parsed.profiles['a'].approval.outsideWorkspace, undefined, 'false 竟然进了 spec');
    ok(parsed.errors.some((e) => e.includes('只能')), '没报"只能加严"');
  });

  await check('**只能加严 · patterns 是并集**：删不掉设置里的，加得上自己的，且不重复', () => {
    const e = compileProfile({ approval: { patterns: ['\\bdrop\\s+table\\b', '\\brm\\b'] }, tools: { deny: [] } }, SETTINGS);
    for (const p of SETTINGS.patterns) ok(e.approval.patterns.includes(p), `设置里的 ${p} 被删掉了`);
    ok(e.approval.patterns.includes('\\bdrop\\s+table\\b'), 'profile 自己的 pattern 没加上');
    eq(e.approval.patterns.filter((p) => p === '\\brm\\b').length, 1, '与设置重复的 pattern 没有去重');
    // 空清单表达不了"删光" —— 并集之后设置那两条还在
    const empty = parseProfileFile(JSON.stringify({ profiles: { a: { approval: { patterns: [] } } } }));
    eq(
      compileProfile(empty.profiles['a'], SETTINGS).approval.patterns.length,
      SETTINGS.patterns.length,
      '给空数组竟然把设置里的清单一并删了'
    );
    // 并集顺序要稳定（菜单/日志不随读取顺序漂）
    eq(e.approval.patterns.slice(0, SETTINGS.patterns.length).join(','), SETTINGS.patterns.join(','), '并集顺序不稳定');
  });

  await check('**只能加严 · tools**：只有 deny，且原样带出（没有 allow 这个方向）', () => {
    const e = compileProfile({ approval: { patterns: [] }, tools: { deny: ['bash', 'write'] } }, SETTINGS);
    eq(e.toolDeny.join(','), 'bash,write', 'deny 没带出来');
    eq('allow' in e, false, '编译结果里出现了 allow —— 那个方向不该存在');
    const parsed = parseProfileFile(JSON.stringify({ profiles: { a: { tools: { allow: ['read'] } } } }));
    ok(parsed.errors.some((x) => x.includes('allow')), 'allow 没被报成错误');
    eq(parsed.profiles['a'].tools.deny.length, 0, 'allow 竟然变成了 deny');
  });

  await check('compileProfile：整条链走一遍 —— 文件文本 → 解析 → 编译，只看编译结果', () => {
    const file = parseProfileFile(
      JSON.stringify({
        profiles: { p: { model: 'deepseek-reasoner', approval: { patterns: ['\\bnuke\\b'] }, tools: { deny: ['bash'] } } },
      })
    );
    const e = compileProfile(file.profiles['p'], SETTINGS, 'p');
    eq(e.name, 'p', 'name 没带出来（配置条靠它显示当前项）');
    eq(e.model, 'deepseek-reasoner', 'model 没带出来');
    eq(e.toolDeny.join(','), 'bash', 'deny 没带出来');
    for (const p of SETTINGS.patterns) ok(e.approval.patterns.includes(p), `丢了设置里的 ${p}`);
    ok(e.approval.patterns.includes('\\bnuke\\b'), '丢了 profile 的 pattern');
  });

  // ==================== 三、插件决策表（把生成的文件当纯模块载入） ====================

  const files = writeToolPolicyPluginFiles({ storageDir: dir });

  await check('writeToolPolicyPluginFiles：插件文件写出来了，pluginUrl 是 file:/// 形态', () => {
    ok(existsSync(files.scriptPath), '插件文件没写出来');
    ok(/^file:\/\/\//.test(files.pluginUrl), `pluginUrl 不是 file:/// 形态：${files.pluginUrl}`);
  });

  const mod = await import(pathToFileURL(files.scriptPath).href);

  /** 载入的插件跑一次 apply，抓住它注册的所有监听器 */
  const mount = (config) => {
    const handlers = {};
    mod.apply({ on: (name, fn) => { handlers[name] = fn; } }, config);
    return handlers;
  };
  /** 假 agent：`restrict` 把收到的 filter 记下来 */
  const fakeAgent = (calls) => ({
    id: 'a-1',
    ctx: { tools: { restrict: (f) => { calls.push(f); return () => {}; } } },
  });

  await check('插件模块本身：导出了 name 与 apply', () => {
    eq(typeof mod.apply, 'function', '没有 apply');
    eq(typeof mod.name, 'string', '没有 name');
  });

  await check('插件只挂 agent/created —— **不挂 agent/pre-step**（restrict 是追加式的，每步调会层层累加）', () => {
    const handlers = mount({ deny: ['bash'] });
    eq(Object.keys(handlers).join(','), 'agent/created', `挂了别的监听器：${Object.keys(handlers).join(',')}`);
  });

  await check('决策表：给了 deny → restrict 收到恰好那个 filter', () => {
    const calls = [];
    const handlers = mount({ deny: ['bash', 'write'] });
    handlers['agent/created']({ agent: fakeAgent(calls) });
    eq(calls.length, 1, `restrict 被调了 ${calls.length} 次（该恰好 1 次）`);
    eq(JSON.stringify(calls[0]), JSON.stringify({ deny: ['bash', 'write'] }), 'filter 不对');
  });

  await check('决策表：deny 为空/缺失/不是数组 → **restrict 一次都没被调**（惰性 = 零回归的根据）', () => {
    for (const cfg of [undefined, {}, { deny: [] }, { deny: 'bash' }, { deny: null }, { deny: [1, 2] }, { deny: [''] }]) {
      const calls = [];
      const handlers = mount(cfg);
      if (!handlers['agent/created']) continue; // 干脆没注册，等价于"不生效"
      handlers['agent/created']({ agent: fakeAgent(calls) });
      eq(calls.length, 0, `config=${JSON.stringify(cfg)} 竟然调了 restrict`);
    }
  });

  await check('决策表：deny 里的非字符串条目被就地过滤（写手那道之外的第二道）', () => {
    const calls = [];
    const handlers = mount({ deny: ['bash', 7, null, 'read', ''] });
    handlers['agent/created']({ agent: fakeAgent(calls) });
    eq(JSON.stringify(calls[0]), JSON.stringify({ deny: ['bash', 'read'] }), '坏条目没被过滤掉');
  });

  await check('决策表：载荷缺 agent / 缺 ctx / 缺 tools → 不抛（插件里抛一下就是会话起不来）', () => {
    const handlers = mount({ deny: ['bash'] });
    for (const payload of [undefined, null, {}, { agent: null }, { agent: {} }, { agent: { ctx: {} } }, { agent: { ctx: { tools: {} } } }]) {
      handlers['agent/created'](payload); // 抛了这条就红
    }
  });

  await check('决策表：restrict 自己抛（名字对不上等）→ **绝不冒泡**，退化成"工具还在"', () => {
    const handlers = mount({ deny: ['bash'] });
    let threw = false;
    try {
      handlers['agent/created']({
        agent: { id: 'a', ctx: { tools: { restrict: () => { throw new Error('unknown global tool'); } } } },
      });
    } catch {
      threw = true;
    }
    ok(!threw, 'restrict 的异常冒泡了 —— 那会把 agent 创建整个打断');
  });

  // ==================== 四、端到端：真运行时跑一轮，读盘上的 header.tools ====================

  const mounted = writeDerivedConfig({
    storageDir: dir,
    baseConfigPath: baseConfig,
    hooksPath: '',
    toolPolicy: { pluginUrl: files.pluginUrl, deny: ['bash'] },
  });

  await check('派生块文本：id / name(file:///) / deny 列表都在，且不给 toolPolicy 时一个字都不多', () => {
    const text = readFileSync(mounted.cordisPath, 'utf8');
    ok(text.includes('- id: hello-chat-tool-policy'), '派生文件里没有工具策略块');
    ok(text.includes(`name: '${files.pluginUrl}'`), `name 不是单引号原样：\n${text.slice(-320)}`);
    ok(/deny:\s*\n\s*- 'bash'/.test(text), `deny 列表没写进去：\n${text.slice(-320)}`);
    const plain = writeDerivedConfig({ storageDir: join(dir, 'plain'), baseConfigPath: baseConfig, hooksPath: '' });
    eq(readFileSync(plain.cordisPath, 'utf8').includes('hello-chat-tool-policy'), false, '没要求却挂了工具策略块');
  });

  await check('根不是块状序列：工具策略块挂不上 → 只 warning，绝不 throw（不拿 C1 的主功能去换）', () => {
    // ⚠️ 独立的 storageDir：派生文件的路径是 `<storageDir>/dsh-config/cordis.yml`，
    //    共用 `dir` 会把上面那份悬挂好的 `mounted.cordisPath` **原地覆盖**掉 ——
    //    于是端到端跑的是这份坏文件（第一版就这么栽的：报的是"config file must be a top-level array"）。
    const badBase = join(dir, 'flat.yml');
    writeFileSync(badBase, 'plugins: [a, b]\n', 'utf8');
    const r = writeDerivedConfig({
      storageDir: join(dir, 'flat'),
      baseConfigPath: badBase,
      hooksPath: '',
      toolPolicy: { pluginUrl: files.pluginUrl, deny: ['bash'] },
    });
    ok(typeof r.toolPolicyWarning === 'string' && r.toolPolicyWarning.length > 0, '挂不上却没有告警（那就是静默失效）');
    // C1 的既有语义一个字不改
    let threw = false;
    try {
      writeDerivedConfig({ storageDir: join(dir, 'flat'), baseConfigPath: badBase, hooksPath: join(dir, 'hooks.json') });
    } catch {
      threw = true;
    }
    ok(threw, 'C1 那条「根不合法就拒绝生成」被改软了');
  });

  /** 没挂工具策略的派生文件 —— 端到端的**反控**用（同一份底本，只少了那个块） */
  const controlPath = writeDerivedConfig({
    storageDir: join(dir, 'control'),
    baseConfigPath: baseConfig,
    hooksPath: '',
  }).cordisPath;

  /**
   * header.tools 的元素形态由上游定（可能是名字字符串，也可能是带 name 的 schema 对象）。
   * **认不出来就响亮报错**，绝不返回空数组 —— 空数组会让"bash 不在里面"变成假绿。
   */
  const toolNamesOf = (header, tag) => {
    const tools = header?.tools;
    ok(Array.isArray(tools) && tools.length > 0, `${tag}：header.tools 不是非空数组（${JSON.stringify(tools)?.slice(0, 200)}）`);
    const names = tools.map((t) => (typeof t === 'string' ? t : t && typeof t.name === 'string' ? t.name : undefined));
    ok(
      names.every((n) => typeof n === 'string' && n),
      `${tag}：header.tools 的元素形态认不出来，改这条判据：${JSON.stringify(tools[0])?.slice(0, 300)}`
    );
    return names;
  };

  const boot = (sessionId, configPath) => {
    const root = join(dir, 'sessions', sessionId);
    return runTurn({
      node,
      entry,
      config: baseConfig, // 位置参数：基础配置（扩展就是这样）
      cwd: dir,
      sessionRoot: root,
      sessionId,
      prompt: '探针：只为触发一次请求构建，不需要成功',
      apiKey: 'sk-000000000000000000000000000000000000000000000000', // 假 key：不花真钱
      env: { DSH_CORDIS_CONFIG: configPath }, // 派生文件只从这里进（与扩展一致）
      bootTimeoutMs: 90_000,
      turnTimeoutMs: 90_000,
    }).then((r) => ({ r, root }));
  };

  /** 从盘上的会话日志里捞出这一轮的 request/header */
  const findHeader = (root) => {
    for (const p of walk(root)) {
      if (!p.endsWith('.jsonl.zstd')) continue;
      for (const e of readSessionEvents(p)) {
        if (e?.type === 'request/header' && e?.data?.header?.config) return e.data.header;
      }
    }
    return undefined;
  };

  await check('端到端：profile 禁 bash → 这次请求的 header.tools 里**没有** bash（工具真的从模型视野里消失）', async () => {
    const { r, root } = await boot('probe-profile-deny', mounted.cordisPath);
    const header = findHeader(root);
    ok(header, `没找到 request/header（这一轮压根没跑到请求构建期）—— 这一轮的结局：${r.reason}`);
    const names = toolNamesOf(header, '带 profile');
    eq(names.includes('bash'), false, `bash 还在模型视野里：${names.join(', ')}`);
    // 反证"限制不是把工具全清空了"：别的工具必须还在
    ok(names.includes('read'), `连 read 都没了 —— 那说明不是"限制生效"而是"工具全没了"：${names.join(', ')}`);
    eq(header.config.provider, 'deepseek-official', 'provider 不对，读到的可能不是我们这一轮');
  });

  await check('端到端反控：不带 profile 的那一轮，bash **必须在**（否则上面那条是假绿）', async () => {
    const { r, root } = await boot('probe-profile-control', controlPath);
    const header = findHeader(root);
    ok(header, `没找到 request/header —— 这一轮的结局：${r.reason}`);
    const names = toolNamesOf(header, '不带 profile');
    ok(names.includes('bash'), `反控失败：不带 profile 时 bash 也不在，那上面那条断言毫无鉴别力：${names.join(', ')}`);
  });

  // ==================== 五、静态守卫 ====================

  await check('静态守卫：agentProfile.ts / toolPolicyPlugin.ts 都不带 vscode（带了判据就只能回宿主里验）', () => {
    for (const f of ['agentProfile.ts', 'toolPolicyPlugin.ts']) {
      const src = readFileSync(join(repoRoot, 'src', f), 'utf8');
      ok(
        !/from 'vscode'|require\('vscode'\)/.test(src),
        `${f} import vscode 了 —— 判据又会变回「只有肉眼能验」（C10b 的教训）`
      );
    }
  });

  await check('静态守卫：审批松紧只由 compileProfile 一处决定（provider 里不许再写一遍）', () => {
    // 「只能加严」是纯函数守着的；要是 provider 里另写一处 `|| profile.enabled` 之类，
    // 守的就变成了巧合 —— 这条守卫盯的是那个形状。
    const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8');
    ok(src.includes('compileProfile('), 'provider 没有走 compileProfile —— 松紧逻辑被旁路了');
    const raw = src.split('\n').filter((l) => /get<boolean>\('approval\.(enabled|outsideWorkspace)'/.test(l));
    eq(raw.length, 2, `设置原文的读取有 ${raw.length} 处（该恰好 2 处，在 _approvalSetting* 里）`);
    ok(
      src.includes('_approvalSettingEnabled()') && src.includes('_approvalSettingOutside()'),
      '找不到 _approvalSetting* —— 审批读口没有走「设置原文 → compileProfile」这条路'
    );
  });

  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
    for (const f of failures) console.log(`   · ${f}`);
  } else {
    // ⚠️ 这行必须在 else 里：无条件打印会出现「有红 + ✓ 全部通过」同屏
    console.log(`✓ 全部通过：${passed}/${passed}`);
  }
  console.log(`  （派生文件与会话日志留在 ${dir}，排查用；那是临时目录，可随手删）`);
  // ⚠️ 不用 process.exit()：Windows 上被重定向的 stdout 是异步写，退出会丢掉还没冲出去的结论行。
  process.exitCode = failures.length ? 1 : 0;
}
