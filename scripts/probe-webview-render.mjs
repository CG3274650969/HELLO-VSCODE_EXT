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
 *
 * `setAttribute`/`getAttribute` 必须**真存真取**（2026-09-18 补）：推理/profile 改成方块
 * 图标钮后钮里没有文字，`aria-label` 是它**唯一**的可访问名 —— 老影子把 setAttribute 吞掉、
 * getAttribute 恒返回 null，那这条判据就只能靠肉眼，正是本仓库最恨的那种。
 */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._classes = new Set();
    this._attrs = new Map();
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
  setAttribute(k, v) {
    this._attrs.set(String(k), String(v));
    if (k === 'class') this.className = v; else if (k === 'hidden') this.hidden = true;
  }
  getAttribute(k) { return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null; }
  hasAttribute(k) { return this._attrs.has(String(k)); }
  removeAttribute(k) {
    this._attrs.delete(String(k));
    if (k === 'hidden') this.hidden = false;
  }
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

// ---------- C11 推理档位菜单（同一影子的回归样） ----------

/** 菜单项按文案找（渲染函数把文案写在 `.lc-mi-name` 上） */
const effortRow = (label) => $('live-effort-menu').children.find((r) => hasText(r, label));

check('C11 档位：payload 的 effort 字段与渲染函数对得上（默认「跟随」）', () => {
  send({ type: 'mode-set', mode: 'harness' });
  send({ type: 'live-config', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], apiConfigured: true, dshConfigured: true, effort: null, efforts: ['off', 'low', 'high', 'max'], effortThinkingDisabled: false });
  ok(/推理档位：跟随 cordis.yml/.test($('live-effort-btn').title), `默认档位没在 title 里说出来（方块钮里没有文字，值只能在这儿）：${$('live-effort-btn').title}`);
  ok(!$('live-config-bar').hidden, '配置条没显示');
});

check('C11 档位：选中档位 → 触发钮跟着走、当前项打勾、其余不打', () => {
  send({ type: 'live-config', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], apiConfigured: true, dshConfigured: true, effort: 'low', efforts: ['off', 'low', 'high', 'max'], effortThinkingDisabled: false });
  ok(/推理档位：low/.test($('live-effort-btn').title), '触发钮没跟着 effort 走');
  // 菜单是关闭态也照渲 —— 打开时会重画，但内容必须已经是对的
  const rows = [['跟随配置', null], ['off · 关闭思考', 'off'], ['low', 'low'], ['high', 'high'], ['max', 'max']];
  for (const [label] of rows) ok(effortRow(label), `菜单里没有「${label}」这一项`);
  const checkOf = (label) => effortRow(label).children.find((c) => c.className === 'lc-mi-check');
  eq(checkOf('low').hidden, false, '当前档位没打勾');
  eq(checkOf('high').hidden, true, '非当前档位也打勾了');
  eq(checkOf('跟随配置').hidden, true, '「跟随配置」不该打勾');
});

check('C11 档位：点一项 → 发出 set-effort（点当前项不发）', () => {
  posted.length = 0;
  effortRow('max').click();
  eq(posted.length, 1, '点一下菜单项该只发一条消息');
  eq(posted[0].type, 'set-effort', `发的不是 set-effort：${posted[0].type}`);
  eq(posted[0].effort, 'max', '档位值没带上');
  posted.length = 0;
  effortRow('low').click(); // 就是当前项
  eq(posted.length, 0, '点当前档位不该发消息（白重写一次表）');
  posted.length = 0;
  effortRow('跟随配置').click();
  eq(posted[0] && posted[0].effort, null, '「跟随配置」该发 null（扩展据此删掉会话字段）');
});

check('C11 档位：底本 thinking: disabled → 三档置灰且点了不发，off 与跟随仍可选', () => {
  posted.length = 0;
  send({ type: 'live-config', model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], apiConfigured: true, dshConfigured: true, effort: null, efforts: ['off', 'low', 'high', 'max'], effortThinkingDisabled: true });
  for (const label of ['low', 'high', 'max']) {
    ok(effortRow(label).classList.contains('lc-item-disabled'), `${label} 没置灰（选了会让 provider 在请求期抛错）`);
    effortRow(label).click();
  }
  eq(posted.length, 0, '置灰的档位竟然发出去了');
  ok(!effortRow('off · 关闭思考').classList.contains('lc-item-disabled'), 'off 被误置灰了');
  ok(hasText($('live-effort-menu'), 'thinking: disabled'), '没写明为什么置灰');
  effortRow('off · 关闭思考').click();
  eq(posted[0] && posted[0].effort, 'off', 'disabled 下 off 该能选');
  // 触发钮的 title 也要说实话
  ok(/thinking: disabled/.test($('live-effort-btn').title), '触发钮 title 没说清当前配置的限制');
});

// ---------- C12 项目 profile 菜单（同款影子） ----------

/** 菜单项按文案找（渲染函数把名字写在 `.lc-mi-name` 上，摘要另起一行 `.lc-mi-sub`） */
const profileRow = (label) => $('live-profile-menu').children.find((r) => hasText(r, label));

/** 一份完整的 live-config 载荷；C12 的六个字段都可按需覆盖 */
const liveConfig = (over) =>
  send(
    Object.assign(
      {
        type: 'live-config',
        model: 'deepseek-v4-flash',
        models: ['deepseek-v4-flash'],
        apiConfigured: true,
        dshConfigured: true,
        effort: null,
        efforts: ['off', 'low', 'high', 'max'],
        effortThinkingDisabled: false,
        profiles: [
          { name: '严格', summary: '模型 deepseek-reasoner · 禁 bash' },
          { name: '省钱', summary: '模型 deepseek-chat' },
        ],
        profile: null,
        profileModelPinned: false,
        profileStale: false,
        profileErrors: 0,
        profileAvailable: true,
      },
      over
    )
  );

check('C12 profile：payload 字段与渲染函数对得上（默认「不用 profile」），首项就是退路', () => {
  send({ type: 'mode-set', mode: 'harness' });
  posted.length = 0;
  liveConfig({});
  ok(/项目 profile：不用 profile/.test($('live-profile-btn').title), `未选 profile 时没说清（方块钮里没有文字，值只能在这儿）：${$('live-profile-btn').title}`);
  ok(!$('live-config-bar').hidden, '配置条没显示');
  ok(profileRow('不用 profile'), '菜单首项不是「不用 profile」');
  ok(profileRow('严格'), '菜单里没有「严格」');
  ok(profileRow('省钱'), '菜单里没有「省钱」');
  // 名字顺序 == 扩展下发的顺序（文件里的声明顺序）
  const names = $('live-profile-menu')
    .children.map((r) => (r.children[0] ? r.children[0].textContent : ''))
    .filter((t) => t);
  eq(names.slice(0, 3).join(','), '不用 profile,严格,省钱', `菜单顺序不对：${names.join(',')}`);
  // 摘要要**不点开就知道**这个 profile 要干什么
  ok(hasText($('live-profile-menu'), '禁 bash'), 'profile 摘要行没渲染出来');
});

check('C12 profile：选中一项 → 触发钮跟着走、当前项打勾、其余不打', () => {
  liveConfig({ profile: '严格' });
  ok(/项目 profile：严格/.test($('live-profile-btn').title), '触发钮没跟着 profile 走');
  const checkOf = (label) => profileRow(label).children.find((c) => c.className === 'lc-mi-check');
  eq(checkOf('严格').hidden, false, '当前 profile 没打勾');
  eq(checkOf('省钱').hidden, true, '非当前 profile 也打勾了');
  eq(checkOf('不用 profile').hidden, true, '「不用 profile」不该打勾');
});

check('C12 profile：点一项 → **恰好一条** set-profile；点「不用 profile」发 null', () => {
  posted.length = 0;
  profileRow('省钱').click();
  eq(posted.length, 1, '点一下菜单项该只发一条消息');
  eq(posted[0].type, 'set-profile', `发的不是 set-profile：${posted[0].type}`);
  eq(posted[0].profile, '省钱', 'profile 名没带上');
  posted.length = 0;
  profileRow('不用 profile').click();
  eq(posted.length, 1, '「不用 profile」该发一条');
  eq(posted[0].profile, null, '「不用 profile」该发 null（扩展据此清掉激活项）');
});

check('C12 profile：钉住模型 → 模型菜单整片置灰、**连监听器都不挂**、且不给自定义入口', () => {
  posted.length = 0;
  liveConfig({ profile: '严格', profileModelPinned: true, model: 'deepseek-reasoner' });
  // 钮上照旧是**真在用的**模型名（"被钉住"改由 .pinned 的小锁 + title 说 —— 见下面「配置条三钮」那组）
  eq($('live-model-label').textContent, 'deepseek-reasoner', '钉住时钮上该是真正在用的模型名');
  const modelRows = $('live-model-menu').children.filter((r) => r.children[0] && /^deepseek-/.test(r.children[0].textContent));
  ok(modelRows.length > 0, '模型菜单里一行都没有（置灰也就无从谈起）');
  for (const r of modelRows) {
    ok(r.classList.contains('lc-item-disabled'), `${r.children[0].textContent} 没置灰`);
    r.click();
  }
  eq(posted.length, 0, '置灰的模型行竟然点出了消息 —— 灰了还能点是最坏的一种');
  ok(!hasText($('live-model-menu'), '自定义模型'), '钉住时仍提供了「自定义模型…」入口（它同样不会生效）');
  ok(hasText($('live-model-menu'), '由 profile「严格」固定'), '菜单里没写明是谁钉的');
  // 触发钮的 title 必须说两件事：**它被固定了**，以及**往哪退**
  const pinTitle = $('live-model-btn').title;
  ok(/固定/.test(pinTitle) && /严格/.test(pinTitle), `模型钮 title 没说清是被谁固定的：${pinTitle}`);
  ok(/不用 profile/.test(pinTitle), `模型钮 title 没给出退路（用户只会以为按钮坏了）：${pinTitle}`);
});

check('C12 profile：没钉模型时模型菜单照旧能点（上面那条不是"永远置灰"）', () => {
  posted.length = 0;
  liveConfig({ profile: '省钱', profileModelPinned: false, model: 'deepseek-v4-flash' });
  const row = $('live-model-menu').children.find((r) => hasText(r, 'deepseek-v4-flash'));
  ok(row && !row.classList.contains('lc-item-disabled'), '没钉住却把模型行置灰了');
  ok(hasText($('live-model-menu'), '自定义模型'), '没钉住时「自定义模型…」入口不见了');
});

check('C12 profile：`profile.json 已改动` 那一行发得出去（点的就是当前项，故意不比 v !== liveProfile）', () => {
  posted.length = 0;
  liveConfig({ profile: '严格', profileStale: true });
  ok(hasText($('live-profile-menu'), 'profile.json 已改动'), '改过文件却没有那一行提示');
  const stale = $('live-profile-menu').children.find((r) => hasText(r, 'profile.json 已改动'));
  stale.click();
  eq(posted.length, 1, '「重新应用」那一行点了没发消息（那就是个死按钮）');
  eq(posted[0].profile, '严格', '重新应用该发当前项');
  // 没改过时那一行不该在
  liveConfig({ profile: '严格', profileStale: false });
  ok(!hasText($('live-profile-menu'), 'profile.json 已改动'), '没改过也显示"已改动"');
});

check('C12 profile：文件有问题 → 菜单里露出条数；没工作区 → 明说读不了且整个钮禁用', () => {
  liveConfig({ profileErrors: 3 });
  ok(hasText($('live-profile-menu'), '3 处问题'), '解析错误没在菜单里说出来');
  liveConfig({ profileAvailable: false });
  ok(hasText($('live-profile-menu'), '没有打开工作区'), '没有工作区时没说清为什么读不了');
  eq($('live-profile-btn').disabled, true, '没有工作区时按钮该禁用（点了也没有 profile 可谈）');
  liveConfig({ profileAvailable: true });
  eq($('live-profile-btn').disabled, false, '有工作区了按钮还禁用着');
});

check('C12 profile：正有一轮在跑 → profile 钮禁用 + 菜单收起（点不到，这是第一道；扩展侧还会拒绝一次）', () => {
  // ⚠️ 这里**不去点菜单行**：影子没有排版，`.click()` 无视 CSS 的 `display:none`，
  //    点在真界面里根本够不着的行上，只会得到一个不存在的 bug。真正该钉的是
  //    「忙碌时这个菜单打不开」—— 关着的菜单 display:none，用户碰不到那些行。
  liveConfig({ profile: '严格' });
  $('live-profile-btn').click();
  ok($('live-profile-menu').classList.contains('open'), '前提不成立：菜单没打开（这条就是在测"开着的时候来了一轮"）');
  send({ type: 'run-busy', busy: true });
  eq($('live-profile-btn').disabled, true, '忙碌时 profile 钮该禁用');
  eq($('live-profile-menu').classList.contains('open'), false, '忙碌时菜单没收起 —— 那些行就还够得着');
  $('live-profile-btn').click(); // 禁用态的钮点了不该再打开
  eq($('live-profile-menu').classList.contains('open'), false, '忙碌时点开了 profile 菜单');
  send({ type: 'run-busy', busy: false });
  eq($('live-profile-btn').disabled, false, '跑完了按钮没解禁');
  $('live-profile-btn').click();
  eq($('live-profile-menu').classList.contains('open'), true, '跑完了菜单打不开');
  $('live-profile-btn').click(); // 收起来，别把开着的菜单留给后面
});

// ---------- 配置条三个下拉钮的形状（2026-09-18 三次收窄：药丸 → 裸文字 → 图标 + 值 → 26px 方块图标钮） ----------

check('配置条三钮：推理/profile 是**方块图标钮**（轴与值只在 title / aria-label 里），模型名照旧看得见', () => {
  liveConfig({ profile: null, profileModelPinned: false, model: 'deepseek-v4-flash', effort: null });
  // 模型钮是唯一还带文案的：模型名是"我在跟谁说话"，必须一眼看见
  eq($('live-model-label').textContent, 'deepseek-v4-flash', '模型钮文案被改了（模型名自证身份，既不加图标也不加前缀）');
  ok(/模型/.test($('live-model-btn').title), '模型钮的 title 里没有「模型」');
  // 两个方块钮里只有一支 <svg aria-hidden> ⇒ aria-label 是它们**唯一**的可访问名，而且必须带值：
  // 钮里已经放不下值了，读不到值 = 这个钮什么都没说。title 管鼠标，aria-label 管屏读，两边都要有。
  eq($('live-effort-btn').getAttribute('aria-label'), '推理档位：跟随 cordis.yml', '推理钮的可访问名不对（轴 + 当前值，缺一不可）');
  eq($('live-profile-btn').getAttribute('aria-label'), '项目 profile：不用 profile', 'profile 钮的可访问名不对（轴 + 当前值）');
  ok(/推理档位：跟随 cordis.yml/.test($('live-effort-btn').title), `推理钮 title 没带当前值：${$('live-effort-btn').title}`);
  ok(/项目 profile：不用 profile/.test($('live-profile-btn').title), `profile 钮 title 没带当前 profile：${$('live-profile-btn').title}`);
  // 值一变，两个地方都得跟着变（否则 title 会安静地停在旧档位上）
  liveConfig({ effort: 'low', profile: '严格' });
  eq($('live-effort-btn').getAttribute('aria-label'), '推理档位：low', '推理钮的可访问名没跟着值走');
  eq($('live-profile-btn').getAttribute('aria-label'), '项目 profile：严格', 'profile 钮的可访问名没跟着值走');
  ok(/推理档位：low/.test($('live-effort-btn').title), '推理钮 title 没跟着值走');
  ok(/项目 profile：严格/.test($('live-profile-btn').title), 'profile 钮 title 没跟着值走');
  liveConfig({ effort: null, profile: null });
});

check('配置条三钮：非默认态在角上点一个状态点（.on）—— 方块钮上唯一还看得见的"这个轴被动过"', () => {
  liveConfig({ effort: null, profile: null });
  eq($('live-effort-btn').classList.contains('on'), false, '默认「跟随」不该点状态点（干净的灰方块本身就是"没被动过"的读数）');
  eq($('live-profile-btn').classList.contains('on'), false, '「不用 profile」不该点状态点');
  liveConfig({ effort: 'max', profile: '严格' });
  eq($('live-effort-btn').classList.contains('on'), true, '非默认档位没点状态点 —— 方块钮里值看不见，只剩这一个信号');
  eq($('live-profile-btn').classList.contains('on'), true, '选了 profile 却没点状态点');
  liveConfig({ effort: null, profile: null });
  eq($('live-effort-btn').classList.contains('on'), false, '退回默认后状态点还赖着');
  eq($('live-profile-btn').classList.contains('on'), false, '退回默认后状态点还赖着');
});

check('配置条三钮：钉住时钮上仍是**真在用的模型名** + .pinned（小锁靠这个 class 出）', () => {
  liveConfig({ profile: '严格', profileModelPinned: true, model: 'deepseek-reasoner' });
  eq($('live-model-label').textContent, 'deepseek-reasoner', '钉住时钮上不是真在用的模型名 —— 那条信息不该为了"说明是被钉住的"而让位');
  eq($('live-model-btn').classList.contains('pinned'), true, '钉住时没挂 .pinned —— 箭头槽换不成小锁，钮上就一点看不出被固定了');
  ok(/固定/.test($('live-model-btn').title) && /严格/.test($('live-model-btn').title), '钉住时 title 没说清是被哪个 profile 固定的');
  liveConfig({ profile: null, profileModelPinned: false, model: 'deepseek-v4-flash' });
  eq($('live-model-btn').classList.contains('pinned'), false, 'profile 撤了 .pinned 还赖着 —— 小锁会一直挂在钮上');
});

check('配置条三钮：轴图标是**两个不同的真 <svg>**（轴名撤出文案后，图标就是唯一还看得见的轴标）', () => {
  const html = readFileSync(htmlPath, 'utf8');
  const buttonOf = (id) => {
    const m = new RegExp(`<button[^>]*\\bid="${id}"[\\s\\S]*?</button>`).exec(html);
    return m ? m[0] : '';
  };
  const svgOf = (b) => {
    const m = /<svg[\s\S]*?<\/svg>/.exec(b);
    return m ? m[0] : '';
  };
  const effort = buttonOf('live-effort-btn');
  const profile = buttonOf('live-profile-btn');
  ok(effort, 'chat.html 里找不到 #live-effort-btn');
  ok(profile, 'chat.html 里找不到 #live-profile-btn');
  ok(svgOf(effort), '#live-effort-btn 里没有 <svg> —— 轴名已经不在文案里了，图标再没有，这个钮就是个来路不明的值');
  ok(svgOf(profile), '#live-profile-btn 里没有 <svg> —— 同上');
  ok(svgOf(effort) !== svgOf(profile), '两个钮用了同一个图标 —— 轴标退化成"这里有个图标而已"，还不如把轴名写回来');
  // 图标必须跟主题走：颜色一旦写死，深/浅主题下各错一半
  for (const [id, b] of [['live-effort-btn', effort], ['live-profile-btn', profile]]) {
    ok(svgOf(b).includes('stroke="currentColor"'), `#${id} 的图标不是 stroke="currentColor" —— 定色的话深浅主题会各错一半`);
  }
});

check('配置条三钮：**每一类钮只有一处定义** —— 方块钮挂 .tool-icon（同附件钮），模型钮挂 .link-button', () => {
  // 这条盯的是"同一个观感只有一处定义"：一旦有人把 border/background/height 加回 .lc-model
  // 或 .lc-knob，钮就会各自漂移 —— 而漂移的样子（比旁边的状态钮重一截）正是改掉的东西。
  const html = readFileSync(htmlPath, 'utf8');
  const classOf = (id) => {
    for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
      if (!new RegExp(`\\bid="${id}"`).test(m[0])) continue;
      const c = m[0].match(/\bclass="([^"]*)"/);
      return c ? c[1].split(/\s+/) : [];
    }
    return undefined;
  };
  const model = classOf('live-model-btn');
  ok(model, 'chat.html 里找不到 #live-model-btn');
  ok(model.includes('link-button') && model.includes('lc-model'), `模型钮的类不对：${model.join(' ')}`);
  for (const id of ['live-effort-btn', 'live-profile-btn']) {
    const cls = classOf(id) || [];
    ok(cls.includes('tool-icon'), `#${id} 没挂 .tool-icon —— 它就长不成左侧附件钮那样的方块`);
    ok(cls.includes('lc-knob'), `#${id} 丢了 .lc-knob（菜单开着时的高亮与角上那个状态点都挂在它上面）`);
    ok(!cls.includes('link-button'), `#${id} 同时挂了 .link-button —— 那是带 padding/文字的钮，两套外观会打架`);
  }
  // 反向：药丸那几件（边框/底色/固定高度）不该再回到 .lc-model 里
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8');
  const block = /\.lc-model\s*\{([^}]*)\}/.exec(css);
  ok(block, 'chat.css 里找不到 .lc-model 的规则块');
  for (const dead of ['border:', 'background:', 'height:']) {
    ok(!block[1].includes(dead), `.lc-model 里又出现了 \`${dead}\` —— 药丸正在长回来（外观该全部来自 .link-button）`);
  }
  // 角上那个点**必须绝对定位**：它一旦回到流里就吃掉 13px，这次收窄换来的宽度当场还回去
  const dot = /\.lc-knob\.on::after\s*\{([^}]*)\}/.exec(css);
  ok(dot, 'chat.css 里找不到 .lc-knob.on::after（角上那个状态点）');
  ok(/position:\s*absolute/.test(dot[1]), '角上的状态点不再是绝对定位 —— 它会占掉宽度，方块钮就白改了');
});

// ---------- C13 · 顶栏 shell 读数 + 批准条的路径两读法（2026-09-19） ----------
//
// 盯三件事：① 读数三态画对了、**不带就不出现**（老扩展 / 诊断没算出来 / 一切正常，三种情况
// 表现一致）；② 确认条那段说明是**多行只读**的，收起时清干净；③ 两条**结构守卫** —— 影子 DOM
// 把树摊平了，挂错父子关系在影子里看不出来（`#harness-status` 整段重写 textContent 会把子节点
// 抹掉，而那要等到下一次重连才发作，正是 C10b 那种形状），所以只能用原文钉。

const SHELL_SEG = {
  wsl: { label: 'bash=WSL', level: 'wsl', title: 'agent 的 bash 是 WSL 启动器（System32\\bash.exe）' },
  unknown: { label: 'bash=?', level: 'warn', title: 'shell 探测没能得出可判的结论' },
  bad: { label: 'bash=坏', level: 'bad', title: '找不到可用的 bash：PATH 上没有 bash，也没设 hello.dsh.bashPath' },
};

const C13_NOTE = [
  '已按 POSIX 形态给出：/mnt/d/proj/src/a.ts',
  '模型想指的应是：D:\\proj\\src\\a.ts',
  '按 DSH 的解析方式会落到：D:\\mnt\\d\\proj\\src\\a.ts（/… 被当成 Windows 相对根）',
  '本次不会为它抓轮前快照 —— 通常意味着这次改动不会出现在本轮审阅里。',
].join('\n');

check('C13 顶栏 shell 段：有读数就显示，label / level / title 三样都落到位', () => {
  send({ type: 'mode-set', mode: 'harness' });
  send({ type: 'backend-status', state: 'online', model: 'deepseek-v4-flash', busy: false, shell: SHELL_SEG.wsl });
  const el = $('harness-shell');
  eq(el.hidden, false, '有读数却整段藏着');
  eq(el.textContent, 'bash=WSL', '读数文案没落上去');
  eq(el.className, 'harness-shell wsl', 'level 没挂成 class');
  eq(el.title, SHELL_SEG.wsl.title, 'title 没落上去 —— 读数只有几个字，详情全靠它');
});

check('C13 顶栏 shell 段：三档 level 各自成 class，且不残留上一档', () => {
  const el = $('harness-shell');
  for (const k of ['unknown', 'bad', 'wsl']) {
    send({ type: 'backend-status', state: 'online', busy: false, shell: SHELL_SEG[k] });
    // 精确到整串：多一个旧 level 的 class 就说明上一条读数的颜色还留着（琥珀/红混着看=看不出档）
    eq(el.className, `harness-shell ${SHELL_SEG[k].level}`, `${k} 档的 class 不对`);
    eq(el.textContent, SHELL_SEG[k].label, `${k} 档的文案不对`);
  }
});

check('C13 顶栏 shell 段：**不带 shell 就整段不出现**（老扩展 / 诊断没算出来 / 一切正常同款）', () => {
  const el = $('harness-shell');
  send({ type: 'backend-status', state: 'online', busy: false, shell: SHELL_SEG.wsl });
  eq(el.hidden, false, '前置条件没成立');
  send({ type: 'backend-status', state: 'online', busy: false }); // 老载荷：没有 shell 字段
  eq(el.hidden, true, '不带 shell 时读数还赖着 —— 那会把上一次的结论当成现在的');
  eq(el.textContent, '', '藏起来了但字还在（下次亮起来会先闪一下旧值）');
  eq(el.title, '', 'title 没清');
});

check('C13 顶栏 shell 段：chat 模式下连**重发**的 backend-status 也点不亮它，切回 harness 靠缓存自己回来', () => {
  const el = $('harness-shell');
  send({ type: 'mode-set', mode: 'harness' });
  send({ type: 'backend-status', state: 'online', busy: false, shell: SHELL_SEG.bad });
  eq(el.hidden, false, '前置条件没成立');
  send({ type: 'mode-set', mode: 'chat' });
  eq(el.hidden, true, 'chat 模式下 bash 读数还挂着 —— 那个模式里根本没有 agent 在跑 bash');
  // ⚠️ 这一帧是这条判据的全部意义：扩展会在任意时刻重发 backend-status（连上/重连/改设置），
  // 只在 applyMode 里藏的话，chat 模式下一帧就把它重新点亮了。
  send({ type: 'backend-status', state: 'online', busy: false, shell: SHELL_SEG.bad });
  eq(el.hidden, true, 'chat 模式下重发一帧 backend-status 就把读数点亮了（可见性不能只看 applyMode 那一刻）');
  // 切回来时**不重发**（扩展不会因为换了个模式就重发）⇒ 只能靠缓存把那段补回来
  send({ type: 'mode-set', mode: 'harness' });
  eq(el.hidden, false, '切回 harness 后读数没回来（缓存被 applyMode 扔了）');
  eq(el.textContent, SHELL_SEG.bad.label, '切回来后读数内容不对');
});

check('C13 批准条：pathNote 多行原样落进 #approval-note（换行不能塌成一行）', () => {
  send({ type: 'approval-request', id: 'c13-1', toolName: 'write', command: 'write /mnt/d/proj/src/a.ts', pathNote: C13_NOTE });
  const el = $('approval-note');
  eq(el.hidden, false, '带了 pathNote 却不显示；带说明的那次审批会安静地少掉一截信息');
  eq(el.textContent, C13_NOTE, '说明文本被改了字');
  eq(el.textContent.split('\n').length, 4, '换行没了 —— 塌成一行就读不出「想指」与「会落到」的对比');
  eq($('approval-cmd').textContent, 'write /mnt/d/proj/src/a.ts', '命令原文被改动了（那段是只读的，一个字的改写权都没有）');
});

check('C13 批准条：不带 pathNote 的载荷 ⇒ 整段不出现（反控）', () => {
  send({ type: 'approval-resolved', id: 'c13-1' });
  send({ type: 'approval-request', id: 'c13-2', toolName: 'bash', command: 'rm -rf build' });
  eq($('approval-note').hidden, true, '没有 pathNote 却显示出一段空说明');
  eq($('approval-note').textContent, '', '空说明还留着字');
});

check('C13 批准条：收起时清干净；id 对不上的迟到帧不许误关新的那条', () => {
  const el = $('approval-note');
  send({ type: 'approval-request', id: 'c13-3', toolName: 'write', command: 'x.ts', pathNote: C13_NOTE });
  eq(el.hidden, false, '前置条件没成立');
  send({ type: 'approval-resolved', id: 'late-frame' }); // 迟到帧
  eq(el.hidden, false, '迟到的 resolved 把当前这条说明关掉了');
  send({ type: 'approval-resolved', id: 'c13-3' });
  eq(el.hidden, true, '拍板后说明还挂着 —— 下一条命令会先闪出上一条的路径');
  eq(el.textContent, '', '藏起来但字还在');
});

check('C13 结构守卫：#harness-shell 必须是 #harness-status 的**兄弟**，不能挂成子节点', () => {
  const html = readFileSync(htmlPath, 'utf8');
  const m = /<span[^>]*\bid="harness-status"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  ok(m, 'chat.html 里找不到 #harness-status');
  ok(
    !/harness-shell/.test(m[1]),
    '#harness-shell 落进了 #harness-status 里面 —— 那个节点整段重写 textContent，读数会在下一次重连时被静默抹掉'
  );
  ok(/id="harness-shell"/.test(html), 'chat.html 里没有 #harness-shell（读数没有落点）');
  ok(/<pre[^>]*\bid="approval-note"[^>]*\shidden(?=[\s/>])/.test(html), '#approval-note 必须是**初始 hidden 的 <pre>**（多行文本 + 没说明时整段不出现）');
});

check('C13 结构守卫：CSS —— 读数不被挤掉、颜色走 token、hidden 没被 display 覆盖', () => {
  // 先去掉注释：本仓库的 CSS 每个小节前都有一行 `/* ---- 标题 ---- */`，它会被 `[^{}]+`
  // 一起吞进「选择器」里，于是 trim 之后谁都不等于选择器本身 —— 那条判据会**永远假红**。
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 按**选择器列表**取规则块：`.harness-shell.wsl, .harness-shell.warn { … }` 这种合并写法
  // （同色的两档本来就该是一条规则）用「选择器紧跟着 {」的字面匹配会一条都取不到，然后假红。
  const block = (sel) => {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].split(',').some((s) => s.trim() === sel)) return m[2];
    }
    return undefined;
  };
  const shell = block('.harness-shell');
  ok(shell, 'chat.css 里找不到 .harness-shell');
  ok(/flex:\s*0 0 auto/.test(shell), '.harness-shell 不是 flex:0 0 auto —— 它会被左边 flex:1 1 auto 的 .harness-status 挤没（那是这条读数唯一可能被吃掉的方式）');
  ok(/white-space:\s*nowrap/.test(shell), '.harness-shell 会折行 —— 顶栏那一行装不下两行');
  ok(!/display:/.test(shell), '.harness-shell 里写了 display —— 那会盖掉 [hidden] 的 display:none，读数会以空壳形式常驻');
  const bad = block('.harness-shell.bad');
  ok(bad && /error/.test(bad), '.harness-shell.bad 没走 error token —— 「坏」和「WSL」就只剩文案不一样，颜色分不出档');
  const warn = block('.harness-shell.wsl');
  ok(warn && /warning/.test(warn), '.harness-shell.wsl 没走 warning token（复用仓库已有 token，不新造色）');
  const note = block('.approval-note');
  ok(note, 'chat.css 里找不到 .approval-note');
  ok(/white-space:\s*pre-wrap/.test(note), '.approval-note 不是 pre-wrap —— 四行说明会塌成一团');
  ok(!/display:/.test(note), '.approval-note 里写了 display —— [hidden] 会失效，没说明时也占一块位置');
});

// ---------- C14 · 工具卡上的「预计 / 实际改动」 ----------
//
// 真机看到的是「卡片头部下面多一行」。这里验的是那行的**结构与就地改**：
// 位置（顶栏的兄弟、不是塞进顶栏）、`tool-result` 之后不被抹掉、
// 事后帧换字不换节点、以及**没有 diff 时按钮与展开区都不许赖着**。

/** 造一张工具卡：先换会话清空消息面，再送 tool-start（同一 id 才能收到 forecast 帧） */
function mkToolCard(id, name, input) {
  send({ type: 'snapshot', sessionId: `s-c14-${id}`, messages: [] });
  send({ type: 'mode-set', mode: 'harness' });
  send({ type: 'tool-start', message: { id, role: 'tool', toolName: name, toolInput: input, toolState: 'running' } });
  const wraps = msgNodes().filter((n) => childWithClass(n, 'tool-card').length);
  return childWithClass(wraps[wraps.length - 1], 'tool-card')[0];
}
const forecastOf = (card) => childWithClass(card, 'tool-forecast')[0];

const C14_BEFORE = {
  type: 'forecast',
  id: 'f1',
  phase: 'before',
  label: '≈ 预计改动 D:\\proj\\src\\a.ts（修改 · +2 −1）',
  title: '这次调用看下来没有明显问题（不代表一定成功）\n按现在盘上的内容算的',
  level: 'ok',
  diff: [
    { kind: 'ctx', text: 'const a = 1;' },
    { kind: 'del', text: 'const b = 2;' },
    { kind: 'add', text: 'const b = 3;' },
  ],
  note: '按现在盘上的内容算的',
};

check('C14 卡片那行：落在顶栏**之后、入参之前**，且不在顶栏里面', () => {
  const card = mkToolCard('f1', 'write', '{"file_path":"D:\\\\proj\\\\src\\\\a.ts"}');
  eq(card.children[0].className, 'tool-head', '第一块不是顶栏 —— 卡片结构变了');
  eq(card.children[1].className, 'tool-input', '前置条件：入参块该在第二位');
  send(C14_BEFORE);
  const box = forecastOf(card);
  ok(box, '送了 forecast 帧却没长出那行');
  // 比节点用 `ok(a === b)`：`eq` 会 JSON.stringify，而影子节点带 `_parent` 环（拿 eq 比会
  // 抛 "Converting circular structure to JSON"，报的还不是断言本身）
  ok(card.children[1] === box, '那行没落在顶栏正下方（插到入参/输出后面去了）—— 用户要先滚过一坨 JSON 才看得到');
  eq(card.children[2].className, 'tool-input', '那行把入参块挤到了别处 —— 卡片里各块的次序变了');
  eq(card.children[3].className, 'tool-output', '输出块不在末尾 —— 那行插错了位置');
  const head = card.children[0];
  ok(!childWithClass(head, 'tool-forecast').length, '那行被塞进了顶栏里面 —— 顶栏是 flex 行，塞进去会被挤坏');
  eq(box.classList.contains('after'), false, '事前那一帧就被当成「实际」了');
  ok(box.title.includes('不代表一定成功'), 'title 没落上去（预测的口径全靠它说清）');
  eq(box.children[1]._text, '按现在盘上的内容算的', 'note 没落上去');
  eq(box.children[2].hidden, false, '有 diff 却把展开按钮藏了');
  eq(box.children[3].hidden, true, 'diff 默认就该是收起的');
});

check('C14 卡片那行：点开才出 diff，逐行 kind 成 class、行首带 +/-/空格', () => {
  const card = mkToolCard('f2', 'write', '{"file_path":"a.ts"}');
  send(Object.assign({}, C14_BEFORE, { id: 'f2' }));
  const box = forecastOf(card);
  const diff = box.children[3];
  box.children[2].click();
  eq(diff.hidden, false, '点了展开还是藏着');
  eq(diff.children.length, 3, `diff 行数不对：${diff.children.length}`);
  eq(diff.children[0].className, 'diff-line ctx', '上下文行的 class 不对（复用审阅面板那套 token）');
  eq(diff.children[1].className, 'diff-line del', '删除行的 class 不对');
  eq(diff.children[1]._text, '-const b = 2;', '行首没带 - 号');
  eq(diff.children[2]._text, '+const b = 3;', '行首没带 + 号');
  box.children[2].click();
  eq(diff.hidden, true, '再点一下没收起来');
});

check('C14 卡片那行：`tool-result` 一到，那行**原地**被换成事实（不是重建卡片）', () => {
  const card = mkToolCard('f3', 'write', '{"file_path":"a.ts"}');
  send(Object.assign({}, C14_BEFORE, { id: 'f3' }));
  const before = forecastOf(card);
  before.children[2].click();
  // 工具跑完：扩展先发 tool-result（卡片换状态），再发 phase:'after'
  send({ type: 'tool-result', id: 'f3', toolState: 'ok', output: 'ok' });
  ok(forecastOf(card) === before, 'tool-result 之后那行没了 —— 它被 applyToolState 或重建抹掉了');
  send({
    type: 'forecast',
    id: 'f3',
    phase: 'after',
    label: '实际改动 D:\\proj\\src\\a.ts（+1 −1）',
    level: 'ok',
    diff: [
      { kind: 'del', text: 'const b = 2;' },
      { kind: 'add', text: 'const b = 3;' },
    ],
  });
  const after = forecastOf(card);
  ok(after === before, '事后帧换了新节点 —— 那就不叫「就地改」，展开状态与位置都会丢');
  eq(after.classList.contains('after'), true, '没挂上 .after —— 事前/事后在配色上分不出来');
  ok(after.children[0]._text.startsWith('实际改动'), '主文案没换成「实际」：' + after.children[0]._text);
  eq(after.children[3].children.length, 2, 'diff 没被换成 DSH 报的那份');
  eq(after.children[3].hidden, false, '换 diff 时把用户展开的状态也一起重置了');
});

check('C14 卡片那行：事后**不带 diff**（新建/失败/中断）⇒ 按钮与展开区当场收掉（反控）', () => {
  const card = mkToolCard('f4', 'write', '{"file_path":"new.ts"}');
  send(Object.assign({}, C14_BEFORE, { id: 'f4' }));
  const box = forecastOf(card);
  box.children[2].click();
  eq(box.children[3].hidden, false, '前置条件：展开着');
  send({
    type: 'forecast',
    id: 'f4',
    phase: 'after',
    label: '实际改动 D:\\proj\\new.ts（DSH 没报改动）',
    note: 'DSH 报的 diffs 是空的：新建文件，或内容与改动前完全一样',
  });
  eq(box.children[2].hidden, true, '没有 diff 却还留着展开按钮 —— 点开是上一次的残留');
  eq(box.children[2]._text, 'Diff', '按钮文案没复位');
  eq(box.children[3].hidden, true, '没有 diff 却还开着 —— 上一次那份 diff 看起来像这一条的结果');
  eq(box.children[3].children.length, 0, '旧 diff 行没清掉');
  eq(box.children[1].hidden, false, 'note 该显示（「新建」这种结论只能靠它说）');
});

check('C14 卡片那行：失败/中断两档各自挂 class，文案是「预测作废」那一句', () => {
  const card = mkToolCard('f5', 'edit', '{"file_path":"a.ts"}');
  send(Object.assign({}, C14_BEFORE, { id: 'f5' }));
  const box = forecastOf(card);
  // 文案用扩展真发的那一句（`changeForecast.FORECAST_FAILED_LINE` 的原样抄件）——
  // 这里写个自造句子就等于只测「textContent 会被赋值」，测不出那句话有没有说清楚
  send({
    type: 'forecast',
    id: 'f5',
    phase: 'after',
    label: '这次调用失败了 —— 上面那行只是预测，不是结果',
    level: 'warn',
    failed: true,
  });
  eq(box.classList.contains('failed'), true, 'failed 没挂 class');
  ok(box.children[0]._text.includes('只是预测'), '失败收尾的文案没说清「那只是预测」：' + box.children[0]._text);
  send({ type: 'forecast', id: 'f6', phase: 'after', label: '不该出现', level: 'warn', unknown: true });
  eq(forecastOf(card).children[0]._text.includes('不该出现'), false, 'id 对不上的帧改到了别的卡上（按 id 查之前必须先查存在）');
});

check('C14 卡片那行：id 找不到时**什么都不做**（回放/切会话/react-live 都会走到这儿）', () => {
  send({ type: 'snapshot', sessionId: 's-c14-none', messages: mkMessages(3) });
  const n = msgNodes().length;
  send({ type: 'forecast', id: '不存在的卡', phase: 'before', label: 'x' });
  eq(msgNodes().length, n, '找不到 id 却凭空建了东西');
  eq(msgNodes().filter((m) => childWithClass(m, 'tool-forecast').length).length, 0, '普通气泡上长出了那行');
});

check('C14 反控：没发过 forecast 的工具卡**不长**那一行', () => {
  const card = mkToolCard('f7', 'read', '{"file_path":"a.ts"}');
  send({ type: 'tool-result', id: 'f7', toolState: 'ok', output: 'ok' });
  eq(forecastOf(card), undefined, '没送过 forecast 的卡上也多出一行 —— 那它就成每条工具卡的常驻噪声了');
});

check('C14 结构守卫：CSS 不写 display（否则 [hidden] 失效）、长路径不许撑破卡片', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].split(',').some((s) => s.trim() === sel)) return m[2];
    }
    return undefined;
  };
  const box = block('.tool-forecast');
  ok(box, 'chat.css 里找不到 .tool-forecast');
  ok(/flex-wrap:\s*wrap/.test(box), '.tool-forecast 没开 flex-wrap —— 展开的 diff 会挤在同一行里');
  // ⚠️ 容器自己是允许写 display 的（它身上没有 [hidden] 语义）；被 hidden 切的是下面两个
  for (const sel of ['.tf-toggle', '.tf-diff']) {
    const b = block(sel);
    ok(b, `chat.css 里找不到 ${sel}`);
    ok(!/display:/.test(b), `${sel} 里写了 display —— 那会盖掉 [hidden] 的 display:none`);
  }
  const label = block('.tf-label');
  ok(label && /text-overflow:\s*ellipsis/.test(label), '.tf-label 没有省略号 —— 一条长路径会把状态字挤出卡片');
  ok(/white-space:\s*nowrap/.test(label), '.tf-label 会折行 —— 那行本来就只有一行的高度');
});

check('C13 结构守卫：路径两读法**只在显示链路上**（判定链路一行没动）', () => {
  const src = readFileSync(join(repoRoot, 'src', 'chatViewProvider.ts'), 'utf8');
  const lines = src.split('\n');
  const lineOf = (needle, from = 0) => lines.findIndex((l, i) => i >= from && l.includes(needle)) + 1;
  const idxOfLine = (k) => lines.slice(0, k - 1).join('\n').length;

  const calls = lines.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('readPosixTarget('));
  eq(calls.length, 1, `readPosixTarget( 出现了 ${calls.length} 次 —— 只该在 _approvalPathNote 里被调一次`);
  const def = lineOf('private _approvalPathNote(');
  ok(def > 0, '找不到 _approvalPathNote 的定义');
  ok(
    calls[0][0] > def && calls[0][0] < def + 20,
    `readPosixTarget 的调用不在 _approvalPathNote 体内（第 ${calls[0][0]} 行 vs 定义在第 ${def} 行）`
  );

  // 说明只由「问」的那条路算。判定链路（_fsTargetAbs → 快照/是否放行）碰它一下，
  // 它就悄悄从「显示」变成了「行为」，而本次明确不做路径归一化。
  const askDef = idxOfLine(lineOf('private _onApprovalAsk('));
  const askEnd = src.indexOf('\n  private ', askDef + 1);
  const callIdx = idxOfLine(lineOf('this._approvalPathNote('));
  ok(callIdx > askDef && callIdx < askEnd, '_approvalPathNote 被 _onApprovalAsk 之外的代码调用了 —— 那它就不只是显示');

  // fail-safe 那一行必须原样在 —— 但 C14 起它搬进了 `changeForecast.resolveTargetPath`
  // （卡片上那行「预计改动」与批准条必须是同一个函数算的路径）。所以判据改形为：
  // `_fsTargetAbs` **委派**、体内不再有那个字面量；字面量本身的唯一性由
  // `probe-change-forecast` 的 G 组全仓扫（那边还钉住「shellDiag 那份是翻译、不是拒绝」）。
  const fsDef = idxOfLine(lineOf('private _fsTargetAbs('));
  const fsBody = src.slice(fsDef, src.indexOf('\n  private ', fsDef + 1));
  ok(/resolveTargetPath\(/.test(fsBody), '_fsTargetAbs 没有委派给 changeForecast.resolveTargetPath —— 卡片与批准条的路径会各算各的');
  ok(
    !/startsWith\('\/'\)/.test(fsBody),
    '_fsTargetAbs 体内又自己写了一份 POSIX 判据 —— 判据只准有一处（改这个函数就等于改审批行为）'
  );
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
