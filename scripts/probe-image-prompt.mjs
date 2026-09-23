#!/usr/bin/env node
/**
 * C17b「图片说明住在系统提示词里」的自检 —— **不需要 VS Code，端到端那段不需要真 key**。
 *
 * 守的是这一次反转的全部意义：**那段说明不再进用户消息（气泡干净），但它仍然到得了模型**。
 * 两句话各有一个判据，缺一个这条改动就白做：
 *
 * - 「气泡干净」= 盘上这次会话日志里的 `user/message` **一个字节都不含**那些字（第五段）。
 * - 「仍然到得了」= 同一个日志里的 `request/header.header.system` **含**那些字（第四段）。
 *
 * 四段，层层逼近：
 *   一、**插件模块**：把生成出来的 `image-prompt.mjs` 当纯模块 `import()` 进来，喂假 ctx ——
 *      条条都是真跑那段代码，零成本。含两条承重的**顺序**判据（先注册变量、再注册小节；
 *      小节注册失败要回滚变量）。
 *   二、**文案**：`imageAttach.imagePromptText` 的四句约束、两读法、两道上限、`{{` 逐字保真。
 *   三、**派生块**：`writeDerivedConfig` 真的把块写进派生文件里（id / name(file:///) / statePath）。
 *   四、**端到端**：真起一次运行时跑一轮，读盘上那一轮的 header —— 正面断言我们的抬头、图名、
 *      约束句**都在 system 里**；**反控**另起一个会话（独立 session root），表里没有它 ⇒
 *      同一个串**不在**。反控用的靶子（`probe-image-aa11.png`）只可能来自状态文件。
 *
 * ⚠️ 端到端**刻意用假 key**（`sk-000…`）：请求会 401，但 `request/header` 是在请求**构建期**
 * 就落盘的（`dsh-agent-loop` 先 `canonicalHeader` 再 `session.append`，之后才发请求），
 * 所以断言照样成立、且不花真钱。反过来，「压根没跑起来」必须响亮报错 ——
 * 绝不能把"没跑起来"读成"验过了"。
 *
 * ⚠️ 端到端**不做**跨进程的 `header.system` 逐字节对比：system 里混着日期这类每次都不同的
 * 东西，逐字节比只会假红。判据是"含不含只可能来自状态文件的那个串"。
 *
 *   node scripts/probe-image-prompt.mjs [--runtime dist-runtime]
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

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}：期望 ${e}，实得 ${a}`);
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

/** 读仓库里的源码文本（静态守卫用）。 */
const readSrc = (f) => readFileSync(join(repoRoot, 'src', f), 'utf8');

// ---- 参数：--runtime（默认 dist-runtime，仓库外/没建就响亮跳过） ----
const argv = process.argv.slice(2);
let runtimeDir = 'dist-runtime';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--runtime') runtimeDir = argv[++i];
}
const runtimeAbs = resolve(repoRoot, runtimeDir);
const manifestPath = join(runtimeAbs, 'runtime.json');
const promptJs = join(repoRoot, 'out', 'imagePromptPlugin.js');
const attachJs = join(repoRoot, 'out', 'imageAttach.js');
const hooksJs = join(repoRoot, 'out', 'dshHooks.js');

if (!existsSync(manifestPath)) {
  console.log(`⚠ 跳过：${manifestPath} 不存在（先跑 node scripts/build-runtime.mjs），别把这次通过当成验过了`);
  process.exitCode = 0;
} else if (!existsSync(promptJs) || !existsSync(attachJs) || !existsSync(hooksJs)) {
  console.error(`缺少编译产物（${promptJs} / ${attachJs} / ${hooksJs}）\n  先跑 npm run compile（out/ 是 gitignored 的）。`);
  process.exitCode = 2;
} else {
  await main();
}

async function main() {
  const P = await import(pathToFileURL(promptJs).href);
  const A = await import(pathToFileURL(attachJs).href);
  const hooks = await import(pathToFileURL(hooksJs).href);
  const { writeDerivedConfig } = hooks;
  const { imagePromptText, MAX_IMAGES_IN_PROMPT, MAX_IMAGE_PROMPT_CHARS } = A;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const node = join(runtimeAbs, manifest.node);
  const entry = join(runtimeAbs, manifest.entry);
  const baseConfig = join(runtimeAbs, manifest.config);

  console.log('C17b 图片说明进系统提示词 —— 四段：插件模块 / 文案 / 派生块 / 真运行时端到端');
  console.log(`  运行时 ${runtimeAbs}（dsh ${manifest.dshVersion ?? '?'}）`);
  console.log('');

  const dir = mkdtempSync(join(tmpdir(), 'hello-imgprompt-'));
  const files = P.writeImagePromptPluginFiles({ storageDir: dir });
  const mod = await import(pathToFileURL(files.scriptPath).href);

  const mk = (over = {}) => ({
    name: 'shot.png',
    path: 'D:\\proj\\.hello-chat\\images\\shot.png',
    bytes: 1258291,
    mediaType: 'image/png',
    ...over,
  });

  // ==================== 一、插件模块（当纯模块载入 + 假 ctx） ====================

  /**
   * 载入的插件跑一次 apply，抓住它注册的变量与小节。
   * 体例照 `probe-effort-plugin.mjs` 的 `mount`：假 ctx 只实现我们真的用到的那三个面。
   */
  const mount = (config, opts = {}) => {
    const got = { variable: undefined, section: undefined, disposed: 0, registered: [] };
    const ctx = {
      systemPrompt: {
        variable: (name, fn) => {
          if (opts.variableThrows) throw new Error('名字被占了');
          got.variable = { name, fn };
          got.registered.push('variable');
          return () => {
            got.disposed++;
          };
        },
        section: (spec) => {
          if (opts.sectionThrows) throw new Error('小节注册不上');
          got.section = spec;
          got.registered.push('section');
          return () => {
            got.disposed++;
          };
        },
      },
      effect: (fn) => {
        got.effectRan = true;
        got.disposer = fn();
      },
    };
    if (opts.noEffect) delete ctx.effect;
    if (opts.noVariableMethod) delete ctx.systemPrompt.variable;
    if (opts.noSectionMethod) delete ctx.systemPrompt.section;
    if (opts.noSystemPrompt) delete ctx.systemPrompt;
    mod.apply(ctx, config);
    return got;
  };

  await check('A1 插件模块导出 name / apply，并声明 inject=[systemPrompt]', () => {
    eq(mod.name, 'hello-chat-image-prompt', 'name 不对');
    eq(typeof mod.apply, 'function', '没有 apply');
    eq(mod.inject, ['systemPrompt'], '没声明 inject —— 服务没就绪时 apply 会抛，等于赌运气');
  });

  await check('A2 注册的形状：名字、order 是有限数、正文**恰是一个变量引用**', () => {
    P.writeImagePromptState(files.statePath, { 'sess-hit': 'BLOCK-A2' });
    const got = mount({ statePath: files.statePath });
    eq(got.registered, ['variable', 'section'], '注册顺序必须先是变量、后是小节');
    eq(got.variable.name, P.IMAGE_PROMPT_VARIABLE_NAME, '变量名与源码常量不一致');
    eq(got.section.name, P.IMAGE_PROMPT_SECTION_NAME, '小节名与源码常量不一致');
    // ⚠️ 小节正文必须是**那个引用本身**，不许是渲染好的正文：正文里带的是用户数据（文件名/路径），
    //    而 renderPrompt 对每个 section 都跑 interpolate ⇒ 一个 `{{草稿}}.png` 会让该会话每一轮都抛。
    eq(got.section.text, P.IMAGE_PROMPT_SECTION_TEXT, '小节正文不是那个变量引用');
    eq(got.section.text, '{{hello_image_list}}', '小节正文的字面量漂了');
    ok(Number.isFinite(got.section.order), `order 不是有限数（会被上游 TypeError）：${got.section.order}`);
    // 注册的东西必须**交回一个回收函数**（`ctx.effect` 的契约）：不交，cordis 就没法在换配置时
    // 摘掉这一节 —— 一次请求里积一节，长会话会攒出一串重复的说明。
    ok(typeof got.disposer === 'function', '没有把 disposer 交回给 ctx.effect');
  });

  await check('A3 变量提供方：命中的会话拿到整块，别的会话/没有 agent/空串一律空串', () => {
    P.writeImagePromptState(files.statePath, { 'sess-hit': 'BLOCK-A3', 'sess-empty': '' });
    const got = mount({ statePath: files.statePath });
    const f = got.variable.fn;
    eq(f({ agent: { id: 'sess-hit' } }), 'BLOCK-A3', '命中的会话没拿到说明');
    // 空串是「没有图片」的表达方式 —— renderPrompt 会把空小节整个丢掉，所以这就是零痕迹
    for (const ctx of [
      { agent: { id: 'sess-unknown' } },
      { agent: { id: 'sess-empty' } },
      { agent: {} },
      { agent: null },
      {},
      null,
      undefined,
    ]) {
      eq(f(ctx), '', `载荷 ${JSON.stringify(ctx)} 竟然给出了内容`);
    }
  });

  await check('A4 表坏了 / 表不在 → 空串，且绝不抛（一次请求不许因为一个说明挂掉）', () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    eq(mount({ statePath: broken }).variable.fn({ agent: { id: 'sess-hit' } }), '', '坏 JSON 却给出了内容');
    eq(
      mount({ statePath: join(dir, 'never-existed.json') }).variable.fn({ agent: { id: 'sess-hit' } }),
      '',
      '表不在却给出了内容'
    );
    // 绕过我们的写手直接往表里塞垃圾：插件必须自己挡住（写手那道不是唯一防线）
    writeFileSync(files.statePath, JSON.stringify({ 'sess-num': 3, 'sess-obj': { a: 1 }, 'sess-ok': 'x' }), 'utf8');
    const f = mount({ statePath: files.statePath }).variable.fn;
    eq(f({ agent: { id: 'sess-num' } }), '', '数字被原样交上去了');
    eq(f({ agent: { id: 'sess-obj' } }), '', '对象被原样交上去了');
    eq(f({ agent: { id: 'sess-ok' } }), 'x', '正常的值反而没交上去');
  });

  await check('A5 承重顺序：变量注册失败 ⇒ **绝不**留下引用它的小节（否则每轮 assembly 都抛）', () => {
    const got = mount({ statePath: files.statePath }, { variableThrows: true });
    eq(got.registered, [], '变量注册失败却还是注册了东西');
    eq(got.disposed, 0, '没有变量可回滚');
  });

  await check('A6 承重回滚：小节注册失败 ⇒ 变量要撤掉，且**不留半套**（异常由外层的纯增益兜住）', () => {
    const got = mount({ statePath: files.statePath }, { sectionThrows: true });
    eq(got.section, undefined, '小节注册失败了却还是留下了它');
    eq(got.disposed, 1, `变量没被撤掉（disposed=${got.disposed}）—— 那是一个没人回收的注册`);
    // 外层那道「纯增益」的兜底：注册不上就等于没有这个功能，**绝不**让异常出去搅一次 apply
    // （cordis 把它当插件加载失败，代价比「少一段说明」大得多）。
    let threw = undefined;
    try {
      mount({ statePath: files.statePath }, { sectionThrows: true });
    } catch (err) {
      threw = err;
    }
    eq(threw, undefined, `异常逃出了 apply：${threw}`);
  });

  await check('A7 没有 statePath / ctx 形状不对 → 干脆什么都不注册（零开销，不抛）', () => {
    for (const cfg of [{}, undefined, null, { statePath: 42 }, { statePath: '' }]) {
      eq(mount(cfg).registered, [], `config=${JSON.stringify(cfg)} 竟然注册了东西`);
    }
    for (const opts of [{ noSystemPrompt: true }, { noVariableMethod: true }, { noSectionMethod: true }, { noEffect: true }]) {
      eq(mount({ statePath: files.statePath }, opts).registered, [], `ctx 缺件（${JSON.stringify(opts)}）竟然注册了东西`);
    }
  });

  await check('A8 生成脚本里没有 `${}` 插值（它靠 String.raw，插值会把路径规则静默钉死）', () => {
    const src = readSrc('imagePromptPlugin.ts');
    const at = src.indexOf('export const IMAGE_PROMPT_PLUGIN_SCRIPT');
    ok(at > 0, '找不到插件脚本文本');
    const body = src.slice(at);
    ok(!/\$\{/.test(body), '插件脚本里出现了 ${} 插值 —— 一切都要从 config 入参读');
    // 脚本里的字面量必须与源码常量一致（两条各写一份，漂了要在 A2 红）
    ok(body.includes(`const VARIABLE_NAME = '${P.IMAGE_PROMPT_VARIABLE_NAME}'`), '脚本里的变量名不是源码那个');
    ok(body.includes(`const SECTION_NAME = '${P.IMAGE_PROMPT_SECTION_NAME}'`), '脚本里的小节名不是源码那个');
    ok(body.includes(`const SECTION_ORDER = ${P.IMAGE_PROMPT_SECTION_ORDER}`), '脚本里的 order 不是源码那个');
  });

  // ==================== 二、文案（`imagePromptText`） ====================

  console.log('\n--- 二、文案 ---');

  await check('B1 路径 / 可读大小 / MIME / 文件名都在（**不写**原始字节数：这块每轮都进提示词）', () => {
    const n = imagePromptText([mk()]);
    ok(n.includes(mk().path), '没有路径');
    ok(n.includes('1.2 MB'), '没有人读的大小');
    ok(n.includes('image/png'), '没有 MIME');
    ok(n.includes('shot.png'), '没有文件名');
    // 一行一张图、每轮都进系统提示词：旧版那句「344 KB，共 352136 字节」是给聊天气泡看的，
    // 在这里是纯噪声（人类读的刻度已经有了）。这条断言钉的是"这个决定没被后人改回去"。
    ok(!n.includes('1258291'), '又把原始字节数写进来了');
  });

  await check('B2 盘符路径附 WSL 第二读法；非盘符路径**不附**（真机上那一轮白烧就是这么来的）', () => {
    const win = imagePromptText([mk()]);
    ok(win.includes('/mnt/d/proj/.hello-chat/images/shot.png'), '没有给 WSL 里可执行的那一读');
    ok(win.includes('WSL'), '给了第二读法却没说它什么时候用得上');
    // 反控：POSIX 路径换算后原样返回 ⇒ 不该凭空多出一行 `/mnt/…`（macOS/Linux 上那是纯噪音）
    const posix = imagePromptText([mk({ path: '/home/u/.hello-chat/images/shot.png' })]);
    ok(!posix.includes('/mnt/'), 'POSIX 路径上凭空长出了 WSL 读法');
    ok(!posix.includes('WSL'), 'POSIX 路径上多了一句 WSL 的话');
    // 反控 2：真·Windows 路径里本来就带 `mnt` 段（`D:\mnt\x`）时，第二读法要老实换算
    ok(
      imagePromptText([mk({ path: 'D:\\mnt\\a\\shot.png' })]).includes('/mnt/d/mnt/a/shot.png'),
      '带 mnt 段的路径换算错了'
    );
  });

  await check('B3 「关」那一档的四句约束一句不少（掐掉任何一句都是这次改动白做的形状）', () => {
    const n = imagePromptText([mk()], 'blind');
    // C20：归因改准了 —— 判定来自「运行时有没有挂附件仓库」，那是**这次部署**的事实，
    // 不是模型的属性（模型完全可能是多模态的）。反控在下面 B3c。
    ok(n.includes('这次部署没有开通图片输入'), '没说清是这次部署没开通');
    ok(n.includes('看不到'), '没说「看不到」—— 模型会一本正经地描述画面');
    ok(n.includes('不要凭文件名猜测'), '没有「不要凭文件名猜测」那半句');
    // 真机：一句「这是什么东西」就让 agent 装了整套 OCR 栈
    ok(n.includes('不要试图用工具'), '没有拦「用工具把它看出来」这条路');
    ok(n.includes('OCR') && n.includes('装识别工具'), '没有点名那几种走不通的做法');
    ok(n.includes('直接告诉用户'), '只说了别做什么，没说该做什么');
    // 反控：正当的文件操作**必须仍然放行**（收得太紧会把「把这个文件挪到 X」也拒掉）
    ok(n.includes('只有用户明确要求'), '把用工具这条路整个堵死了');
  });

  await check('B3b 「开」那一档：指出正确的动作，且**不许**拦那条唯一正确的路', () => {
    const n = imagePromptText([mk()], 'readable');
    ok(n.includes('read_image'), '没说该用哪个工具读 —— 这一档的全部意义就是指出正确动作');
    // ⚠️ 这两句在「开」的那一半世界里是**假话**，第二句更坏：它禁掉的正是唯一正确的动作
    ok(!n.includes('看不到'), '「开」那一档还写着「看不到」');
    ok(!n.includes('不要试图用工具'), '「开」那一档还拦着「用工具把它看出来」—— 那正是它该做的事');
    ok(!n.includes('OCR'), '「开」那一档还在讲装 OCR 栈那件事');
    // 两句共同的尾巴：与档位无关，不该被顺手删掉
    ok(n.includes('不要凭文件名猜测'), '共同的那半句「不要凭文件名猜测」被删了');
    ok(n.includes('只有用户明确要求'), '共同的那半句「只有用户明确要求」被删了');
    // 「开」的一档**不承诺能力**：运行时会不会答应由它自己的闸说了算，这里只指出动作
    ok(n.includes('读不了') || n.includes('不支持'), '没交代「撞门了怎么办」');
  });

  await check('B3c 判定与文案同向：不提不存在的工具、也不把部署说成模型', () => {
    const blind = imagePromptText([mk()], 'blind');
    const readable = imagePromptText([mk()], 'readable');
    // 「关」的那一档里点名 `read_image` 是**反向的同一句谎**（那个工具根本不存在）
    ok(!blind.includes('read_image'), '「关」的文案里点了一个不存在的工具名');
    ok(!blind.includes('当前模型不支持图片输入'), '又把部署的事实说成模型的属性了（C17 的老毛病）');
    // 两档共用同一抬头：图片字节不随消息走这件事**在两个世界里都为真**
    for (const n of [blind, readable]) {
      ok(n.includes('图片字节不随消息发送'), '抬头丢了 —— 那是两个变体唯一的共同事实');
      ok(n.includes(mk().path), '没有路径');
    }
    // 档位是**封闭两档**：认不出来的值一律落到「关」（fail-closed）
    eq(imagePromptText([mk()], 'weird'), blind, '认不出来的档位没有落到「关」');
    eq(imagePromptText([mk()]), blind, '缺省档位不是「关」');
  });

  await check('B4 绝不出现 `@"`（DSH 的 @ 只管会话引用，发了等于把 agent 引向文本工具）', () => {
    for (const n of [imagePromptText([mk()]), imagePromptText([mk(), mk({ name: 'a b.png' })])]) {
      ok(!n.includes('@"'), '说明文字里出现了 @"');
      ok(!/dsh-session:/.test(n), '混进了会话引用语法');
    }
  });

  await check('B5 没有图片 ⇒ 空串（空小节会被 renderPrompt 整个丢掉 = 零痕迹）', () => {
    eq(imagePromptText([]), '');
    for (const junk of [undefined, null, 'x', 42, {}]) eq(imagePromptText(junk), '', `垃圾输入 ${JSON.stringify(junk)} 给出了内容`);
  });

  await check('B6 按张数封顶：只留最新 12 张，省略几条要报数并指出目录', () => {
    const many = Array.from({ length: MAX_IMAGES_IN_PROMPT + 3 }, (_, i) =>
      mk({ name: `p${i}.png`, path: `D:\\proj\\images\\p${i}.png` })
    );
    const n = imagePromptText(many);
    ok(!n.includes('p0.png'), '最旧的那张还在（封顶没生效）');
    ok(n.includes(`p${MAX_IMAGES_IN_PROMPT + 2}.png`), '最新的那张丢了');
    ok(n.includes(`p${MAX_IMAGES_IN_PROMPT}.png`), '第 12 张（最后一张该留的）丢了');
    ok(n.includes('更早的 3 张已省略'), '省略条数没说');
    ok(n.includes('.hello-chat/images/'), '省略行没点出目录 —— 模型再没有别的办法找到它们');
    ok(n.includes('这次部署没有开通图片输入'), '省掉了行，却把约束一起丢了');
  });

  await check('B7 按字符封顶：病态长路径下整块不超上限，且约束句还在', () => {
    const long = mk({ path: 'D:\\' + 'x'.repeat(5000) + '.png' });
    const n = imagePromptText([long]);
    ok(n.length <= MAX_IMAGE_PROMPT_CHARS, `长度 ${n.length} 超过上限 ${MAX_IMAGE_PROMPT_CHARS}`);
    ok(n.includes('已截断'), '单行截断了却没说');
    ok(n.includes('这次部署没有开通图片输入'), '截断把尾段的约束切掉了（那正是要保住的东西）');
  });

  await check('B8 `{{` 逐字保真：模板生成的 `{{草稿}}.png` 不许被改写、也不许被吃掉', () => {
    // 这一条是 C17b 唯一改过投递通道的理由（见 imagePromptPlugin 头注释）：正文走**变量**，
    // 而 interpolate 的文档明说 "substituted values are not scanned again"。
    // 单看纯函数只能证明「我们没洗掉它」；「DSH 不会把它当引用再扫一遍」由 D4 端到端证。
    const n = imagePromptText([mk({ name: '{{草稿}}.png', path: 'D:\\proj\\{{草稿}}.png' })]);
    ok(n.includes('{{草稿}}.png'), '名字里的 {{ }} 被改写了');
    ok(n.includes('D:\\proj\\{{草稿}}.png'), '路径里的 {{ }} 被改写了');
  });

  // ==================== 三、派生配置块 ====================

  console.log('\n--- 三、派生块 ---');

  await check('C1 派生文件里有图片说明块：id / name(file:///) / statePath 都在', () => {
    const r = writeDerivedConfig({
      storageDir: dir,
      baseConfigPath: baseConfig,
      hooksPath: '',
      imagePrompt: { pluginUrl: files.pluginUrl, statePath: files.statePath },
    });
    const text = readFileSync(r.cordisPath, 'utf8');
    ok(text.includes('- id: hello-chat-image-prompt'), '派生文件里没有图片说明块');
    ok(text.includes(`name: '${files.pluginUrl}'`), `name 不是单引号原样：\n${text.slice(-320)}`);
    ok(text.includes(`statePath: '${files.statePath}'`), 'statePath 没写进去');
    eq(r.imagePromptWarning, undefined, `不该有告警：${r.imagePromptWarning}`);
  });

  await check('C2 根不是块状序列 ⇒ 挂不上就**必须**告警（静默失效正是 C17 那场事故的入口）', () => {
    const badBase = join(dir, 'flat.yml');
    writeFileSync(badBase, 'plugins: [a, b]\n', 'utf8');
    const r = writeDerivedConfig({
      storageDir: dir,
      baseConfigPath: badBase,
      hooksPath: '',
      imagePrompt: { pluginUrl: files.pluginUrl, statePath: files.statePath },
    });
    ok(typeof r.imagePromptWarning === 'string' && r.imagePromptWarning.length > 0, '挂不上却没有告警');
    // C1 的既有语义一个字不改：要追加 hooks 块且根不合法 → 照旧 throw
    let threw = false;
    try {
      writeDerivedConfig({ storageDir: dir, baseConfigPath: badBase, hooksPath: join(dir, 'hooks.json') });
    } catch {
      threw = true;
    }
    ok(threw, 'C1 那条「根不合法就拒绝生成」被改软了');
  });

  await check('C3 没给 imagePrompt 时派生文件里一个字都不多（零回归反控）', () => {
    const r = writeDerivedConfig({ storageDir: join(dir, 'plain'), baseConfigPath: baseConfig, hooksPath: '' });
    const text = readFileSync(r.cordisPath, 'utf8');
    eq(text.includes('hello-chat-image-prompt'), false, '没要求却挂了图片说明块');
    eq(r.imagePromptWarning, undefined, '没要求却报了告警');
  });

  await check('C4 `writeImagePromptState`：整份重写、丢掉空串与非字符串、不留 .tmp', () => {
    P.writeImagePromptState(files.statePath, { 's-1': 'x', 's-2': '', '': 'y', 's-3': 7, 's-4': 'z' });
    eq(
      JSON.parse(readFileSync(files.statePath, 'utf8')),
      { 's-1': 'x', 's-4': 'z' },
      '表没按预期清洗（空串=没有图片，写进去就是垃圾）'
    );
    ok(!existsSync(`${files.statePath}.tmp`), '留下了 .tmp（原子写的中间件不该留在盘上）');
    P.writeImagePromptState(files.statePath, { 's-9': 'q' });
    eq(JSON.parse(readFileSync(files.statePath, 'utf8')), { 's-9': 'q' }, '不是整份重写（合并会留下已删会话的残影）');
  });

  // ==================== 四、端到端（真运行时，读盘上的 header 与 user/message） ====================

  console.log('\n--- 四、端到端（真运行时 + 假 key）---');

  const mounted = writeDerivedConfig({
    storageDir: dir,
    baseConfigPath: baseConfig,
    hooksPath: '',
    imagePrompt: { pluginUrl: files.pluginUrl, statePath: files.statePath },
  });
  ok(mounted.imagePromptWarning === undefined, `端到端用的派生配置没挂上图片说明块：${mounted.imagePromptWarning}`);

  /** 只可能来自状态文件的记号：正控的靶子。 */
  const MARK = 'probe-image-aa11.png';
  const CURLY = '{{草稿}}-probe.png';
  const seeded = imagePromptText([
    mk({ name: MARK, path: `D:\\probe\\images\\${MARK}`, bytes: 512 }),
    mk({ name: CURLY, path: `D:\\probe\\images\\${CURLY}`, bytes: 512 }),
  ]);
  ok(seeded.includes(MARK) && seeded.includes(CURLY), '探针自己拼的正文里没有记号（靶子不成立）');

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

  /** 从盘上的会话日志里捞出这一轮的 request/header 与所有 user/message。 */
  const readLog = (root) => {
    let header;
    const users = [];
    for (const p of walk(root)) {
      if (!p.endsWith('.jsonl.zstd')) continue;
      for (const e of readSessionEvents(p)) {
        if (e?.type === 'request/header' && e?.data?.header?.config) header = e.data.header;
        if (e?.type === 'user/message') users.push(JSON.stringify(e.data));
      }
    }
    return { header, users };
  };

  let positive; // 正控那一轮的结果，给 D4 用
  await check('D1 正面判据：这一轮的 system 里**有**我们的抬头、图名与约束句', async () => {
    P.writeImagePromptState(files.statePath, { 'probe-img-1': seeded });
    const { r, root } = await boot('probe-img-1');
    const { header, users } = readLog(root);
    positive = { r, header, users };
    ok(header, `没找到 request/header（这一轮压根没跑到请求构建期）—— 这一轮的结局：${r.reason}`);
    const system = typeof header.system === 'string' ? header.system : '';
    ok(system.length > 0, 'header 里没有 system（空 system 会被 canonicalHeader 丢掉）');
    ok(system.includes('用户在本会话附过这些图片'), '抬头不在 system 里 —— 插件根本没生效');
    ok(system.includes(MARK), `那张图的路径不在 system 里。system 尾部：\n${system.slice(-600)}`);
    ok(system.includes('不要试图用工具'), '约束句不在 system 里 —— 那模型就会去装 OCR 栈');
    ok(system.includes(`/mnt/d/probe/images/${MARK}`), 'WSL 第二读法没进 system');
  });

  await check('D2 气泡干净的判据：同一份日志里的 user/message **一个字节都不含**那些字', async () => {
    ok(positive, 'D1 没跑成，这条无从谈起');
    eq(positive.users.length > 0, true, '日志里一条 user/message 都没有（那这条反证等于没查）');
    const all = positive.users.join('\n');
    ok(!all.includes('用户在本会话附过这些图片'), 'user/message 里出现了我们的抬头 —— 气泡又脏了');
    ok(!all.includes(MARK), 'user/message 里出现了图片路径');
    ok(!all.includes('不要试图用工具'), 'user/message 里出现了约束句');
    ok(all.includes('探针：只为触发一次请求构建'), '连探针自己那句话都找不到 —— 读的可能不是这一条');
  });

  await check('D3 反控：表里没有这个会话 ⇒ 同一个串**不在**它的 system 里', async () => {
    // 表非空（装着别的会话）才能证明"没有"是**按会话**的，而不是"整个插件没生效"
    P.writeImagePromptState(files.statePath, { 'probe-img-1': seeded });
    const { r, root } = await boot('probe-img-2');
    const { header } = readLog(root);
    ok(header, `没找到 request/header —— 这一轮的结局：${r.reason}`);
    const system = typeof header.system === 'string' ? header.system : '';
    ok(!system.includes(MARK), '别的会话的图片清单串到它头上了');
    ok(!system.includes('用户在本会话附过这些图片'), '别的会话的说明串到它头上了');
  });

  await check('D4 `{{` 保真：名字里带 `{{草稿}}` 的图既不让这一轮失败，也不被改写', async () => {
    ok(positive, 'D1 没跑成，这条无从谈起');
    const system = typeof positive.header.system === 'string' ? positive.header.system : '';
    // 真跑到了这一步（header 在），就证明 interpolate 没有把它当引用再扫一遍
    ok(system.includes(CURLY), '名字里的 {{ }} 没能逐字到达 system —— 要么被吃了要么搅了 assembly');
    eq(positive.r.ok, true, `这一轮没跑通（reason=${positive.r.reason}）—— 说明 assembly 抛了`);
  });

  // ==================== 五、静态守卫 ====================

  console.log('\n--- 五、静态守卫 ---');

  await check('E1 那段说明的旧出口已经全拆了（一个判据只有一个家）', () => {
    const provider = readSrc('chatViewProvider.ts');
    for (const f of ['imageAttach.ts', 'chatViewProvider.ts', 'protocol.ts']) {
      const src = readSrc(f);
      ok(!src.includes('noteForAttachment'), `${f} 里还有 noteForAttachment`);
      ok(!/imageNote\s*\(/.test(src), `${f} 里还在调 imageNote`);
    }
    // ⚠️ 只在 `Attachment` 的接口体里找：`protocol.ts` 另有一个**同名**的 `note?: string`
    //    属于 change-forecast 的记录（`:280`），那是另一件事，扫全文会把它一起判红（实测踩过）。
    const proto = readSrc('protocol.ts');
    const decl = proto.slice(proto.indexOf('export interface Attachment'));
    ok(!/^\s*note\?:/m.test(decl.slice(0, decl.indexOf('\n}'))), 'Attachment 上还有 note 字段');
    ok(provider.includes('_writeImagePromptState()'), 'provider 不再重建图片说明表了');
  });

  await check('E2 表是在**发请求之前**、**起进程之前**写的（否则这一轮读到的是旧表）', () => {
    const provider = readSrc('chatViewProvider.ts');
    const live = provider.slice(provider.indexOf('private async _runLive'));
    const writeAt = live.indexOf('this._writeImagePromptState()');
    const promptAt = live.indexOf('runtime.prompt(');
    const connectAt = live.indexOf('await this._connectLive()');
    ok(writeAt > 0, '_runLive 里没有重建表');
    ok(writeAt < promptAt, '表写在发请求之后了');
    ok(writeAt < connectAt, '表写在起进程之后了 —— 新进程第一步请求读不到它');
  });

  await check('E3 键的来源：内存表 `_dshSessions` 优先、`s.dsh?.id` 兜底（只认后者会整段静默消失）', () => {
    const provider = readSrc('chatViewProvider.ts');
    const at = provider.indexOf('private _imagePromptTable(');
    ok(at > 0, '找不到 _imagePromptTable（表的算法与落盘应当分开 —— 判决那条要用它）');
    const body = provider.slice(at, provider.indexOf('\n  }', at));
    ok(body.includes('this._dshSessions.get('), '没有用内存表取键 —— no-patch / cwd 不符那两支会把整段说明弄丢');
    ok(body.includes('s.dsh?.id'), '没有用落盘的 id 兜底 —— 重载窗口后一个键都写不出来');
    ok(body.includes('this._active.id'), '活跃会话没有排到最后（上限会把它本轮刚贴的图挤掉）');
    ok(provider.slice(provider.indexOf('private _purgeOne')).includes('this._writeImagePromptState()'), '_purgeOne 里没有重建表（删掉的会话会留下残影）');
  });

  await check('E5 「到不了模型」的判决晚于挂块旗标（初版写在写表里 ⇒ 首次连接必然误报，且烧掉唯一那条额度）', () => {
    const provider = readSrc('chatViewProvider.ts');
    // ① 写表里**不许**问挂块旗标：`_refreshDerivedConfig` 里写表跑在挂块**之前**，那时旗标还是旧值
    const wAt = provider.indexOf('private _writeImagePromptState(');
    ok(wAt > 0, '找不到 _writeImagePromptState');
    const wBody = provider.slice(wAt, provider.indexOf('\n  }', wAt));
    ok(!wBody.includes('_imagePromptMounted') && !wBody.includes('_overlayConfigPath'),
      '写表里又去问挂块旗标了 —— 那一刻它是上一轮的旧值（首连为空 ⇒ 刚挂上被误判成没挂上）');
    // ② `_refreshDerivedConfig` 里：末尾那次判决必须在旗标赋值**之后**，且早退支也要判一次
    const refreshAt = provider.indexOf('private _refreshDerivedConfig(');
    ok(refreshAt > 0, '找不到 _refreshDerivedConfig');
    const refresh = provider.slice(refreshAt, provider.indexOf('// ---------- C11', refreshAt));
    const lastCall = refresh.lastIndexOf('this._checkImagePromptDelivery()');
    const lastAssign = refresh.lastIndexOf('this._imagePromptMounted = ');
    ok(lastCall > 0, '_refreshDerivedConfig 里根本没有判决点');
    // 「底本配置找不到」那一支是**早退**（还没走到挂块就 return 了），所以它必须在 return 之前自己判一次
    const earlyAt = refresh.indexOf('if (!baseConfigPath)');
    ok(earlyAt > 0, '找不到「底本配置找不到」那一支');
    const early = refresh.slice(earlyAt, refresh.indexOf('\n    }', earlyAt));
    ok(early.includes('this._checkImagePromptDelivery()'),
      '「底本配置找不到」那一支（早退）没有判决 —— 那条路上派生配置根本没被用上，而它是事故入口之一');
    ok(lastAssign > 0 && lastCall > lastAssign, '末尾那次判决在旗标赋值之前 —— 顺序反了就是误报');
    // ③ 每轮发送前那条也要在写表之后（那时连接早已完成、旗标是准的）
    // ⚠️ 切片必须**止于 `_runLive` 的结尾**：`_refreshDerivedConfig` 在它后面，那里面也有判决点，
    //    切到文件尾会让这条断言恒真 —— 「这条变异没被抓到」实测过一次（假绿）。
    const runAt = provider.indexOf('private async _runLive');
    const runEnd = provider.indexOf('\n  private ', runAt + 10);
    ok(runAt > 0 && runEnd > runAt, '定位不到 _runLive 的结尾');
    const live = provider.slice(runAt, runEnd);
    const w = live.indexOf('this._writeImagePromptState()');
    const c = live.indexOf('this._checkImagePromptDelivery()');
    ok(w > 0 && c > w, '_runLive 里没有在写表之后判决（本轮贴了图却到不了模型就没人说）');
  });

  await check('E6 C20 三处跟随的接线：判定只有一个入口，值记在会话上，翻档不在流里重画', () => {
    const provider = readSrc('chatViewProvider.ts');
    // ① 判定的入口：`request/header` 那一帧 → 纯模块的 `imageRouteFromHeader`（判据本身在 attach 探针钉着）
    const caseAt = provider.indexOf("case 'request/header'");
    ok(caseAt > 0, "找不到 case 'request/header' —— 判定没有来源");
    const caseBody = provider.slice(caseAt, provider.indexOf('case \'', caseAt + 10));
    ok(caseBody.includes('imageRouteFromHeader(d.header)'), '判定不是从这一轮的 header 读的');
    ok(/this\._active\.imageRead\s*=/.test(caseBody), '判定没有记在会话上 —— 只记内存的话重开窗口就退回「关」');
    // ⚠️ 流里**不许**重画快照：那一刻正在生成回复，重画会把正在写的气泡拆掉
    ok(!caseBody.includes('_postSnapshot()'), '在流里重画快照了（会把正在写的气泡拆掉）');
    // ② 「这一档」的读数只有一个函数，三处都走它
    ok(provider.includes('private _imageRoute('), '找不到 _imageRoute');
    ok(provider.includes('this._imageRoute(this._active) === \'readable\''), '快照没有带 imageRead');
    ok(provider.includes('this._imageRouteOfDshId(dshId)'), '提示词表那一处没有跟随档位');
    ok(provider.includes('sessionToMarkdown(frozen, this._imageRoute('), '导出那一处没有跟随档位');
    // ③ 同一个 dsh id 取「或」：一个进程服务多条 UI 会话（分叉共享源 id）
    const routeAt = provider.indexOf('private _imageRouteOfDshId(');
    ok(routeAt > 0, '找不到 _imageRouteOfDshId');
    const routeBody = provider.slice(routeAt, provider.indexOf('\n  }', routeAt));
    ok(routeBody.includes('=== dshId') && routeBody.includes('readable'), '同一 dsh id 没有取或 —— 分叉那条会说回旧话');
    // ④ 翻档的补发在轮尾（那时没有流在跑），且翻完就清
    const afterAt = provider.indexOf('private _afterTurn(');
    const afterBody = provider.slice(afterAt, provider.indexOf('\n  }', afterAt));
    ok(afterBody.includes('_imageReadFlipped'), '_afterTurn 里没有补发翻档的快照 —— 已经画出来的 chip 永远不翻');
    ok(/this\._imageReadFlipped = false/.test(afterBody), '翻档旗标没有清 —— 之后每轮都会白发一次快照');
    // ⑤ 会话字段本身（落盘的那一份）
    const store = readSrc('sessionStore.ts');
    ok(/imageRead\?: boolean;/.test(store), 'StoredSession 上没有 imageRead —— 判定没落盘');
  });

  await check('E4 这个探针与 attach 探针各守一段，不重叠（D1–D4 不许搬回去）', () => {
    const attach = readFileSync(join(repoRoot, 'scripts', 'probe-image-attach.mjs'), 'utf8');
    // 判据是**导入表**里没有它（`imageNote` 这个词在后人的注释里出现是对的 —— 他得说明为什么没有它）
    ok(!/^\s*imageNote,\s*$/m.test(attach), 'attach 探针又把 imageNote 导进来了');
    ok(!attach.includes('MAX_IMAGE_NOTE_CHARS'), 'attach 探针里还留着旧上限常量');
    ok(attach.includes('probe-image-prompt.mjs'), 'attach 探针里没有一句「这段判据搬去哪儿了」');
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
