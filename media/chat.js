// 侧边栏聊天的 webview 前端。纯浏览器 JS，无打包、无依赖。
// 原则：
//   1) 本端只是「视图」——会话/消息事实源在扩展进程，靠 snapshot 重建、delta 追加；
//   2) 所有文本一律用 textContent / createElement 渲染，绝不用 innerHTML（防 XSS）；
//   3) 渲染收口成 renderMarkdownInto(el, md) 一个函数，将来换 marked 只改这一处。
(function () {
  'use strict';

  /** 与扩展进程通信的唯一句柄（同一 iframe 内只能 acquire 一次） */
  var vscode = acquireVsCodeApi();

  var messagesEl = document.getElementById('messages');
  var emptyHint = document.getElementById('empty-hint');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('send-btn');
  var stopBtn = document.getElementById('stop-btn');
  var newChatBtn = document.getElementById('new-chat-btn');
  var historyBtn = document.getElementById('history-btn');
  var historyPanel = document.getElementById('history-panel');
  var historyList = document.getElementById('history-list');
  var historyEmpty = document.getElementById('history-empty');
  var historySearch = document.getElementById('history-search');
  var historyQuery = ''; // 搜索框当前关键字

  // Harness 连接状态点：仅 harness 模式可见（applyMode 切 hidden）
  var harnessStatusEl = document.getElementById('harness-status');

  var chatTitle = document.getElementById('chat-title');
  var chatTitleInput = document.getElementById('chat-title-input');
  var currentTitle = ''; // 活动会话标题（空 = 未命名/新对话）
  var titleEditing = false; // 是否正处于改名输入态

  var attachBar = document.getElementById('attach-bar');
  var attachList = document.getElementById('attach-list');
  var attachBtn = document.getElementById('attach-btn');
  var pending = []; // 待发送附件，始终 = pendings[currentMode] 的引用（见 applyMode）
  var pendingSeq = 0;
  var sending = false; // 已发出、在等扩展回执（防连点重复发送）

  // runBusy = DSH 整轮运行中（连接/等首事件期间没有任何流式气泡 → 用它锁输入/亮停止）
  var runBusy = false;

  // 底部配置条（模型/DSH/API 配置）：仅 harness 模式可见（harness 恒为 DSH 直播）
  var liveConfigBar = document.getElementById('live-config-bar');
  var liveModelSel = document.getElementById('live-model-sel');
  var liveModelInput = document.getElementById('live-model-input');
  var liveApiBtn = document.getElementById('live-api-btn');
  var liveDshBtn = document.getElementById('live-dsh-btn');
  var liveModels = []; // 扩展下发的可选模型
  var liveModel = ''; // 当前生效模型（扩展为真相）
  var liveModelOptionsKey = ''; // 下拉是否已按 models 构建过
  var apiConfigured = false; // API key 是否已配
  var dshConfigured = false; // DSH 运行路径（nodePath && entry）是否已配
  var customModelActive = false; // 是否正显示"自定义模型"输入框

  // 2.1 本轮 DSH 改动审阅：审阅条（composer 内）+ 面板浮层（body 直系）。react-live 下也可见。
  var reviewBar = document.getElementById('review-bar');
  var reviewSummary = document.getElementById('review-summary');
  var reviewViewBtn = document.getElementById('review-view');
  var reviewKeepAllBtn = document.getElementById('review-keep-all');
  var reviewRevertAllBtn = document.getElementById('review-revert-all');
  var reviewPanel = document.getElementById('review-panel');
  var reviewPanelSub = document.getElementById('review-panel-sub');
  var reviewList = document.getElementById('review-list');
  var reviewPanelClose = document.getElementById('review-panel-close');
  var reviewPanelKeepAll = document.getElementById('review-panel-keep-all');
  var reviewPanelRevertAll = document.getElementById('review-panel-revert-all');
  var reviewChanges = []; // 扩展 review-set 下发的审阅项（扁平 DTO）
  var reviewPanelOpen = false; // 面板当前是否展开
  var expandedRel = null; // 当前展开 diff 的文件（同刻只开一行）

  // 顶部模式：chat（内嵌聊天）/ harness（Agent）。两种模式各一套草稿与待发附件，互不串。
  var modeTabs = Array.prototype.slice.call(document.querySelectorAll('.mode-tab'));
  var currentMode = 'harness'; // mode-set 到达前的占位，扩展回执后纠正为真正模式（默认 harness）
  var modeConfirmed = false; // 是否已收到过扩展的 mode-set（收到前 equality 短路不可信）
  var drafts = { chat: '', harness: '' };
  var pendings = { chat: [], harness: [] };
  pending = pendings.chat;

  /** id -> 该条消息的 DOM 记录；text 字段是本端对当前可见文本的唯一累积处 */
  var byId = new Map();
  var atBottom = true; // 用户是否接近底部（决定要不要抢滚）

  // 历史会话：扩展下发的列表摘要 + 当前活动会话 id
  var sessions = [];
  var activeId = null;

  // ---------- 真 DSH 对话组件的懒加载桥（harness 专属；harness 恒为 DSH 直播） ----------
  // reactLive = harness 模式。条件成立才揭示 #dsh-live-host、注入 media/dsh-live 的
  // 单包产物；DOM 消息体同步停用。产物缺失时静默回退 DOM 渲染。
  var liveHost = document.getElementById('dsh-live-host');
  var reactAssetsInjected = false;
  /** React 单包已执行完（window.__dshLive 就绪）——见 ensureReactAssets 的 onload */
  var reactBundleLoaded = false;
  /** 最近一次 snapshot 的整幅消息（React 挂载晚于消息到达时用于补齐回放前缀） */
  var lastSnapshotMessages = null;
  var ORIG_PLACEHOLDER = inputEl ? inputEl.placeholder : '';

  function isReactLive() {
    return !!liveHost && !liveHost.hidden;
  }

  /** 首次 reactLive 时把 <link>/<script> 挂进文档（脚本必须带与 CSP 一致的 nonce）。 */
  function ensureReactAssets() {
    if (reactAssetsInjected) return;
    reactAssetsInjected = true;
    var js = liveHost.dataset.js;
    var css = liveHost.dataset.css;
    var nonce = liveHost.dataset.nonce;
    if (!js || !css) {
      console.warn('[dsh-live] 未找到 media/dsh-live 构建产物 → 保持既有 DOM 渲染');
      return;
    }
    // dsh-live.css 主题已由 chat.html head 的 %%DSH_THEME_LINK%% 常驻加载（先于 chat.css）；
    // 这里只注入 React 单包，不再重复加 <link>。data-css 仍作产物存在性判断。
    var s = document.createElement('script');
    s.src = js;
    if (nonce) s.setAttribute('nonce', nonce);
    s.onerror = function () {
      console.warn('[dsh-live] bundle 加载失败：' + js);
    };
    s.onload = function () {
      // 单包同步执行完 → 驱动已挂载、window.__dshLive 就绪。此刻才补发回放前缀：
      // ready 时 React 可能还没挂上（快照早到），晚到的一次必须能把历史补上。
      reactBundleLoaded = true;
      maybeBridgeReplay(lastSnapshotMessages);
    };
    document.head.appendChild(s);
  }

  /** 把最近一幅权威消息作为 dsh-replay 中继给已挂载的 React live 驱动。
   *  由快照到达或 React 单包加载完成二者较晚者触发；React 自己的 window
   *  listener 消费它（重建历史前缀），chat.js 的 onMessage 忽略同类型。 */
  function maybeBridgeReplay(messages) {
    if (!messages) return;
    if (!reactBundleLoaded) return;
    if (!isReactLive()) return;
    if (runBusy) return; // 直播运行在途：不中继半截会话（重挂 webview 时只播挂载后的帧）
    if (!window.__dshLive) return; // 驱动尚未就绪（加载失败等），放弃
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh-replay', messages: messages },
    }));
  }

  /** 模式一变就重算是否展示真组件；产物缺失时 ensureReactAssets 内已回退。 */
  function syncReactLive() {
    var want = currentMode === 'harness' && !!liveHost;
    if (want && !isReactLive()) {
      if (!liveHost.dataset.js || !liveHost.dataset.css) {
        // 产物缺失：ensureReactAssets 已提示；这里不揭示空壳
        ensureReactAssets();
        return;
      }
      // 先揭示让容器参与布局，再注入 bundle（React 挂载在有尺寸的盒子上）
      liveHost.hidden = false;
      document.body.classList.add('react-live');
      ensureReactAssets();
    } else if (!want && isReactLive()) {
      liveHost.hidden = true;
      document.body.classList.remove('react-live');
    }
    updateBusy(); // 让输入/发送/停止按钮按 react 态调整
  }

  // ---------- DSH 主题暗色属性同步 ----------
  // DSH 令牌表的暗色别名挂在 body[data-ds-dark-theme] 上（design-platform.css 的
  // body[data-ds-dark-theme]{} 块覆盖 light 别名）；light = 无该属性。VS Code 会给
  // webview 的 <body> 加 vscode-dark / vscode-light / vscode-high-contrast 类并热切换，
  // 因此用一个布尔属性把 VS Code 主题翻译成 DSH 主题（照 dsh-webview main.tsx 的
  // applyDshThemeAttribute）。产物缺失时该属性无任何效果（chat.css 走 vscode 兜底）。
  function applyDshTheme() {
    var dark =
      document.body.classList.contains('vscode-dark') ||
      document.body.classList.contains('vscode-high-contrast');
    var light = document.body.classList.contains('vscode-light');
    // VS Code 恒给 vscode-light/dark/high-contrast 三者之一，显式类优先；
    // 仅当都没有（主题类还没挂上）才退回系统偏好，避免「VS Code 亮色 + 系统暗色」误判。
    if (!dark && !light && window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches) {
      dark = true;
    }
    if (dark) document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
  }

  /** VS Code 主题热切换（body 类变化）时跟随更新 DSH 暗色属性。 */
  function watchDshTheme() {
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(applyDshTheme);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // ---------- 2.1 本轮改动审阅 UI（review-set / review-clear 驱动） ----------

  /** 按 reviewChanges 更新审阅条（0 条 → 隐藏条并收起面板）。 */
  function renderReviewBar() {
    var n = reviewChanges.length;
    reviewBar.hidden = n === 0;
    if (n === 0) {
      closeReviewPanel();
      return;
    }
    var added = 0;
    var modified = 0;
    var deleted = 0;
    for (var i = 0; i < n; i++) {
      if (reviewChanges[i].kind === 'added') added++;
      else if (reviewChanges[i].kind === 'deleted') deleted++;
      else modified++;
    }
    reviewSummary.textContent = '本轮改动 ' + n + ' 个文件（＋' + added + ' 改' + modified + ' −' + deleted + '）';
    reviewViewBtn.hidden = false;
    reviewKeepAllBtn.hidden = false;
    reviewRevertAllBtn.hidden = false;
  }

  function openReviewPanel() {
    reviewPanelOpen = true;
    reviewPanel.classList.add('open');
    renderReviewList();
  }

  function closeReviewPanel() {
    reviewPanelOpen = false;
    reviewPanel.classList.remove('open');
    expandedRel = null;
  }

  /** 重建面板列表（逐条 createElement/textContent，防 XSS）。 */
  function renderReviewList() {
    reviewList.textContent = '';
    if (reviewChanges.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'rp-empty';
      empty.textContent = '没有待处理的改动。';
      reviewList.appendChild(empty);
      reviewPanelSub.textContent = '';
      return;
    }
    var added = 0;
    var modified = 0;
    var deleted = 0;
    for (var i = 0; i < reviewChanges.length; i++) {
      if (reviewChanges[i].kind === 'added') added++;
      else if (reviewChanges[i].kind === 'deleted') deleted++;
      else modified++;
    }
    reviewPanelSub.textContent = '＋' + added + '  改' + modified + '  −' + deleted;
    // 展开的那行若已被移出（revert/keep），重置 expandedRel
    var still = false;
    if (expandedRel !== null) {
      for (var e = 0; e < reviewChanges.length; e++) {
        if (reviewChanges[e].rel === expandedRel) {
          still = true;
          break;
        }
      }
      if (!still) expandedRel = null;
    }
    for (var k = 0; k < reviewChanges.length; k++) {
      reviewList.appendChild(buildReviewRow(reviewChanges[k]));
    }
  }

  /** 单条改动的行：操作徽 + 相对路径 + 展开 diff / 保留 / 还原。按钮回调闭包捕获 rel。 */
  function buildReviewRow(ch) {
    var box = document.createElement('div');
    box.className = 'rp-file';
    var isOpen = expandedRel === ch.rel;

    var row = document.createElement('div');
    row.className = 'rp-file-row';

    var op = document.createElement('span');
    op.className = 'rp-op ' + ch.kind;
    op.textContent = ch.kind === 'added' ? 'A' : ch.kind === 'deleted' ? 'D' : 'M';
    row.appendChild(op);

    var name = document.createElement('span');
    name.className = 'rp-name';
    name.textContent = ch.rel;
    name.title = ch.rel;
    row.appendChild(name);

    var spacer = document.createElement('span');
    spacer.className = 'rp-file-spacer';
    row.appendChild(spacer);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'link-button rp-toggle';
    toggle.textContent = isOpen ? '收起' : 'Diff';
    toggle.disabled = !ch.diff && !ch.diffTruncated;
    toggle.title = ch.diff ? '展开行级 diff' : (ch.diffTruncated ? 'diff 过大未附内容' : '无可预览内容（二进制/超大）');
    (function (rel) {
      toggle.addEventListener('click', function () {
        expandedRel = expandedRel === rel ? null : rel;
        renderReviewList();
      });
    })(ch.rel);
    row.appendChild(toggle);

    var keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'link-button rp-keep';
    keep.textContent = '保留';
    keep.title = '保留该文件改动，从审阅里移除';
    (function (rel) {
      keep.addEventListener('click', function () {
        post({ type: 'review-keep', rel: rel });
      });
    })(ch.rel);
    row.appendChild(keep);

    var revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'link-button rp-revert';
    revert.textContent = '还原';
    revert.disabled = !ch.reversible;
    revert.title = ch.reversible ? '用轮前快照还原该文件' : '无轮前内容可还原（二进制/超大文件）';
    (function (rel) {
      revert.addEventListener('click', function () {
        post({ type: 'review-revert', rel: rel });
      });
    })(ch.rel);
    row.appendChild(revert);

    box.appendChild(row);

    if (isOpen && ch.diff) {
      var pre = document.createElement('pre');
      pre.className = 'rp-diff';
      for (var d = 0; d < ch.diff.length; d++) {
        var line = document.createElement('div');
        line.className = 'diff-line ' + ch.diff[d].kind;
        line.textContent = ch.diff[d].text;
        pre.appendChild(line);
      }
      box.appendChild(pre);
      if (ch.diffTruncated) {
        var note = document.createElement('div');
        note.className = 'rp-diff-note';
        note.textContent = '…diff 过长，已截断';
        box.appendChild(note);
      }
    }
    return box;
  }

  // ---------- 通用 ----------

  function post(msg) {
    vscode.postMessage(msg);
  }

  function focusInput() {
    inputEl.focus();
  }

  function isEmpty() {
    return byId.size === 0;
  }

  function hasPending() {
    return pending.length > 0;
  }

  /** 待发送附件里是否有读取失败/过大的（有则禁止发送，必须移除） */
  function hasBadAttachment() {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].readError) return true;
    }
    return false;
  }

  function toggleEmptyHint() {
    emptyHint.hidden = !isEmpty();
    if (isEmpty()) {
      // 空态文案按当前模式给（白色 pre-line，\n 换行）
      emptyHint.textContent =
        currentMode === 'harness'
          ? dshConfigured
            ? '还没有 Agent 会话。\n发一句话，看真实 DSH 工具调用与转录。'
            : 'Harness 走真实 DSH 直播，需先配置本地运行路径。\n在下方配置条点「配置 DSH」引导完成。'
          : '还没有对话。\n在下方输入，向（假）助手问点什么吧。';
    }
  }

  /** 是否"正在忙"：有一条正在流的助手消息，或一张 running 的工具卡 → 锁输入/显示停止。 */
  function hasStreaming() {
    for (var rec of byId.values()) {
      if (rec.status === 'streaming') return true;
      if (rec.role === 'tool' && rec.toolState === 'running') return true;
    }
    return false;
  }

  function updateBusy() {
    // reactLive（真 DSH 画面）只接管消息区，composer 仍是 DOM：输入/发送/停止按
    // 通用 busy 规则（runBusy/sending）锁，不再整组禁用（Phase 1 起启用实时输入）。
    inputEl.placeholder = ORIG_PLACEHOLDER;
    attachBtn.disabled = false;
    // live 在连接/等首事件期间没有任何流式气泡，但整轮仍在跑 → 额外看 runBusy
    var busy = hasStreaming() || sending || runBusy;
    inputEl.disabled = busy;
    // 只有正文或只有附件也能发；但附件里有读取失败的 → 禁止发送（要先移除）
    var blockSend = hasBadAttachment();
    // harness 未配 DSH 运行路径（node/入口）→ 禁发，引导先点底部「配置 DSH」
    var dshBlock = currentMode === 'harness' && !dshConfigured;
    sendBtn.disabled =
      busy || (!inputEl.value.trim() && !hasPending()) || blockSend || dshBlock;
    sendBtn.title = blockSend
      ? '有附件读取失败，请先移除后再发送'
      : dshBlock
        ? '先点底部「配置 DSH」配好运行路径再发送'
        : '';
    stopBtn.hidden = !(hasStreaming() || runBusy);
    refreshLiveConfigEnabled();
  }

  function scrollToBottom() {
    if (atBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // ---------- 模式切换（内嵌聊天 ⇄ harness） ----------

  /** 高亮顶部分段条里对应模式的 tab。 */
  function highlightMode(mode) {
    for (var i = 0; i < modeTabs.length; i++) {
      var on = modeTabs[i].dataset.mode === mode;
      modeTabs[i].classList.toggle('active', on);
      modeTabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  // ---------- harness 状态（DSH 直播连接状态点） ----------

  /** 把扩展下发的 backend-status 画到顶栏 harness 状态点（扩展侧是真相）。 */
  function renderHarnessStatus(data) {
    var state = data.state || 'offline';
    harnessStatusEl.className = 'harness-status ' + state;
    var detail = data.detail || '';
    if (state === 'connecting') {
      harnessStatusEl.textContent = detail || '连接中…';
      harnessStatusEl.title = '';
    } else if (state === 'online') {
      var model = data.model ? ' · ' + data.model : '';
      harnessStatusEl.textContent = '在线' + model;
      harnessStatusEl.title = detail || 'DSH 子进程已连接';
    } else if (state === 'error') {
      harnessStatusEl.textContent = detail || '连接出错';
      harnessStatusEl.title = detail || '';
    } else {
      harnessStatusEl.textContent = '未连接';
      harnessStatusEl.title = '';
    }
    // 状态一变，底部配置条跟着刷新（含未配置时的引导空态文案）
    refreshLiveConfigVisibility();
    refreshLiveConfigEnabled();
    syncReactLive(); // harness ⇄ 真 DSH 对话画面（产物齐全时）
  }

  // ---------- live 底部配置条（模型 + API Key） ----------

  /** 配置条是否可见：仅 harness 模式（harness 恒为 DSH 直播；未配置也常驻，供引导）。 */
  function refreshLiveConfigVisibility() {
    var show = currentMode === 'harness';
    if (!show && customModelActive) exitCustomModelInput(false); // 藏起来时收掉自定义输入态
    liveConfigBar.hidden = !show;
  }

  /** 运行在途（sending/runBusy）→ 模型 / API / DSH 配置一律禁改。 */
  function refreshLiveConfigEnabled() {
    var busy = sending || runBusy;
    liveModelSel.disabled = busy;
    liveModelInput.disabled = busy;
    liveApiBtn.disabled = busy;
    liveDshBtn.disabled = busy;
  }

  /** 把扩展下发的 live-config 画到配置条（模型下拉/自定义 + API 灯）。 */
  function renderLiveConfig(data) {
    if (data.models) liveModels = data.models;
    if (data.model) liveModel = data.model;
    if (typeof data.apiConfigured === 'boolean') apiConfigured = data.apiConfigured;
    liveApiBtn.classList.toggle('on', apiConfigured);
    liveApiBtn.textContent = 'API：' + (apiConfigured ? '已配置' : '未配置');
    liveApiBtn.title = apiConfigured
      ? 'DEEPSEEK_API_KEY 已配置（SecretStorage 或 ~/.dsh/.credentials.yaml），点击可改'
      : '未检测到 DEEPSEEK_API_KEY，点击配置';

    if (typeof data.dshConfigured === 'boolean') dshConfigured = data.dshConfigured;
    liveDshBtn.classList.toggle('on', dshConfigured);
    liveDshBtn.textContent = 'DSH：' + (dshConfigured ? '已配置' : '未配置');
    liveDshBtn.title = dshConfigured
      ? 'DSH 运行路径已配置，点击可重新引导（保存后重启 live 子进程）'
      : '尚未配置 node / 入口，点击打开引导向导';

    // 下拉：预设 + 当前模型（不在预设里则加在最前）+ 「自定义…」
    var list = liveModels.slice();
    if (liveModel && list.indexOf(liveModel) === -1) list.unshift(liveModel);
    var key = JSON.stringify(list);
    if (key !== liveModelOptionsKey) {
      liveModelOptionsKey = key;
      liveModelSel.textContent = '';
      for (var i = 0; i < list.length; i++) {
        var o = document.createElement('option');
        o.value = list[i];
        o.textContent = list[i];
        liveModelSel.appendChild(o);
      }
      var c = document.createElement('option');
      c.value = '__custom';
      c.textContent = '自定义…';
      liveModelSel.appendChild(c);
    }
    if (!customModelActive) liveModelSel.value = liveModel;
    refreshLiveConfigVisibility();
    refreshLiveConfigEnabled();
    toggleEmptyHint(); // dshConfigured 一变 → harness 空态引导文案跟着切
  }

  /** 选了「自定义…」→ 显示可编辑输入框，预填当前模型。 */
  function beginCustomModelInput() {
    if (customModelActive) return;
    customModelActive = true;
    liveModelInput.value = liveModel;
    liveModelInput.hidden = false;
    liveModelInput.focus();
    liveModelInput.select();
  }

  /** 收起自定义输入。commit=true → 有改动就发 set-model（扩展重启 live 子进程生效）。 */
  function exitCustomModelInput(commit) {
    if (!customModelActive) return;
    customModelActive = false;
    var v = liveModelInput.value.trim();
    liveModelInput.hidden = true;
    liveModelSel.value = liveModel; // 先回显当前生效模型，等扩展 live-config 回执确认
    if (commit && v && v !== liveModel) {
      post({ type: 'set-model', model: v });
    }
  }

  /**
   * 点顶部分段条 → 切到目标模式。
   * 本端先暂存旧模式的草稿/待发附件、收掉改名态、藏掉待发 chip，再发 set-mode。
   * 扩展回 mode-set + snapshot 后，整帧切到目标模式的会话/历史/草稿。
   */
  function requestMode(mode) {
    if (sending) return; // 发送在途先别切，避免回执落错帧
    // 已确认模式后点当前 tab 才空转；尚未收到 mode-set 时 currentMode 只是占位，
    // 若存的是 harness、用户在启动瞬间点「内嵌聊天」，不能因 currentMode===mode 就放掉。
    if (mode === currentMode && modeConfirmed) return;
    closeHistoryPanel();
    cancelTitleEdit();
    drafts[currentMode] = inputEl.value; // 暂存旧模式草稿
    pendings[currentMode] = pending; // pending 本就是它的引用，写回更保险
    attachBar.hidden = true; // 旧模式的 chip 先藏起来，等目标模式回显
    post({ type: 'set-mode', mode: mode });
  }

  /** 扩展确认已切到某模式（回复 mode-set）→ 对齐本帧到该模式的草稿/附件/高亮。 */
  function applyMode(mode) {
    currentMode = mode;
    modeConfirmed = true;
    highlightMode(mode);
    sending = false; // 视图重建/切换时复位在途发送标记
    runBusy = false; // 模式一换，live 轮的锁也复位（扩展侧有运行就已被取消）
    pending = pendings[currentMode] || (pendings[currentMode] = []);
    inputEl.value = drafts[currentMode] || '';
    // 状态点只在 harness 模式可见（chat 模式没有连接概念）
    harnessStatusEl.hidden = mode !== 'harness';
    refreshLiveConfigVisibility(); // 配置条仅 harness 常驻
    renderPending();
    syncReactLive(); // 模式一变先重算真组件显隐，updateBusy 才能据此锁按钮
    updateBusy();
    toggleEmptyHint();
  }

  // ---------- 标题编辑 ----------

  /** 顶栏标题显示逻辑：没命名时用「新对话」占位并弱化。 */
  function refreshTitleDisplay() {
    chatTitle.textContent = currentTitle || '新对话';
    chatTitle.classList.toggle('untitled', !currentTitle);
    chatTitle.title = currentTitle ? '点击编辑标题' : '点击给会话命名';
  }

  /** 点标题 → 进入改名输入态。 */
  function beginTitleEdit() {
    if (titleEditing) return;
    titleEditing = true;
    chatTitle.hidden = true;
    chatTitleInput.hidden = false;
    chatTitleInput.value = currentTitle;
    chatTitleInput.focus();
    chatTitleInput.select();
  }

  /** 回车 / 失焦 → 提交。空名字会当作「清空」，由扩展回退成第一条消息默认标题。 */
  function commitTitleEdit() {
    if (!titleEditing) return;
    titleEditing = false;
    chatTitle.hidden = false;
    chatTitleInput.hidden = true;
    var v = chatTitleInput.value.trim();
    if (v !== currentTitle) {
      currentTitle = v; // 先本地反映；扩展处理完后会用 snapshot/history-update 回写最终标题
      post({ type: 'rename-session', title: v });
    }
    refreshTitleDisplay();
  }

  /** Esc → 放弃本次改名，恢复原标题。 */
  function cancelTitleEdit() {
    if (!titleEditing) return;
    titleEditing = false;
    chatTitle.hidden = false;
    chatTitleInput.hidden = true;
    refreshTitleDisplay();
  }

  // ---------- 历史面板 ----------

  function isHistoryOpen() {
    return historyPanel.classList.contains('open');
  }

  function closeHistoryPanel() {
    historyPanel.classList.remove('open');
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return hm;
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
  }

  function renderHistory() {
    historyList.textContent = '';
    historySearch.hidden = sessions.length === 0; // 没会话时搜索框没意义

    // 按标题关键字过滤（不区分大小写）
    var q = historyQuery.trim().toLowerCase();
    var shown = sessions;
    if (q) {
      shown = [];
      for (var i = 0; i < sessions.length; i++) {
        if ((sessions[i].title || '').toLowerCase().indexOf(q) !== -1) {
          shown.push(sessions[i]);
        }
      }
    }

    // 空态分两种提示：真的没有会话 / 有会话但没搜到
    if (sessions.length === 0) {
      historyEmpty.textContent = '暂无历史会话';
      historyEmpty.hidden = false;
    } else if (shown.length === 0) {
      historyEmpty.textContent = '没有匹配「' + historyQuery.trim() + '」的会话';
      historyEmpty.hidden = false;
    } else {
      historyEmpty.hidden = true;
    }

    for (var k = 0; k < shown.length; k++) {
      buildHistoryItem(shown[k]);
    }
  }

  /**
   * 构建单条历史项。必须独立成函数：每次调用都形成独立闭包，
   * 点击/删除回调里引用的 id 就是这一条自己的（写成循环内 var 会全体共享同一个 → 点错会话）。
   */
  function buildHistoryItem(s) {
    var li = document.createElement('li');
    li.className = 'history-item' + (s.id === activeId ? ' active' : '');
    var sid = s.id; // 本次调用专属，供下面两个监听器稳定引用

    var open = document.createElement('button');
    open.className = 'history-open';
    open.title = '回到这个会话';

    var title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = s.title || '（无标题会话）';
    open.appendChild(title);

    var time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = fmtTime(s.updatedAt);
    open.appendChild(time);

    open.addEventListener('click', function () {
      post({ type: 'open-session', sessionId: sid });
      closeHistoryPanel();
    });

    var del = document.createElement('button');
    del.className = 'history-delete';
    del.title = '删除这个会话';
    del.textContent = '✕'; // ✕
    del.addEventListener('click', function () {
      post({ type: 'delete-session', sessionId: sid });
    });

    li.appendChild(open);
    li.appendChild(del);
    historyList.appendChild(li);
  }

  function toggleHistory() {
    cancelTitleEdit(); // 先收掉进行中的改名，避免跟面板操作打架
    if (isHistoryOpen()) {
      closeHistoryPanel();
      return;
    }
    post({ type: 'list-sessions' }); // 打开时向扩展要最新列表
    historySearch.value = '';
    historyQuery = ''; // 每次打开从完整列表开始
    historyPanel.classList.add('open');
    renderHistory();
    historySearch.focus();
  }

  // ---------- 流式光标 ----------

  function setStreaming(rec, on) {
    if (on) {
      rec.status = 'streaming';
      if (!rec.caret) {
        rec.caret = document.createElement('span');
        rec.caret.className = 'caret';
        rec.bubble.appendChild(rec.caret);
      }
    } else {
      rec.status = rec.status === 'streaming' ? 'done' : rec.status;
      if (rec.caret) {
        rec.caret.remove();
        rec.caret = null;
      }
    }
  }

  // ---------- 最小 Markdown 渲染（段落/标题/列表/引用/行内码/粗体/代码围栏） ----------

  function appendInline(parent, text) {
    // 把 **bold** 与 `code` 逐段拆出来渲染，其余原样当文本
    var re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      var tok = m[0];
      if (tok.charAt(0) === '**') {
        var strong = document.createElement('strong');
        strong.textContent = tok.slice(2, -2);
        parent.appendChild(strong);
      } else {
        var code = document.createElement('code');
        code.textContent = tok.slice(1, -1);
        parent.appendChild(code);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function isFence(line) {
    return /^```/.test(line.replace(/^\s+/, ''));
  }
  function isHeading(line) {
    return /^#{1,6}\s+/.test(line.replace(/^\s+/, ''));
  }
  function isQuote(line) {
    return /^>/.test(line.replace(/^\s+/, ''));
  }
  function isUlLine(line) {
    return /^[-*+]\s+/.test(line.replace(/^\s+/, ''));
  }
  function isOlLine(line) {
    return /^\d+[.)]\s+/.test(line.replace(/^\s+/, ''));
  }
  function isBlank(line) {
    return line.trim() === '';
  }

  /** 把一段 markdown 渲染进 container（会先清空 container）。全程 textContent，安全。 */
  function renderMarkdownInto(container, md) {
    container.textContent = '';
    var lines = md.split('\n');
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 代码围栏
      if (isFence(line)) {
        i++;
        var codeLines = [];
        while (i < lines.length && !isFence(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // 跳过结束围栏
        var pre = document.createElement('pre');
        var codeEl = document.createElement('code');
        codeEl.textContent = codeLines.join('\n');
        pre.appendChild(codeEl);
        container.appendChild(pre);
        continue;
      }

      if (isBlank(line)) {
        i++;
        continue;
      }

      // 标题
      if (isHeading(line)) {
        var hm = line.replace(/^\s+/, '').match(/^(#{1,6})\s+(.*)/);
        var h = document.createElement('h' + hm[1].length);
        appendInline(h, hm[2]);
        container.appendChild(h);
        i++;
        continue;
      }

      // 引用
      if (isQuote(line)) {
        var quoteLines = [];
        while (i < lines.length && isQuote(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        var bq = document.createElement('blockquote');
        var qp = document.createElement('p');
        appendInline(qp, quoteLines.join(' '));
        bq.appendChild(qp);
        container.appendChild(bq);
        continue;
      }

      // 列表（连续同类的行合成一个 ul/ol）
      if (isUlLine(line) || isOlLine(line)) {
        var ordered = isOlLine(line);
        var listEl = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          var l = lines[i];
          if ((ordered && isOlLine(l)) || (!ordered && isUlLine(l))) {
            var li = document.createElement('li');
            var clean = l
              .replace(/^\s+/, '')
              .replace(/^[-*+]\s+/, '')
              .replace(/^\d+[.)]\s+/, '');
            appendInline(li, clean);
            listEl.appendChild(li);
            i++;
          } else {
            break;
          }
        }
        container.appendChild(listEl);
        continue;
      }

      // 普通段落（一直吃到空行或新的块级语法）
      var para = [];
      while (i < lines.length) {
        var pl = lines[i];
        if (
          isBlank(pl) ||
          isFence(pl) ||
          isHeading(pl) ||
          isQuote(pl) ||
          isUlLine(pl) ||
          isOlLine(pl)
        ) {
          break;
        }
        para.push(pl);
        i++;
      }
      if (para.length) {
        var p = document.createElement('p');
        appendInline(p, para.join(' '));
        container.appendChild(p);
      }
    }
  }

  // ---------- DOM 构建 ----------

  function makeAssistantShell(id) {
    var rec = makeBubble(id, 'assistant');
    rec.content.className = 'md';
    return rec;
  }

  function makeBubble(id, role) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-' + role;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var content = document.createElement('div');
    bubble.appendChild(content);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);

    var rec = { id: id, role: role, wrap: wrap, bubble: bubble, content: content, text: '', status: 'streaming', caret: null };
    byId.set(id, rec);
    return rec;
  }

  /**
   * 构建/更新一张工具调用卡（role:'tool'）。入参与输出一律 textContent（防 XSS）。
   * running 只转圈不出输出；ok/error 时把输出文本放进 pre。
   */
  function applyToolState(rec) {
    rec.card.classList.toggle('running', rec.toolState === 'running');
    rec.card.classList.toggle('ok', rec.toolState === 'ok');
    rec.card.classList.toggle('error', rec.toolState === 'error');
    rec.stateEl.textContent =
      rec.toolState === 'running'
        ? '运行中…'
        : rec.toolState === 'ok'
          ? '✓ 成功'
          : rec.toolState === 'error'
            ? '✗ 失败'
            : rec.toolState || '';
    var showOutput = rec.toolState !== 'running' && !!rec.outputText;
    rec.outputEl.hidden = !showOutput;
    rec.outputEl.textContent = rec.outputText || '';
  }

  function addToolMessage(msg) {
    if (isReactLive()) return;
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-tool';
    var card = document.createElement('div');
    card.className = 'tool-card';

    var head = document.createElement('div');
    head.className = 'tool-head';
    var dot = document.createElement('span');
    dot.className = 'tool-dot';
    var name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = msg.toolName || 'tool';
    var spacer = document.createElement('span');
    spacer.className = 'tool-spacer';
    var stateEl = document.createElement('span');
    stateEl.className = 'tool-state';
    head.appendChild(dot);
    head.appendChild(name);
    head.appendChild(spacer);
    head.appendChild(stateEl);
    card.appendChild(head);

    if (msg.toolInput) {
      var input = document.createElement('div');
      input.className = 'tool-input';
      input.textContent = msg.toolInput;
      card.appendChild(input);
    }

    var output = document.createElement('pre');
    output.className = 'tool-output';
    card.appendChild(output);

    wrap.appendChild(card);
    messagesEl.appendChild(wrap);

    var rec = {
      id: msg.id,
      role: 'tool',
      wrap: wrap,
      card: card,
      stateEl: stateEl,
      outputEl: output,
      outputText: msg.toolOutput || '',
      toolState: msg.toolState || 'running',
      status: 'done',
      caret: null,
    };
    byId.set(msg.id, rec);
    applyToolState(rec);
    return rec;
  }

  /** 居中灰字说明行（role:'note'，如「已开启全新 DSH 会话…」）。恒 done、不流式。 */
  function addNoteMessage(msg) {
    if (isReactLive()) return;
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-note';
    wrap.textContent = msg.text; // 纯文本渲染（CSS ::before/::after 加两侧 —）
    messagesEl.appendChild(wrap);
    var rec = {
      id: msg.id,
      role: 'note',
      wrap: wrap,
      bubble: wrap,
      content: wrap,
      text: msg.text || '',
      status: 'done',
      caret: null,
    };
    byId.set(msg.id, rec);
    return rec;
  }

  function addMessage(msg) {
    if (isReactLive()) return; // 真组件画面接管，DOM 消息面整体停用
    if (msg.role === 'tool') {
      return addToolMessage(msg);
    }
    if (msg.role === 'note') {
      return addNoteMessage(msg);
    }
    var rec = makeBubble(msg.id, msg.role === 'user' ? 'user' : 'assistant');
    rec.text = msg.text;
    rec.status = msg.status;

    if (msg.role === 'user') {
      // 附件块放在正文上方（只读回放）
      if (msg.attachments && msg.attachments.length) {
        rec.bubble.insertBefore(buildAttachmentBlock(msg.attachments), rec.content);
      }
      rec.content.textContent = msg.text; // 用户原文，保留换行（CSS pre-wrap）
    } else {
      rec.content.className = 'md';
      renderMarkdownInto(rec.content, msg.text);
      if (msg.status === 'streaming') setStreaming(rec, true);
    }
  }

  /** 只清掉消息气泡，保留 #messages 里的空状态提示元素。 */
  function removeAllMessages() {
    var children = Array.prototype.slice.call(messagesEl.children);
    for (var k = 0; k < children.length; k++) {
      if (children[k].classList.contains('msg')) {
        children[k].remove();
      }
    }
  }

  function renderSnapshot(messages) {
    byId.clear();
    removeAllMessages();
    for (var i = 0; i < messages.length; i++) {
      addMessage(messages[i]);
    }
    toggleEmptyHint();
    updateBusy();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- 文件附件 ----------

  /** 附件文本上限（与扩展侧一致），超出截断。 */
  var MAX_CHIP_TEXT = 200000;
  /** 浏览器 File 直接读取时的字节上限，再大就不读了（与扩展侧一致：10KB）。 */
  var MAX_FILE_BYTES = 10 * 1024;

  function addPending(src) {
    var item = { key: 'p' + (++pendingSeq), name: src.name };
    if (src.path) item.path = src.path;
    if (src.content) item.content = src.content;
    if (src.truncated) item.truncated = true;
    if (src.readError) item.readError = src.readError;
    pending.push(item);
    renderPending();
    updateBusy();
  }

  function removePending(key) {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].key === key) {
        pending.splice(i, 1);
        break;
      }
    }
    renderPending();
    updateBusy();
  }

  // 就地清空（保持 pending === pendings[currentMode] 的引用），避免 map 里留下残留
  function clearPending() {
    pending.length = 0;
    renderPending();
    updateBusy();
  }

  function renderPending() {
    attachList.textContent = '';
    attachBar.hidden = pending.length === 0;
    for (var i = 0; i < pending.length; i++) {
      attachList.appendChild(buildPendingChip(pending[i]));
    }
  }

  /** 构建一条可移除的待发送 chip。独立成函数：移除按钮闭包捕获这一条自己的 key。 */
  function buildPendingChip(p) {
    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = p.path || p.readError || p.name;

    var name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = p.name;
    chip.appendChild(name);

    if (p.readError) {
      var err = document.createElement('span');
      err.className = 'chip-err';
      err.textContent = p.readError;
      chip.appendChild(err);
    } else if (p.truncated) {
      var tr = document.createElement('span');
      tr.className = 'chip-err';
      tr.textContent = '已截断';
      chip.appendChild(tr);
    }

    var x = document.createElement('button');
    x.className = 'chip-x';
    x.textContent = '✕';
    x.title = '移除这个附件';
    x.addEventListener('click', function () {
      removePending(p.key);
    });
    chip.appendChild(x);
    return chip;
  }

  /** 气泡内的只读附件块：显示于用户消息上方（历史/已发送均从消息内容回放）。 */
  function buildAttachmentBlock(attachments) {
    var list = document.createElement('div');
    list.className = 'attachments';
    for (var i = 0; i < attachments.length; i++) {
      var a = attachments[i];
      var chip = document.createElement('span');
      chip.className = 'chip readonly';
      chip.title = a.path || a.readError || a.name;
      var name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = a.name || '（未命名文件）';
      chip.appendChild(name);
      if (a.readError) {
        var err = document.createElement('span');
        err.className = 'chip-err';
        err.textContent = a.readError;
        chip.appendChild(err);
      } else if (a.truncated) {
        var tr = document.createElement('span');
        tr.className = 'chip-err';
        tr.textContent = '已截断';
        chip.appendChild(tr);
      }
      list.appendChild(chip);
    }
    return list;
  }

  /** 逐个读取 File 对象（拖拽/粘贴得到）并加为待发送附件。 */
  function addFilesFromList(fileList) {
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      if (file.size > MAX_FILE_BYTES) {
        addPending({ name: file.name, readError: '文件过大(>10KB)' });
        continue;
      }
      // 立即闭包捕获这一个 file，避免异步回调读到循环末态
      (function (f) {
        var r = new FileReader();
        r.onload = function () {
          var content = String(r.result);
          var truncated = content.length > MAX_CHIP_TEXT;
          if (truncated) content = content.slice(0, MAX_CHIP_TEXT);
          addPending({ name: f.name, content: content, truncated: truncated });
        };
        r.onerror = function () {
          addPending({ name: f.name, readError: '无法读取' });
        };
        r.readAsText(f);
      })(file);
    }
  }

  function dropHasFiles(e) {
    return e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0;
  }

  // ---------- 事件 ----------

  function send() {
    var text = inputEl.value.trim();
    if (inputEl.disabled || sending) return;
    if (!text && !hasPending()) return;
    if (hasBadAttachment()) return; // 双保险：有坏附件不应走到这里
    console.log('[chat.js] 发送用户消息 →', text, '| 附件', pending.length);
    var attachments = [];
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i];
      var a = { name: p.name };
      if (p.path) a.path = p.path;
      if (p.content) a.content = p.content;
      attachments.push(a);
    }
    // 不清空、不删 chip：等扩展回执。被拒（附件过大等）时内容原样保留；成功后再统一收尾
    sending = true;
    updateBusy();
    post({ type: 'user-message', text: text, attachments: attachments });
  }

  /** 按当前模式存草稿（state 可跨视图销毁保留，内含每模式的草稿文本）。 */
  function saveDraft() {
    drafts[currentMode] = inputEl.value;
    vscode.setState({ drafts: drafts, currentMode: currentMode });
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else {
      saveDraft(); // 其它键入也存草稿
    }
  }

  function bindEvents() {
    // 顶部模式切换：点 tab → 暂存本模式草稿并请扩展切模式
    for (var ti = 0; ti < modeTabs.length; ti++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          requestMode(tab.dataset.mode);
        });
      })(modeTabs[ti]);
    }

    // 底部配置条（仅 harness）：模型下拉 → 换模型（或进「自定义…」）；API 按钮 → 弹密钥录入
    liveModelSel.addEventListener('change', function () {
      if (sending || runBusy) {
        liveModelSel.value = liveModel; // 运行中禁改：弹回当前模型
        return;
      }
      if (liveModelSel.value === '__custom') {
        beginCustomModelInput();
      } else if (liveModelSel.value && liveModelSel.value !== liveModel) {
        post({ type: 'set-model', model: liveModelSel.value });
      }
    });
    liveModelInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        exitCustomModelInput(true);
        focusInput();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        exitCustomModelInput(false);
        focusInput();
      }
    });
    liveModelInput.addEventListener('blur', function () {
      exitCustomModelInput(true); // 失焦即提交（若确有改动）
    });
    liveApiBtn.addEventListener('click', function () {
      if (sending || runBusy) return;
      post({ type: 'configure-key' });
    });
    liveDshBtn.addEventListener('click', function () {
      if (sending || runBusy) return;
      post({ type: 'configure-dsh' });
    });

    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', function () {
      post({ type: 'stop' });
    });
    newChatBtn.addEventListener('click', function () {
      cancelTitleEdit();
      sending = false;
      clearPending(); // 开始新对话时丢弃未发送的附件
      closeHistoryPanel();
      post({ type: 'clear' }); // = 开始新对话
    });
    // 顶栏标题：点击进入改名
    chatTitle.addEventListener('click', function () {
      if (!isHistoryOpen()) beginTitleEdit();
    });
    chatTitleInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTitleEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelTitleEdit();
        focusInput();
      }
    });
    chatTitleInput.addEventListener('blur', commitTitleEdit); // 失焦即提交
    historyBtn.addEventListener('click', function (evt) {
      evt.stopPropagation(); // 别让下方 document 的「点外面收起」逻辑把它自己收掉
      console.log('[chat.js] 点了「历史」按钮');
      toggleHistory();
    });
    // 搜索框输入 → 按标题即时过滤（搜索框在面板内，点它不会触发「点外面收起」）
    historySearch.addEventListener('input', function () {
      historyQuery = historySearch.value;
      renderHistory();
    });
    // Esc 收起历史面板
    historySearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeHistoryPanel();
        focusInput();
      }
    });
    // 点面板以外的地方收起历史面板
    document.addEventListener('click', function (evt) {
      if (!isHistoryOpen()) return;
      if (evt.target.closest && evt.target.closest('#history-panel')) return;
      if (evt.target.closest && evt.target.closest('#history-btn')) return;
      console.log('[chat.js] 点击外部，收起历史面板');
      closeHistoryPanel();
    });
    // ＋附件 → 弹系统文件选择器（由扩展读取后回发 files-picked）
    attachBtn.addEventListener('click', function () {
      post({ type: 'pick-files' });
    });
    // 粘贴文件（Ctrl+V 复制的文件）→ 读为附件
    inputEl.addEventListener('paste', function (e) {
      if (dropHasFiles(e)) {
        e.preventDefault();
        addFilesFromList(e.clipboardData.files);
      }
    });
    // 整面板都可接收拖入的文件；同时拦截默认行为，避免把文件拖到 webview 里被浏览器打开
    document.addEventListener('dragover', function (e) {
      if (dropHasFiles(e)) e.preventDefault();
    });
    document.addEventListener('drop', function (e) {
      if (!dropHasFiles(e)) return;
      e.preventDefault();
      addFilesFromList(e.dataTransfer.files);
    });

    inputEl.addEventListener('keydown', handleKeydown);
    inputEl.addEventListener('input', saveDraft);
    inputEl.addEventListener('input', updateBusy);
    messagesEl.addEventListener('scroll', function () {
      atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    });

    // ---- 2.1 改动审阅：审阅条 / 浮层面板 ----
    reviewViewBtn.addEventListener('click', function () {
      if (reviewPanelOpen) closeReviewPanel();
      else openReviewPanel();
    });
    reviewKeepAllBtn.addEventListener('click', function () {
      post({ type: 'review-keep-all' });
    });
    reviewRevertAllBtn.addEventListener('click', function () {
      post({ type: 'review-revert-all' });
    });
    reviewPanelClose.addEventListener('click', function () {
      closeReviewPanel();
    });
    reviewPanelKeepAll.addEventListener('click', function () {
      post({ type: 'review-keep-all' });
    });
    reviewPanelRevertAll.addEventListener('click', function () {
      post({ type: 'review-revert-all' });
    });
    // Esc 收起审阅面板（在标题编辑/历史搜索输入框内时不抢 —— 它们自己管 Esc）
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !reviewPanelOpen) return;
      if (e.target === chatTitleInput || e.target === historySearch) return;
      closeReviewPanel();
    });
  }

  // ---------- 消息分发（扩展 → webview） ----------

  function onMessage(data) {
    // 降噪：只在本帧确实会处理这条消息时才打日志。react-live 下 DOM 气泡消息
    // （assistant-*/tool-*/note-message）会被就地丢弃；dsh-event / dsh-replay 由
    // React live 驱动直接消费、chat.js 从不处理——两者都不该刷屏。
    var type = data && data.type;
    var domOnly =
      type === 'assistant-start' || type === 'assistant-delta' ||
      type === 'assistant-done' || type === 'assistant-error' ||
      type === 'tool-start' || type === 'tool-result' ||
      type === 'note-message';
    var reactOnly = type === 'dsh-event' || type === 'dsh-replay';
    if (type && !reactOnly && !(isReactLive() && domOnly)) {
      console.log('[chat.js] 收到消息 →', type);
    }
    switch (data.type) {
      case 'mode-set':
        // 扩展确认当前模式 → 对齐本帧（草稿/待发附件/顶栏高亮）。随后的
        // snapshot / history-update 会把该模式的内容整帧重建。
        applyMode(data.mode);
        break;

      case 'snapshot':
        sending = false; // 视图重建/切换会话时复位在途发送标记
        activeId = data.sessionId || null;
        if (!titleEditing) {
          currentTitle = data.sessionTitle || '';
          refreshTitleDisplay();
        }
        renderSnapshot(data.messages);
        renderHistory();
        // react-live：把最新整幅消息中继给真 ChatView 作回放前缀（重建/切会话/清空/删除）。
        // 扩展不再直发 dsh-replay——快照可能早于 React 挂载，统一由此处按较晚者补发。
        lastSnapshotMessages = data.messages;
        maybeBridgeReplay(data.messages);
        break;

      case 'history-update':
        sessions = data.sessions;
        activeId = data.activeId || null;
        // 活动会话若在列表里（如发首条消息后自动命名 / 重命名后回显），用它刷新顶栏标题
        if (activeId && !titleEditing) {
          for (var hi = 0; hi < sessions.length; hi++) {
            if (sessions[hi].id === activeId) {
              currentTitle = sessions[hi].title || '';
              refreshTitleDisplay();
              break;
            }
          }
        }
        renderHistory();
        break;

      case 'files-picked':
        // 系统选择器选中的文件（扩展已读好内容）→ 逐个加入待发送列表
        for (var fi = 0; fi < data.attachments.length; fi++) {
          addPending(data.attachments[fi]);
        }
        break;

      case 'user-message-rejected':
        // 扩展拒绝（附件过大/读不出）→ 已写内容原样保留，解除在途状态
        sending = false;
        updateBusy();
        focusInput();
        break;

      case 'user-message':
        // 扩展接受并回执（这是本次发送的确认）→ 此时才清空输入与待发附件
        if (sending) {
          sending = false;
          inputEl.value = '';
          saveDraft();
          clearPending();
        }
        addMessage(data.message);
        toggleEmptyHint();
        scrollToBottom();
        break;

      case 'assistant-start':
        if (isReactLive()) break; // react 画面下不建 DOM 气泡
        makeAssistantShell(data.message.id);
        setStreaming(byId.get(data.message.id), true);
        toggleEmptyHint();
        updateBusy();
        break;

      case 'assistant-delta': {
        if (isReactLive()) break;
        var rec = byId.get(data.id);
        if (!rec) rec = makeAssistantShell(data.id); // 兜底：万一先到 delta
        setStreaming(rec, true); // 确保有闪烁光标（兜底帧/续传场景）
        rec.text += data.delta;
        renderMarkdownInto(rec.content, rec.text);
        scrollToBottom();
        break;
      }

      case 'assistant-done': {
        if (isReactLive()) break;
        var doneRec = byId.get(data.id);
        if (doneRec) setStreaming(doneRec, false);
        updateBusy();
        scrollToBottom();
        break;
      }

      case 'assistant-error': {
        if (isReactLive()) break;
        var errRec = byId.get(data.id);
        if (errRec) {
          setStreaming(errRec, false);
          errRec.status = 'error';
          var p = document.createElement('p');
          var t = document.createElement('span');
          t.textContent = '出错了：' + data.message;
          p.appendChild(t);
          errRec.content.appendChild(p);
        }
        updateBusy();
        break;
      }

      case 'tool-start':
        if (isReactLive()) break; // react 画面下不建 DOM 工具卡
        // harness：新工具卡进场（running → 之后 tool-result 更新为 ok/error）
        addToolMessage(data.message);
        toggleEmptyHint();
        updateBusy();
        scrollToBottom();
        break;

      case 'tool-result': {
        if (isReactLive()) break;
        var toolRec = byId.get(data.id);
        if (toolRec && toolRec.role === 'tool') {
          toolRec.toolState = data.toolState;
          if (data.output !== undefined) toolRec.outputText = data.output;
          applyToolState(toolRec);
        }
        updateBusy();
        scrollToBottom();
        break;
      }

      case 'backend-status':
        // harness 连接状态点的唯一真相。busy 一并用来锁输入。
        runBusy = !!data.busy;
        renderHarnessStatus(data);
        updateBusy();
        break;

      case 'run-busy':
        // live 整轮在途锁：连接/等首事件期间没有流式气泡也锁输入、亮停止
        runBusy = !!data.busy;
        if (!runBusy) sending = false; // 收尾解锁：即使全程没等来 assistant 事件也不卡输入
        updateBusy();
        break;

      case 'live-config':
        // 底部配置条：模型下拉(含自定义) + API/DSH 状态
        renderLiveConfig(data);
        break;

      case 'note-message':
        // 居中灰字说明行（如「已开启全新 DSH 会话…」）
        addNoteMessage(data.message);
        toggleEmptyHint();
        scrollToBottom();
        break;

      case 'review-set':
        // 2.1 本轮 DSH 改动 → 刷新审阅条；浮层开着则同步重建列表
        reviewChanges = data.changes || [];
        renderReviewBar();
        if (reviewPanelOpen) renderReviewList();
        break;

      case 'review-clear':
        // 新轮开始 / 审阅已清空 → 隐藏审阅条并收起浮层
        reviewChanges = [];
        renderReviewBar();
        break;
    }
  }

  // ---------- 启动 ----------

  function init() {
    // DSH 主题暗色属性：先按当前 body 类同步一次，再挂观察者跟随 VS Code 主题热切换
    applyDshTheme();
    watchDshTheme();
    console.log('[chat.js] 初始化完成');
    bindEvents();

    // 草稿按模式分开存（drafts 映射）；真正要显示哪个由扩展回执的 mode-set 决定
    var state = vscode.getState();
    if (state && typeof state === 'object') {
      if (state.drafts && typeof state.drafts === 'object') {
        drafts.chat = typeof state.drafts.chat === 'string' ? state.drafts.chat : '';
        drafts.harness = typeof state.drafts.harness === 'string' ? state.drafts.harness : '';
      } else if (typeof state.draft === 'string') {
        drafts.chat = state.draft; // 兼容旧版「单一草稿」格式
      }
    }
    refreshTitleDisplay();
    // harness 状态点占位（offline）：扩展回 backend-status 后即纠正为真实连接状态
    renderHarnessStatus({ state: 'offline', busy: false });
    refreshLiveConfigVisibility(); // 配置条：等 backend-status/live-config 回执亮起
    updateBusy();

    window.addEventListener('message', function (evt) {
      onMessage(evt.data);
    });

    // 告诉扩展：本帧已就绪，请下发 snapshot 与历史列表
    post({ type: 'ready' });
    focusInput();
  }

  init();
})();
