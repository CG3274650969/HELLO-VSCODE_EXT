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
  /** 影子专用（真 DOM 里 click() 也是这么派的）：派发一次事件。
   *  C17：可选 `props` 并进事件对象 —— 只有这样才带得动 `clipboardData.files` / `dataTransfer.files`
   *  （粘贴与拖拽那条路）。不带 props 的老调用（含 `click()`）语义一字未变。 */
  dispatch(type, props) {
    const ev = Object.assign(
      { type: type, target: this, preventDefault() {}, stopPropagation() {} },
      props || {}
    );
    const a = this._listeners.get(type) || [];
    for (const fn of a) fn(ev);
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
/**
 * `document` 上的监听器（C15 起捕获；原来是 `() => {}` 的 no-op）。
 *
 * 捕获是为了让**全局键盘链**第一次可测：Esc 逐层收浮层那条链挂在 document 上，
 * 而 no-op 意味着它从来没被验过 —— 「改了一处顺序、结果 Esc 收错了面板」这种错
 * 只能靠肉眼在真机上撞见。捕获本身是纯增量的（没有任何代码会去读这个桩）。
 */
const docListeners = new Map();
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
  addEventListener: (t, fn) => {
    if (!docListeners.has(t)) docListeners.set(t, []);
    docListeners.get(t).push(fn);
  },
  removeEventListener: () => {},
  execCommand: () => true,
};

/** 按一下键（默认 target 为 null —— 那些「自带 Esc 的输入框」的分支就不会抢） */
function pressKey(key, target) {
  const ev = { key, target: target || null, preventDefault() {}, stopPropagation() {}, repeat: false };
  for (const fn of docListeners.get('keydown') || []) fn(ev);
}

/**
 * 在 document 上派一次 click（target 默认是 body —— 「点在外面」的那种点法）。
 *
 * ⚠️ 影子**不做事件冒泡**：`El.click()` 只跑元素自己身上的监听器，永远到不了 document。
 * 所以"点别处就把浮层收起来"这条判据在真 DOM 里是自动的、在这里必须显式派一次。
 * 也正因如此，`contains()` 那个恒 false 的桩在这里**帮了忙**：任何 target 都算"在外面"，
 * 于是"某一条 clause 漏了"会被这条判据直接抓出来（漏的那个菜单没人关）。
 */
function docClick(target) {
  const ev = { type: 'click', target: target || document.body, preventDefault() {}, stopPropagation() {} };
  for (const fn of docListeners.get('click') || []) fn(ev);
}

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
  /**
   * C17：`readAsDataURL` 必须**真的**把结果交回去。今天这个影子里的 `FileReader` 只有
   * `readAsText`（**而且从不回调**），所以 paste / drop / addFilesFromList 这条路从来没被跑过。
   *
   * 假 File 就是普通对象 `{ name, type, size, dataUrl }`；结果从 `dataUrl` 取。
   * ⚠️ 这里是**同步**回调（真 FileReader 是异步的）。有意的：本探针整体是同步的（没有 await），
   * 而同步回调让「贴第 5 张图」那条用例测得到前端那道张数闸。**真机上异步顺序会让同时拖进来的
   * 5 张各自看到「当前 0 张」而全部放行** —— 兜底在扩展侧（`_sendUser` 的那道复查），
   * 这里测不到它，也不该假装测到了。
   */
  FileReader: class {
    readAsDataURL(f) {
      if (typeof f.dataUrl === 'string') {
        this.result = f.dataUrl;
        if (typeof this.onload === 'function') this.onload({ target: this });
      } else if (typeof this.onerror === 'function') {
        this.onerror({ target: this });
      }
    }
    readAsText() {}
    addEventListener() {}
  },
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
// C21：读数**行**（原 C3a 的 `#usage-bar` + C9 的 `#runs-bar` 合并成 `#status-row`）。
// C22 起这行**只剩运行读数**，用量/上下文那半搬去了配置条里的 `#ctx-ring`（见下）。
const statusRow = () => $('status-row');
const statusRun = () => $('status-run');

// C22 上下文占用环。`#ctx-ring` 是外壳（承载 title / aria-label / `.near` / `.stale`），
// `#ctx-ring-arc` 是那条弧（承载 stroke-dashoffset 与 hidden）。
// ⚠️ C22c 起**外壳没有 `hidden` 这一档**（新建对话里它也在，读作 0）—— 弧的 `hidden` 还在。
// ⚠️ 影子没有 `document.createElementNS`，所以 SVG 是**静态写在 chat.html 里**的，chat.js 只
// `getElementById` 再写属性 —— 也正因如此，`setAttribute` 必须真存真取（老影子吞掉它的话，
// 弧长这条判据就只能靠肉眼，正是本仓库最恨的那种）。
const ctxRing = () => $('ctx-ring');
const ctxArc = () => $('ctx-ring-arc');
// C22b：环变成按钮之后多了一个**只读浮层**（与三个菜单同一套壳）。它挂在 `#ctx-ring-wrap` 里，
// 「点在外面」那条判据靠 wrap.contains 决定关不关 —— 影子写的 contains 恒 false（见 El 的桩），
// 所以下面验互斥/关法时**不能走真事件冒泡**，得直接派一次 document 上的 click（docClick）。
const ctxMenu = () => $('ctx-ring-menu');

/** 从一个开始标签的原文里取出 class 列表（影子不种静态属性，这类判据只能读 chat.html 原文）。 */
function classOf(tag) {
  const m = /class="([^"]*)"/.exec(tag || '');
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

/**
 * chat.js 的 `CTX_RING_LEN` 与 chat.css 的 `stroke-dasharray` 必须相等，**钉一份在这里**。
 * 这是有意的三重复：它一旦与另两处不一致，下面「弧长正比」那组与 CSS 守卫会一起变红 ——
 * 那就该有人去看是"实现改了"还是"探针过时了"，而不是静默地画出半圈。
 */
const CTX_RING_LEN = 40.84;

/** 弧的 stroke-dashoffset（number）。**没写过**不是 0，是「chat.js 没画弧」—— 得红，不能静默当满环。 */
function arcOffset() {
  const raw = ctxArc().getAttribute('stroke-dashoffset');
  ok(raw !== null && raw !== undefined, '环的 stroke-dashoffset 根本没写过 —— chat.js 没在画弧');
  const n = Number(raw);
  ok(Number.isFinite(n), 'stroke-dashoffset 不是个有限数（写坏成 ' + JSON.stringify(raw) + ' 了）');
  return n;
}
/** 浮点比较：chat.js 已经收过一次两位小数，这里再给一点余量。
 *  名字躲开 `near`（那个词在这个文件里到处是 CSS 的 `.near` 类，撞名会读到隔壁的阴影）。 */
const closeTo = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

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

// ---------- D1 · 上下文占用环（C22 起是配置条里的 `#ctx-ring`） ----------
//
// C22 把这段读数从"读数行的左半"搬成了"配置条上的一枚环"：**文案一个字没改，整段搬进了环的
// `title`**。所以下面这些断言全部原样保留，只是落点从 `statusSummary().textContent` 换成
// `ctxRing().title`，`#status-row` 的 `hidden`/`.near` 换成 `#ctx-ring` 的 —— 语义一条没放松。
// 唯一宽松的地方：`title` 是多行，所以"整段只有一处"那条改成比**第一行**逐字相等。
// ⚠️ **C22c 翻掉了其中唯一那条"藏起来"**（用户要求新建对话里也看得见这枚钮）：现在没有读数
//    时报的是**空态一行文案**，不再是 `hidden`。其余语义（near / stale / 已压缩 / aria）一字未动。
// ⚠️ 影子不种静态属性、也不连父子关系，所以 `#ctx-ring` 的 `class` / `tabindex` / `role`
//    一概读 chat.html 原文（见下面 C22 那组结构守卫），这里只断言运行时写出来的东西。

check('D1 没有任何用量（新建对话）→ 环**照常在**、只是不画弧，并明说「本轮尚无用量」', () => {
  // C22c 推翻了 C22 那条"没有数据就整个藏掉"（用户原话：「新建对话时也要有这个按钮，
  // 只不过是"0"即可」）。藏起来的问题不是审美：一个控件在新建对话里凭空消失、发了第一句话
  // 才冒出来，本身就是个疑点。所以**环读作 0，话说成"尚无"**：
  send({ type: 'usage', usage: null });
  ok(!ctxRing().hidden, '没有读数时环被藏了 —— 新建对话里它该在（只是读作 0）');
  ok(ctxArc().hidden, '一条读数都没有却画了弧 —— 空弧既会被读成 0%，而真相可能是"不知道"');
  eq(ctxRing().title.split('\n')[0], '本轮尚无用量', '空态那行文案不对：' + ctxRing().title);
  ok(ctxRing().title.includes('第一次请求跑完就有数了'), '空态没解释"为什么现在是 0"：' + ctxRing().title);
  // ⚠️ 空态**不写数字**：`usageState` 为空既可能是"刚新建"（那真是 0），也可能是"这个会话
  //    我们拼不出读数"（那是**未知**）。写成 `↑0 ↓0` 就把后一种说成了前一种 —— 那是句假话。
  ok(!/[↑↓]/.test(ctxRing().title), '空态写了 ↑0 ↓0 —— 把"未知"写成了 0：' + ctxRing().title);
});

check('D1 有占用但离阈值远 → 环显示、title 写占用、不挂 .near、不喊 ⚠', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  ok(!ctxRing().hidden, '有读数时环应显示');
  // 24K 那段按 fmtTokens 的档位给：<1e5 保留一位小数，所以是 24.0K 而不是 24K
  ok(ctxRing().title.includes('上下文 24.0K / 1.0M'), '占用段文案不对：' + ctxRing().title);
  ok(!ctxRing().title.includes('⚠'), '没接近阈值却喊了警');
  ok(!ctxRing().classList.contains('near'), '没接近阈值却挂了 .near');
});

check('D1 state=ok 与缺省同义（都不算 near）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000, state: 'ok' } }) });
  ok(!ctxRing().classList.contains('near'), "state:'ok' 被当成了 near");
});

check('D1 state=near → 文案带 ⚠ 且环挂 .near', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near' } }) });
  ok(ctxRing().title.includes('⚠ 接近压缩阈值'), '接近阈值时没喊警：' + ctxRing().title);
  ok(ctxRing().classList.contains('near'), '.near 没挂上（CSS 的警示色就靠它）');
});

check('D1 near 的 title 必须写明「我们的数不是 DSH 的判据」（口径诚实是硬要求）', () => {
  const t = ctxRing().title;
  ok(t.includes('不是同一个数'), 'title 没写口径差异 —— 界面会让人以为到了这条线就一定会压缩');
  ok(!t.includes('还有'), 'title 里出现了「还有 X」式承诺：分子口径不支持这种说法');
});

check('D1 stale → 标「上次」+ 挂 .stale，但不因此挂 .near', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000, stale: true } }) });
  ok(ctxRing().title.includes('· 上次'), '陈旧读数没标「上次」：' + ctxRing().title);
  ok(ctxRing().classList.contains('stale'), '.stale 没挂上 —— 环不会变淡，陈旧与实时就分不出来了');
  ok(!ctxRing().classList.contains('near'), '陈旧不等于接近');
  ok(ctxRing().title.includes('上一次跑完时留下的样本'), 'title 没解释「上次」是什么');
});

check('D1 stale + near 两个后缀**并列**（不是 else if），两个类也同时挂', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near', stale: true } }) });
  const s = ctxRing().title;
  ok(s.includes('· 上次') && s.includes('⚠ 接近压缩阈值'), '两个后缀应同时出现：' + s);
  ok(
    ctxRing().classList.contains('stale') && ctxRing().classList.contains('near'),
    '两个状态类应同时挂 —— 「很旧的读数」与「快压了」是两件事，不该互相吃掉'
  );
});

check('D1 near → 回到 ok 时 .near 要摘掉（add/remove 两条路都走一遍）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near' } }) });
  ok(ctxRing().classList.contains('near'), '前置条件不成立');
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000, state: 'ok' } }) });
  ok(!ctxRing().classList.contains('near'), '从 near 回退后 .near 没摘掉');
});

check('D1 compacted>0 → 追加「已压缩 N 次」', () => {
  send({ type: 'usage', usage: usage({ compacted: 3, context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  ok(ctxRing().title.includes('已压缩 3 次'), '压缩计数没上条：' + ctxRing().title);
});

check('D1 只有 compacted、别的段全空 → 环仍要显示、但不画弧（不能被 parts 为空的分支藏掉）', () => {
  send({ type: 'usage', usage: { compacted: 1 } });
  ok(!ctxRing().hidden, '只有压缩计数时环被藏了 —— 那这条唯一的持久提醒就没了');
  eq(ctxRing().title.split('\n')[0], '已压缩 1 次', '只有一段时那一段的文案不对');
  ok(ctxArc().hidden, '压根没有 context 段却画了弧 —— 空弧会被读成 0%，而真相是「不知道」');
});

check('D1 落到空态那条路也要摘 .near / .stale（否则新建对话里环带着上一份读数的旧警示色）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 700000, contextWindow: 1000000, state: 'near', stale: true } }) });
  ok(ctxRing().classList.contains('near') && ctxRing().classList.contains('stale'), '前置条件不成立');
  send({ type: 'usage', usage: { compacted: 0 } }); // 一段都拼不出来 ⇒ 空态
  eq(ctxRing().title.split('\n')[0], '本轮尚无用量', '前提不成立：这一份该落到空态');
  ok(!ctxRing().classList.contains('near'), '空态没摘 .near');
  ok(!ctxRing().classList.contains('stale'), '空态没摘 .stale');
  ok(ctxArc().hidden, '空态还留着上一份读数的弧 —— 那弧是上个会话的占用比例');
});

// ---------- C21 · 读数行：两半合成一条（原 C3a 用量条 + C9 运行条） ----------
//
// 合并是"搬一半"的高发区，两处最容易丢的**老决定**：
//   ① 只有 runs、没有 usage 时**整行仍要显示**（C9 的原话：运行浮层的入口不能等第一轮跑完才出现）；
//   ② 两半在同一帧里各写各的，谁都不能把谁挤掉。
// 另加两条**结构守卫**：老 id 留一个就是死代码；而"读数不画卡"这条设计整个活在 CSS 里，
// 影子 DOM 看不见样式，只能按原文钉。

// 右半的最小读数（不动 C9_READOUT：那个在下面，此处引它会撞 TDZ）
const C21_READOUT = {
  runs: [{ id: 1, turn: 1, outcome: 'completed', startedAt: Date.now() - 11226, durationMs: 11226, stepCount: 1, toolCount: 10, toolErrors: 0, toolUnknown: 0, errorCount: 0, truncated: false }],
};

check('C21 只有 runs、完全没用过 usage → 行仍要显示（C9 的入口不等第一轮）', () => {
  send({ type: 'usage', usage: null });
  send({ type: 'runs', readout: { runs: [] } });
  ok(!statusRow().hidden, '只有 runs 时整行被藏了 —— 运行浮层的入口就跟着没了');
  ok(!ctxRing().hidden, '没有用量时环被藏了 —— C22c 起它一直在（新建对话就该看得见它）');
  eq(statusRun().textContent, '本轮尚无', '空读数的文案不对（入口自己就叫「运行记录」，这里不该再说一遍）');
});

check('C21/C22 同一帧里环与行各就各位：环画占用，行上只有运行文案 + 入口', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  send({ type: 'runs', readout: C21_READOUT });
  ok(!statusRow().hidden, '有运行读数时行反而不显示');
  ok(!ctxRing().hidden, '有用量时环反而不显示');
  ok(ctxRing().title.includes('上下文 24.0K / 1.0M'), '环被行挤掉了：' + ctxRing().title);
  ok(hasText(statusRun(), '10 工具'), '行被环挤掉了：' + statusRun().textContent);
  // 入口的归属按 chat.html 的原文钉：影子不给元素连父子关系（seedFromHtml 只读 hidden 属性），
  // 所以 `statusRow().children` 在这里恒为空 —— 那不是判据，别写成断言。
  const rowHtml = /<div id="status-row"[\s\S]*?<\/div>/.exec(readFileSync(join(repoRoot, 'media', 'chat.html'), 'utf8'));
  ok(rowHtml, 'chat.html 里找不到 #status-row 那个块');
  ok(rowHtml[0].includes('id="runs-view"'), '入口按钮不在 #status-row 块里 —— 搬块时漏了它');
  ok(/id="runs-view"[^>]*class="[^"]*status-open/.test(rowHtml[0]), '入口按钮丢了 .status-open —— 它就不会半淡常显（脚下那条 C21 CSS 守卫也白写了）');
  // C22 反过来的一条：占用那半搬去配置条了，**不许留一半在这儿**
  ok(!rowHtml[0].includes('ctx-ring'), '环又跑回读数行里了 —— 它该在配置条上（模型钮与推理钮之间）');
});

check('C21/C22 快照那一路：环与行随快照整帧重放（快照那条叫 `runs`，与流式那条的 `readout` 不同）', () => {
  send({
    type: 'snapshot',
    sessionId: 's-c21',
    messages: [],
    usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }),
    runs: C21_READOUT,
  });
  ok(!statusRow().hidden, '快照带了两个字段，行却不显示');
  ok(!ctxRing().hidden, '快照带了 usage，环却不显示');
  ok(ctxRing().title.includes('上下文 24.0K / 1.0M'), '快照的 usage 没画到环上');
  ok(
    hasText(statusRun(), '10 工具'),
    '快照的 runs 没画上 —— 两个字段名八成被合并成同一个了：' + statusRun().textContent
  );
});

check('C21/C22 结构守卫：搬走了的老 id 一个都不许留（搬一半最典型的样子）', () => {
  const html = readFileSync(join(repoRoot, 'media', 'chat.html'), 'utf8');
  // C21 那两个 + **C22 搬走的那个**：`status-summary` 是这一轮的新增项 ——
  // 占用那半搬去了 `#ctx-ring`，读数行里那个 span 就该连 id 带规则一起删干净。
  for (const dead of ['usage-bar', 'runs-bar', 'usage-summary', 'runs-summary', 'status-summary', 'statusSummary']) {
    ok(!html.includes(dead), `chat.html 里还留着 \`${dead}\``);
    ok(!chatJs.includes(dead), `chat.js 里还留着 \`${dead}\``);
  }
});

check('C21 结构守卫：读数行无边框无底色、不再有任何变色状态，入口半淡常显且键盘可达', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // ① 行本身没有 border / background —— 这就是"读数不画卡"本身
  const row = /\.status-row\s*\{([^}]*)\}/.exec(css);
  ok(row, 'chat.css 里找不到 .status-row 的规则块');
  for (const dead of [/(^|[;\s])border\s*:/, /(^|[;\s])background(-color)?\s*:/]) {
    ok(!dead.test(row[1]), `.status-row 里又出现了边框/底色（${dead}）—— 四张同款卡就是这么长回来的`);
  }
  // ② C22：这一行**不再变色**了 —— 警示色搬去了环上，同一个警示不许在两处同时喊。
  //    （留着一个 `.status-row.near` 规则 = 那个类还可能被别处挂上来，等于埋了个哑炮。）
  ok(
    !/\.status-row\.near\b/.test(css),
    'chat.css 里还有 .status-row.near —— 警示色该只在环上（.ctx-ring.near），别两处一起喊'
  );
  // ③ 入口**半淡常显**（C21b）：默认不透明度必须落在开区间 (0, 1) 里。
  //    0 = C21 第一版那个"要悬停才存在"的入口（真机撞过：用户找不着），
  //    1 = 它和运行读数一样重 —— 那 hover 那条规则也就白留了。改用 display/visibility 也不行：
  //    display:none 会把它摘出流（左边的字会重排），visibility:hidden 则连键盘一起挡掉。
  const open = /\.status-open\s*\{([^}]*)\}/.exec(css);
  ok(open, 'chat.css 里找不到 .status-open 的规则块');
  const openOpacity = /opacity:\s*([\d.]+)/.exec(open[1]);
  ok(openOpacity, '.status-open 没有 opacity —— 入口默认得是"半淡"，不是随行文字');
  const openOpacityNum = openOpacity ? Number(openOpacity[1]) : NaN;
  ok(
    openOpacityNum > 0 && openOpacityNum < 1,
    `.status-open 的默认不透明度是 ${openOpacityNum} —— 必须「看得见但更轻」（0 < x < 1）：` +
      '0 = 入口找不着（C21b 之前就是），1 = 与读数一样重'
  );
  ok(!/display\s*:\s*none/.test(open[1]), '.status-open 改成 display:none 了 —— 按钮会退出流，左边的字会重排');
  ok(!/visibility\s*:\s*hidden/.test(open[1]), '.status-open 改成 visibility:hidden 了 —— 键盘再也够不到这个入口');
  ok(/\.status-row:focus-within\s+\.status-open/.test(css), '没有 :focus-within 显形规则 —— Tab 到入口它也不会出现（键盘不可达）');
  // 半淡是"默认"而不是"永远"：悬停 / 聚焦必须把它推到满
  const reveal = /\.status-row:hover\s+\.status-open[^{]*\{([^}]*)\}/.exec(css);
  ok(reveal, '没有 `.status-row:hover .status-open` 显形规则 —— 半淡就成了恒态，指针停在行上也不见它变亮');
  ok(reveal && /opacity:\s*1\s*;/.test(reveal[1]), '悬停 / 聚焦那条规则没把不透明度推到 1 —— 入口没有"点亮"这一步');
});

// ---------- C22 · 上下文占用环（配置条上、模型钮与推理钮之间） ----------
//
// 这一组管的是**环自己的东西**：弧长怎么算、两端怎么办、没有数据时画什么；
// 外加四条**结构守卫**（影子看不见样式与静态属性，只能按 chat.html / chat.css 原文钉）。
// 文案与状态类那一半在上面 D1（照原样保留，只换了落点）。

check('C22 弧长正比于占用比（8% 那种小数也要看出来，这是它取代数字的全部理由）', () => {
  // offset 是「把那段 dash 往回推多少」，所以**占用 25% ⇒ 推掉 75%**（露出 25%）。
  // 别把这两个数写反 —— 写反了画出来仍然是个像模像样的环，只是比例倒过来
  //（"还剩多少"而不是"用了多少"），肉眼几乎看不出来，所以这里按公式钉死。
  send({ type: 'usage', usage: usage({ context: { usedTokens: 250000, contextWindow: 1000000 } }) });
  ok(closeTo(arcOffset(), CTX_RING_LEN * 0.75), '25% 占用的 offset 不对（该推掉 75%）：' + arcOffset());
  send({ type: 'usage', usage: usage({ context: { usedTokens: 500000, contextWindow: 1000000 } }) });
  ok(closeTo(arcOffset(), CTX_RING_LEN * 0.5), '50% 占用的 offset 不对：' + arcOffset());
  // 单调性：占用涨 ⇒ offset 必须**变小**（弧变长）。反了就是那个最经典的实现错误
  // ——`LEN * ratio` 写成了正比，画出来刚好是"还剩多少"，看着也挺像回事。
  const big = arcOffset();
  send({ type: 'usage', usage: usage({ context: { usedTokens: 900000, contextWindow: 1000000 } }) });
  ok(arcOffset() < big, '占用涨了弧反而短了 —— offset 的符号写反了（那是"剩余比例"不是"占用比例"）');
  ok(!ctxArc().hidden, '有占用却把弧收起来了');
});

check('C22 两个端点：0% 不画弧（不能留个圆头冒充 5%），100% 是满环', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 0, contextWindow: 1000000 } }) });
  ok(!ctxRing().hidden, '0% 也是有效读数，环不该整个消失');
  ok(closeTo(arcOffset(), CTX_RING_LEN), '0% 时 offset 该顶满整圈（一点不露）：' + arcOffset());
  ok(
    ctxArc().hidden,
    '0% 时弧没收起来 —— `stroke-linecap: round` 会在零长弧上留一个 ~5% 长的圆头，' +
      '那就是把一个"没用"读成"用了 5%"；一个 5% 的谎比不画更糟'
  );
  send({ type: 'usage', usage: usage({ context: { usedTokens: 1000000, contextWindow: 1000000 } }) });
  ok(closeTo(arcOffset(), 0), '用满窗口时该是满环（offset 0）：' + arcOffset());
  ok(!ctxArc().hidden, '满环也是有效读数，弧不该被收起来');
  // 超出窗口（分母是 DSH 的估算、分子是 provider 实测的，这个组合真的会发生）：
  // 不夹的话 offset 变负数，弧会反着绕出去画第二圈
  send({ type: 'usage', usage: usage({ context: { usedTokens: 1500000, contextWindow: 1000000 } }) });
  ok(closeTo(arcOffset(), 0), '用量超过窗口时 offset 必须夹在 0（不然弧反着绕一圈）：' + arcOffset());
  ok(!ctxArc().hidden, '超出窗口时弧该保持满环');
});

check('C22 没有 context 段 → 环还在、不画弧，悬浮信息里如实写「暂无数据」', () => {
  send({ type: 'usage', usage: usage({ compacted: 2 }) });
  ok(!ctxRing().hidden, '环被藏了 —— 「已压缩 N 次」那条唯一的持久提醒会跟着一起没');
  ok(ctxArc().hidden, '没有上下文数据却画了弧 —— 空弧会被读成 0%，而真相是「不知道」');
  ok(
    ctxRing().title.includes('已压缩 2 次'),
    '环上该留着压缩计数（compaction 说明会随转写滚走，条上这段才常在）：' + ctxRing().title
  );
  const aria = ctxRing().getAttribute('aria-label');
  ok(
    typeof aria === 'string' && aria.includes('暂无数据'),
    '没有数据时 aria-label 该如实说「暂无数据」（留空或写 0% 都是在撒谎）：' + JSON.stringify(aria)
  );
});

check('C22 aria-label 是给读屏的**短话**：说清占用、状态，但不抄那一整段多行口径', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000, state: 'near', stale: true } }) });
  const aria = ctxRing().getAttribute('aria-label');
  ok(aria.includes('上下文占用'), 'aria-label 没说这是上下文占用：' + aria);
  ok(aria.includes('2%'), 'aria-label 没带上比例：' + aria);
  ok(aria.includes('接近压缩阈值'), 'near 时 aria-label 该说出来（读屏用户看不到颜色）：' + aria);
  ok(aria.includes('上次'), 'stale 时 aria-label 该说出来：' + aria);
  ok(!aria.includes('\n'), 'aria-label 里带了换行 —— 读屏会读成一段多行说明，那就成了噪音');
  ok(!aria.includes('不是同一个数'), 'aria-label 抄了整段口径说明 —— 那是 title 的活，读屏一次念完等于刷屏');
});

// ---------- C22b · 环成了配置条第三个方块钮，点开一个**只读**浮层 ----------
//
// 用户原话：「希望它能变成一个按钮，并且使用「推理档位」和「profile」相同的容器，这样可以统一
// 样式」。于是它挂上 `.tool-icon .lc-knob`、外面套 `.lc-model-wrap`，并多了一个只读浮层。
// 这一组验的全是**行为**（影子能派 click / 读 class / 读 children）；"类名与那两个钮逐字同款"
// 与"自己的规则块里没写回外观"那些看不见的东西，在下面那组结构守卫里按 chat.html/css 原文钉。

/** 浮层里一行的文本 = 它两个 span 拼起来（label + body），空 label 就只有 body。 */
const ctxRowText = (row) => row.children.map((c) => c.textContent).join(' ');

check('C22b 点环 ⇒ 浮层开（钮与浮层同时挂 .open，与三个菜单同款）；再点 ⇒ 关', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  eq(ctxMenu().classList.contains('open'), false, '前提不成立：读数浮层一开始就开着');
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '点了环浮层没开 —— 那就还是个纯读数（C22b 要的正是点得开）');
  eq(ctxRing().classList.contains('open'), true, '浮层开了但触发钮没挂 .open —— 三个菜单都是两个一起挂的');
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), false, '再点一下没关上（开关只说了一半）');
  eq(ctxRing().classList.contains('open'), false, '关上了但钮的 .open 没摘');
});

check('C22b 浮层逐行与 title **同源**：把浮层的行拼回去必须逐字等于 title 第一行', () => {
  // 造一份**每一段都在**的读数（含 stale + near + 压缩计数 ⇒ 4 行 + 说明里最长的那条两段）
  send({
    type: 'usage',
    usage: usage({
      turn: { inputTokens: 11000, cacheReadTokens: 800, outputTokens: 948 },
      session: { inputTokens: 50000, cacheReadTokens: 8200, outputTokens: 4100 },
      compacted: 2,
      context: { usedTokens: 280000, contextWindow: 1000000, state: 'near', stale: true },
    }),
  });
  const lines = ctxRing().title.split('\n');
  const rowEls = childWithClass(ctxMenu(), 'ctx-row');
  const noteEls = childWithClass(ctxMenu(), 'ctx-note');
  ok(rowEls.length >= 4, `读数行只有 ${rowEls.length} 行 —— 本轮/累计/上下文/已压缩 四段该都在`);
  // ⚠️ 判据是"拼回去相等"，**不是**按 ` · ` 切开数行数：一段 body 里本来就可能带 ` · `
  //    （「本轮 ↑… ↓… · 缓存 97%」就是一个 body 里的分隔），按分隔符数必然假红。
  eq(rowEls.map(ctxRowText).join(' · '), lines[0], '浮层的行拼不回 title 第一行 —— 两处各拼了一套（那就必然会漂移）');
  eq(
    noteEls.map((e) => e.textContent).join('\n'),
    lines.slice(1).join('\n'),
    '浮层的说明行与 title 第一行之后的那些行对不上'
  );
  // 「接近阈值」那条说明里带一个换行 ⇒ 必须拆成两行铺开，不许缩成一行（`.ctx-note` 是 white-space:normal）
  ok(
    noteEls.some((e) => e.textContent.includes('不是同一个数')),
    '口径那条说明没进浮层 —— 只读浮层正是为了让键盘/读屏用户读到它（C22 记的已知局限）'
  );
  ctxRing().click(); // 开一下再关：确认开着的时候（也在每帧重建的那条路上）内容是对的
  ctxRing().click();
  eq(ctxMenu().children.length, rowEls.length + noteEls.length, '浮层里的元素数与行+说明对不上（有东西每帧在往里面加）');
});

check('C22c 空态那一行也走同一条同源判据（新建对话里点得开，里面写着为什么是 0）', () => {
  // 空态是 C22c 新加的一行**读数**（不是特例分支）：所以它照旧由 `rows` 派生 —— 浮层里那一行、
  // `title` 第一行、读屏那句仍然只有一个来源。要是哪天有人图省事在浮层里写死一句"尚无用量"，
  // 这一条会红。
  send({ type: 'usage', usage: null });
  const rowEls = childWithClass(ctxMenu(), 'ctx-row');
  eq(rowEls.length, 1, `空态该只有一行读数，实际 ${rowEls.length} 行`);
  eq(rowEls.map(ctxRowText).join(' · '), ctxRing().title.split('\n')[0], '空态那行在浮层里与 title 第一行对不上');
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '空态下浮层点不开 —— 新建对话里点它什么都不发生，那这枚钮就是个摆设');
  ok(childWithClass(ctxMenu(), 'ctx-note').length >= 1, '空态浮层里没有那句"数从第一次请求开始记"');
  ctxRing().click();
});

check('C22b 浮层开着时跟着流式帧刷新（不是打开那一刻的快照）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  ctxRing().click();
  ok(hasText(ctxMenu(), '24.0K'), '前提不成立：浮层里没有 24.0K');
  send({ type: 'usage', usage: usage({ context: { usedTokens: 48000, contextWindow: 1000000 } }) });
  ok(hasText(ctxMenu(), '48.0K'), '开着的浮层没跟着刷新 —— 数字会冻在打开那一刻（流式跑一轮就看出来了）');
  ok(!hasText(ctxMenu(), '24.0K'), '旧数字还在浮层里 —— 每帧是**整份重建**，不是往上追加');
  ctxRing().click();
});

check('C22b 同一排浮层只开一个：开环的浮层时，另外三个菜单全收起来', () => {
  $('live-effort-btn').click();
  eq($('live-effort-menu').classList.contains('open'), true, '前提不成立：推理档位菜单没打开');
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '环的浮层没开');
  eq(
    $('live-effort-menu').classList.contains('open'),
    false,
    '开环的浮层时没收掉档位菜单 —— 两个浮层会叠在同一个位置上'
  );
  ctxRing().click(); // 收起来，别把开着的浮层留给后面
});

check('C22b 点别处 ⇒ 浮层关（document 那条"点在外面"的判据里，环这一句也在）', () => {
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '前提不成立：浮层没开');
  docClick(document.body);
  eq(
    ctxMenu().classList.contains('open'),
    false,
    '点在外面的空白处，读数浮层没关 —— 那条判据里漏了环（另外三个菜单都有，就它没有）'
  );
  eq(ctxRing().classList.contains('open'), false, '浮层关了但钮的 .open 没摘');
});

check('C22b Esc 关浮层，且只关它（层次链里排在审阅/运行/对照三个面板之前）', () => {
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '前提不成立：浮层没开');
  pressKey('Escape');
  eq(ctxMenu().classList.contains('open'), false, 'Esc 没关掉读数浮层');
  // 顺序：它开着时按 Esc 只该收它这一层，不许顺手把身后的运行面板也收了。
  // 影子不做冒泡，所以这里用真实入口把运行面板打开（那条入口同时置内部标志与 .open）。
  $('runs-view').click();
  eq($('runs-panel').classList.contains('open'), true, '前提不成立：运行面板没打开');
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '前提不成立：浮层没开');
  pressKey('Escape');
  eq(ctxMenu().classList.contains('open'), false, 'Esc 没收掉读数浮层');
  eq($('runs-panel').classList.contains('open'), true, '一次 Esc 把身后的运行面板也收了 —— 层次链的顺序不对');
  $('runs-panel-close').click(); // 收干净，别留给后面
});

check('C22c 整条配置条藏起来时（切走 harness）⇒ 读数浮层必须收掉', () => {
  // C22b 那条老守卫走的是"环自己被藏"那两条早退路径；C22c 之后环**不再被藏**（见 chat.js 函数头），
  // 那两条路整条没了 —— 但"幽灵浮层"这件事还在，入口收敛成了这一个：绝对定位的浮层不能锚在
  // 一个看不见的控件上（整条 `#live-config-bar` 藏起来时它就在那个位置上）。
  send({ type: 'mode-set', mode: 'harness' });
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  ok(!$('live-config-bar').hidden, '前提不成立：harness 下配置条没显示');
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '前提不成立：浮层没开');
  send({ type: 'mode-set', mode: 'chat' });
  eq($('live-config-bar').hidden, true, '前提不成立：切到 chat 模式配置条没藏起来');
  eq(
    ctxMenu().classList.contains('open'),
    false,
    '整条配置条都藏了、浮层还开着 —— 它锚在一个看不见的控件旁边（点不到、也关不掉）'
  );
  eq(ctxRing().classList.contains('open'), false, '浮层关了但钮的 .open 没摘');
  send({ type: 'mode-set', mode: 'harness' }); // 复原，别把 chat 模式留给后面的检查
});

check('C22b 运行中（busy）环照旧可点 —— 旁边三个钮灰掉时它不灰（刻意的差异）', () => {
  send({ type: 'usage', usage: usage({ context: { usedTokens: 24000, contextWindow: 1000000 } }) });
  ctxRing().click();
  eq(ctxMenu().classList.contains('open'), true, '前提不成立：浮层没开');
  send({ type: 'run-busy', busy: true });
  eq($('live-effort-btn').disabled, true, '前提不成立：忙碌时档位钮没灰');
  eq(ctxRing().disabled, false, '忙时把读数环也禁用了 —— 看读数什么时候都该能看，运行中正是最想看它的时候');
  eq(
    ctxMenu().classList.contains('open'),
    true,
    '开跑那一刻读数浮层被收了 —— 那条"收起所有菜单"只该收三个"改配置"的，读数浮层正相反（开着看数字）'
  );
  ctxRing().click(); // 忙时也关得掉
  eq(ctxMenu().classList.contains('open'), false, '忙时点它关不掉浮层（开关在忙时被短路了）');
  ctxRing().click(); // 忙时照样点得开
  eq(ctxMenu().classList.contains('open'), true, '忙时点不开读数浮层 —— 那就等于把它也禁用了');
  ctxRing().click();
  send({ type: 'run-busy', busy: false });
  eq($('live-effort-btn').disabled, false, '前提不成立：跑完了档位钮还灰着');
});

check('C22b 结构守卫：环是配置条**第三个方块钮**（与推理/profile 钮逐字同款），且仍夹在两个钮之间', () => {
  const html = readFileSync(join(repoRoot, 'media', 'chat.html'), 'utf8');
  // C22b 起它是 `<button>`（C22 那版是 `<span role="img" tabindex="0">`）—— 上面那组行为断言
  // 点的就是它，所以这里连标签名一起钉住。
  const ring = /<button id="ctx-ring"[^>]*>/.exec(html);
  ok(ring, 'chat.html 里找不到 #ctx-ring 的 <button> 开始标签（C22b 起它是按钮，不再是 span）');
  const tag = ring ? ring[0] : '';
  // ① 位置：用户点名的就是"在模型版本选择和推理挡位之间"（Claude Code 那一枚的位置）。
  //    影子不连父子关系，DOM 上的"之间"在这个探针里只能按**源码下标**验。
  const iRing = html.indexOf('id="ctx-ring"');
  const iModel = html.indexOf('id="live-model-btn"');
  const iEffort = html.indexOf('id="live-effort-btn"');
  ok(iModel >= 0 && iEffort >= 0, 'chat.html 里找不到模型钮或推理钮 —— 位置判据没了基准');
  ok(iModel < iRing && iRing < iEffort, '环不在模型钮与推理钮之间（用户点名的就是那个位置）');
  // ② **同一份外观来源**（C22b 的全部理由）：挂 `.tool-icon`（26×26 / 圆角 / hover / 光标 /
  //    灰字全从它来）+ `.lc-knob`（与推理/profile 钮逐字同款）。这里逐字比类名集合，
  //    不许靠"看着差不多"——多一个少一个都说明它又在自己长一套样式。
  const ringCls = classOf(tag);
  ok(ringCls.includes('tool-icon'), '环没挂 .tool-icon —— 那它就又是一套自绘外观（C22b 要的正是统一）');
  ok(ringCls.includes('lc-knob'), '环没挂 .lc-knob —— 与推理/profile 钮的类名就不再逐字同款了');
  ok(!ringCls.includes('link-button'), '环挂了 .link-button —— 那是**文字**钮（带 padding 与 hover 底色），它是方块图标钮');
  const knob = /<button id="live-effort-btn"[^>]*>/.exec(html);
  ok(knob, 'chat.html 里找不到推理钮的开始标签 —— 类名对拍的基准没了');
  const knobCls = classOf(knob ? knob[0] : '');
  const extra = ringCls.filter((c) => !knobCls.includes(c));
  ok(
    extra.length === 1 && extra[0] === 'ctx-ring',
    `环与推理钮的类名只该差一个 .ctx-ring，实际差 ${JSON.stringify(extra)} —— 同一条工具栏里又长出第二套外观`
  );
  // ③ 键盘/读屏可达：`<button>` 天然可聚焦，所以不再需要 tabindex（C22 那条 tabindex="0" 随 span
  //    一起去掉了；留着反而会出现"作者自己声明可聚焦"与原生焦点顺序两套说法）。
  ok(!/tabindex=/.test(tag), '环上又写了 tabindex —— <button> 本来就进 Tab 顺序，重复声明只会打架');
  ok(/aria-label="[^"]+"/.test(tag), '环没有 aria-label —— <button> 的可访问名只能从它来（钮里只有两个 SVG 圆）');
  ok(/aria-haspopup=/.test(tag), '环没写 aria-haspopup —— 读屏不会知道按下去会弹东西出来');
  // C22c 翻面：一帧数据都没有时**也要在**（新建对话里就该看得见它，只是读作 0）。
  // 上面 D1 那组按运行时验的是同一件事，这里连 `hidden` 属性本身都不许写回 —— 写回一个静态
  // `hidden` 就会在 F5 里变成"新建对话看不见这枚钮"，而那正是用户这轮要改掉的毛病。
  ok(!/\shidden[\s/>]/.test(tag), '环上又写了 hidden —— C22c 起它一直在（没有数据就是读作 0，不是消失）');
  // ④ 浮层：外层必须是 `.lc-model-wrap`（绝对定位浮层的基准），浮层壳必须是 `.lc-model-menu`
  //    —— 这两条就是"统一样式"里"用同一个容器"的字面落实。
  ok(
    /<div id="ctx-ring-wrap" class="lc-model-wrap">/.test(html),
    '环外面没有 `.lc-model-wrap` —— 浮层会失去定位基准（模型/档位/profile 三个都是这么套的）'
  );
  const menu = /<div id="ctx-ring-menu" class="([^"]*)"/.exec(html);
  ok(menu, 'chat.html 里找不到 #ctx-ring-menu 那个浮层');
  ok(menu && menu[1].includes('lc-model-menu'), '读数浮层没用 `.lc-model-menu` 那套壳 —— 它会与另外三个浮层长得不一样');
  ok(menu && /role="dialog"/.test(html.slice(menu.index, menu.index + 200)), '读数浮层没写 role="dialog" —— 它是只读的，不该被读成 menu');
  // ⑤ 弧必须是 <circle> 且绕了 -90°：不转的话从 3 点钟起步，读数方向就错了
  const arc = /<circle id="ctx-ring-arc"[\s\S]*?<\/circle>/.exec(html);
  ok(arc, 'chat.html 里找不到 #ctx-ring-arc 那个 <circle>');
  ok(arc[0].includes('rotate(-90'), '弧没绕 -90° —— 它会从 3 点钟起步，而不是从 12 点顺时针长');
});

check('C22b 结构守卫：环自己的规则块里**不许写回外观**（那等于又长出第二套样式），警示色只用真令牌', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const ring = /\.ctx-ring\s*\{([^}]*)\}/.exec(css);
  ok(ring, 'chat.css 里找不到 .ctx-ring 的规则块');
  // C22b：外观（26×26 / 圆角 / hover / 光标 / 灰字）**全从 `.tool-icon` 来**。这里写回任何一条，
  // 就等于悄悄分叉出第二套外观 —— 平时看不出来，等哪天 .tool-icon 统一调尺寸时就它不跟。
  // （C22 那版正是自绘全套，还专门断言过"不许挂 .tool-icon"，C22b 整个翻了过来。）
  for (const dead of [
    /(^|[;\s])width\s*:/,
    /(^|[;\s])height\s*:/,
    /(^|[;\s])color\s*:/,
    /(^|[;\s])border\s*:/,
    /(^|[;\s])background(-color)?\s*:/,
    /(^|[;\s])cursor\s*:/,
  ]) {
    ok(!dead.test(ring[1]), `.ctx-ring 上出现了 ${dead} —— 外观该全从 .tool-icon 来（写回一处就是第二套样式）`);
  }
  // 换色只改 `color`：弧是 `stroke: currentColor` 一路吃到环上，所以规则块里只该有状态色那条。
  const nearRule = /\.ctx-ring\.near[^{]*\{([^}]*)\}/.exec(css);
  ok(nearRule, 'chat.css 里找不到 .ctx-ring.near —— 「上下文要压了」就再也喊不出来');
  // ⚠️ 这条先判、且判的是**否定式**，因为它报的错最精确：`-warning-` 那个名字在 dsh-live.css 里
  // **根本没定义**，写错不报错，只会静默退到 --vscode-editorWarning-foreground 兜底色
  //（看着"差不多对"，所以一直没人发现）。C21 在读数行上写的就是它 —— 这轮搬到环上才逮到。
  // 放在正面断言之前：否则一写错就先挨「没走 warn 那套 token」，那句话说不出真正的原因。
  ok(
    !/(^|[;\s(])--dsw-alias-state-warning-/.test(nearRule[1]),
    '.ctx-ring.near 写的是 `-warning-` 那套 token —— dsh-live.css 里只有 `warn`，' +
      '写错不报错、只会静默退到兜底色（C21 在读数行上正是这么错的，C22 才逮到）'
  );
  ok(
    /--dsw-alias-state-warn-primary/.test(nearRule[1]),
    '.ctx-ring.near 没走 warn 那套 token —— 和旁边两个 .tool-icon 就只剩粗细不一样了'
  );
  // ⚠️⚠️ **`:hover` 那一条不能省**：`.ctx-ring.near`（0,2,0）斗不过 `.tool-icon:hover:not(:disabled)`
  //（0,3,0），少了它，指针一压上去警告色就被换成普通亮字 —— 而那正是最该看见警示的时候。
  // 这条只能按**选择器原文**验：影子不解析样式，算不出权重，更不会替你发现"被 hover 盖掉了"。
  const nearSel = /(\.ctx-ring\.near[^{]*)\{/.exec(css);
  ok(
    nearSel && /\.ctx-ring\.near:hover/.test(nearSel[1]),
    '.ctx-ring.near 那条没带 `:hover` 版本 —— 与 `.tool-icon:hover` 权重打平、靠源码顺序决胜，' +
      '少了它，指针一压上去警告色就没了（探针看不到样式，只能在这里钉住选择器）'
  );
  // 唯一性：同一个警示不许在环和读数行两处一起喊（`.status-row.near` 那条规则该已经删了）
  ok(!/\.status-row\.near\b/.test(css), 'chat.css 里还有 .status-row.near —— 警示色该只在环上');
  // stale 必须真的变淡，且用的是 opacity（不是 display/visibility —— 那会连焦点一起摘掉）
  const stale = /\.ctx-ring\.stale\s*\{([^}]*)\}/.exec(css);
  ok(stale, 'chat.css 里找不到 .ctx-ring.stale —— 陈旧读数就看不出来了');
  ok(/opacity\s*:/.test(stale[1]), '.ctx-ring.stale 没给透明度 —— 「这个数有点旧」就说不出来');
});

check('C22 结构守卫：弧的两条 CSS 契约 —— dasharray 等于 JS 那个常量，且这块**绝不写** dashoffset', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const arc = /\.ctx-ring-arc\s*\{([^}]*)\}/.exec(css);
  ok(arc, 'chat.css 里找不到 .ctx-ring-arc 的规则块');
  // ① 两处常量必须相等（第三份钉在这个文件顶上）。两者漂移 ⇒ 弧的长度整体错位，
  //    而且**画出来仍然是个圆环**、只是比例不对 —— 肉眼最难发现的那种错。
  const dash = /stroke-dasharray\s*:\s*([\d.]+)/.exec(arc[1]);
  ok(dash, '.ctx-ring-arc 里没写 stroke-dasharray —— 没有它 dashoffset 什么也推不动');
  ok(
    closeTo(Number(dash[1]), CTX_RING_LEN, 0.005),
    `stroke-dasharray(${dash[1]}) 与 chat.js 的 CTX_RING_LEN(${CTX_RING_LEN}) 对不上了`
  );
  // ② ⚠️⚠️ 这块里**绝不许出现 dashoffset 这个属性**：chat.js 是用 setAttribute 写的**表现属性**，
  //    表现属性在 CSS 里优先级最低 —— 这里写一个值就会把 JS 写的整个盖掉，弧从此永远卡在
  //    同一个长度上，**而且不报错**。
  //    注意判据要的是"声明"（`stroke-dashoffset:`），不是"出现过这个词"：
  //    `transition: stroke-dashoffset 0.2s ease` 是合法的，它只是补一段动画、并不设置值。
  ok(
    !/(^|[;{\s])stroke-dashoffset\s*:/.test(arc[1]),
    '.ctx-ring-arc 里给 stroke-dashoffset 写了值 —— CSS 会盖掉 chat.js 写的那条表现属性，' +
      '弧会永远停在同一个长度上（而且是静默的）'
  );
});

check('C22b 结构守卫：读数浮层看着是同一套菜单，但**不假装能点**', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 行复用 `.lc-model-item` 的排版（"统一样式"要的就是这个），但那是**菜单项**的样式：
  // 带手形光标、hover 亮底。读数行不可点，这两样留着就是骗人 —— 悬停亮起来、点下去没反应。
  const item = /\.ctx-readout\s+\.lc-model-item\s*\{([^}]*)\}/.exec(css);
  ok(item, 'chat.css 里找不到 `.ctx-readout .lc-model-item` —— 读数行会带着"我能点"的手形光标');
  ok(
    item && /cursor\s*:\s*default/.test(item[1]),
    '读数行没把手形光标改回来 —— 它在假装自己能点（它是只读浮层）'
  );
  ok(
    /\.ctx-readout\s+\.lc-model-item:hover\s*\{[^}]*background\s*:\s*none/.test(css),
    '读数行保留了 hover 亮底 —— 悬停亮起来、点下去没反应，那比不给反馈更糟'
  );
  ok(/\.ctx-note\s*\{/.test(css), 'chat.css 里找不到 `.ctx-note` —— 口径说明那几行没地方放');
});

check('C22c 结构守卫：读数浮层的**排版**四件事（宽度 / 基线 / 标签定宽 / 值独占一列）', () => {
  // 由来：用户 2026-09-24 真机看了第一版浮层，原话「排版改一下，太丑了」。丑的具体形状是
  // 值折行、行行高矮不齐、标签浮在两行中间 —— 这几条都只活在 CSS 里，影子看不见样式，
  // 所以只能按原文钉。⚠️ 这里卡的是**机制**（有没有那一列 / 有没有那个单位），不是字面值
  // —— C21b 的教训：卡字面量的守卫等于把当时那个值写成了正确。
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const item = /\.ctx-readout\s+\.lc-model-item\s*\{([^}]*)\}/.exec(css);
  ok(item, 'chat.css 里找不到 `.ctx-readout .lc-model-item`');
  ok(
    item && /align-items\s*:\s*baseline/.test(item[1]),
    '读数行还是 .lc-model-item 的 center 对齐 —— 值一折成两行，标签就浮在两行中间（这就是"丑"的头一条）'
  );
  ok(
    item && /white-space\s*:\s*normal/.test(item[1]),
    '读数行还是 nowrap —— 它继承的是菜单项那条（一行的短名字），读数是句子，折不动就顶出去'
  );
  // 宽度：`.lc-model-menu` 给的是 150/230px（那是"模型名"的量级），而最长的一行读数
  // `76.9K / 1.0M · ⚠ 接近压缩阈值` 放不进 230px ⇒ 值一动就折行。
  // ⚠️ 选择器**必须带 `.lc-model-menu`**：那一条排在本文件**后面**，同权重靠源码顺序决胜 ——
  //    只写 `.ctx-readout` 会被它盖掉（C22b 的 `.near:hover` 是同一条坑）。探针看不到层叠结果，
  //    所以这里把选择器原文钉住；宽度本身卡的是"> 230px"这个**关系**，不是某个具体数。
  const width = /\.lc-model-menu\.ctx-readout\s*\{([^}]*)\}/.exec(css);
  ok(
    width,
    'chat.css 里找不到 `.lc-model-menu.ctx-readout` 的宽度覆盖 —— ' +
      '只写 `.ctx-readout` 会被后面那条 `.lc-model-menu`（150/230px）盖掉，白写'
  );
  // 下限允许写成 `min(Npx, calc(100vw - …))`（侧栏拖窄时跟着缩，别把浮层顶出面板），
  // 所以这里把可选的 `min(` 吃掉再读那个 px。
  const minW = width && /min-width\s*:\s*(?:min\(\s*)?(\d+)px/.exec(width[1]);
  ok(
    minW && Number(minW[1]) > 230,
    `.lc-model-menu.ctx-readout 的 min-width 是 ${minW ? minW[1] + 'px' : '（没写）'} —— ` +
      '不比 .lc-model-menu 的 max-width(230px) 宽，最长那行读数照样折行（宽度覆盖就成了摆设）'
  );
  ok(
    width && /max-width\s*:/.test(width[1]),
    '读数浮层没有自己的 max-width —— 那条 230px 会继续生效，宽度覆盖等于只改了下限'
  );
  // 标签定宽右对齐（3em = 三个汉字）：三行的值列左边缘因此对齐，读起来是一张表。
  const label = /\.ctx-row-label\s*\{([^}]*)\}/.exec(css);
  ok(label, 'chat.css 里找不到 `.ctx-row-label`');
  ok(
    label && /min-width\s*:\s*[\d.]+em/.test(label[1]),
    '标签没有按 em 定宽 —— 本轮/累计/上下文 三个标签宽度不同，三行的值就会各自从不同的 x 起，' +
      '读起来是散着的三段而不是一列'
  );
  ok(label && /text-align\s*:\s*right/.test(label[1]), '标签没右对齐 —— 值列对不齐，定宽也就白定了');
  // 值独占一列：吃掉剩余宽度 + 允许缩到 0。少了 `min-width: 0`，flex 项不肯缩到内容宽度以下
  //（值是长句子时会把整行顶宽，折行也折不动）。
  const body = /\.ctx-row-body\s*\{([^}]*)\}/.exec(css);
  ok(body, 'chat.css 里找不到 `.ctx-row-body`');
  ok(
    body && /flex\s*:\s*1/.test(body[1]) && /min-width\s*:\s*0/.test(body[1]),
    '值那一列不是"吃掉剩余宽度 + 允许缩到 0" —— 窄面板下长值会把行顶宽，而且折不进自己那一列'
  );
  ok(
    /\.ctx-readout\s+\.lc-model-item\s*\+\s*\.ctx-note\s*\{[^}]*border-top/.test(css),
    '口径说明与上面的读数之间没有分隔线 —— 数字和说明读起来是一团同质的灰字'
  );
});

check('C22 结构守卫：四个令牌在 dsh-live.css 里**真的存在**（写错不报错，只会静默退色）', () => {
  const tokens = readFileSync(join(repoRoot, 'media', 'dsh-live', 'dsh-live.css'), 'utf8');
  const used = [
    '--dsw-alias-label-secondary',
    '--dsw-alias-border-l2',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-label-tertiary', // C22d：浮层的口径说明行用它（比读数轻一档，但**看得见**）
  ];
  for (const t of used) {
    ok(tokens.includes(t + ':'), `dsh-live.css 里没有定义 ${t} —— 会静默退到 VS Code 兜底色`);
  }
  // 明暗两套都要有：只在一套里定义，另一套主题下就退色
  for (const t of used) {
    const hits = tokens.split(t + ':').length - 1;
    ok(hits >= 2, `${t} 只定义了 ${hits} 次 —— 明暗两套主题里少了一套（那套下会退到兜底色）`);
  }
});

check('C22d 结构守卫：说明那几行的色阶必须**夹在**行标签与 dimmed 之间（暗色下不再看不见）', () => {
  // 由来：用户 2026-09-24 在**暗色主题**下看浮层，原话「这句话…有点暗，可以稍微亮一点」。
  // 原来用的是 `--dsw-alias-label-dimmed` —— 它在 dsh-live.css 的令牌梯里是最淡那一档
  //（亮色 = bluish-200 `rgb(225,229,238)`、暗色 = bluish-750 `rgb(67,69,74)`），而浮层底色是
  // VS Code 的 dropdown-listBackground（暗色 ≈ `rgb(43,43,48)`）⇒ 暗色下对比度 ≈1.5:1。
  // dimmed 是给"几乎不用看见的装饰"的，不是给"安静的文字"的。
  //
  // ⚠️ 这里卡的是**梯子上的位置**，不是令牌名也不是色值（C21b 的教训：卡字面量等于把当时那个值
  //    写成了正确，下一个人只会照着字面量改回去）：
  //      ① 必须**弱于**行标签（保住「数字 > 标签 > 说明」的层级，说明不能比读数还响）；
  //      ② 必须**强于** dimmed（否则又回到"看不见"）。
  //    梯子顺序抄自 dsh-live.css 那两套别名块（明暗一致：primary > secondary > tertiary > caption > dimmed）。
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const LADDER = ['primary', 'secondary', 'tertiary', 'caption', 'dimmed']; // 越靠前越显眼
  const tier = (sel) => {
    // 允许 `label-primary-bluish` 这类同族名：取最长匹配前缀
    const m = new RegExp('\\.' + sel + '\\s*\\{([^}]*)\\}').exec(css);
    if (!m) return null;
    const c = /color\s*:\s*var\(\s*--dsw-alias-label-([a-z-]+)\s*,/.exec(m[1]);
    if (!c) return null;
    const name = LADDER.find((t) => c[1] === t || c[1].startsWith(t + '-'));
    return name ? { name, i: LADDER.indexOf(name), block: m[1] } : { name: c[1], i: -1, block: m[1] };
  };
  const note = tier('ctx-note');
  const label = tier('ctx-row-label');
  ok(label, 'chat.css 里找不到 `.ctx-row-label` 的 color（或它不再走带兜底的 `--dsw-alias-label-*`）');
  ok(note, 'chat.css 里找不到 `.ctx-note` 的 color（或它不再走带兜底的 `--dsw-alias-label-*`）');
  if (!note || !label) return;
  ok(
    label.i >= 0 && note.i >= 0,
    `说明/标签用了梯子之外的令牌（说明 = ${note.name}、标签 = ${label.name}）—— ` +
      '梯子外的不保证明暗两套都给得出来，暗色下很可能就退成看不见'
  );
  ok(
    note.i > label.i,
    `说明那档（${note.name}）不比行标签那档（${label.name}）弱 —— 层级反了：` +
      '说明是不需要先读的东西，不能和读数一样响'
  );
  ok(
    note.i < LADDER.indexOf('dimmed'),
    `说明那档是 ${note.name}，已经落到 dimmed 那一侧了 —— dimmed 是"几乎不用看见的装饰"那一档` +
      '（暗色下 ≈1.5:1，就是 C22d 用户报的那条"有点暗"）'
  );
  // 兜底链不能丢：media/dsh-live 产物缺失时 chat.html 那条 <link> 是空的，那时全靠第二个参数。
  ok(
    /color\s*:\s*var\(\s*--dsw-alias-label-[a-z-]+\s*,\s*var\(/.test(note.block),
    '说明行的 color 没有兜底（`var(令牌, var(--vscode-…))` 这样一路退下去）—— ' +
      'dsh-live 产物缺失时说明会变成不可见'
  );
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
    statusRun().textContent,
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

// ---------- C15 · 分支对照浮层 ----------
//
// 真机看到的是「点 header 的『对照』→ 铺满侧栏的两栏转写」。
// 这里验影子能表达的部分：开关与三浮层互斥、**三种空态的区别**、分叉点那两行的文案、
// 各自独立的折叠、选择器的置灰与回执，以及两条**不许发生**的事 ——
// 污染直播面的 `byId`、以及被关掉之后迟到的快照把面板画回来。

const cmpPanel = () => $('compare-panel');
const cmpOpen = () => cmpPanel().classList.contains('open');
const cmpPane = (side) => $('compare-transcript-' + side);
const cmpNodes = (side) => childWithClass(cmpPane(side), 'msg');
const cmpVerdictLines = () => childWithClass($('compare-verdict'), 'cmp-verdict-line');
/** 工具卡不是栏的直接子节点（外面还套着 `.msg.msg-tool`），得整棵子树找 */
const cmpCards = (side) => walk(cmpPane(side)).filter((e) => e.classList.contains('tool-card'));

/** 干净的局面：清空消息面 + 关掉面板（若开着），再给一份历史列表（选择器的数据源） */
function resetCompare() {
  send({ type: 'snapshot', sessionId: 's-c15', messages: [] });
  send({ type: 'mode-set', mode: 'harness' });
  send({
    type: 'history-update',
    sessions: [
      { id: 'sa', title: '重构登录', updatedAt: 1700000000000 },
      { id: 'sb', title: '重构登录（分支）', updatedAt: 1700000001000 },
      { id: 'sc', title: '别的事', updatedAt: 1700000002000 },
    ],
    trashed: [],
    activeId: 'sa',
  });
  // 三个浮层都用**各自的关闭钮**收（走真实路径：那条路会连内部标志一起复位）
  if (cmpOpen()) $('compare-panel-close').click();
  if ($('review-panel').classList.contains('open')) $('review-panel-close').click();
  if ($('runs-panel').classList.contains('open')) $('runs-panel-close').click();
}

/** 一份快照载荷：`over` 覆盖要测的那几处 */
function compareSet(over = {}) {
  const pane = (id, title, messages, shared, frozen, extra = {}) =>
    Object.assign(
      { id, title, updatedAt: 1700000000000, messages, shared, sharedNote: `共同前缀 ${shared} 条已折叠（两侧同源）`, frozen },
      extra
    );
  return Object.assign(
    {
      type: 'compare-set',
      at: 1700000000000,
      live: false,
      sides: { a: 'sa', b: 'sb' },
      panes: {
        a: pane('sa', '重构登录', [
          { id: 'S#1', role: 'user', text: '把注释改一下', status: 'done' },
          { id: 'S#2', role: 'assistant', text: '改好了', status: 'done' },
          { id: 'F#3', role: 'assistant', text: '甲支的回答', status: 'done' },
        ], 2, 0),
        b: pane('sb', '重构登录（分支）', [
          { id: 'S#1', role: 'user', text: '把注释改一下', status: 'done' },
          { id: 'S#2', role: 'assistant', text: '改好了', status: 'done' },
          { id: 'G#3', role: 'assistant', text: '乙支的回答', status: 'done' },
        ], 2, 1, { frozenNote: '其中 1 条「仍在跑」的状态已冻结为终态' }),
      },
      split: {
        shared: 2,
        aAfter: 1,
        bAfter: 1,
        kind: 'fork',
        line: '分叉点在第 2 条 · 此后 左 1 条 / 右 1 条',
        title: '判据：两条会话的消息 id 逐条比对。',
      },
      crosstalk: {
        line: '两条会话共享同一份 DSH 记忆 —— 在任一边继续发消息，另一边也会看到',
        title: '判据：盘上保存的 DSH 身份',
        level: 'warn',
      },
    },
    over
  );
}

check('C15 开关：点入口 → 面板开且**恰好一条** compare-open；再点 → 收起', () => {
  resetCompare();
  const before = posted.filter((m) => m.type === 'compare-open').length;
  $('compare-btn').click();
  ok(cmpOpen(), '点了「对照」面板没开');
  eq(posted.filter((m) => m.type === 'compare-open').length - before, 1, 'compare-open 应恰好发一条（发多了扩展会把快照重取 N 次）');
  ok($('compare-verdict').hidden, '前置条件：还没收到快照时判定区就该是 hidden（初值从 chat.html 读）');
  $('compare-btn').click();
  ok(!cmpOpen(), '再点一次没收起（同一个钮要能开也能关）');
});

check('C15 **三个空态分开说**：载入中 / 还没选 / 选了但已删', () => {
  resetCompare();
  $('compare-btn').click();
  // ① 快照还没到（postMessage 是异步的）—— 把这几毫秒画成「没有数据」是在说谎
  ok(hasText(cmpPane('a'), '载入中'), '快照未到时没说「载入中…」');
  // ② 一条都没选
  send(compareSet({ panes: {}, sides: {} }));
  ok(hasText(cmpPane('a'), '还没有可对照的会话'), '没选会话时那句不对');
  ok(!hasText(cmpPane('a'), '载入中'), '收到空快照后还挂着「载入中」');
  // ③ 选了，但解不出来（已进回收站 / 已清空）
  send(compareSet({ panes: {}, sides: { a: 'sa', b: 'gone' } }));
  ok(hasText(cmpPane('b'), '已被删除或清空'), '选中却解不出来的那一侧没说清是「已被删除或清空」');
  ok(hasText(cmpPane('a'), '已被删除或清空'), '前置条件：两侧都解不出来时两栏都该说这句');
});

check('C15 快照落地：两栏各自渲染、分叉点两行、判定区两行且只有串话那行是警示色', () => {
  resetCompare();
  $('compare-btn').click();
  send(compareSet());
  eq(cmpNodes('a').length, 3, '左栏的尾段条数不对');
  eq(cmpNodes('b').length, 3, '右栏的尾段条数不对');
  ok(hasText(cmpPane('a'), '共同前缀 2 条已折叠'), '左栏没说共同前缀被折叠了');
  ok(hasText(cmpPane('a'), '分叉点之后'), '左栏没有分叉点那条界线');
  ok(hasText(cmpPane('a'), '甲支的回答') && hasText(cmpPane('b'), '乙支的回答'), '两栏渲染的内容串了');
  ok(hasText($('compare-meta-b'), '冻结 1 条'), '有冻结条数时侧栏 meta 没写出来');
  const lines = cmpVerdictLines();
  eq(lines.length, 2, '判定区应是两行（分叉点 + 串话）');
  eq(texts(lines[0]).join(''), '分叉点在第 2 条 · 此后 左 1 条 / 右 1 条', '分叉点那行的文案不是扩展侧给的那句');
  ok(!lines[0].classList.contains('warn'), '分叉点那行不该是警示色');
  ok(lines[1].classList.contains('warn'), '共享记忆那行**必须**是警示色（那是本项唯一要喊出来的事）');
  ok(!$('compare-verdict').hidden, '有判定文案时判定区还是 hidden');
});

check('C15 **无关会话不许出警示色**（另一档 level 的正面反控）', () => {
  resetCompare();
  $('compare-btn').click();
  send(
    compareSet({
      split: { shared: 0, aAfter: 3, bAfter: 3, kind: 'none', line: '两侧没有共享消息 —— 不是同一次分支的结果（或源会话的那一段已被清掉）', title: 't' },
      crosstalk: { line: '两条会话的 DSH 记忆是分开的 —— 在一边发消息不会影响另一边', title: 't', level: 'ok' },
    })
  );
  const lines = cmpVerdictLines();
  eq(lines.length, 2, '判定区行数不对');
  ok(lines.every((l) => !l.classList.contains('warn')), '两条无关会话飘出了警示色 —— 警示很快就没人看了');
  eq(texts(lines[0]).join(''), '两侧没有共享消息 —— 不是同一次分支的结果（或源会话的那一段已被清掉）', '文案被改写了（判据在扩展侧，前端只排版）');
});

check('C15 折叠是**各自的**：对照栏展开不许把直播面也展开（反控：两个状态共用一个就会串）', () => {
  resetCompare();
  // 直播面先折上：100 条 → 折 40
  send({ type: 'snapshot', sessionId: 's-c15-live', messages: mkMessages(100, 'L') });
  eq(foldRows().length, 1, '前置条件：直播面该折起来了');
  eq(msgNodes().length, FOLD_KEEP, '前置条件：直播面该只留尾部 60 条');
  // 对照栏给一份超长尾段（80 条 > FOLD_KEEP）
  $('compare-btn').click();
  const long = [];
  for (let i = 1; i <= 80; i++) long.push({ id: `T#${i}`, role: 'assistant', text: `尾 ${i}`, status: 'done' });
  send(compareSet({ panes: { a: Object.assign(compareSet().panes.a, { messages: long }), b: compareSet().panes.b } }));
  eq(childWithClass(cmpPane('a'), 'msg-fold').length, 1, '对照栏的超长尾段没折起来');
  eq(cmpNodes('a').length, FOLD_KEEP, '对照栏折完之后该只留 60 条');
  // 点对照栏那一行
  childWithClass(cmpPane('a'), 'msg-fold')[0].children[0].click();
  eq(cmpNodes('a').length, 80, '点了对照栏的「显示」，它自己没展开');
  // 反控：直播面必须还是折着的（共用 `foldExpanded` 的话它会被一起展开）
  eq(foldRows().length, 1, '展开对照栏把**直播面**也展开了 —— 两个落点的折叠态串了');
  eq(msgNodes().length, FOLD_KEEP, '直播面被对照栏的展开带跑了');
});

check('C15 选择器：点了「选择会话」列出全部会话，**已选的两行点了不发消息**', () => {
  resetCompare();
  $('compare-btn').click();
  send(compareSet());
  $('compare-pick-a').click();
  const list = childWithClass(cmpPane('a'), 'cmp-list')[0];
  ok(list, '点了「选择会话」没长出列表');
  eq(list.children.length, 3, '列表条数应等于 sessions（在列且有内容的会话）');
  const rows = list.children;
  ok(rows[0].classList.contains('disabled'), '本侧那行没置灰');
  ok(rows[1].classList.contains('disabled'), '对侧那行没置灰');
  ok(!rows[2].classList.contains('disabled'), '没选中的那行不该置灰');
  // ⚠️ 灰了还能点出消息是最坏的一种 —— 置灰的行连监听都不许挂
  const before = posted.filter((m) => m.type === 'compare-pick').length;
  rows[0].click();
  rows[1].click();
  eq(posted.filter((m) => m.type === 'compare-pick').length - before, 0, '置灰的行还挂着 click —— 点它能改掉已经选定的一侧');
  rows[2].click();
  const picks = posted.filter((m) => m.type === 'compare-pick');
  eq(picks.length - before, 1, '点可选的行走应恰好发一条 compare-pick');
  eq(picks[picks.length - 1].side, 'a', 'compare-pick 的 side 不对');
  eq(picks[picks.length - 1].sessionId, 'sc', 'compare-pick 的 sessionId 不对');
});

check('C15 `compare-set` 一到就收起选择器（回执语义 —— 被拒也回整份 set，不会卡在那一屏）', () => {
  resetCompare();
  $('compare-btn').click();
  send(compareSet());
  $('compare-pick-a').click();
  ok(childWithClass(cmpPane('a'), 'cmp-list').length === 1, '前置条件：选择器该开着');
  send(compareSet());
  eq(childWithClass(cmpPane('a'), 'cmp-list').length, 0, '收到快照后选择器没收起 —— 用户会以为选择没生效');
  eq(cmpNodes('a').length, 3, '收起选择器后没把转写画回来');
});

check('C15 **关掉之后迟到的快照不许把面板画回来**', () => {
  resetCompare();
  $('compare-btn').click();
  $('compare-panel-close').click();
  ok(!cmpOpen(), '前置条件：应先关上');
  send(compareSet()); // 关掉的那一刻快照还在路上
  ok(!cmpOpen(), '迟到的 compare-set 把面板画回来了 —— 用户关不掉它');
  ok(!hasText(cmpPane('a'), '甲支的回答'), '迟到的快照往已关闭的面板里写了内容');
  // 再打开必须是干净的「载入中」，而不是上一份快照的残影
  $('compare-btn').click();
  ok(hasText(cmpPane('a'), '载入中'), '重开面板时还留着上一次的快照');
});

check('C15 **对照栏不许污染直播面的 byId**（迟到帧按 id 找不到记录，什么都不能做）', () => {
  resetCompare();
  $('compare-btn').click();
  send(
    compareSet({
      panes: {
        a: Object.assign(compareSet().panes.a, {
          messages: [
            { id: 'cmp-t1', role: 'tool', text: '', status: 'done', toolName: 'bash', toolInput: 'ls', toolOutput: 'x', toolState: 'unknown' },
          ],
        }),
        b: compareSet().panes.b,
      },
    })
  );
  const card = cmpCards('a')[0];
  ok(card, '对照栏里的工具卡没渲染出来');
  ok(card.classList.contains('unknown'), '前置条件：那卡该是 unknown 态');
  // 迟到帧：id 与对照栏里那张卡相同
  send({ type: 'tool-result', id: 'cmp-t1', toolState: 'ok', output: 'done!' });
  ok(card.classList.contains('unknown'), '对照栏那张卡的 class 被迟到帧改了 —— 说明它的记录进了直播面的 byId（给迟到帧开了一扇门）');
  ok(!card.classList.contains('ok'), '对照栏那张卡被翻成了成功 —— 同上');
  ok(hasText($('compare-transcript-a'), '? 无结果'), '对照栏那张卡的状态字被迟到帧改了');
});

check('C15 对照渲染**不碰直播面**，且冻结过的状态是终态视觉（不转圈、不闪光标）', () => {
  resetCompare();
  send({ type: 'snapshot', sessionId: 's-c15-live', messages: mkMessages(4, 'L') });
  const liveBefore = messagesEl().children.length;
  $('compare-btn').click();
  send(
    compareSet({
      panes: {
        a: Object.assign(compareSet().panes.a, {
          messages: [
            { id: 'fz1', role: 'tool', text: '', status: 'done', toolName: 'bash', toolInput: 'ls', toolState: 'unknown' },
            { id: 'fz2', role: 'assistant', text: '被打断的那句', status: 'interrupted' },
          ],
        }),
        b: compareSet().panes.b,
      },
    })
  );
  eq(messagesEl().children.length, liveBefore, '渲染对照栏动了 #messages 的子节点 —— 直播面被它碰了');
  const c = cmpCards('a')[0];
  ok(c.classList.contains('unknown'), '冻结过的工具卡不是 unknown 态');
  ok(!c.classList.contains('running'), '冻结过的工具卡还在转圈 —— 那是「还在跑」的视觉，与 unknown 的语义打架');
  ok(!hasText(cmpPane('a'), '运行中'), '冻结过的工具卡状态字还是「运行中…」');
  // 打断的助手消息不许有闪烁光标（那是「正在生成」的视觉）
  const carets = walk(cmpPane('a')).filter((e) => e.classList.contains('caret'));
  eq(carets.length, 0, '对照栏里有 caret —— 冻结过的一条看起来还在生成');
});

check('C15 三个浮层互斥（同层 z-40，同时开着没有视觉仲裁）', () => {
  resetCompare();
  $('review-view').click(); // 走真实入口：它同时置内部标志与 .open（只加 class 的话，互斥那条判据就只是在验 CSS）
  $('compare-btn').click();
  ok(cmpOpen(), '对照没开');
  ok(!$('review-panel').classList.contains('open'), '开着审阅时点对照，审阅没收 —— 两个满屏浮层会叠在一起');
  $('compare-btn').click(); // 先关掉，避免它干扰下面这条
  // 开着对照 → 点运行检查器的「查看」
  $('compare-btn').click();
  ok(cmpOpen(), '前置条件：对照该开着');
  $('runs-view').click();
  ok(!cmpOpen(), '开着对照时点运行的「查看」，对照没收');
  ok($('runs-panel').classList.contains('open'), '运行检查器没开');
  $('runs-panel-close').click();
});

check('C15 Esc 逐层收：对照开着时 Esc 收对照（且不误关历史面板）', () => {
  resetCompare();
  $('compare-btn').click();
  ok(cmpOpen(), '前置条件：对照该开着');
  pressKey('Escape');
  ok(!cmpOpen(), 'Esc 没收掉对照浮层');
  // 反控：审阅浮层开着时 Esc 该收审阅 —— 顺序是「审阅 → 运行 → 对照 → 历史」
  $('review-view').click();
  pressKey('Escape');
  ok(!$('review-panel').classList.contains('open'), 'C9 起的那条次序被破坏了：Esc 没先收审阅');
});

check('C15 结构守卫：CSS 与 chat.html 的形状（影子表达不了布局，只验字面）', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].split(',').some((s) => s.trim() === sel)) return m[2];
    }
    return undefined;
  };
  const tr = block('.cmp-transcript');
  ok(tr, 'chat.css 里找不到 .cmp-transcript');
  // `.msg` 的 align-self（用户靠右/助手靠左）与 max-width:92% 都是 **flex 项**属性 ——
  // 块容器下用户消息就不右对齐了，而影子看不到布局，只能钉住这两条声明。
  ok(/display:\s*flex/.test(tr), '.cmp-transcript 不是 display:flex —— 栏里的用户消息不会右对齐');
  ok(/flex-direction:\s*column/.test(tr), '.cmp-transcript 不是 column');
  ok(!/max-width/.test(tr), '.cmp-transcript 抄了 .messages 的 max-width —— 半宽的栏里内容会被挤成一条');
  ok(!/margin:\s*0\s+auto/.test(tr), '.cmp-transcript 抄了 .messages 的 margin:0 auto（那是单栏的阅读列）');
  const body = block('.cmp-body');
  ok(body && /grid-template-columns:\s*1fr\s+1fr/.test(body), '.cmp-body 不是并排两栏');
  ok(/@media \(max-width: 520px\)/.test(css), '窄栏改竖排的那条 media query 不见了');
  const warn = block('.cmp-verdict-line.warn');
  ok(warn && /warning/.test(warn), '警示那行没走 warning token（复用仓库已有 token，不新造色）');

  // chat.html：面板必须是 body 直系子元素，且**不在 #messages 的区间里** ——
  // react-live 时 `#messages` 整个 display:none，放进去的浮层会跟着消失（C14 栽过）。
  const html = readFileSync(join(repoRoot, 'media', 'chat.html'), 'utf8');
  const msgOpen = html.indexOf('id="messages"');
  const mainClose = html.indexOf('</main>', msgOpen);
  const panelAt = html.indexOf('id="compare-panel"');
  ok(msgOpen > 0 && mainClose > msgOpen && panelAt > 0, 'chat.html 里找不到 #messages / #compare-panel 的区间');
  ok(panelAt > mainClose, '#compare-panel 落在 #messages 的区间里 —— react-live 时它会跟着一起消失');
  // 入口钮在 header 的动作区里（不在 composer —— 那里是「本轮的读数/动作」的地方）
  const actionsAt = html.indexOf('header-actions');
  const actionsEnd = html.indexOf('</div>', actionsAt);
  const btnAt = html.indexOf('id="compare-btn"');
  ok(btnAt > actionsAt && btnAt < actionsEnd, '#compare-btn 不在 .header-actions 里');
  ok(html.indexOf('id="compare-verdict"') > 0 && /\shidden/.test(html.slice(html.indexOf('id="compare-verdict"') - 60, html.indexOf('id="compare-verdict"') + 60)), '#compare-verdict 的 hidden 初值被去掉了 —— 空判定区会占一块位置');
});

// ---------- C16 · 审批白名单记忆（「永久信任」） ----------
//
// 真机看到的是「拦停条上多一个『永久信任此命令/此目录』按钮 + 一行边界说明」。
// 这里验影子能表达的部分：**能不能提供信任、提供哪一种、文案怎么写，全是扩展说了算**
// （webview 只画它拿到的那份，不拼字、不推断），点下去回传的粒度原样，
// 以及四条**不许发生**的事 —— Esc 被反转成信任、「允许执行」被静默升级成永久信任、
// 下一条审批继承上一条的粒度、老载荷下留一个没字的空按钮。

/** 一份「扩展允许永久信任」的载荷：`kind` 决定是命令档还是目录档 */
const trustPayload = (id, kind, over = {}) =>
  Object.assign(
    {
      type: 'approval-request',
      id,
      toolName: kind === 'dir' ? 'write' : 'bash',
      command: kind === 'dir' ? 'write D:\\out\\a.ts' : 'rm -rf ./dist',
      trust: {
        kind,
        label: kind === 'dir' ? '永久信任此目录' : '永久信任此命令',
        scope:
          kind === 'dir'
            ? '这个目录及其子目录都不再问（D:\\out）'
            : '只对这一条命令生效（在 D:\\proj 里）',
      },
    },
    over
  );

/** 干净的局面：屏上不挂任何一条审批（走真实的两条消息收，不碰内部函数） */
function resetApproval() {
  send({ type: 'approval-request', id: 'c16-reset', toolName: 'bash', command: 'echo reset' });
  send({ type: 'approval-resolved', id: 'c16-reset' });
  posted.length = 0;
}

check('C16 拦停条：带 trust 的载荷 ⇒ 按钮与边界说明都出现，文案逐字是扩展给的那份', () => {
  resetApproval();
  send(trustPayload('c16-1', 'command'));
  eq($('approval-bar').hidden, false, '前置条件不成立：条没弹出来');
  eq($('approval-trust').hidden, false, '扩展说这次能给永久信任，按钮却没画出来');
  eq($('approval-trust').textContent, '永久信任此命令', '按钮文字不是扩展给的那份 —— 带判定的文案不许在前端拼');
  eq($('approval-scope').hidden, false, '给了信任却不说明它覆盖什么 —— 那才是这个按钮真正的分量');
  eq($('approval-scope').textContent, '只对这一条命令生效（在 D:\\proj 里）', '边界说明被改字了');
});

check('C16 反控：不带 trust 的老载荷 ⇒ 按钮与说明行一起藏起来，且一个字都不留', () => {
  resetApproval();
  send({ type: 'approval-request', id: 'c16-2', toolName: 'bash', command: 'rm -rf ./dist' });
  eq($('approval-trust').hidden, true, '没有 trust 的载荷也把按钮画出来了');
  eq($('approval-trust').textContent, '', '藏起来了但文字还在 —— 换了显示方式就会漏出一句不属于这条审批的承诺');
  eq($('approval-scope').hidden, true, '没有 trust 的载荷也把边界说明画出来了');
  eq($('approval-scope').textContent, '', '藏起来了但说明还在');
});

check('C16 点「永久信任」⇒ 恰好一条 approval-answer，allow:true 且粒度原样回传', () => {
  resetApproval();
  send(trustPayload('c16-3', 'command'));
  $('approval-trust').click();
  eq(posted.length, 1, `点一下该只发一条消息，实际 ${posted.length} 条`);
  const m = posted[0];
  eq(m.type, 'approval-answer', '发出去的不是审批答复');
  eq(m.id, 'c16-3', '回的 id 不对 —— 扩展那边会当失效帧静默丢掉，这个按钮就成了摆设');
  eq(m.allow, true, '点了永久信任却没允许这次执行');
  eq(m.trust, 'command', '粒度丢了或串成了别的档');
  eq($('approval-bar').hidden, true, '拍板后条没收起 —— 下一次审批会先闪出上一次的命令');
});

check('C16 连点只发一条（收起发生在回话之前）', () => {
  resetApproval();
  send(trustPayload('c16-4', 'dir'));
  $('approval-trust').click();
  $('approval-trust').click();
  eq(posted.length, 1, `连点第二下又发了一条（共 ${posted.length} 条）—— 扩展侧会拿到两条答复`);
});

check('C16 dir 档走同一条路（webview 不擅自把粒度改成 command）', () => {
  resetApproval();
  send(trustPayload('c16-5', 'dir'));
  eq($('approval-trust').textContent, '永久信任此目录', 'dir 档的按钮文字不对');
  $('approval-trust').click();
  eq(posted.length, 1, '点一下该只发一条消息');
  eq(posted[0].trust, 'dir', 'dir 档被前端改成了别的粒度 —— 那就成了「我准的是目录、它记下的是命令」或反过来');
});

check('C16 Esc 仍然是拒绝：allow:false 且**不带 trust**（把拒绝反转成信任是最坏的一种）', () => {
  resetApproval();
  send(trustPayload('c16-6', 'command'));
  pressKey('Escape');
  eq(posted.length, 1, `Esc 该只发一条消息，实际 ${posted.length} 条`);
  eq(posted[0].allow, false, 'Esc 没被当成拒绝');
  ok(!('trust' in posted[0]), 'Esc 的答复里带上了 trust —— 一次拒绝会被记成永久信任');
  eq($('approval-trust').hidden, true, 'Esc 之后按钮还亮着');
});

check('C16 点「允许执行」⇒ 只允许这次，答复里不带 trust（不许静默升级）', () => {
  resetApproval();
  send(trustPayload('c16-9', 'command'));
  $('approval-allow').click();
  eq(posted.length, 1, '点一下该只发一条消息');
  eq(posted[0].allow, true, '点了允许执行却没允许');
  ok(!('trust' in posted[0]), '「允许执行」被静默升级成了永久信任 —— 那是替用户按下了另一个按钮');
});

check('C16 收起即复位：下一条不带 trust 的审批不许继承上一条的按钮文字与说明', () => {
  resetApproval();
  send(trustPayload('c16-7', 'dir'));
  send({ type: 'approval-resolved', id: 'c16-7' });
  send({ type: 'approval-request', id: 'c16-7b', toolName: 'bash', command: 'echo hi' });
  eq($('approval-trust').hidden, true, '下一条（不给信任的）审批把上一条的按钮继承下来了');
  eq($('approval-trust').textContent, '', '按钮藏起来了却还写着上一条的粒度 —— 一旦显示出来就是错的粒度');
  eq($('approval-scope').hidden, true, '边界说明也被继承了 —— 它会指着一个与这条命令无关的目录');
});

check('C16 复位后即使按下那个（已隐藏的）按钮，也不会替扩展记下上一条的粒度', () => {
  resetApproval();
  send(trustPayload('c16-8', 'dir'));
  send({ type: 'approval-resolved', id: 'c16-8' });
  posted.length = 0;
  send({ type: 'approval-request', id: 'c16-8b', toolName: 'bash', command: 'echo hi' });
  // 真实用户点不到（hidden），但 DOM 上点得动 —— 这是 check「kind 有没有被复位」唯一的手段
  $('approval-trust').click();
  eq(posted.length, 1, `该只发一条（允许这次），实际 ${posted.length} 条`);
  eq(posted[0].allow, true, '按钮的处理器不认这条审批了');
  ok(!('trust' in posted[0]), '按下了上一条遗留的按钮，却把 dir 档记到了这条根本无从信任的命令上');
});

check('C16 结构守卫：#approval-trust 在按钮行里、#approval-scope 另起一行，两者初始 hidden', () => {
  const html = readFileSync(htmlPath, 'utf8');
  const actAt = html.indexOf('class="approval-actions"');
  const actEnd = html.indexOf('</div>', actAt);
  const btnAt = html.indexOf('id="approval-trust"');
  ok(actAt > 0 && actEnd > actAt, 'chat.html 里找不到 .approval-actions 的区间');
  ok(btnAt > actAt && btnAt < actEnd, '#approval-trust 不在 .approval-actions 里 —— 窄侧栏下它会掉出按钮行');
  ok(/id="approval-trust"[^>]*\shidden(?=[\s/>])/.test(html), '#approval-trust 没写**初始 hidden** —— 老载荷下会留一个没字的空按钮');
  const scopeAt = html.indexOf('id="approval-scope"');
  ok(scopeAt > 0, 'chat.html 里没有 #approval-scope（信任的边界没有落点）');
  ok(scopeAt < actAt || scopeAt > actEnd, '#approval-scope 挤进了 .approval-actions —— 它是整段文本，塞进按钮行会把按钮挤走');
  ok(/id="approval-scope"[^>]*\shidden(?=[\s/>])/.test(html), '#approval-scope 没写初始 hidden —— 每次审批都会先闪出一块空说明');
  // 静态标签只能从源码上验（影子不解析 HTML 里的文本节点）：三个按钮读作
  // 允许执行 / 永久信任… / 拒绝 —— 「允许执行」本来就是「信任这次」，改字只会让既有断言白白重跑
  ok(
    /<button[^>]*id="approval-allow"[^>]*>[^<]*允许执行/.test(html),
    '「允许执行」的标签被改了 —— 它承载的语义是「信任这次」，不是「总是允许」'
  );
});

check('C16 CSS 守卫：.approval-scope 走 warn 那套 token（不是 warning）且没写 display', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].split(',').some((s) => s.trim() === sel)) return m[2];
    }
    return undefined;
  };
  const scope = block('.approval-scope');
  ok(scope, 'chat.css 里找不到 .approval-scope');
  ok(/--dsw-alias-state-warn-primary/.test(scope), '.approval-scope 没走 warn 那套 token —— 它和命令原文就只剩字号不一样');
  ok(
    !/state-warning-/.test(scope),
    '.approval-scope 写了 -warning- 那套 token —— dsh-live.css 里没有它，会静默退到 VS Code 兜底色（.approval-note 正是这个情况）'
  );
  ok(!/display:/.test(scope), '.approval-scope 里写了 display —— [hidden] 会失效，没信任可说时也占一块位置');
});

// ---------- C17 · 图片附件（诚实降级） ----------
//
// 真机看到的是：贴一张截图 ⇒ 待发条上是一枚写着「图片 · 1.2 MB · 图片输入未接通」的 chip
// （末标是 C20 的通路判定，两档见下），发出去之后模型收到的是一段说明（不是图，永远不是图 —— 它到不了）。
//
// 这里验影子能表达的部分：**字节怎么走（dataBase64，且绝不带 content）、chip 怎么说话、
// 三道闸（大小 / 张数 / 坏附件不许发）拦不拦得住**，以及一条反控 —— 文本附件照旧走老路。

const fakeImage = (over = {}) =>
  Object.assign(
    {
      name: 'shot.png',
      type: 'image/png',
      size: 1258291,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    },
    over
  );

/** 贴文件：走**真实的 paste 监听器**（不是直接调内部函数） */
function pasteFiles(files) {
  $('input').dispatch('paste', { clipboardData: { files } });
}

/** 按 Enter 发送：走**真实的 keydown 监听器** */
function pressEnter() {
  $('input').dispatch('keydown', { key: 'Enter', shiftKey: false });
}

let c17Ack = 0;
/**
 * 干净局面。两件事都要做，少一件后面的用例就会**因为错误的原因通过**：
 * - 逐个点掉待发 chip（✕ 是真实的移除路径）；
 * - 收一条扩展回执 —— `sending` 只有在回执里才会归位，而 `send()` 开头就是
 *   `if (inputEl.disabled || sending) return`：不归位的话下一条用例按 Enter 什么都不会发生，
 *   于是「有坏附件却发出去了」这类断言会**假绿**。
 */
function resetAttach() {
  for (let i = 0; i < 40 && $('attach-list').children.length > 0; i++) {
    const chip = $('attach-list').children[0];
    const x = chip.children.filter((c) => c.classList.contains('chip-x'))[0];
    if (!x) break;
    x.click();
  }
  send({
    type: 'user-message',
    message: { id: 'c17-ack-' + ++c17Ack, role: 'user', text: '', status: 'done' },
  });
  $('input').value = '';
  posted.length = 0;
}

check('C17 粘一张图 ⇒ 一条 user-message，带字节，**绝不带 content**', () => {
  resetAttach();
  pasteFiles([fakeImage()]);
  eq($('attach-bar').hidden, false, '贴了图但待发条没出现');
  $('input').value = '看看这张图';
  pressEnter();
  eq(posted.length, 1, `该只发一条消息，实际 ${posted.length} 条`);
  const m = posted[0];
  eq(m.type, 'user-message');
  eq(m.attachments.length, 1, '附件数不对');
  const a = m.attachments[0];
  eq(a.kind, 'image', 'kind 没传上去 —— 扩展侧只能靠 dataBase64 猜');
  eq(a.mediaType, 'image/png', 'mediaType 没传（扩展侧会重新嗅探，但 chip 要用它）');
  eq(a.bytes, 1258291, 'bytes 没传 —— chip 上的大小就没得显示');
  ok(typeof a.dataBase64 === 'string' && a.dataBase64.length > 0, '没把字节传上去，扩展侧无从落盘');
  ok(!/^data:/.test(a.dataBase64), 'base64 里带着 `data:` 前缀 —— 扩展侧解出来会多一段垃圾');
  eq(a.content, undefined, '图片附件带上了 content —— 那是把二进制当文本递给了模型');
});

check('C17/C20 chip：「图片 + 真实大小 + 通路判定」，缺省那一档是「关」', () => {
  resetAttach();
  // C20：先喂一条**不带 imageRead**的快照（缺省 = 关），让这条用例的档位是确定的，
  // 而不是"上一条用例恰好留下了什么"
  send({ type: 'snapshot', messages: [] });
  pasteFiles([fakeImage()]);
  const chip = $('attach-list').children[0];
  ok(chip.classList.contains('chip-image'), '没打上 .chip-image');
  ok(hasText(chip, 'shot.png'), '没写文件名');
  ok(hasText(chip, '图片'), '没写「图片」');
  ok(hasText(chip, '1.2 MB'), '没写真实大小');
  // C20 的末标是**两档**，这里是「关」那一档（今天真机的档位）
  ok(hasText(chip, '图片输入未接通'), `缺省档位不是「关」：${texts(chip).join('|')}`);
  ok(!hasText(chip, '模型需自行读取'), '缺省档位渲染成了「开」那一档');
  // ⚠️ 两档都**刻意不写「模型看不到」**：那是把「这份配置没开通」说成模型的属性，多模态下就是假话
  ok(!hasText(chip, '模型看不到'), '又写成「模型看不到」了 —— 多模态下这句是假话');
  eq(walk(chip).filter((e) => e.tagName === 'IMG').length, 0, '画了 <img>');
});

check('C20 chip 跟着 snapshot.imageRead 翻档（三处跟随在 webview 这一侧）', () => {
  resetAttach();
  const bubbleChip = () => {
    send({
      type: 'snapshot',
      messages: [
        {
          id: 'c20-m1',
          role: 'user',
          text: '',
          status: 'done',
          attachments: [
            { name: 'shot.png', path: 'D:\\p\\shot.png', kind: 'image', mediaType: 'image/png', bytes: 1258291 },
          ],
        },
      ],
      imageRead: true,
    });
    const nodes = msgNodes();
    const chip = walk(nodes[nodes.length - 1]).filter((e) => e.classList.contains('chip-image'))[0];
    ok(chip, '气泡里没画出图片 chip');
    return chip;
  };
  // ① 通路开着 ⇒ 末标是**取用方式**（说的是模型该用什么动作），且工具名点得出来
  const open = bubbleChip();
  ok(hasText(open, '模型需自行读取'), `imageRead:true 却还是「关」那一档：${texts(open).join('|')}`);
  ok(!hasText(open, '图片输入未接通'), 'imageRead:true 时两档的字都在');
  // ② 显式 false ⇒ 回到「关」（同一枚 chip 的两种画法必须只差那几个字）
  send({
    type: 'snapshot',
    messages: [
      {
        id: 'c20-m1',
        role: 'user',
        text: '',
        status: 'done',
        attachments: [
          { name: 'shot.png', path: 'D:\\p\\shot.png', kind: 'image', mediaType: 'image/png', bytes: 1258291 },
        ],
      },
    ],
    imageRead: false,
  });
  const off = walk(msgNodes().slice(-1)[0]).filter((e) => e.classList.contains('chip-image'))[0];
  ok(hasText(off, '图片输入未接通'), 'imageRead:false 没有回到「关」那一档');
  // ③ 缺字段（老扩展）⇒ 也是「关」：**fail-closed**，与扩展侧同一条纪律
  send({ type: 'snapshot', messages: [] });
  pasteFiles([fakeImage()]);
  ok(
    hasText($('attach-list').children[0], '图片输入未接通'),
    '快照没带 imageRead 时待发 chip 没按「关」渲染'
  );
  resetAttach(); // 后面的用例从干净局面开始（档位此刻已经是「关」，与真机今天一致）
});

check('C17 超 3.5MB ⇒ chip 上说「图片过大」，且 send() 什么都不发', () => {
  resetAttach();
  pasteFiles([fakeImage({ name: 'huge.png', size: 4 * 1024 * 1024 })]);
  const chip = $('attach-list').children[0];
  ok(hasText(chip, '图片过大'), `没说清是图片过大：${texts(chip).join('|')}`);
  $('input').value = '发';
  pressEnter();
  eq(posted.length, 0, '有坏附件却发出去了');
});

check('C17 第 5 张图 ⇒ 拒的是**张数**，不是大小', () => {
  resetAttach();
  for (let i = 0; i < 4; i++) pasteFiles([fakeImage({ name: `a${i}.png` })]);
  eq($('attach-list').children.length, 4, '前 4 张该都进来（上限是 4）');
  pasteFiles([fakeImage({ name: 'a5.png' })]);
  const last = $('attach-list').children[4];
  ok(last, '第 5 张连 chip 都没有 —— 那用户根本不知道自己贴的那张去哪了');
  ok(hasText(last, '图片最多 4 张'), `第 5 张的说法不对：${texts(last).join('|')}`);
});

check('C17 反控：文本附件照旧走 content 那一路（图片分支不许把老的带坏）', () => {
  resetAttach();
  send({ type: 'files-picked', attachments: [{ name: 'a.txt', path: 'D:\\p\\a.txt', content: 'hello' }] });
  const chip = $('attach-list').children[0];
  ok(!chip.classList.contains('chip-image'), '文本附件被打上了图片标');
  $('input').value = 'q';
  pressEnter();
  const a = posted[0].attachments[0];
  eq(a.content, 'hello', '文本内容没发出去');
  eq(a.dataBase64, undefined, '文本附件带上了 dataBase64');
  eq(a.kind, undefined, '文本附件被贴上了 kind');
});

check('C17 待发项的 truncated 要转发（今天它在这里被丢掉）', () => {
  resetAttach();
  send({
    type: 'files-picked',
    attachments: [{ name: 'big.txt', content: 'x'.repeat(10), truncated: true }],
  });
  ok(hasText($('attach-list').children[0], '已截断'), 'chip 上没提示已截断');
  $('input').value = 'q';
  pressEnter();
  eq(posted[0].attachments[0].truncated, true, 'truncated 又被丢了 —— 扩展侧只会看到一段"完好"的内容');
});

check('C17 气泡里的图片附件画成文字 chip（不是图）', () => {
  send({
    type: 'snapshot',
    messages: [
      {
        id: 'c17-m1',
        role: 'user',
        text: '',
        status: 'done',
        attachments: [
          { name: 'shot.png', path: 'D:\\p\\shot.png', kind: 'image', mediaType: 'image/png', bytes: 1258291 },
        ],
      },
    ],
  });
  const nodes = msgNodes();
  const node = nodes[nodes.length - 1];
  const chip = walk(node).filter((e) => e.classList.contains('chip-image'))[0];
  ok(chip, '气泡里没画出图片 chip');
  ok(
    hasText(chip, 'shot.png') && hasText(chip, '1.2 MB') && hasText(chip, '图片输入未接通'),
    `chip 文案不对（缺省档位应当是「关」）：${texts(chip).join('|')}`
  );
  eq(walk(node).filter((e) => e.tagName === 'IMG').length, 0, '气泡里出现了 <img> —— 读起来就是「模型看见过这张图」');
  send({ type: 'snapshot', messages: [] });
});

check('C20 结构守卫：末标只从那张表读，且档位在 renderSnapshot **之前**落定', () => {
  // ① 那句话不许在别处硬编（今天就是这么漂的：chip 的 tooltip 里写着「当前模型路由没开图片输入」，
  //    那是一个写死的状态断言，没人跟着改）
  const badge = chatJs.slice(chatJs.indexOf('function appendImageBadges'));
  const body = badge.slice(0, badge.indexOf('\n  }'));
  ok(body.includes('IMAGE_ROUTE_TAGS[imageRoute]'), 'chip 的末标不是从那张表读的');
  // 「只许出现一次」= 只许写在顶部那张镜像表里。写第二处就是今天 tooltip 那个毛病的形状。
  for (const w of ['图片输入未接通', '模型需自行读取']) {
    eq(chatJs.split(w).length - 1, 1, `media/chat.js 里「${w}」出现了 ${chatJs.split(w).length - 1} 次（末标只许写在镜像表那一处）`);
  }
  // ② 档位必须在 renderSnapshot 之前设 —— 晚一步就会用上一档把这一屏画完
  const snap = chatJs.slice(chatJs.indexOf("case 'snapshot':"));
  const at = snap.indexOf('imageRoute = data.imageRead');
  const render = snap.indexOf('renderSnapshot(data.messages)');
  ok(at > 0, 'snapshot 处理里没有落定档位');
  ok(at < render, '档位设在 renderSnapshot 之后了 —— 这一屏的 chip 会用上一档画完');
  ok(snap.includes("data.imageRead === true ? 'readable' : 'blind'"), '缺字段没有按「关」处理（fail-closed）');
});

check('C17 CSS 守卫：图片 chip 那两枚小标走的是 dsh-live.css 里真有的 token', () => {
  const css = readFileSync(join(repoRoot, 'media', 'chat.css'), 'utf8');
  const live = readFileSync(join(repoRoot, 'media', 'dsh-live', 'dsh-live.css'), 'utf8');
  for (const cls of ['.chip-tag', '.chip-dim']) {
    ok(css.includes(cls), `chat.css 里找不到 ${cls}`);
  }
  const dim = css.slice(css.indexOf('.chip-dim'));
  const scope = dim.slice(0, dim.indexOf('}'));
  ok(/--dsw-alias-label-secondary/.test(scope), '.chip-dim 没走 label-secondary');
  ok(
    live.includes('--dsw-alias-label-secondary'),
    'dsh-live.css 里没有 --dsw-alias-label-secondary —— 那它会静默退到 VS Code 兜底色'
  );
  // 同 C16 那条：chip 上是 [hidden] 管的显隐，一条 display 就能把它整条废掉
  ok(!/display:/.test(scope), '.chip-dim 里写了 display');
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
