#!/usr/bin/env node
/**
 * C11 会话级推理档位（reasoningEffort）的自检 —— **不需要 VS Code、不需要真 API key**。
 *
 * 它守的是三件事：
 *   一、纯判据（`normalizeEffort` / `thinkingDisabledInConfig` / 档位表写盘 / 派生块文本）；
 *   二、**插件本体的决策表** —— 把生成出来的插件文件当纯模块直接 `import()`，喂一个假 ctx 抓住它的
 *       `agent/request` 监听器逐条喂载荷。零成本、零模型调用，而且**条条都是真跑那段代码**；
 *   三、**端到端启动一次真运行时**：派生配置挂上真插件 → 真跑一轮 → 读盘上日志里的
 *       `request/header`，断言 `config.reasoningEffort` 就是我们要的那个值。
 *
 * 为什么值得单独一个探针：C11 的判据（"档位到底有没有落到这次请求上"）住在 DSH 进程里，
 * 扩展侧肉眼只能看见「我点了 low」，看不见「这次请求真的带了 low」—— 而那正是本功能唯一要说的事。
 * 第三段的**反控**（表里没有这个会话 ⇒ header 里就没有 reasoningEffort）才是关键：没有它，
 * 「有覆盖」可能只是适配器默认值恰好长这样。
 *
 * ⚠️ 第三段**刻意用假 key**（`sk-000…`）：请求会 401 失败，但 `request/header` 是在请求**构建期**
 * 就落盘的（`dsh-agent-loop` 先 `canonicalHeader` 再 `session.append`，之后才发请求），
 * 所以断言照样成立、且**不花真钱**。反过来，「压根没跑起来」必须响亮报错 ——
 * 绝不能把"没跑起来"读成"验过了"。
 *
 *   node scripts/probe-effort-plugin.mjs [--runtime dist-runtime]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
const effortJs = join(repoRoot, 'out', 'effortPlugin.js');
const hooksJs = join(repoRoot, 'out', 'dshHooks.js');

if (!existsSync(manifestPath)) {
  console.log(`⚠ 跳过：${manifestPath} 不存在（先跑 node scripts/build-runtime.mjs），别把这次通过当成验过了`);
  process.exitCode = 0;
} else if (!existsSync(effortJs) || !existsSync(hooksJs)) {
  console.error(`缺少编译产物（${effortJs} / ${hooksJs}）\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
  process.exitCode = 2;
} else {
  await main();
}

async function main() {
  const effort = await import(pathToFileURL(effortJs).href);
  const hooks = await import(pathToFileURL(hooksJs).href);
  const { normalizeEffort, thinkingDisabledInConfig, writeEffortPluginFiles, writeEffortState } = effort;
  const { writeDerivedConfig } = hooks;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const node = join(runtimeAbs, manifest.node);
  const entry = join(runtimeAbs, manifest.entry);
  const baseConfig = join(runtimeAbs, manifest.config);

  console.log('C11 会话级推理档位 —— 三段：纯判据 / 插件决策表 / 真运行时端到端');
  console.log(`  运行时 ${runtimeAbs}（dsh ${manifest.dshVersion ?? '?'}）`);
  console.log('');

  // 派生文件写临时目录：不污染仓库，也不碰任何人的真配置
  const dir = mkdtempSync(join(tmpdir(), 'hello-effort-'));

  // ==================== 一、纯判据 ====================

  await check('normalizeEffort：四个合法档位原样通过', () => {
    for (const v of ['off', 'low', 'high', 'max']) eq(normalizeEffort(v), v, `${v} 没通过`);
    eq(effort.EFFORT_VALUES.length, 4, '档位不是四档');
  });

  await check('normalizeEffort：认不出的一律 undefined（= 不覆盖，绝不猜）', () => {
    const junk = [undefined, null, '', 'LOW', 'Low', '跟随配置', 'medium', 'none', 0, 7, true, {}, [], 'off '];
    for (const v of junk) eq(normalizeEffort(v), undefined, `${JSON.stringify(v)} 被当成了档位`);
  });

  await check('thinkingDisabledInConfig：只看 llm-deepseek 块里那一行', () => {
    const text = (v) =>
      `plugins:\n  - id: llm-deepseek\n    name: '@deepseek-ai/dsh-llm-deepseek'\n    config:\n      thinking: ${v}\n      reasoningEffort: max\n`;
    eq(thinkingDisabledInConfig(text('enabled')), false, 'enabled 被判成了 disabled');
    eq(thinkingDisabledInConfig(text('disabled')), true, 'disabled 没认出来');
    eq(thinkingDisabledInConfig(text("'disabled'")), true, '带引号的 disabled 没认出来');
  });

  await check('thinkingDisabledInConfig：别的块里的 disabled 不算数（锚点纪律）', () => {
    const other =
      "plugins:\n  - id: compaction-basic\n    config:\n      thinking: disabled\n  - id: llm-deepseek\n    config:\n      thinking: enabled\n";
    eq(thinkingDisabledInConfig(other), false, '把别的块里的 disabled 算到 llm-deepseek 头上了');
    // 块边界：llm-deepseek 块之后**同级**的下一个插件，它的 thinking 不该被读进来
    const after =
      "plugins:\n  - id: llm-deepseek\n    config:\n      thinking: enabled\n  - id: another\n    config:\n      thinking: disabled\n";
    eq(thinkingDisabledInConfig(after), false, '越过了块边界去读下一个插件');
  });

  await check('thinkingDisabledInConfig：锚点不唯一/没有 → false（判不了的代价不对称）', () => {
    eq(thinkingDisabledInConfig('plugins:\n  - id: other\n    config:\n      thinking: disabled\n'), false, '没有锚点却给了结论');
    eq(
      thinkingDisabledInConfig('plugins:\n  - id: llm-deepseek\n    config:\n      thinking: disabled\n  - id: llm-deepseek\n'),
      false,
      '锚点两处却还是给了结论'
    );
    eq(thinkingDisabledInConfig(''), false, '空文本不该有结论');
  });

  const files = writeEffortPluginFiles({ storageDir: dir });

  await check('writeEffortPluginFiles：插件文件写出来了，pluginUrl 是 file:/// 形态', () => {
    ok(existsSync(files.scriptPath), '插件文件没写出来');
    ok(/^file:\/\/\//.test(files.pluginUrl), `pluginUrl 不是 file:/// 形态：${files.pluginUrl}`);
    eq(files.statePath.endsWith('reasoning-effort-state.json'), true, '状态表文件名不对');
  });

  await check('派生块文本：id / name(file:///) / statePath / thinkingDisabled 都在', () => {
    const r = writeDerivedConfig({
      storageDir: dir,
      baseConfigPath: baseConfig,
      hooksPath: '',
      effort: { pluginUrl: files.pluginUrl, statePath: files.statePath, thinkingDisabled: true },
    });
    const text = readFileSync(r.cordisPath, 'utf8');
    ok(text.includes('- id: hello-chat-reasoning-effort'), '派生文件里没有档位块');
    ok(text.includes(`name: '${files.pluginUrl}'`), `name 不是单引号原样：\n${text.slice(-320)}`);
    ok(text.includes(`statePath: '${files.statePath}'`), 'statePath 没写进去');
    ok(/thinkingDisabled: true/.test(text), 'thinkingDisabled 没写进去');
    eq(r.effortMounted, true, 'effortMounted 该是 true');
    eq(r.effortWarning, undefined, `不该有告警：${r.effortWarning}`);
  });

  await check('零回归：没给 effort 时派生文件里一个字都不多', () => {
    const r = writeDerivedConfig({ storageDir: join(dir, 'plain'), baseConfigPath: baseConfig, hooksPath: '' });
    const text = readFileSync(r.cordisPath, 'utf8');
    eq(text.includes('hello-chat-reasoning-effort'), false, '没要求却挂了档位块');
    eq(r.effortMounted, false, '没要求却报 effortMounted');
  });

  await check('派生块文本：路径里的单引号按 YAML 规则写成两个', () => {
    const weird = join(dir, "it's");
    mkdirSync(weird, { recursive: true });
    const f2 = writeEffortPluginFiles({ storageDir: weird });
    const r = writeDerivedConfig({
      storageDir: weird,
      baseConfigPath: baseConfig,
      hooksPath: '',
      effort: { pluginUrl: f2.pluginUrl, statePath: f2.statePath, thinkingDisabled: false },
    });
    const text = readFileSync(r.cordisPath, 'utf8');
    ok(text.includes("it''s"), `单引号没转义（原样写出去会把 YAML 撕开）：\n${text.slice(-260)}`);
    ok(!/statePath: '[^']*it's/.test(text), 'statePath 里留着一个没转义的单引号');
  });

  await check('根不是块状序列：档位块挂不上 → 只 warning，绝不 throw（不拿 C1 的主功能去换）', () => {
    const badBase = join(dir, 'flat.yml');
    writeFileSync(badBase, 'plugins: [a, b]\n', 'utf8');
    const r = writeDerivedConfig({
      storageDir: dir,
      baseConfigPath: badBase,
      hooksPath: '',
      effort: { pluginUrl: files.pluginUrl, statePath: files.statePath, thinkingDisabled: false },
    });
    eq(r.effortMounted, false, '挂不上却说挂上了');
    ok(typeof r.effortWarning === 'string' && r.effortWarning.length > 0, '挂不上却没有告警（那就是静默失效）');
    // C1 的既有语义一个字不改：要追加 hooks 块且根不合法 → 照旧 throw
    let threw = false;
    try {
      writeDerivedConfig({ storageDir: dir, baseConfigPath: badBase, hooksPath: join(dir, 'hooks.json') });
    } catch {
      threw = true;
    }
    ok(threw, 'C1 那条「根不合法就拒绝生成」被改软了 —— 那是既有语义，不该跟着 C11 变');
  });

  await check('writeEffortState：整份重写、丢掉垃圾键值、不留 .tmp', () => {
    writeEffortState(files.statePath, { 's-1': 'low', 's-2': 'HIGH', 's-3': '', '': 'max', 's-4': 'off' });
    eq(
      readFileSync(files.statePath, 'utf8').replace(/\s+/g, ''),
      JSON.stringify({ 's-1': 'low', 's-4': 'off' }).replace(/\s+/g, ''),
      '档位表没按预期清洗'
    );
    ok(!existsSync(`${files.statePath}.tmp`), '留下了 .tmp（原子写的中间件不该留在盘上）');
    // 第二次写必须是**整份**替换，不是合并 —— 插件每次都整份读，合并会留下已删会话的残影
    writeEffortState(files.statePath, { 's-9': 'max' });
    eq(
      readFileSync(files.statePath, 'utf8').replace(/\s+/g, ''),
      JSON.stringify({ 's-9': 'max' }).replace(/\s+/g, ''),
      '不是整份重写'
    );
  });

  // ==================== 二、插件决策表（把生成的文件当纯模块载入） ====================

  const seeded = { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 256000 };
  const next = async () => ({ ...seeded });

  const mod = await import(pathToFileURL(files.scriptPath).href);
  /** 载入的插件跑一次 apply，抓住它注册的 agent/request 监听器 */
  const mount = (config) => {
    const handlers = {};
    mod.apply({ on: (name, fn) => { handlers[name] = fn; } }, config);
    return handlers['agent/request'];
  };

  await check('插件模块本身：导出了 name 与 apply', () => {
    eq(typeof mod.apply, 'function', '没有 apply');
    eq(typeof mod.name, 'string', '没有 name');
  });

  await check('决策表：会话命中 → 覆盖档位，且 provider/model/maxTokens 一个不少', async () => {
    writeEffortState(files.statePath, { 'sess-hit': 'low' });
    const h = mount({ statePath: files.statePath, thinkingDisabled: false });
    ok(typeof h === 'function', '没注册 agent/request 监听器');
    const r = await h({ agent: { id: 'sess-hit' }, turn: 1, step: 1 }, next);
    eq(r.reasoningEffort, 'low', '档位没落上');
    eq(r.provider, seeded.provider, '把 provider 弄丢了');
    eq(r.model, seeded.model, '把 model 弄丢了');
    eq(r.maxTokens, seeded.maxTokens, '把 maxTokens 弄丢了');
  });

  await check('决策表：表里没有这个会话 → 原样返回**同一个对象**（惰性 = 零回归的根据）', async () => {
    const h = mount({ statePath: files.statePath, thinkingDisabled: false });
    const r = await h({ agent: { id: 'sess-not-in-table' }, turn: 1, step: 1 }, next);
    eq('reasoningEffort' in r, false, '没命中却塞了个 reasoningEffort 进去');
    eq(r.provider, seeded.provider, '内容被改动了');
    // 连"造了个新对象"都不许：拿上游那个对象的引用本身做判据
    const seed = { ...seeded };
    const r2 = await h({ agent: { id: 'sess-not-in-table' } }, async () => seed);
    ok(r2 === seed, '没命中时返回的不是上游那个对象本身');
  });

  await check('决策表：载荷没有 agent / 没有 id → 不覆盖，也不抛', async () => {
    writeEffortState(files.statePath, { 'sess-hit': 'low' });
    const h = mount({ statePath: files.statePath, thinkingDisabled: false });
    for (const payload of [{}, { agent: {} }, { agent: { id: '' } }, { agent: null }, null, undefined]) {
      const r = await h(payload, next);
      eq('reasoningEffort' in r, false, `载荷 ${JSON.stringify(payload)} 竟然命中了`);
    }
  });

  await check('决策表：状态文件不在 / 是坏 JSON / 值是垃圾 → 一律不覆盖，且不抛', async () => {
    const h = mount({ statePath: join(dir, 'never-existed.json'), thinkingDisabled: false });
    eq('reasoningEffort' in (await h({ agent: { id: 'sess-hit' } }, next)), false, '文件不在却覆盖了');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    const hb = mount({ statePath: broken, thinkingDisabled: false });
    eq('reasoningEffort' in (await hb({ agent: { id: 'sess-hit' } }, next)), false, '坏 JSON 却覆盖了');

    // 绕过我们的写手直接往表里塞非法档位：插件必须自己挡住（写手那道不是唯一防线）
    writeFileSync(files.statePath, JSON.stringify({ 'sess-bad': 'LOW', 'sess-num': 3 }), 'utf8');
    const hv = mount({ statePath: files.statePath, thinkingDisabled: false });
    eq('reasoningEffort' in (await hv({ agent: { id: 'sess-bad' } }, next)), false, '垃圾档位被原样下发（provider 会抛）');
    eq('reasoningEffort' in (await hv({ agent: { id: 'sess-num' } }, next)), false, '数字档位被原样下发');
  });

  await check('决策表：每次请求**现读**状态表 —— 这就是「热生效」的判据', async () => {
    writeEffortState(files.statePath, { 'sess-hit': 'low' });
    const h = mount({ statePath: files.statePath, thinkingDisabled: false });
    eq((await h({ agent: { id: 'sess-hit' } }, next)).reasoningEffort, 'low', '第一次不是 low');
    writeEffortState(files.statePath, { 'sess-hit': 'max' }); // 进程没重启，只换了盘上那张表
    eq((await h({ agent: { id: 'sess-hit' } }, next)).reasoningEffort, 'max', '改了表却没跟着变（热生效不成立）');
    writeEffortState(files.statePath, {}); // 清空 = 回到跟随配置
    eq('reasoningEffort' in (await h({ agent: { id: 'sess-hit' } }, next)), false, '清空后还在覆盖');
  });

  await check('决策表：底本 thinking: disabled → 只放行 off，其余三档一律不覆盖', async () => {
    const h = mount({ statePath: files.statePath, thinkingDisabled: true });
    for (const v of ['low', 'high', 'max']) {
      writeEffortState(files.statePath, { 'sess-hit': v });
      eq(
        'reasoningEffort' in (await h({ agent: { id: 'sess-hit' } }, next)),
        false,
        `disabled 下 ${v} 竟然被下发了（provider 会抛 UNSUPPORTED_REASONING_EFFORT）`
      );
    }
    writeEffortState(files.statePath, { 'sess-hit': 'off' });
    eq((await h({ agent: { id: 'sess-hit' } }, next)).reasoningEffort, 'off', 'disabled 下 off 该放行（它就是「关闭思考」）');
  });

  await check('决策表：没给 statePath → 干脆不注册监听器（零开销）', () => {
    ok(mount({}) === undefined, '没有 statePath 却注册了监听器');
    ok(mount({ statePath: 42 }) === undefined, 'statePath 不是字符串却注册了监听器');
  });

  await check('决策表：上游 next() 抛错 → 必须原样抛出去，绝不吞', async () => {
    const h = mount({ statePath: files.statePath, thinkingDisabled: false });
    const boom = new Error('上游炸了');
    let caught;
    try {
      await h({ agent: { id: 'sess-hit' } }, async () => {
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    ok(caught === boom, '上游的异常被插件吞掉了 —— 那等于把整轮静默换成另一种行为');
  });

  await check('决策表：上游返回的不是对象 → 原样返回（别把它 spread 成 {}）', async () => {
    const h = mount({ statePath: files.statePath, thinkingDisabled: false });
    eq(await h({ agent: { id: 'sess-hit' } }, async () => undefined), undefined, 'undefined 被换成了别的');
    eq(await h({ agent: { id: 'sess-hit' } }, async () => 'x'), 'x', '非对象被改动了');
  });

  // ==================== 三、端到端：真运行时跑一轮，读盘上的 request/header ====================

  const mounted = writeDerivedConfig({
    storageDir: dir,
    baseConfigPath: baseConfig,
    hooksPath: '',
    effort: { pluginUrl: files.pluginUrl, statePath: files.statePath, thinkingDisabled: false },
  });
  ok(mounted.effortMounted, '端到端用的派生配置没挂上档位块');

  /**
   * 跑一轮（假 key：请求会 401，但 request/header 在那之前就落盘了）。
   * 每个会话一个**独立的 sessionRoot** —— 这样"读回来的 header 是哪一轮的"不用靠猜文件名。
   */
  /**
   * 底本 llm-deepseek 自己的默认档位。**负控的靶子**：没设档位的会话，这次请求带的就是它。
   * 从底本原文里读而不是写死 —— 运行时换了默认值时，这里会跟着变（而不是给出一个假的通过）。
   */
  const baseDefaultEffort = (() => {
    const text = readFileSync(baseConfig, 'utf8');
    const at = text.indexOf('- id: llm-deepseek');
    if (at < 0) return undefined;
    const m = /reasoningEffort:\s*['"]?([A-Za-z]+)['"]?/.exec(text.slice(at, at + 600));
    return m ? m[1] : undefined;
  })();
  ok(
    baseDefaultEffort !== undefined,
    `底本 llm-deepseek 块里没有 reasoningEffort —— 负控没有靶子，这条反控会退化成假绿（底本：${baseConfig}）`
  );

  const boot = (sessionId) => {
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
      env: { DSH_CORDIS_CONFIG: mounted.cordisPath }, // 派生文件只从这里进（与扩展一致）
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

  await check('端到端：派生配置挂真插件 → 这次请求真的带上了 reasoningEffort=low', async () => {
    writeEffortState(files.statePath, { 'probe-effort-1': 'low' });
    const { r, root } = await boot('probe-effort-1');
    const header = findHeader(root);
    ok(header, `没找到 request/header（这一轮压根没跑到请求构建期）—— 这一轮的结局：${r.reason}`);
    eq(header.config.reasoningEffort, 'low', `档位没落到请求上。header.config = ${JSON.stringify(header.config)}`);
    ok(
      header.adapterDefaults?.reasoningEffort !== true,
      'adapterDefaults 里标着 reasoningEffort: true —— 说明这是适配器默认值而不是我们显式提的（断言会失去意义）'
    );
    eq(header.config.provider, 'deepseek-official', 'provider 不对，读到的可能不是我们这一轮');
  });

  await check('端到端反控：表里没有这个会话 → 这次请求带的是**底本自己的默认档位**，不是我们的值', async () => {
    writeEffortState(files.statePath, {}); // 同一个插件块，只是表里没有它
    const { r, root } = await boot('probe-effort-2');
    const header = findHeader(root);
    ok(header, `没找到 request/header —— 这一轮的结局：${r.reason}`);
    // ⚠️ 判据不是"没有这个键"（实测：**有**，值是底本 llm-deepseek 自己的 reasoningEffort）。
    //    真正要证的是"这个值的来源不是我们"—— 所以拿底本的默认值当靶子。
    eq(
      header.config.reasoningEffort,
      baseDefaultEffort,
      `没设档位的会话带上了别的值（覆盖不是按会话来的）：${JSON.stringify(header.config)}`
    );
    ok(
      baseDefaultEffort !== 'low',
      `底本的默认档位恰好就是 low，这条反控没有鉴别力 —— 换一个档位再跑（否则正控也是假绿）`
    );
  });

  // ==================== 四、静态守卫 ====================

  await check('静态守卫：effortPlugin.ts 不带 vscode（带了判据就只能回宿主里验）', () => {
    const src = readFileSync(join(repoRoot, 'src', 'effortPlugin.ts'), 'utf8');
    ok(
      !/from 'vscode'|require\('vscode'\)/.test(src),
      "这个文件 import vscode 了 —— 判据又会变回「只有肉眼能验」（C10b 的教训）"
    );
  });

  await check('静态守卫：换活跃会话必须走 _setActive（四个入口一个都不能漏）', () => {
    // 真机 F5 里踩到的：`_openSession` 换了 _active 却没重播配置条 ⇒ 点开设过 low 的会话，
    // 菜单还显示「跟随配置」。**探针载不了那个文件**（它 import vscode），所以能机器化的
    // 只有这条结构判据：赋值只准出现在 `_setActive` 一处。
    const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8');
    const writes = src.split('\n').filter((l) => /_actives\[this\._mode\]\s*=/.test(l));
    eq(writes.length, 1, `_actives[_mode] 的赋值有 ${writes.length} 处（应恰好 1 处，在 _setActive 里）：${writes.join(' | ')}`);
    const at = src.indexOf('private _setActive(');
    ok(at > 0, '找不到 _setActive（改了名就同步改这条守卫）');
    ok(
      src.slice(at, at + 400).includes('_postLiveConfig()'),
      '_setActive 里没有 _postLiveConfig() —— 换会话时档位菜单会安静地留着上一个会话的值'
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
