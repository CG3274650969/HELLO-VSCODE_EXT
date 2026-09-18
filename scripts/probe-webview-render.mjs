#!/usr/bin/env node
/**
 * webview 渲染自检 —— **不需要 VS Code、不需要浏览器、不发任何模型调用**。
 *
 * 在 Node 里用一个最小 DOM 影子把 `media/chat.js` 整份载起来，然后像扩展那样往
 * `window` 上喂消息帧，断言**渲染出来的 DOM 结构与文案**。F5 之前这是唯一能跑通
 * chat.js 那几百行 DOM 构建代码的路子：`node --check` 只验语法，HTML/JS/CSS 交叉
 * 检查只验 id 与 class 拼写，都碰不到"渲染出来的东西对不对"。
 *
 * 为什么入库（以前是一次性脚本，删了又重建第二遍）：它抓到的两类真 bug 都不是
 * 语法错，而是**契约漂移** ——
 *   1. 一个渲染函数被两种 payload 共用、字段名不一样（C9 运行条）；
 *   2. 影子自己对 `classList.toggle(cls, force)` 的支持与真 DOM 不一致。
 * 第 2 类说明影子**本身**也要被钉住，所以它现在把「初始 hidden 从 chat.html 里读」
 * 这种事也照做了（见 seedFromHtml），而不是给每个元素手写默认值。
 *
 * 影子必须满足 chat.js 的**加载期**依赖，少一个都载不起来：
 *   · `acquireVsCodeApi()`（唯一句柄，同一 iframe 只能取一次）
 *   · `window.addEventListener('message', …)`（init() 末尾挂的那个总入口）
 *
 * 覆盖面：C10 的 D1（占用指示：near / stale / compacted）与 D4（转写折叠），
 * 外加 C9 运行条的一小段回归样（它就是上面第 1 类 bug 的案发现场）。
 * **盖不住的**：CSS 长什么样、真实滚动位置、React 单包接管后的画面（影子不给
 * `dsh-live-host` 产物 uri，chat.js 会按"产物缺失"静默回退 DOM 渲染 —— 这正是我们要的那条路）。
 *
 *   node scripts/probe-webview-render.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { findHarnessStore, readHarnessStore } from './dsh-session-log.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `media/chat.js` 里那个 `FOLD_KEEP`（那边是 IIFE 内的 var，探针拿不到，只能钉一份在这里）。
 * **这是有意的重复**：它一旦与 chat.js 里的值不一致，下面 D4 那两组断言会立刻整片变红 ——
 * 那就该有人去看是"实现改了"还是"探针过时了"，而不是静默地对不齐。
 */
const FOLD_KEEP = 60;

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
  ok(actual === expected, `${what}\n    期望 ${JSON.stringify(expected)}，实到 ${JSON.stringify(actual)}`);
}

// ---------- 最小 DOM 影子 ----------

/**
 * 一个元素。**刻意实现成"够用就诚实"**：`className` 与 `classList` 必须是同一份数据
 * （chat.js 一边用 `className = 'msg msg-user'` 建，一边用 `classList.contains('msg')` 删），
 * `classList.toggle` 必须认 force 参数（`updateBusy` 用的是 `toggle('live-busy', busy)`），
 * `addEventListener` 必须**真存**（折叠那行按钮点了要能重渲染）。
 * 这三条都是被真 bug 教出来的，不是照着 MDN 抄的。
 */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._classes = new Set();
    this._listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.title = '';
    this.id = '';
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 50;
    this.offsetHeight = 50;
    const cls = this._classes;
    this.classList = {
      add: (...cs) => { cs.forEach((c) => cls.add(c)); },
      remove: (...cs) => { cs.forEach((c) => cls.delete(c)); },
      contains: (c) => cls.has(c),
      // force 参数（与真 DOM 同语义）：true 加、false 删、不传则翻转
      toggle: (c, force) => {
        const want = force === undefined ? !cls.has(c) : !!force;
        if (want) cls.add(c); else cls.delete(c);
        return want;
      },
    };
  }
  get className() { return [...this._classes].join(' '); }
  // ⚠️ 必须**原地改**那个 Set，不能换成新的：上面的 classList 闭包捕获的是构造时那一个，
  // 换掉 = classList 从此看着一个空集合（`wrap.className = 'msg msg-user'` 之后
  // `classList.contains('msg')` 为假 → removeAllMessages 一个都删不掉、折叠断言全空转）。
  set className(v) {
    this._classes.clear();
    for (const c of String(v).split(/\s+/)) if (c) this._classes.add(c);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get parentNode() { return this._parent || null; }
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  append() { for (const c of arguments) this.appendChild(c); }
  insertBefore(c, ref) {
    c._parent = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  replaceChildren() { this.children = []; }
  remove() { if (this._parent) this._parent.removeChild(this); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners.get(type);
    if (a) this._listeners.set(type, a.filter((f) => f !== fn));
  }
  /** 影子专用（真 DOM 里 click() 也是这么派的）：派发一次事件 */
  dispatch(type) {
    const a = this._listeners.get(type) || [];
    for (const fn of a) fn({ type: type, target: this, preventDefault() {}, stopPropagation() {} });
  }
  click() { this.dispatch('click'); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  contains() { return false; }
  focus() {}
  blur() {}
  select() {}
  setSelectionRange() {}
  setAttribute(k, v) { if (k === 'class') this.className = v; else if (k === 'hidden') this.hidden = true; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
  removeAttribute() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { width: 300, height: 20, top: 0, left: 0, bottom: 20, right: 300 }; }
  cloneNode() { return new El(this.tagName); }
}

/**
 * 按 chat.html 里**写了 `hidden` 属性**的 id 给影子一个诚实的初值。
 *
 * 不是洁癖：`#dsh-live-host` 初值是否 hidden 决定了 `isReactLive()` 的真假，
 * 而它真了的话 `addMessage` 会整条提前返回 —— 折叠那套测试就会全绿地空转。
 * （旧影子给所有元素 hidden=false，于是这条路上永远走不到 DOM 渲染。）
 */
function seedFromHtml(html) {
  const hiddenIds = new Set();
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    const idm = tag.match(/\bid="([^"]+)"/);
    if (!idm) continue;
    if (/\shidden(?=[\s/>])/.test(tag)) hiddenIds.add(idm[1]);
  }
  return hiddenIds;
}

const htmlPath = join(repoRoot, 'media', 'chat.html');
const hiddenIds = seedFromHtml(readFileSync(htmlPath, 'utf8'));

const byId = new Map();
const document = {
  body: new El('body'),
  head: new El('head'),
  documentElement: new El('html'),
  createElement: (t) => new El(t),
  createDocumentFragment: () => new El('fragment'),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
  getElementById(id) {
    if (!byId.has(id)) {
      const e = new El('div');
      e.id = id;
      e.hidden = hiddenIds.has(id);
      byId.set(id, e);
    }
    return byId.get(id);
  },
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  execCommand: () => true,
};

const posted = [];
let messageHandler = null;
const win = {
  addEventListener: (type, fn) => { if (type === 'message') messageHandler = fn; },
  removeEventListener: () => {},
  dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  getComputedStyle: () => ({
    fontSize: '13px', lineHeight: '18.85px',
    paddingTop: '4px', paddingBottom: '4px', borderTopWidth: '1px', borderBottomWidth: '1px',
  }),
  location: { href: 'vscode-webview://probe', reload: () => {} },
};
let internalState = null;
const vscodeApi = {
  postMessage: (m) => posted.push(m),
  getState: () => internalState,
  setState: (s) => { internalState = s; },
};

const sandbox = {
  document,
  window: win,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: () => {},
  acquireVsCodeApi: () => vscodeApi,
  getComputedStyle: win.getComputedStyle,
  navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'node' },
  location: win.location,
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  requestIdleCallback: (fn) => setTimeout(fn, 0),
  MessageEvent: class { constructor(t, i) { this.type = t; this.data = i && i.data; } },
  URL: { createObjectURL: () => 'blob:probe', revokeObjectURL: () => {} },
  Blob: class { constructor() {} },
  FileReader: class { readAsText() {} addEventListener() {} },
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Intl,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

vm.createContext(sandbox);
const chatJs = readFileSync(join(repoRoot, 'media', 'chat.js'), 'utf8');
let loadError = null;
try {
  vm.runInContext(chatJs, sandbox, { filename: 'media/chat.js' });
} catch (err) {
  loadError = err;
}

// ---------- 断言用的小工具 ----------

const $ = (id) => document.getElementById(id);
const messagesEl = () => $('messages');
const usageBar = () => $('usage-bar');
const usageSummary = () => $('usage-summary');

/** 整棵子树的元素（前序） */
function walk(el, out = []) {
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}
/** 整棵子树的文本片段（叶子上的 + 直接挂在有子元素节点上的，如折叠行按钮） */
function texts(el) {
  return walk(el).filter((e) => e._text).map((e) => e._text);
}
function hasText(el, s) {
  return texts(el).some((t) => t.includes(s));
}
/**
 * 比**真数据正文**时用的宽松版：markdown 渲染会把 `` ` `` 当代码记号、把 `\` 当转义吃掉，
 * 所以两边都先去记号、去空白再比。用它只为了确认"这个节点是那条消息"，不是验渲染细节
 * —— 2026-09-18 实测：真实消息里带 `D:\metabase\…` 这种路径，raw slice 比法假红过一次。
 */
function plainText(s) {
  return String(s)
    .replace(/[`\\*_#>|~[\]()]/g, '')
    .replace(/\s+/g, '');
}
function hasTextLoose(el, s) {
  const want = plainText(s).slice(0, 24);
  if (!want) return true; // 这条消息没有可比的可观察特征（比如纯符号），跳过不判
  return plainText(texts(el).join('')).includes(want);
}
function childWithClass(el, cls) {
  return el.children.filter((c) => c.classList.contains(cls));
}
/** #messages 里的消息气泡（不含折叠行与空态提示） */
const msgNodes = () => childWithClass(messagesEl(), 'msg');
const foldRows = () => childWithClass(messagesEl(), 'msg-fold');

const send = (m) => {
  if (!messageHandler) throw new Error('window 上没有 message 监听器 —— init() 没跑完');
  messageHandler({ data: m, origin: '', source: win });
};

/** 造 n 条消息（user/assistant 交替，纯文本行；assistant 会走 renderMarkdownInto） */
function mkMessages(n, prefix = 'm') {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      id: `${prefix}${i}`,
      role: i % 2 ? 'user' : 'assistant',
      text: `第 ${i} 条`,
      status: 'done',
    });
  }
  return out;
}

/** 一条读数：只给要测的那几段，其余缺省（渲染函数对缺省段有专门的早退分支） */
function usage(over = {}) {
  return Object.assign({ turn: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, session: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }, over);
}

// ---------- 加载期 ----------

check('chat.js 在 DOM 影子里载入成功（加载期没做影子没覆盖的事）', () => {
  if (loadError) {
    throw new Error(`${loadError.message}\n    ${String(loadError.stack || '').split('\n').slice(1, 4).join('\n    ')}`);
  }
});

check('init() 挂上了 message 监听器并回了 ready（影子满足了两处加载期依赖）', () => {
  ok(typeof messageHandler === 'function', '没抓到 message 监听器');
  ok(posted.some((m) => m.type === 'ready'), 'init() 没 post ready');
});

check('#dsh-live-host 初值是 hidden（否则 isReactLive() 为真，addMessage 会整条早退）', () => {
  ok($('dsh-live-host').hidden === true, '影子没按 chat.html 给出 hidden 初值 —— 折叠那组断言会变成假绿');
});

// ---------- D1 · 占用指示（扩 #usage-bar 的上下文段） ----------

check('D1 没有任何用量 → 整条隐藏', () => {
  send({ type: 'usage', usage: null });
  ok(usageBar().hidden, '没有读数时条应隐藏');
});

check('D1 有占用但离阈值远 → 显示占用、不挂 .near、不喊 ⚠', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  ok(!usageBar().hidden, '有读数时条应显示');
  // 24K 那段按 fmtTokens 的档位给：<1e5 保留一位小数，所以是 24.0K 而不是 24K
  ok(hasText(usageSummary(), '上下文 24.0K / 1.0M'), '占用段文案不对：' + usageSummary().textContent);
  ok(!usageSummary().textContent.includes('⚠'), '没接近阈值却喊了警');
  ok(!usageBar().classList.contains('near'), '没接近阈值却挂了 .near');
});

check('D1 state=ok 与缺省同义（都不算 near）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000, state: 'ok' } }) });
  ok(!usageBar().classList.contains('near'), "state:'ok' 被当成了 near");
});

check('D1 state=near → 文案带 ⚠ 且条挂 .near', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near' } }) });
  ok(hasText(usageSummary(), '⚠ 接近压缩阈值'), '接近阈值时没喊警：' + usageSummary().textContent);
  ok(usageBar().classList.contains('near'), '.near 没挂上（CSS 的警示色就靠它）');
});

check('D1 near 的 title 必须写明「我们的数不是 DSH 的判据」（口径诚实是硬要求）', () => {
  const t = usageSummary().title;
  ok(t.includes('不是同一个数'), 'title 没写口径差异 —— 界面会让人以为到了这条线就一定会压缩');
  ok(!t.includes('还有'), 'title 里出现了「还有 X」式承诺：分子口径不支持这种说法');
});

check('D1 stale → 标「上次」，但不因此挂 .near', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000, stale: true } }) });
  ok(hasText(usageSummary(), '· 上次'), '陈旧读数没标「上次」：' + usageSummary().textContent);
  ok(!usageBar().classList.contains('near'), '陈旧不等于接近');
  ok(usageSummary().title.includes('上一次跑完时留下的样本'), 'title 没解释「上次」是什么');
});

check('D1 stale + near 两个后缀**并列**（不是 else if）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near', stale: true } }) });
  const s = usageSummary().textContent;
  ok(s.includes('· 上次') && s.includes('⚠ 接近压缩阈值'), '两个后缀应同时出现：' + s);
});

check('D1 near → 回到 ok 时 .near 要摘掉（add/remove 两条路都走一遍）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near' } }) });
  ok(usageBar().classList.contains('near'), '前置条件不成立');
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000, state: 'ok' } }) });
  ok(!usageBar().classList.contains('near'), '从 near 回退后 .near 没摘掉');
});

check('D1 compacted>0 → 追加「已压缩 N 次」', () => {
  send({ type: 'usage', usage: usage({ compacted: 3, context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  ok(hasText(usageSummary(), '已压缩 3 次'), '压缩计数没上条：' + usageSummary().textContent);
});

check('D1 只有 compacted、别的段全空 → 条仍要显示（不能被 parts 为空的分支藏掉）', () => {
  send({ type: 'usage', usage: { compacted: 1 } });
  ok(!usageBar().hidden, '只有压缩计数时条被藏了 —— 那这条唯一的持久提醒就没了');
  eq(usageSummary().textContent, '已压缩 1 次', '只有一段时的文案不对');
});

check('D1 整条隐藏的那条路也要摘 .near（否则下次亮起来带着旧警示色）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near' } }) });
  ok(usageBar().classList.contains('near'), '前置条件不成立');
  send({ type: 'usage', usage: { compacted: 0 } });
  ok(usageBar().hidden, '一段都没有时条应隐藏');
  ok(!usageBar().classList.contains('near'), '隐藏分支没摘 .near');
});

// ---------- D4 · 转写折叠（纯界面，不碰存储） ----------

check('D4 消息数不超过 FOLD_KEEP(60) → 不出现折叠行', () => {
  send({ type: 'snapshot', sessionId: 's-short', messages: mkMessages(60) });
  eq(foldRows().length, 0, '60 条不该折');
  eq(msgNodes().length, 60, '60 条应全部渲染');
});

check('D4 61 条 → 折掉 1 条，折叠行在**最前面**', () => {
  send({ type: 'snapshot', sessionId: 's-61', messages: mkMessages(61) });
  eq(foldRows().length, 1, '61 条应折掉 1 条');
  eq(msgNodes().length, 60, '折后应只剩 60 条气泡');
  ok(messagesEl().children[0].classList.contains('msg-fold'), '折叠行不在首位 —— 折错了一头');
  ok(hasText(foldRows()[0], '更早的 1 条已折叠'), '折叠行文案不对：' + texts(foldRows()[0]).join('|'));
});

check('D4 折叠行的文案必须说清「只影响界面、DSH 记忆未变」', () => {
  const t = texts(foldRows()[0]).join('\n');
  ok(t.includes('仅界面'), '按钮文案没写「仅界面」');
  ok(t.includes('DSH 记忆未变'), '按钮文案没写 DSH 记忆未变');
  ok(foldRows()[0].children[0].title.includes('DSH'), 'title 没说明与 DSH 那侧压缩无关');
});

check('D4 100 条 → 折 40、渲 60，且首条渲染的是第 41 条', () => {
  send({ type: 'snapshot', sessionId: 's-long', messages: mkMessages(100) });
  eq(foldRows().length, 1, '100 条应出现折叠行');
  ok(hasText(foldRows()[0], '更早的 40 条已折叠'), '折叠条数不对：' + texts(foldRows()[0]).join('|'));
  eq(msgNodes().length, 60, '折后应只剩 60 条气泡');
  ok(hasText(msgNodes()[0], '第 41 条'), '折的是头部：第一条渲染出来的应是第 41 条');
});

check('D4 点「显示」→ 全部消息回来、折叠行消失', () => {
  foldRows()[0].children[0].click();
  eq(foldRows().length, 0, '展开了却还留着折叠行');
  eq(msgNodes().length, 100, '展开后应渲全部 100 条');
  ok(hasText(msgNodes()[0], '第 1 条'), '展开后头部应是第 1 条');
});

check('D4 同一会话再送一帧快照 → 保持展开（流式刷新不该把用户点开的又折回去）', () => {
  send({ type: 'snapshot', sessionId: 's-long', messages: mkMessages(100) });
  eq(foldRows().length, 0, '同一会话的后续快照把折叠行又插回来了');
  eq(msgNodes().length, 100, '同一会话的后续快照改了渲染条数');
});

check('D4 换会话 → 折叠复位', () => {
  send({ type: 'snapshot', sessionId: 's-other', messages: mkMessages(100, 'x') });
  eq(foldRows().length, 1, '换会话后折叠没复位');
  eq(msgNodes().length, 60, '换会话后应重新只渲尾部 60 条');
});

check('D4 换到短会话 → 既没折叠行、消息也齐', () => {
  send({ type: 'snapshot', sessionId: 's-other2', messages: mkMessages(5, 'y') });
  eq(foldRows().length, 0, '短会话不该出现折叠行');
  eq(msgNodes().length, 5, '短会话消息数不对');
});

// ---------- D4 · 真数据（几百条消息的真实会话，F5 那一条的机器可验版） ----------
//
// 上面那组全是合成帧（`mkMessages` 只有 user/assistant 两种角色、正文是「第 N 条」）。
// 真实会话里混着 **tool 卡与 note**，这才是折叠真正要面对的输入 —— 也是唯一能验「几百条消息
// 的会话里折叠行为对不对」而不用人眼的路子。**不打印任何消息正文**，失败信息只报下标。

console.log('\n· D4 真数据：盘上那条最长的会话');

{
  const storePath = findHarnessStore();
  const sessions = storePath ? readHarnessStore(storePath) : [];
  let longest = null;
  for (const s of sessions) {
    const msgs = s.messages ?? [];
    if (s.deletedAt) continue;
    if (!longest || msgs.length > longest.messages.length) longest = s;
  }
  const real = longest ? longest.messages : [];

  if (real.length <= FOLD_KEEP) {
    console.log(
      `    ⚠ 跳过：本机最长的会话只有 ${real.length} 条（FOLD_KEEP=${FOLD_KEEP}），折叠根本不会触发。\n` +
        '      别把这次跳过当成验过了 —— 这一段要有一条够长的真实会话才有得比。'
    );
  } else {
    const head = real.length - FOLD_KEEP;
    send({ type: 'snapshot', sessionId: 'real-longest', messages: real });

    check(`D4 真数据：${real.length} 条 → 折掉 ${head}、渲 ${FOLD_KEEP}，折叠行在最前`, () => {
      eq(foldRows().length, 1, '真实长会话没出现折叠行');
      eq(msgNodes().length, FOLD_KEEP, '折后渲染条数不对');
      ok(messagesEl().children[0].classList.contains('msg-fold'), '折叠行不在首位');
      ok(hasText(foldRows()[0], `更早的 ${head} 条已折叠`), '折叠条数与 真实条数-FOLD_KEEP 对不上');
    });

    check('★★ D4 真数据：渲染出来的**就是**真实消息从 head+1 条起那一段（折的是头部，不是随机一段）', () => {
      // ⚠️ 真实消息有三种角色，**可观察特征各不相同**（tool 卡渲染的是 toolName、note 与气泡渲染 text）
      // —— 只比 text 的话，第一条恰好是工具卡时这条会假红（2026-09-18 实测就这么红过一次）。
      const sig = (m) => (m.role === 'tool' ? String(m.toolName || 'tool') : String(m.text || ''));
      const nodes = messagesEl().children.filter((c) => !c.classList.contains('msg-fold'));
      ok(nodes.length === FOLD_KEEP, `渲染节点数不是 ${FOLD_KEEP}`);
      // 逐条对最前面几个节点：**顺序**也必须对上，否则就成了"条数对、内容错位"
      const n = Math.min(8, nodes.length);
      for (let k = 0; k < n; k += 1) {
        const expected = sig(real[head + k]);
        if (!expected) continue;
        ok(hasTextLoose(nodes[k], expected), `真实消息第 ${head + k + 1} 条没出现在第 ${k + 1} 个渲染节点里`);
      }
    });

    check('★★ D4 真数据：点「显示」→ 全部真实消息回来，一条不少', () => {
      foldRows()[0].children[0].click();
      eq(foldRows().length, 0, '展开后还留着折叠行');
      eq(msgNodes().length, real.length, '展开后条数与真实消息数对不上 —— 折着折着把消息弄丢了');
    });

    check('★★ D4 真数据：同一会话再来一帧快照 → 保持展开（真会话的快照是反复下发的）', () => {
      send({ type: 'snapshot', sessionId: 'real-longest', messages: real });
      eq(foldRows().length, 0, '同一会话的后续快照把用户点开的又折回去了');
      eq(msgNodes().length, real.length, '后续快照改了渲染条数');
    });

    check('D4 真数据：切走再切回来 → 折回复位、条数仍是真实条数', () => {
      send({ type: 'snapshot', sessionId: 'real-other', messages: real.slice(-5) });
      eq(foldRows().length, 0, '短会话不该有折叠行');
      send({ type: 'snapshot', sessionId: 'real-longest', messages: real });
      eq(foldRows().length, 1, '切回长会话后折叠没复位');
      eq(msgNodes().length, FOLD_KEEP, '切回来后渲染条数不对');
    });

    const toolCards = longest.messages.filter((m) => m.role === 'tool').length;
    const noteCards = longest.messages.filter((m) => m.role === 'note').length;
    console.log(
      `    真数据：${longest.messages.length} 条消息（含 ${toolCards} 张工具卡 / ${noteCards} 条 note）` +
        ` → 折 ${head} / 渲 ${FOLD_KEEP}，全部对得上`
    );
  }
}

// ---------- C9 运行条：同一影子的回归样（第 1 类真 bug 的案发现场） ----------

const C9_READOUT = {
  runs: [{ id: 1, turn: 3, outcome: 'completed', startedAt: Date.now() - 11226, durationMs: 11226, stepCount: 2, toolCount: 10, toolErrors: 1, toolUnknown: 1, errorCount: 1, truncated: true }],
};

check('C9 运行条：payload 字段名与渲染函数对得上', () => {
  send({ type: 'mode-set', mode: 'harness' });
  send({ type: 'runs', readout: C9_READOUT });
  eq(
    $('runs-summary').textContent,
    '本轮已完成 · 10 工具 · 11.2s · 1 错误 · 1 失败 · 1 结果未知',
    '运行条文案与 payload 脱节了'
  );
});

check('C9 浮层：点「查看」→ .open 挂上，且回执告诉扩展要 details', () => {
  posted.length = 0;
  $('runs-view').click();
  ok($('runs-panel').classList.contains('open'), '浮层没打开（.open 没挂上）');
  ok(
    posted.some((m) => m.type === 'run-panel' && m.open === true),
    '没把 run-panel open 回执发出去 —— 扩展就不会下发 details'
  );
});

check('C9 浮层：details 到位 → 工具行与丢弃计数都渲染', () => {
  const t0 = Date.now() - 11226;
  send({
    type: 'runs',
    readout: C9_READOUT,
    details: [{
      id: 1, uiSessionId: 'ui', dshSessionId: 'dsh', turn: 3, outcome: 'completed', reasonKind: 'completed',
      startedAt: t0, endedAt: t0 + 11226, durationMs: 11226, lastFrameAt: t0 + 11226,
      steps: [{ step: 1, startedAt: t0, endedAt: t0 + 5229, durationMs: 5229 }],
      stepsDropped: 0,
      tools: [{ index: 1, step: 1, name: 'bash', key: 'c:1', state: 'ok', startedAt: t0, endedAt: t0 + 2610, durationMs: 2610 }],
      toolsDropped: 7, unmatched: 2,
      errors: [{ at: t0, message: 'DSH 子进程意外退出（code=1）' }], errorsDropped: 0,
    }],
  });
  ok(hasText($('runs-list'), 'bash'), '浮层里没有工具行');
  ok(hasText($('runs-list'), '另有 7 次工具调用未记录'), '丢弃计数没渲染');
  ok(hasText($('runs-list'), 'DSH 子进程意外退出（code=1）'), '本轮错误没渲染');
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条未过（共 ${passed + failures.length} 条）：`);
  for (const f of failures) console.log(`   · ${f}`);
  // 有未过时**不打**「✓ 全部通过」—— 同一屏里既报失败又报全过，读的人只会记住后一句。
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
// ⚠️ 不用 process.exit()：Windows 上被管道/文件重定向的 stdout 是**异步**写，退出会把还没
// 冲出去的结论行整段丢掉（C8 的 smoke-runtime 就是这么被抓到的：exit=0 却只有第一行）。
process.exitCode = failures.length ? 1 : 0;
