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
  var historyFoot = document.getElementById('history-foot');
  var purgeTrashBtn = document.getElementById('purge-trash-btn');
  var purgeExpiredBtn = document.getElementById('purge-expired-btn');
  var historyQuery = ''; // 搜索框当前关键字（C6 起是**全文检索**词，不再是标题过滤词）

  // C6 检索与回收站状态
  var historyTab = 'active'; // 'active' | 'trash'
  var searchHits = []; // 最近一次检索的命中（仅 historyTab==='active' 且 historyQuery 非空时用）
  var searchSeq = 0; // **全局单调**：绝不在开关面板/切标签时归零，否则关闭前在途的 seq=1
  // 会撞上重开后的 seq=1，过期响应被当新结果收下
  var searchTimer = null; // 输入去抖句柄

  // Harness 连接状态点：仅 harness 模式可见（applyMode 切 hidden）
  var harnessStatusEl = document.getElementById('harness-status');
  var harnessShellEl = document.getElementById('harness-shell');
  // C13：最近一次收到的 bash 读数。存着不是为了「记住旧值」（不带 shell 的载荷会清掉它），
  // 而是因为切模式时扩展**不会**重发 backend-status —— 切回 harness 得靠它把那段补回来
  var shellSeg = null;

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
  var liveModelBtn = document.getElementById('live-model-btn'); // 自定义选择器触发钮
  var liveModelLabel = document.getElementById('live-model-label');
  var liveModelMenu = document.getElementById('live-model-menu'); // 浮层菜单
  var liveModelWrap = document.getElementById('live-model-wrap');
  var liveModelInput = document.getElementById('live-model-input');
  var liveEffortBtn = document.getElementById('live-effort-btn'); // C11 推理档位触发钮（方块图标钮）
  var liveEffortMenu = document.getElementById('live-effort-menu'); // 浮层菜单
  var liveEffortWrap = document.getElementById('live-effort-wrap');
  var liveProfileBtn = document.getElementById('live-profile-btn'); // C12 项目 profile 触发钮（方块图标钮）
  var liveProfileMenu = document.getElementById('live-profile-menu'); // 浮层菜单
  var liveProfileWrap = document.getElementById('live-profile-wrap');
  var liveApiBtn = document.getElementById('live-api-btn');
  var liveDshBtn = document.getElementById('live-dsh-btn');
  var liveBalanceBtn = document.getElementById('live-balance-btn'); // C23 余额读数（只读，点一下刷新）
  var liveModels = []; // 扩展下发的可选模型
  var liveModel = ''; // 当前生效模型（扩展为真相）
  var liveModelList = []; // 菜单展示用的模型列表（预设 + 当前模型兜底）
  var liveEfforts = ['off', 'low', 'high', 'max']; // C11 可选档位（扩展下发的为准）
  var liveEffort = null; // C11 当前会话档位；**null = 跟随配置**（扩展为真相）
  var liveEffortThinkingOff = false; // C11 底本 thinking: disabled → 只有 off 合法
  var liveProfiles = []; // C12 文件里声明了哪些 profile（{name, summary}）
  var liveProfile = null; // C12 当前激活的 profile；**null = 不用 profile**（扩展为真相）
  var liveProfileModelPinned = false; // C12 当前 profile 钉住了模型 → 模型菜单置灰
  var liveProfileStale = false; // C12 文件改过但还没重新应用
  var liveProfileErrors = 0; // C12 解析文件攒下的错误条数
  var liveProfileAvailable = false; // C12 有工作区（才有 profile 文件可谈）
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

  // C1 事前审批：待确认的那条（id 非空 = 确认条亮着，整轮正阻塞等这一答）
  var approvalBar = document.getElementById('approval-bar');
  var approvalCmd = document.getElementById('approval-cmd');
  var approvalNote = document.getElementById('approval-note');
  var approvalTool = document.getElementById('approval-tool');
  var approvalAllowBtn = document.getElementById('approval-allow');
  var approvalDenyBtn = document.getElementById('approval-deny');
  // C16：「永久信任」按钮 + 它的边界说明行。**能不能出现由扩展决定** —— 载荷不带 trust
  // 就是不能（命令过长 / 路径解析不出来 / 盘根 / 家目录），那时两个都藏起来。
  var approvalTrustBtn = document.getElementById('approval-trust');
  var approvalScope = document.getElementById('approval-scope');
  var approvalId = null;
  var approvalTrustKind = null; // 亮着的这一条能提供哪种永久信任（'command' | 'dir' | null）
  var expandedRel = null; // 当前展开 diff 的审阅项 id（同刻只开一行；键用 id 不用 rel，C4 起可跨根）

  // C8「继续」条：扩展 retry-offer 驱动显隐（on = 上一轮以中断/出错收场）。
  // 判据在扩展侧（已落盘的 lastTurn），这里只管显示与点击 —— 前端不猜「该不该能继续」。
  var retryBar = document.getElementById('retry-bar');
  var retryBtn = document.getElementById('retry-btn');

  // C21 本轮读数**行**（原 C3a 用量条 + C9 运行条合并成一个节点）：C22 起这里**只剩右半** runs，
  // 最右是「运行记录 ›」；左半那串用量/上下文搬去了配置条里的 `#ctx-ring`（见下面那块）。
  // **这一行的 `hidden` 只有一个写入者**（renderStatusRow）—— 一旦拆成两个函数各写一次，
  // 迟早出顺序 bug（C10b 那一型）。
  var statusRow = document.getElementById('status-row');
  var statusRun = document.getElementById('status-run');
  var usageState = null; // UsageReadout；null = 无数据（内嵌聊天 / 刚切过来）

  // C22/C22b 上下文占用环：配置条里、模型钮与推理钮**之间**的第三个方块钮。数据源仍是 usageState，
  // 弧长 = 占用比例；悬停出原来那一整串文字（一个字没丢），**点它开一个只读浮层**把同一份读数
  // 分行列出来（C22b；键盘/读屏用户由此拿到那串说明，原生 title 聚焦是不弹的）。
  // ⚠️ **它是按钮，但不是"要你动手"那一类**：浮层只读、没有可选项，所以它**不随 busy 禁用**
  // （看读数什么时候都该能看，运行中正是最想看的时候），开跑时也不收起 —— 这两条与旁边三个
  // "改配置"的钮**刻意不同**，别顺手对齐。
  // ⚠️ 外观全从 `.tool-icon` 来（与推理/profile 钮同一份定义）—— 别在 chat.css 里给它写
  // width/height/color/background/border，那等于又长出一套外观（探针有守卫）。
  var ctxRing = document.getElementById('ctx-ring');
  var ctxRingArc = document.getElementById('ctx-ring-arc');
  var ctxRingWrap = document.getElementById('ctx-ring-wrap');
  var ctxRingMenu = document.getElementById('ctx-ring-menu');
  // 整圆周长 = 2πr（r = 6.5）。**必须与 chat.css 里 `.ctx-ring-arc` 的 stroke-dasharray 相等** ——
  // 两处只改一处，环的画法就整体错位（探针有一条守卫专门钉这对常量）。
  var CTX_RING_LEN = 40.84;

  // C9 运行检查器：入口在读数行的右端，浮层是 body 直系。扩展下发摘要 + （面板开着时的）详情。
  // 与 usage 的差别：harness 下**没跑过也显示**（右半写「本轮尚无」），因为浮层的入口不能等
  // 第一轮跑完才出现；内嵌聊天则 runsState 为 null（没有 DSH 帧，永远不会有内容）。
  var runsViewBtn = document.getElementById('runs-view');
  var runsPanel = document.getElementById('runs-panel');
  var runsPanelSub = document.getElementById('runs-panel-sub');
  var runsList = document.getElementById('runs-list');
  var runsPanelClose = document.getElementById('runs-panel-close');
  var runsPanelNote = document.getElementById('runs-panel-note');
  var runsState = null; // RunReadout（扩展算好的每轮摘要）
  var runsDetails = null; // RunRecord[]；**只在面板开着时**扩展才下发
  var runsPanelOpen = false;

  // ---------- C15 分支对照浮层 ----------
  var comparePanel = document.getElementById('compare-panel');
  var comparePanelSub = document.getElementById('compare-panel-sub');
  var compareVerdict = document.getElementById('compare-verdict');
  var compareRefresh = document.getElementById('compare-refresh');
  var comparePanelClose = document.getElementById('compare-panel-close');
  var compareBtn = document.getElementById('compare-btn');
  /** 两侧的 DOM 引用（'a' = 左 / 'b' = 右）。 */
  var compareEls = {
    a: {
      transcript: document.getElementById('compare-transcript-a'),
      meta: document.getElementById('compare-meta-a'),
      pick: document.getElementById('compare-pick-a'),
    },
    b: {
      transcript: document.getElementById('compare-transcript-b'),
      meta: document.getElementById('compare-meta-b'),
      pick: document.getElementById('compare-pick-b'),
    },
  };
  /**
   * 面板状态。⚠️ **`null` 就是「关着」** —— 不另起一个布尔（同 reviewPanelOpen 那条教训：
   * 两个标志必然漂移，而漂移的表现是「面板关着却还在吃消息」或反过来）。
   */
  var compareState = null;
  /**
   * 两侧尾段的折叠展开态。**每个落点自己的** —— 直播面那个 `foldExpanded` 是单例，
   * 共用一个的话在对照栏点「显示」会把直播面也展开（探针有反控钉着这条串台）。
   */
  var compareTailExpanded = { a: false, b: false };

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

  /**
   * C15：**渲染落点** —— 一份转写画到哪儿、记录进哪张表。
   *
   * 直播面就是模块单例（`messagesEl` + `byId`）。C15 的对照面板每次渲染现建一个**一次性**落点
   * （见 `compareSink`）：两条会话的消息 id 各带自己的 uuid，撞名不会发生，但把一个「属于别会话
   * 的 id」塞进 `byId`，就等于给迟到帧（assistant-delta / tool-result）开了一扇门。
   *
   * `reactLive: true` = 这个落点受「真组件接管时不建 DOM」的门规约束。对照面板是 `false` ——
   * 它恰恰**要**在 react-live 下照画（那是它选「全屏浮层」这个形态的唯一理由，C14 刚栽过）。
   */
  var LIVE_SINK = { container: messagesEl, registry: byId, reactLive: true };

  // 历史会话：扩展下发的列表摘要 + 当前活动会话 id
  var sessions = [];
  var trashed = []; // C6 回收站（与 sessions 一起由 history-update 下发）
  // C7 留存：{days, count}。**由扩展算好下发，这里绝不重算判据**（两份判据必然漂移，
  // 而这条漂移的代价是删错东西）。null = 扩展没给（老版本）→ 「清理过期」按钮不出现。
  var retention = null;
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
  var INPUT_MAX_LINES = 6; // 输入框自动增高上限（行），超过后在框内滚动

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

  // ---------- C1 事前审批确认条（approval-request / approval-resolved 驱动） ----------

  /** 弹确认条。命令原文只用 textContent 落进 <pre>（多行/特殊字符都安全）。 */
  function renderApproval(data) {
    approvalId = data.id;
    approvalTool.textContent = data.toolName ? '（' + data.toolName + '）' : '';
    approvalCmd.textContent = data.command || '';
    // C13：路径两读法说明。**只显示**（一个字的改写权都没有），没内容就整段不出现 ——
    // 反控也在这儿：不带 pathNote 的老载荷走同一行代码，得到的就是 hidden
    approvalNote.textContent = data.pathNote || '';
    approvalNote.hidden = !data.pathNote;
    // C16：「永久信任」这一下覆盖什么。**文案与可不可能都由扩展给**（带判定的文案不在前端拼），
    // 不带 trust 的老载荷走同一行代码 → 按钮与说明行一起藏起来
    var trust = data.trust;
    approvalTrustKind = trust && trust.kind ? trust.kind : null;
    approvalTrustBtn.textContent = trust ? trust.label || '' : '';
    approvalTrustBtn.hidden = !approvalTrustKind;
    approvalScope.textContent = trust ? trust.scope || '' : '';
    approvalScope.hidden = !approvalTrustKind;
    approvalBar.hidden = false;
    scrollToBottom();
  }

  /** 收起确认条并复位（不清 approvalId 的调用方自己负责，见 answerApproval）。 */
  function clearApproval() {
    approvalId = null;
    approvalBar.hidden = true;
    approvalCmd.textContent = '';
    approvalNote.textContent = '';
    approvalNote.hidden = true;
    approvalTool.textContent = '';
    // C16：一起复位。它与 renderApproval 里那五行的**无条件赋值**互为备份（2026-09-22 变异测试
    // 逐条确认过）：拆掉这里 ⇒ Esc 之后按钮还亮着，被抓红；只把 renderApproval 改成「有 trust 才
    // 赋值」⇒ 一条都不红（复位兜着）；两处一起拆才红（下一条审批会继承上一条的粒度）。
    // 也就是说：这一处是有判据盯着的，而那半边是无条件的兜底 —— 别只删一边就以为还安全。
    approvalTrustKind = null;
    approvalTrustBtn.textContent = '';
    approvalTrustBtn.hidden = true;
    approvalScope.textContent = '';
    approvalScope.hidden = true;
  }

  /**
   * 用户在确认条上拍板。先收起再回话：按钮立即失效，避免连点发出两条答复
   * （扩展侧对失效 id 也会静默忽略，两头都不怕重复）。
   *
   * `trust`（C16）只在点「永久信任…」时非空 —— 扩展侧会拿这次审批**重算一遍**粒度，
   * 对不上就不记（比如 dir 档要求目标路径能解析出来）。**记不记得住都不改变这次允许。**
   */
  function answerApproval(allow, trust) {
    if (!approvalId) return;
    var id = approvalId;
    clearApproval();
    var msg = { type: 'approval-answer', id: id, allow: !!allow };
    if (allow && trust) msg.trust = trust;
    post(msg);
  }

  // ---------- C8「继续」条（retry-offer 驱动） ----------

  /**
   * 显隐完全由扩展说了算：`on` = 这条会话上一轮以中断/出错收场。
   * 这里**不做任何本地推断**（不数消息、不看状态）—— 判据是扩展侧已落盘的 lastTurn，
   * 前端猜一遍只会多出一套会和它打架的规则。
   */
  function renderRetryBar(on) {
    retryBar.hidden = !on;
    // 每轮终态/快照扩展都会重发 retry-offer → 条一重现就复位（点击时置的 disabled
    // 靠这里回正，不依赖 CSS transition 之类的时序）。
    if (on) retryBtn.disabled = false;
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
    // C9/C15：与另外两个同层满屏浮层互斥（同时开着没有视觉仲裁）。
    // 函数声明会提升，这里直接调没问题；两个都自带早退，重复调用无害。
    closeRunsPanel();
    closeComparePanel();
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
    // 展开的那行若已被移出（revert/keep），重置 expandedRel。键用 id 而不是 rel ——
    // C4 之后列表可能跨多个根，不同目录下会有同名 rel（两个 note.txt）
    var still = false;
    if (expandedRel !== null) {
      for (var e = 0; e < reviewChanges.length; e++) {
        if (reviewChanges[e].id === expandedRel) {
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

  /** 单条改动的行：操作徽 + 相对路径 + 展开 diff / 保留 / 还原。按钮回调闭包捕获 id。 */
  function buildReviewRow(ch) {
    var box = document.createElement('div');
    box.className = 'rp-file';
    var isOpen = expandedRel === ch.id;

    var row = document.createElement('div');
    row.className = 'rp-file-row';

    var op = document.createElement('span');
    op.className = 'rp-op ' + ch.kind;
    op.textContent = ch.kind === 'added' ? 'A' : ch.kind === 'deleted' ? 'D' : 'M';
    row.appendChild(op);

    var name = document.createElement('span');
    name.className = 'rp-name';
    name.textContent = ch.rel;
    name.title = ch.outside ? ch.outside + '\\' + ch.rel : ch.rel;
    row.appendChild(name);

    // C4：工作区外的项另起一段显示所在目录。**不能并进 .rp-name** —— 那是
    // overflow:hidden + ellipsis，长路径被截掉的恰好是最该看见的尾巴。
    if (ch.outside) {
      var out = document.createElement('span');
      out.className = 'rp-outside';
      out.textContent = '工作区外 · ' + ch.outside;
      out.title = ch.outside;
      row.appendChild(out);
    }

    var spacer = document.createElement('span');
    spacer.className = 'rp-file-spacer';
    row.appendChild(spacer);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'link-button rp-toggle';
    toggle.textContent = isOpen ? '收起' : 'Diff';
    toggle.disabled = !ch.diff && !ch.diffTruncated;
    toggle.title = ch.diff ? '展开行级 diff' : (ch.diffTruncated ? 'diff 过大未附内容' : '无可预览内容（二进制/超大）');
    (function (id) {
      toggle.addEventListener('click', function () {
        expandedRel = expandedRel === id ? null : id;
        renderReviewList();
      });
    })(ch.id);
    row.appendChild(toggle);

    var keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'link-button rp-keep';
    keep.textContent = '保留';
    keep.title = '保留该文件改动，从审阅里移除';
    (function (id) {
      keep.addEventListener('click', function () {
        post({ type: 'review-keep', id: id });
      });
    })(ch.id);
    row.appendChild(keep);

    var revert = document.createElement('button');
    revert.type = 'button';
    revert.className = 'link-button rp-revert';
    revert.textContent = '还原';
    revert.disabled = !ch.reversible;
    revert.title = ch.reversible ? '用轮前快照还原该文件' : '无轮前内容可还原（二进制/超大文件）';
    (function (id) {
      revert.addEventListener('click', function () {
        post({ type: 'review-revert', id: id });
      });
    })(ch.id);
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

  /** 输入框的行高 + 纵向 padding/border（供自动增高换算真实像素；随字号/主题变化现算）。 */
  function inputMetrics() {
    var cs = window.getComputedStyle(inputEl);
    var fs = parseFloat(cs.fontSize) || 13;
    var lh = parseFloat(cs.lineHeight);
    if (!lh || isNaN(lh)) lh = Math.round(fs * 1.45);
    var v = 0;
    ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].forEach(function (k) {
      var n = parseFloat(cs[k]);
      if (n) v += n;
    });
    return { lh: lh, pad: v };
  }

  /** 自动增高：默认一行；内容多行则向上长到 INPUT_MAX_LINES 行；再超就在框内滚动。 */
  function autosizeInput() {
    if (!inputEl) return;
    var m = inputMetrics();
    var one = m.lh + m.pad;
    var max = m.lh * INPUT_MAX_LINES + m.pad;
    inputEl.style.height = 'auto';
    var full = inputEl.scrollHeight;
    var h = Math.max(one, Math.min(full, max));
    inputEl.style.height = h + 'px';
    inputEl.style.overflowY = full > max ? 'auto' : 'hidden';
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
    // 运行/在途标记：composer 的发送钮据此在「实心(运行) / 幽灵(空输入待命)」间切换
    document.body.classList.toggle('live-busy', busy);
    // 只有正文或只有附件也能发；但附件里有读取失败的 → 禁止发送（要先移除）
    var blockSend = hasBadAttachment();
    // harness 未配 DSH 运行路径（node/入口）→ 禁发，引导先点底部「配置 DSH」
    var dshBlock = currentMode === 'harness' && !dshConfigured;
    sendBtn.disabled =
      busy || (!inputEl.value.trim() && !hasPending()) || blockSend || dshBlock;
    // 视觉状态机（CSS #send-btn 默认灰、.can-send 变蓝）：只有真能发才挂 can-send，
    // 不依赖 disabled 的原生暗化——保证空输入时按钮是清晰的灰而非近黑。
    sendBtn.classList.toggle(
      'can-send',
      !busy && !blockSend && !dshBlock && (!!inputEl.value.trim() || hasPending())
    );
    sendBtn.title = blockSend
      ? '有附件读取失败，请先移除后再发送'
      : dshBlock
        ? '先点底部「配置 DSH」配好运行路径再发送'
        : '';
    stopBtn.hidden = !(hasStreaming() || runBusy);
    // 空输入待命标记：CSS 据此亮出卡片底行键盘提示（有字/有附件/运行中就隐）
    document.body.classList.toggle('input-empty', !inputEl.value.trim() && !hasPending());
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
    renderShellStatus(data.shell);
    // 状态一变，底部配置条跟着刷新（含未配置时的引导空态文案）
    refreshLiveConfigVisibility();
    refreshLiveConfigEnabled();
    syncReactLive(); // harness ⇄ 真 DSH 对话画面（产物齐全时）
  }

  /** C13：把顶栏那段 bash 读数藏掉（**不动 `shellSeg` 缓存** —— 切回 harness 时它要原样回来）。 */
  function hideShellSegment() {
    harnessShellEl.textContent = '';
    harnessShellEl.title = '';
    harnessShellEl.className = 'harness-shell';
    harnessShellEl.hidden = true;
  }

  /**
   * C13：顶栏那一段 bash 读数（`bash=WSL` / `bash=?` / `bash=坏`）。
   *
   * 三态由扩展侧算（`shellStatusSegment`，纯函数），这里只画，只用 textContent。可见性两道闸：
   * 1. **不带 `shell` 就整段不出现** —— 「能用且不是 WSL」「诊断还没算出来」「扩展是老版本」
   *    三种情况表现一致，都是 hidden；
   * 2. **chat 模式下也不出现**，同 `#harness-status` 那条规矩。⚠️ 这道闸必须在**这里**，
   *    光在 `applyMode` 里藏不够：扩展会在任意时刻重发 `backend-status`（连上、重连、改设置），
   *    chat 模式下一帧就能把这个读数重新点亮 —— 而那个模式里根本没有 agent 在跑 bash。
   */
  function renderShellStatus(shell) {
    shellSeg = shell && shell.label ? shell : null;
    if (!shellSeg || currentMode !== 'harness') {
      hideShellSegment();
      return;
    }
    harnessShellEl.textContent = shellSeg.label;
    harnessShellEl.title = shellSeg.title || '';
    harnessShellEl.className = 'harness-shell ' + (shellSeg.level || 'warn');
    harnessShellEl.hidden = false;
  }

  // ---------- live 底部配置条（模型 + API Key） ----------

  /** 配置条是否可见：仅 harness 模式（harness 恒为 DSH 直播；未配置也常驻，供引导）。 */
  function refreshLiveConfigVisibility() {
    var show = currentMode === 'harness';
    if (!show && customModelActive) exitCustomModelInput(false); // 藏起来时收掉自定义输入态
    if (!show) {
      closeModelMenu(); // 切走 harness 时收起模型菜单
      closeEffortMenu();
      closeProfileMenu();
      closeCtxMenu(); // C22b：整条配置条都藏了，读数浮层不能留在原地
    }
    liveConfigBar.hidden = !show;
  }

  /**
   * 运行在途（sending/runBusy）→ 模型 / 档位 / profile / API / DSH 配置一律禁改。
   * ⚠️ **C22b 那枚读数环刻意不在此列**：它是只读的，忙时正是最该看见它的时候。
   */
  function refreshLiveConfigEnabled() {
    var busy = sending || runBusy;
    liveModelBtn.disabled = busy;
    liveEffortBtn.disabled = busy;
    liveProfileBtn.disabled = busy || !liveProfileAvailable; // 没有工作区就没有项目，也就没有 profile 可谈
    if (busy) {
      closeModelMenu(); // 开始运行了就把打开的菜单收起
      closeEffortMenu();
      closeProfileMenu();
      // ⚠️ 刻意**不**收 ctxRingMenu：那三个菜单是"改配置"，跑起来就不该再改；读数浮层开着
      // 看你自己的数字正是运行中的用法（C22b）。这里少一句是有意的，别当成漏了。
    }
    liveModelInput.disabled = busy;
    liveApiBtn.disabled = busy;
    liveDshBtn.disabled = busy;
    // ⚠️ C23 那枚余额钮**刻意也不在此列**，理由与上面那枚环逐字同源：它是只读读数，
    // 跑一轮的时候正是最该看见余额的时候（它不重启子进程、不改任何配置）。
    // 少一句是有意的，别顺手补上。
  }

  /** 把扩展下发的 live-config 画到配置条（模型下拉/自定义 + API 灯）。 */
  function renderLiveConfig(data) {
    if (data.models) liveModels = data.models;
    if (data.model) liveModel = data.model;
    if (typeof data.apiConfigured === 'boolean') apiConfigured = data.apiConfigured;
    liveApiBtn.classList.toggle('on', apiConfigured);
    // 已配置 → 收敛成点+短标签（CC 的低调状态）；未配置 → 完整「配置 API」引导（配合红点/tooltip）
    liveApiBtn.textContent = apiConfigured ? 'API' : '配置 API';
    liveApiBtn.title = apiConfigured
      ? 'DEEPSEEK_API_KEY 已配置（SecretStorage 或 ~/.dsh/.credentials.yaml），点击可改'
      : '未检测到 DEEPSEEK_API_KEY，点击配置';

    if (typeof data.dshConfigured === 'boolean') dshConfigured = data.dshConfigured;
    liveDshBtn.classList.toggle('on', dshConfigured);
    liveDshBtn.textContent = dshConfigured ? 'DSH' : '配置 DSH';
    liveDshBtn.title = dshConfigured
      ? 'DSH 运行路径已配置，点击可重新引导（保存后重启 live 子进程）'
      : '尚未配置 node / 入口，点击打开引导向导';

    // 模型列表：预设 + 当前模型（不在预设里则加在最前）；全量重画菜单与触发钮文案（列表很小）
    var list = liveModels.slice();
    if (liveModel && list.indexOf(liveModel) === -1) list.unshift(liveModel);
    liveModelList = list;

    // C11 档位：会话字段（不是全局设置），扩展为真相；null/缺省 = 跟随配置
    if (data.efforts) liveEfforts = data.efforts;
    liveEffort = typeof data.effort === 'string' ? data.effort : null;
    if (typeof data.effortThinkingDisabled === 'boolean') liveEffortThinkingOff = data.effortThinkingDisabled;
    renderEffortMenu();

    // C12 profile：整个项目的一份声明。扩展为真相，null = 不用 profile。
    if (data.profiles) liveProfiles = data.profiles;
    liveProfile = typeof data.profile === 'string' ? data.profile : null;
    if (typeof data.profileModelPinned === 'boolean') liveProfileModelPinned = data.profileModelPinned;
    if (typeof data.profileStale === 'boolean') liveProfileStale = data.profileStale;
    if (typeof data.profileErrors === 'number') liveProfileErrors = data.profileErrors;
    if (typeof data.profileAvailable === 'boolean') liveProfileAvailable = data.profileAvailable;
    renderProfileMenu();
    // 钉住模型时自定义输入框也在骗人（那个值同样会被 profile 盖掉）—— 收掉它
    if (liveProfileModelPinned && customModelActive) exitCustomModelInput(false);
    // 模型菜单的画法取决于 profile 有没有钉住模型 —— 上面刚更新过，这里必须**重画一次**，
    // 否则切 profile 后模型菜单会留着上一份的置灰状态（同 C10b/`_setActive` 那个 bug 的形状）。
    renderModelMenu();

    refreshLiveConfigVisibility();
    refreshLiveConfigEnabled();
    toggleEmptyHint(); // dshConfigured 一变 → harness 空态引导文案跟着切
  }

  /**
   * C23：余额读数画到那枚钮上。
   *
   * **一个字都不在这儿拼**：`text` 里已经含「余额：」前缀、`title` 是多行明细（币种/总额/
   * 赠送/充值/取数时刻/失败原因），全部由扩展侧 `src/deepseekApi.ts` 算好 —— 同 C15 的分工线。
   * 前端再拼一遍就等于有了两套币种符号规则，早晚漂移。
   *
   * ⚠️ 整串字**平铺**写进 `textContent`，不塞子 `<span>`：影子 DOM 的 `textContent` 不含子节点
   *（真 DOM 含），塞了会让探针的逐字断言与真机不是一回事。
   */
  function renderBalance(d) {
    if (!liveBalanceBtn) return;
    var text = d && typeof d.text === 'string' && d.text ? d.text : '余额：—';
    var title = d && typeof d.title === 'string' && d.title ? d.title : '';
    liveBalanceBtn.textContent = text;
    if (title) liveBalanceBtn.title = title;
    // stale = 这个数不是此刻的（上次成功取到的）。与 C22 那枚环同一个词、同一个意思：
    // **值留着、话说明白**，而不是把已知的数擦掉。
    liveBalanceBtn.classList.toggle('stale', !!(d && d.stale));
  }

  // ---------- 自定义模型菜单（取代原生 <select>，CC/DSH 同款 DOM 浮层） ----------

  /** 重建菜单内容并刷新触发钮文案。全量重画，模型数量很小可忽略。 */
  function renderModelMenu() {
    if (!liveModelLabel || !liveModelMenu) return;
    // C12：profile 钉住模型时，这个菜单**不可用**且要说清为什么 —— 选它等于选一个不会生效的值。
    // 与 C11 档位菜单置灰同一套道理：宁可明确告知，也不做"选了没反应"的静默覆盖。
    // 钮上只剩模型名（轴名交给 title）：模型名本身就自证身份，旁边两个钮才需要图标 ——
    // 硬给它配个"芯片"图标，等于多一个要认的符号，换不来一点辨识度。**钉住时也一样显示真名**
    // （那才是当下真在用的模型），钉这件事由 .pinned 的小锁 + title 说，不改文案。
    liveModelLabel.textContent = liveModel || '未选';
    liveModelBtn.classList.toggle('pinned', liveProfileModelPinned);
    // 触发钮的 title 也必须跟着改：chat.html 里那句「切换模型…会重启 live 子进程」在钉住时是**假话**
    // —— 选了根本不生效（同 C11 档位菜单的「底本 thinking: disabled」那条）。
    liveModelBtn.title = liveProfileModelPinned
      ? '模型由当前 profile「' + liveProfile + '」固定（profile.json 里的 model 是项目声明）。想临时换模型，先把 profile 切成「不用 profile」'
      : '切换模型（需停在运行中后生效，会重启 live 子进程）';
    liveModelMenu.textContent = '';
    for (var i = 0; i < liveModelList.length; i++) {
      (function (m) {
        var row = document.createElement('div');
        row.className = 'lc-model-item';
        row.setAttribute('role', 'menuitem');
        var name = document.createElement('span');
        name.className = 'lc-mi-name';
        name.textContent = m;
        name.title = liveProfileModelPinned
          ? '模型由当前 profile 固定；想换模型，先把 profile 切成「不用 profile」'
          : m;
        if (liveProfileModelPinned) row.classList.add('lc-item-disabled');
        var check = document.createElement('span');
        check.className = 'lc-mi-check';
        check.textContent = '✓';
        check.hidden = m !== liveModel; // 当前模型右侧打勾
        row.appendChild(name);
        row.appendChild(check);
        // 置灰行**连监听器都不挂**（同 C11 档位菜单）—— 灰了还能点出消息是最坏的一种
        if (!liveProfileModelPinned) {
          row.addEventListener('click', function () {
            pickModel(m);
          });
        }
        liveModelMenu.appendChild(row);
      })(liveModelList[i]);
    }
    if (liveProfileModelPinned) {
      var pinSep = document.createElement('div');
      pinSep.className = 'lc-model-sep';
      liveModelMenu.appendChild(pinSep);
      var pinHint = document.createElement('div');
      pinHint.className = 'lc-model-item lc-model-custom';
      pinHint.textContent = '由 profile「' + liveProfile + '」固定';
      pinHint.title = 'profile 里的 model 是项目声明，优先于这里的选择器';
      liveModelMenu.appendChild(pinHint);
      return; // 钉住时不提供"自定义模型"入口 —— 它同样不会生效
    }
    var sep = document.createElement('div');
    sep.className = 'lc-model-sep';
    liveModelMenu.appendChild(sep);
    var cus = document.createElement('div');
    cus.className = 'lc-model-item lc-model-custom';
    cus.setAttribute('role', 'menuitem');
    cus.textContent = '自定义模型…';
    cus.addEventListener('click', function () {
      closeModelMenu();
      beginCustomModelInput();
    });
    liveModelMenu.appendChild(cus);
  }

  /** 点触发钮：开/关菜单。禁用态（busy）不动作。 */
  function toggleModelMenu() {
    if (liveModelBtn.disabled) return;
    if (liveModelMenu.classList.contains('open')) {
      closeModelMenu();
      return;
    }
    renderModelMenu(); // 打开前重画，勾到当前项
    liveModelMenu.classList.add('open');
    liveModelBtn.classList.add('open');
  }

  function closeModelMenu() {
    liveModelMenu.classList.remove('open');
    liveModelBtn.classList.remove('open');
  }

  /** 从菜单选一个预设模型。busy 由 disabled 兜住；点的就是当前模型 → 只收起。 */
  function pickModel(m) {
    closeModelMenu();
    if (m && m !== liveModel) post({ type: 'set-model', model: m });
    // 触发钮文案等扩展 live-config 回执刷新（所见为准）
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
    // 触发钮文案由下次 live-config 回执刷新（所见为准），这里不强设
    if (commit && v && v !== liveModel) {
      post({ type: 'set-model', model: v });
    }
  }

  // ---------- C11 推理档位菜单（与模型菜单同构，但换的是会话字段、且通常不重启） ----------

  /** 档位项文案：跟随配置那项要说清"不覆盖"，四档直接给 id（它们就是 provider 的取值）。 */
  function effortText(v) {
    if (v === null) return '跟随配置';
    if (v === 'off') return 'off · 关闭思考';
    return v;
  }

  /** 触发钮上的档位文案：钮上只有图标 + 值，所以这里给**短形**（跟随 / off / low…）。
   *  菜单里仍用 effortText()——那边有地方，也要把 off 说清是"关闭思考"。 */
  /** 该档位现在能不能选：底本 thinking: disabled 时只有 off（与「跟随」）合法 —— 其余三档
   *  会让 provider 在请求期抛 UNSUPPORTED_REASONING_EFFORT，所以置灰并说明原因。 */
  function effortBlocked(v) {
    return liveEffortThinkingOff && v !== null && v !== 'off';
  }

  /** 重建菜单内容并刷新触发钮（体例同 renderModelMenu，全量重画）。
   *  钮是**方块图标钮**（.tool-icon），里面没有位置放值 —— 轴与当前值只能走
   *  title / aria-label（看不见但读得到），以及非默认时的那个 `.on` 角点。 */
  function renderEffortMenu() {
    if (!liveEffortBtn || !liveEffortMenu) return;
    var now = liveEffort === null ? '跟随 cordis.yml' : effortText(liveEffort);
    liveEffortBtn.title = '推理档位：' + now + '。' + (liveEffortThinkingOff
      ? '底本 llm-deepseek 是 thinking: disabled，只有 off 可用'
      : '会话级（reasoningEffort），改档位下一步就生效');
    // 方块钮里只有一支 <svg aria-hidden>，没有文字 ⇒ aria-label 是它**唯一**的可访问名。
    // 值也带上：不动鼠标的人（屏读）本来就拿不到 title。
    liveEffortBtn.setAttribute('aria-label', '推理档位：' + now);
    liveEffortBtn.classList.toggle('on', liveEffort !== null); // 非「跟随」才点角上的状态点
    // 档位是会话级的，但它不重启子进程 —— 与模型的提示区别就在这里
    liveEffortMenu.textContent = '';
    var items = [null].concat(liveEfforts);
    for (var i = 0; i < items.length; i++) {
      (function (v) {
        var row = document.createElement('div');
        row.className = 'lc-model-item';
        row.setAttribute('role', 'menuitem');
        var name = document.createElement('span');
        name.className = 'lc-mi-name';
        name.textContent = effortText(v);
        name.title = effortBlocked(v) ? '底本 thinking: disabled，此档在当前配置下不可用' : effortText(v);
        if (effortBlocked(v)) row.classList.add('lc-item-disabled');
        var check = document.createElement('span');
        check.className = 'lc-mi-check';
        check.textContent = '✓';
        check.hidden = v !== liveEffort; // 当前档位右侧打勾
        row.appendChild(name);
        row.appendChild(check);
        if (!effortBlocked(v)) {
          row.addEventListener('click', function () {
            pickEffort(v);
          });
        }
        liveEffortMenu.appendChild(row);
      })(items[i]);
    }
    if (liveEffortThinkingOff) {
      var sep = document.createElement('div');
      sep.className = 'lc-model-sep';
      liveEffortMenu.appendChild(sep);
      var hint = document.createElement('div');
      hint.className = 'lc-model-item lc-model-custom';
      hint.textContent = '底本 thinking: disabled';
      hint.title = 'cordis.yml 的 llm-deepseek 设了 thinking: disabled，此时只有 off 合法';
      liveEffortMenu.appendChild(hint);
    }
  }

  /** 点触发钮：开/关菜单（两个菜单互斥，开一个就收另一个）。 */
  function toggleEffortMenu() {
    if (liveEffortBtn.disabled) return;
    if (liveEffortMenu.classList.contains('open')) {
      closeEffortMenu();
      return;
    }
    closeModelMenu();
    renderEffortMenu(); // 打开前重画，勾到当前项
    liveEffortMenu.classList.add('open');
    liveEffortBtn.classList.add('open');
  }

  function closeEffortMenu() {
    liveEffortMenu.classList.remove('open');
    liveEffortBtn.classList.remove('open');
  }

  /** 选一个档位（null = 跟随配置）。busy 由 disabled 兜住；点的就是当前项 → 只收起。 */
  function pickEffort(v) {
    closeEffortMenu();
    if (v !== liveEffort) post({ type: 'set-effort', effort: v });
    // 触发钮文案等扩展 live-config 回执刷新（所见为准）
  }

  // ---------- C12 项目 profile 菜单（同款浮层；但它**必定重启子进程**） ----------

  /** 菜单里的 profile 文案：不用 profile 时直说「不用 profile」，别让空字符串长得像加载失败。 */
  function profileText(v) {
    return v === null ? '不用 profile' : v;
  }

  /** 菜单顶部那一行"刚改过文件"的提示（只在真的改过时出现）。 */
  function appendProfileStaleRow() {
    if (!liveProfileStale) return;
    var sep = document.createElement('div');
    sep.className = 'lc-model-sep';
    liveProfileMenu.appendChild(sep);
    var row = document.createElement('div');
    row.className = 'lc-model-item lc-model-custom';
    row.textContent = 'profile.json 已改动 · 点这里重新应用';
    row.title = '磁盘上的 .hello-chat/profile.json 与当前生效的那份不一致。运行期用的是激活时的那一份，所以改文件不会自动生效。';
    // 这一行是可点的：点它 = 重新读文件并重新激活当前项（没激活过就只是重读）
    row.addEventListener('click', function () {
      pickProfile(liveProfile);
    });
    liveProfileMenu.appendChild(row);
  }

  /** 重建菜单内容并刷新触发钮文案（体例同 renderEffortMenu，全量重画）。 */
  function renderProfileMenu() {
    if (!liveProfileBtn || !liveProfileMenu) return;
    // 同推理钮：方块图标钮里放不下值，轴与当前 profile 名走 title / aria-label，
    // 非「不用」时角上点状态点。
    var now = liveProfile === null ? '不用 profile' : liveProfile;
    liveProfileBtn.title = '项目 profile：' + now + '。' + (liveProfileModelPinned
      ? '当前 profile 钉住了模型与审批策略，切换会重启 live 子进程'
      : '一键切换模型 / 审批策略 / 工具白名单，切换会重启 live 子进程');
    liveProfileBtn.setAttribute('aria-label', '项目 profile：' + now);
    liveProfileBtn.classList.toggle('on', liveProfile !== null);
    liveProfileMenu.textContent = '';
    if (!liveProfileAvailable) {
      var noWs = document.createElement('div');
      noWs.className = 'lc-model-item lc-model-custom';
      noWs.textContent = '没有打开工作区，无法读取 profile';
      noWs.title = 'profile 文件放在工作区根的 .hello-chat/profile.json；没有工作区时这个功能整体不适用。';
      liveProfileMenu.appendChild(noWs);
      return;
    }
    // 首项固定是「不用 profile」（同档位菜单的 [null, ...] 体例）—— 它是**退路**，
    // 永远排第一，任何 profile 出问题时用户都知道往哪退。
    var items = [null].concat(liveProfiles.map(function (p) { return p.name; }));
    var summaryOf = {};
    for (var k = 0; k < liveProfiles.length; k++) summaryOf[liveProfiles[k].name] = liveProfiles[k].summary;
    for (var i = 0; i < items.length; i++) {
      (function (v) {
        var row = document.createElement('div');
        row.className = 'lc-model-item';
        row.setAttribute('role', 'menuitem');
        var name = document.createElement('span');
        name.className = 'lc-mi-name';
        name.textContent = profileText(v);
        var hint = v === null ? '完全跟随你的设置（不读 profile 文件）' : (summaryOf[v] || '（未做任何覆盖）');
        name.title = hint;
        var check = document.createElement('span');
        check.className = 'lc-mi-check';
        check.textContent = '✓';
        check.hidden = v !== liveProfile; // 当前项右侧打勾
        row.appendChild(name);
        row.appendChild(check);
        // 摘要行单独一行显示 —— 让人**不点开就知道**这个 profile 要干什么
        if (hint) {
          row.classList.add('has-sub');
          var sub = document.createElement('span');
          sub.className = 'lc-mi-sub';
          sub.textContent = hint;
          row.appendChild(sub);
        }
        row.addEventListener('click', function () {
          pickProfile(v);
        });
        liveProfileMenu.appendChild(row);
      })(items[i]);
    }
    appendProfileStaleRow();
    if (liveProfileErrors > 0) {
      var sep2 = document.createElement('div');
      sep2.className = 'lc-model-sep';
      liveProfileMenu.appendChild(sep2);
      var errRow = document.createElement('div');
      errRow.className = 'lc-model-item lc-model-custom';
      errRow.textContent = 'profile.json 有 ' + liveProfileErrors + ' 处问题（已忽略，详见通知）';
      errRow.title = '文件里认不出来的部分已被逐条忽略，并弹过一次通知说明。好的部分照常生效。';
      liveProfileMenu.appendChild(errRow);
    }
  }

  function toggleProfileMenu() {
    if (liveProfileBtn.disabled) return;
    if (liveProfileMenu.classList.contains('open')) {
      closeProfileMenu();
      return;
    }
    closeModelMenu();
    closeEffortMenu();
    renderProfileMenu(); // 打开前重画，勾到当前项
    liveProfileMenu.classList.add('open');
    liveProfileBtn.classList.add('open');
  }

  function closeProfileMenu() {
    liveProfileMenu.classList.remove('open');
    liveProfileBtn.classList.remove('open');
  }

  /** 选一个 profile（null = 不用 profile）。busy 由 disabled 兜住；点的就是当前项 → 只收起。 */
  function pickProfile(v) {
    closeProfileMenu();
    // 注意这里**不比 v !== liveProfile**：`profile.json 已改动` 那一行点的就是当前项，
    // 它的语义是"重新读一遍并按现在的内容重新激活"，必须发得出去。
    post({ type: 'set-profile', profile: v });
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
    autosizeInput(); // 草稿可能是多行：按内容回弹输入框高度
    // 状态点只在 harness 模式可见（chat 模式没有连接概念）；C13 的 bash 读数同一条规矩
    // （**同语义而不是同元素**：不碰它的 textContent，那由 renderShellStatus 管）。
    // 切回 harness 时**不重发** backend-status（扩展不会因为换了个模式就重发）⇒ 靠缓存把那段补回来。
    harnessStatusEl.hidden = mode !== 'harness';
    if (mode === 'harness') renderShellStatus(shellSeg);
    else hideShellSegment(); // 只藏，不扔缓存

    refreshLiveConfigVisibility(); // 配置条仅 harness 常驻
    renderPending();
    // C21/C22 两处读数一起清（配置条上的环 + 读数行）。紧随其后的 snapshot 会带该模式的
    // usage / runs 重新点亮（顺序有保证：mode-set 后必跟 snapshot）；都没带就说明该模式无数据
    // （内嵌聊天）→ 环与行都保持隐藏。
    usageState = null;
    runsState = null;
    runsDetails = null;
    closeRunsPanel();
    renderReadouts();
    // C6：检索态属于「上一条模式的历史」，必须整片清掉。不清的话 chat 模式搜出的命中会挂在
    // harness 面板上不动（切模式后紧跟的 snapshot 会 renderHistory()，而它按 historyQuery 分叉）。
    // searchSeq **不**归零（见变量声明处）。
    historyQuery = '';
    searchHits = [];
    historyTab = 'active';
    historySearch.value = '';
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
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

  // ---------- C3a 用量读数 ----------

  /** token 数紧凑化：<1000 原样，<1e6 一位小数 K，其余一位小数 M（同 DSH 官方 formatTokens）。 */
  function fmtTokens(n) {
    if (!(n > 0)) return '0';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'K';
    return (n / 1000000).toFixed(1) + 'M';
  }

  /** part/whole 的百分比取整；whole 非正时返回 null（调用方据此整段略去）。 */
  function fmtPercent(part, whole) {
    if (!(whole > 0)) return null;
    return Math.round((part / whole) * 100);
  }

  /**
   * 画配置条上那枚**上下文占用环**（C22；原来画读数行左半的 paintUsage）。
   *
   * **文案一个字都没丢**：C21 那行字整段搬进 `title`（第一行还是那串单行文案，后面还是那几段
   * 口径说明），只是从"占一行"变成"悬停才出"。另外补一句短话给读屏（`aria-label`）。
   *
   * ⚠️ **C22b 起，`title` 与浮层是同一个数组派生的两处**：`rows`（{label, body}）+ `notes`。
   * 单行文案 = `rows` 按 ` · ` 拼起来；浮层 = 同一份 `rows` 分行 + 同一份 `notes`。
   * **不许另起一套拼装** —— 那必然漂移（今天改一个数、明天忘一处），探针有一条专抓这件事。
   *
   * ⚠️ **C22c 起这枚环没有 `hidden` 了**（C22 那条"一段都拼不出来就整个藏掉"被用户推翻）：
   * 一条用量都没有时**照样显示**，只是弧为空、读作 0 —— 新建对话正是这个样子，而"一个控件在
   * 新建对话里凭空消失、发了第一句话才冒出来"本身就是个疑点。空态由**一行读数**说清楚
   * （「本轮尚无用量」+ 一句"数从第一次请求开始记"），**不写数字 0**：`usageState` 为空既可能是
   * "刚新建"（那真的是 0），也可能是"这个会话我们拼不出读数"（那是**未知**），写成 `↑0 ↓0`
   * 会把后一种说成前一种。所以——**环读作 0，话说成"尚无"**。
   * 既然没有"回头再藏"这条路，C22b 那条"藏之前先关浮层"也就不再需要了；浮层如今唯一的
   * 收敛点是 `refreshLiveConfigVisibility`（切走 harness 时整条配置条藏起来，见那里的调用）。
   *
   * ⚠️ **没有 context 段时环仍然显示、只是不画弧**：因为「已压缩 N 次」是 C10 特意留在条上的
   * 持久提醒（压缩说明会随转写滚走，条上这段才常在），把整环藏掉会把它一起带走。
   * 代价是一个空环既可能是 0%、也可能是"不知道" —— 浮层与悬浮信息里**根本没有「上下文」那一行**，
   * 读屏听到的是「暂无数据」（`aria-label`），两处都分辨得出来。
   *
   * 文案形如：本轮 ↑11.8K ↓948 · 缓存 97% · 累计 ↑58.2K ↓4.1K · 上下文 2.8K / 1M
   * ↑ = 计费输入（未命中 + 缓存读），↓ = 输出（已含 reasoning，勿另加）。
   * 上下文用绝对值打底：1M 窗口下百分比长期是 0.x%，主显百分比等于常驻「0%」。
   */
  function paintContextRing() {
    var u = usageState || {}; // 空态（新建对话 / 拼不出读数）也走同一条路，见函数头那条 C22c
    var freshCtx = u.context;
    var freshNear = !!(freshCtx && freshCtx.state === 'near');
    // ⚠️ 两个状态类必须在**任何一条分支之前**无条件重算 —— 藏在返回路径后面的 add/remove
    // 一定会漏。漏法是这样的：读数是 near，然后来一条拼不出任何一段的样本 ⇒ `.near` 还留在
    // 身上，下一份读数亮起来就带着一个没人注意到的旧警示色（C10b 就是这么漏的，探针有专走
    // 这条路的一条）。C22c 之后早退没了，但这条规矩照旧：**先重算，再谈画什么**。
    if (freshNear) ctxRing.classList.add('near');
    else ctxRing.classList.remove('near');
    if (freshCtx && freshCtx.stale) ctxRing.classList.add('stale');
    else ctxRing.classList.remove('stale');
    // rows / notes 是这一份读数的**唯一真相**：`title` 与浮层都从它们派生（见函数头）——
    // 别再往下写第二套拼装，那必然与这两处漂移。
    var rows = [];
    var notes = [];
    var t = u.turn;
    if (t && (t.inputTokens || t.cacheReadTokens || t.outputTokens)) {
      var billedIn = t.inputTokens + t.cacheReadTokens;
      var seg = '↑' + fmtTokens(billedIn) + ' ↓' + fmtTokens(t.outputTokens);
      var hit = fmtPercent(t.cacheReadTokens, billedIn);
      if (hit !== null) seg += ' · 缓存 ' + hit + '%';
      rows.push({ label: '本轮', body: seg });
    }
    var s = u.session;
    if (s && (s.inputTokens || s.cacheReadTokens || s.outputTokens)) {
      rows.push({
        label: '累计',
        body: '↑' + fmtTokens(s.inputTokens + s.cacheReadTokens) + ' ↓' + fmtTokens(s.outputTokens),
      });
    }
    var ctx = freshCtx;
    var near = freshNear;
    // 「能不能画弧」与「有没有 context 段」是同一件事：窗口非正就不画（fmtPercent 同一条口径）。
    var drawable = !!(ctx && ctx.contextWindow > 0);
    // drawable 已经保证分母为正 ⇒ fmtPercent 必不返回 null（它只对 whole<=0 返回 null），不用兜。
    var pct = drawable ? fmtPercent(ctx.usedTokens, ctx.contextWindow) : null;
    if (drawable) {
      var seg2 = fmtTokens(ctx.usedTokens) + ' / ' + fmtTokens(ctx.contextWindow);
      if (pct >= 1) seg2 += '（' + pct + '%）';
      // C10：这两个后缀**并列**，不是 else if —— 「上次」说的是这份读数有多旧，
      // 「接近压缩阈值」说的是它的量级，两者可以同时成立（旧会话 + 已接近上限）。
      if (ctx.stale) seg2 += ' · 上次';
      if (near) seg2 += ' · ⚠ 接近压缩阈值';
      rows.push({ label: '上下文', body: seg2 });
    }
    // 这一行没有 label：文案本身就是「已压缩 3 次」，拆成「压缩 / 3 次」会改掉 `title` 的字面
    // （探针有一条逐字断言）。ctxRowText 对空 label 就是原样返回 body。
    if (u.compacted > 0) rows.push({ label: '', body: '已压缩 ' + u.compacted + ' 次' });
    // 空态（C22c）：环照常在，所以这里**不是**"藏起来"，而是**明说没有**。这一行也走 rows，
    // 于是 `title` 第一行、浮层那一行、读屏那一句仍然是同一个来源，没有第二套拼装。
    if (rows.length) {
      // title 给全量（不再有省略号截断的问题，但多行全量本来就比一行清楚）+ 口径说明。
      notes.push('↑ 计费输入（未命中 + 缓存读）· ↓ 输出（含 reasoning）· 缓存 = 缓存读占输入比');
    } else {
      rows.push({ label: '', body: '本轮尚无用量' });
      notes.push('第一次请求跑完就有数了 —— 本轮 / 累计 / 占用都从那时起记。');
    }
    // stale / near 都以"有 context 段"为前提 ⇒ 空态下必然是 false，不必再包一层。
    if (ctx && ctx.stale) {
      notes.push('「上次」= 这份占用不是本轮的实时值，而是上一次跑完时留下的样本。');
    }
    if (near) {
      // 口径必须诚实：我们的分子与 DSH 的判据不是同一个数（详见 src/protocol.ts 的 UsageReadout）。
      // 所以这里只说「接近」，**不说**「距离压缩线还有 X」。
      notes.push(
        '⚠ 上下文已接近 DSH 的压缩阈值：再往上，DSH 可能把一段旧事件折叠成摘要' +
          '（有损、不可撤销；真发生时转写里会留一条说明）。\n' +
          '注意：这里的占用率按 provider 上报的输入算，DSH 的压缩判据是它自己的估算，两者不是同一个数。'
      );
    }
    var title = [rows.map(ctxRowText).join(' · ')].concat(notes).join('\n');
    ctxRing.title = title;
    // 浮层每帧整份重建（不管开没开）—— 理由见 paintCtxReadout 的注释。
    paintCtxReadout(rows, notes);
    // 弧长 = 占用比例。两端都要夹：usedTokens 可能超过 contextWindow（分母是 DSH 的估算、
    // 分子是 provider 实测的），不夹的话 offset 变负数，弧会反着绕出去一整圈。
    // `!(ratio > 0)` 一并吃掉 NaN / 负数（字段缺失时不该往 DOM 里写一个 "NaN"）。
    var ratio = drawable ? ctx.usedTokens / ctx.contextWindow : 0;
    if (!(ratio > 0)) ratio = 0;
    if (ratio > 1) ratio = 1;
    // 两位小数够了（0.01px 的偏移没人看得见），也免得 "10.210000000000001" 那种串进 DOM。
    var offset = Math.round(CTX_RING_LEN * (1 - ratio) * 100) / 100;
    ctxRingArc.setAttribute('stroke-dashoffset', String(offset));
    // 弧长为 0（占用 0%，或压根没有 context 段）时把弧**整个收起来**：
    // `stroke-linecap: round` 在零长弧上会留下一个圆头，那在 0% 处看起来像已经用了 5%
    // —— 一个 5% 的谎比不画更糟。
    ctxRingArc.hidden = !(ratio > 0);
    // aria-label 是**短话**，不是 title 那段多行说明：读屏会把它一次念完，
    // 念十行口径说明等于把整条工具栏变成噪音。给键盘/读屏用户的**是同一份判据**，只是更短。
    var aria = drawable
      ? '上下文占用 ' +
        pct +
        '%（' + fmtTokens(ctx.usedTokens) + ' / ' + fmtTokens(ctx.contextWindow) + '）'
      : '上下文占用：暂无数据';
    if (ctx && ctx.stale) aria += '，这是上次的读数';
    if (near) aria += '，接近压缩阈值';
    ctxRing.setAttribute('aria-label', aria);
  }

  /**
   * 一行读数的单行文案。**`title` 的第一行与浮层的逐行都由这一个函数拼**（C22b）——
   * 空 label 就是原样返回 body（「已压缩 N 次」那一行没有 label）。
   */
  function ctxRowText(r) {
    return r.label ? r.label + ' ' + r.body : r.body;
  }

  /**
   * 把读数画进浮层（C22b）：`rows` 每行一条 `.lc-model-item`（左 label、右 body），
   * 再把 `notes` 逐行铺成 `.ctx-note`。
   *
   * ⚠️ **参数就是 `paintContextRing` 里那两份数组本身**，不是另拼的一份 —— 这是"一个数组派生两处"
   * 的落实点（探针拿 `title` 第一行按 ` · ` 切开、逐段与浮层行对拍，另拼一处立刻被抓）。
   *
   * ⚠️ **一条 note 里的 `\n` 要拆成多行**（「接近阈值」那条本来就是两段）：拆开之后浮层的
   * 文本行与 `title` 去掉第一行之后的那些行**逐一对应**。
   *
   * ⚠️ **每帧都整份重建，不管浮层开没开**：数字在流式过程中一直在涨，而"开着才画"会多出一条
   * 只在特定状态下才跑的路 —— 那正是 C10b 漏掉分母的形状。代价是每帧十来个 textContent，
   * 与整个转写重建比可忽略（已如实记进 backlog）。
   */
  function paintCtxReadout(rows, notes) {
    ctxRingMenu.textContent = ''; // 清空旧内容（webview 里只用 textContent / createElement，绝不 innerHTML）
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'lc-model-item ctx-row';
      if (r.label) {
        var lab = document.createElement('span');
        lab.className = 'ctx-row-label';
        lab.textContent = r.label;
        row.appendChild(lab);
      }
      var body = document.createElement('span');
      body.className = 'ctx-row-body';
      body.textContent = r.body;
      row.appendChild(body);
      ctxRingMenu.appendChild(row);
    });
    notes.forEach(function (n) {
      n.split('\n').forEach(function (ln) {
        var el = document.createElement('div');
        el.className = 'ctx-note';
        el.textContent = ln;
        ctxRingMenu.appendChild(el);
      });
    });
  }

  /**
   * 点环：开/关只读浮层（C22b）。内容由 `paintContextRing` 每帧画好，这里只翻 `.open`。
   *
   * ⚠️ **与旁边三个钮刻意不同的第一处：这里没有 `if (ctxRing.disabled) return`。**
   * 改模型 / 档位 / profile 都会重启或改配置，所以忙时禁点（`refreshLiveConfigEnabled`）；
   * **看读数什么时候都该能看**，运行中恰恰是最想看它的时候。环也就不进那份禁用名单，
   * 开跑时那条"收起所有菜单"也不收它（探针有一条守着这件事）。
   */
  function toggleCtxMenu() {
    if (ctxRingMenu.classList.contains('open')) {
      closeCtxMenu();
      return;
    }
    // 同一排浮层只留一个开着的：开它时把另外三个收掉（与它们互相之间的做法一致）
    closeModelMenu();
    closeEffortMenu();
    closeProfileMenu();
    ctxRingMenu.classList.add('open');
    ctxRing.classList.add('open');
  }

  function closeCtxMenu() {
    ctxRingMenu.classList.remove('open');
    ctxRing.classList.remove('open');
  }

  /**
   * 画读数**行**上的运行摘要（C9）：写 statusRun 的文案与 title，返回「有没有内容」。
   * 与配置条上那枚环的关键差别：**harness 下没跑过也算有内容**（写「本轮尚无」）—— 行尾那个入口是
   * 运行浮层唯一的路，藏起来等于没人找得到。空读数只说「本轮尚无」：入口自己就叫「运行记录」，
   * 这里再说一遍是重复（老版这一句是「运行记录 · 本轮尚无」，因为那时右端按钮写的是「查看」）。
   * ⚠️ 它**不碰 `hidden`** —— 行的显隐只有一个写入者（renderStatusRow）。
   */
  function paintRuns() {
    var st = runsState;
    statusRun.textContent = '';
    statusRun.title = '';
    if (!st) return false;
    var runs = st.runs || [];
    var cur = runs.length ? runs[0] : null;
    // 留着历史的轮次时，「本轮」会被读成「我屏幕上那条对话」；它其实只是**最新**那一轮
    var line = cur ? runLine(cur, runs.length > 1 ? '最新一轮' : '本轮') : '本轮尚无';
    statusRun.textContent = line;
    // title 给全量 + 口径：侧栏一窄，行尾就被 ellipsis 吃掉
    statusRun.title =
      line +
      (runs.length > 1 ? '\n最近 ' + runs.length + ' 轮' : '') +
      '\n只在内存里，重载窗口即清空 · 点「运行记录」看完整时间线';
    return true;
  }

  /**
   * 重绘读数**行**（C22 起它只有右半：运行摘要 + 右端「运行记录 ›」；上下文那半在环上）。
   *
   * **它是这一行 `hidden` 的唯一写入者** —— paintRuns 只管文案，不碰显隐：一行只有一个可见性，
   * 两个写入者迟早互相盖（C10b 那一型的形状）。
   * 判据：右半有内容就显示。**没跑过也算有内容** —— harness 下运行读数从没跑过也下发
   * （`{runs: []}` ⇒ 写「本轮尚无」），因为运行浮层的入口不能等第一轮跑完才出现；
   * 内嵌聊天 runsState 为 null（`_runsReadout` 返回 undefined）⇒ 隐藏。
   */
  function renderStatusRow() {
    statusRow.hidden = !paintRuns();
  }

  /**
   * 重绘 composer 上的**两处读数**：配置条里的上下文环 + 那一行运行读数。
   *
   * 为什么要有这个入口：`usage` 消息只驱动环、`runs` 消息只驱动行，这没错；但**快照与切模式**
   * 必须让两处按新会话的数据**一起**重放（漏一处就会带着上个会话的数字留在屏上）。
   * 把"一起重绘"收成一个名字，免得将来又多一个调用点、只写了其中一个。
   * ⚠️ 这里只是调用顺序的集合，不是第三个写入者 —— 别再往这个函数里直接写 `hidden`。
   * （C22c 起环连 `hidden` 都没有了；那一行读数仍是 `renderStatusRow` 一个人写。）
   */
  function renderReadouts() {
    paintContextRing();
    renderStatusRow();
  }

  // ---------- C9 运行检查器 ----------

  /**
   * 耗时紧凑化：<1s 给毫秒、<60s 给一位小数秒、再往上给分秒。
   * 只做排版，**不做判据** —— 耗时本身是扩展算好的（同 fmtTokens 的分工）。
   */
  function fmtDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    var s = Math.round(ms / 1000);
    return Math.floor(s / 60) + 'm ' + (s % 60 < 10 ? '0' : '') + (s % 60) + 's';
  }

  var RUN_OUTCOME_LABEL = {
    running: '运行中',
    completed: '已完成',
    aborted: '已中止',
    interrupted: '已中断',
    error: '出错',
  };
  var RUN_TOOL_LABEL = { running: '运行中', ok: '成功', error: '失败', unknown: '未知' };

  /**
   * 一轮显示用的耗时。
   *
   * 跑着的时候扩展**不给** `durationMs`（它不编一个「到现在为止」，那样前端就会拿它当判据）。
   * 这里用 `startedAt` 现算一个**纯展示**的值 —— 它随每一帧刷新，所以单次长工具调用期间数字会
   * 停住（全仓零 setInterval，不为一个装饰性秒数开这个口）。判据（终态、计数、成败）一律不碰它。
   */
  function runDuration(r) {
    if (typeof r.durationMs === 'number') return r.durationMs;
    if (r.outcome === 'running' && typeof r.startedAt === 'number') return Date.now() - r.startedAt;
    return undefined;
  }

  /**
   * 一轮的四个计数。**两种输入形状**：条上喂的是 `RunSummary`（扩展算好的计数，T 只有摘要），
   * 浮层里喂的是完整 `RunRecord`（**没有**那四个计数字段，只有 tools/errors 数组本身）。
   * 不给完整记录补这几个字段是刻意的：计数是 O(工具数) 的派生物，让它跟数组各存一份就是等着两份漂移。
   *
   * 派生口径**必须与扩展侧 `_summary()` 逐字一致**（`tools.length + toolsDropped`）——
   * 否则同一条记录在条上和浮层里会给出两个数。超过 100 次工具时派生值只是下限（被丢掉的调用没有
   * 状态可数），届时浮层另有「另有 N 次未记录」一行把差额说清。
   */
  function runCounts(r) {
    if (typeof r.toolCount === 'number') {
      return { toolCount: r.toolCount, toolErrors: r.toolErrors || 0, toolUnknown: r.toolUnknown || 0, errorCount: r.errorCount || 0 };
    }
    var tools = r.tools || [];
    var toolErrors = 0;
    var toolUnknown = 0;
    for (var i = 0; i < tools.length; i++) {
      if (tools[i].state === 'error') toolErrors++;
      else if (tools[i].state === 'unknown') toolUnknown++;
    }
    return {
      toolCount: tools.length + (r.toolsDropped || 0),
      toolErrors: toolErrors,
      toolUnknown: toolUnknown,
      errorCount: (r.errors || []).length + (r.errorsDropped || 0),
    };
  }

  /**
   * 一轮摘要的一句话。判据全在扩展侧，这里只排版。
   * 条与浮层头**共用这一句** —— 同一轮在两处说法不一致，用户不知道信哪个。
   *
   * `who` 是「这一轮」的称呼，缺省「本轮」（条上永远只有一轮，说「本轮」最自然）。
   * 浮层里多轮并排，全写「本轮」等于每行都在说自己是当前轮 —— 那里传「第 N 轮」。
   * 前缀换称呼、**后缀一个字不动**，所以同一轮在两处的读数仍然逐字可比。
   */
  function runLine(r, who) {
    if (!r) return '';
    var c = runCounts(r);
    var self = who || '本轮';
    var prefix = r.outcome === 'running' ? self + '运行中' : self + (RUN_OUTCOME_LABEL[r.outcome] || r.outcome);
    var line = prefix + ' · ' + (c.toolCount > 0 ? c.toolCount + ' 工具' : '无工具调用') + ' · ' + fmtDuration(runDuration(r));
    if (r.outcome !== 'running') {
      // 三种后缀**并列**，不再互相顶掉：一轮里可能同时有轮级错误、工具失败、结果未知，
      // 只写最重的那个会把另外两类直接吞掉（实测中断轮「1 未知 + 3 失败」条上只剩「3 失败」）。
      // 顺序固定（重 → 轻），所以同一轮在两处的这一句仍然逐字可比。
      if (c.errorCount > 0) line += ' · ' + c.errorCount + ' 错误';
      if (c.toolErrors > 0) line += ' · ' + c.toolErrors + ' 失败';
      if (c.toolUnknown > 0) line += ' · ' + c.toolUnknown + ' 结果未知';
    }
    return line;
  }

  function openRunsPanel() {
    // 与另外两个同层（z-index 40）满屏浮层互斥：同时开着没有视觉仲裁
    closeReviewPanel();
    closeComparePanel();
    runsPanelOpen = true;
    runsPanel.classList.add('open');
    post({ type: 'run-panel', open: true }); // 扩展据此把 details 一起发下来
    renderRunsPanel();
  }

  function closeRunsPanel() {
    if (!runsPanelOpen) return;
    runsPanelOpen = false;
    runsPanel.classList.remove('open');
    post({ type: 'run-panel', open: false });
  }

  // ---------- C15 分支对照浮层 ----------

  /**
   * 对照面板的一次性落点（见 LIVE_SINK 的说明）。
   *
   * ⚠️ 绝不能写进 `byId` —— 那是**直播面**的表，assistant-delta / tool-result / forecast 都按 id
   * 去那里取记录。两条会话的 id 各自带 uuid，撞名不会发生；但把一个「属于别会话的 id」塞进去，
   * 就等于给迟到帧开了一扇门。
   *
   * `reactLive: false` 正是「在 react-live 下也照画」—— 那是这个浮层选全屏形态的**唯一理由**。
   */
  function compareSink(container) {
    return { container: container, registry: new Map(), reactLive: false };
  }

  function openComparePanel() {
    // 三个同层（z-index 40）满屏浮层互斥：同时开着没有视觉仲裁
    closeReviewPanel();
    closeRunsPanel();
    compareState = { sides: {}, panes: {}, split: null, crosstalk: null, at: 0, live: false, pick: null };
    compareTailExpanded = { a: false, b: false };
    comparePanel.classList.add('open');
    renderCompare(); // 先画「载入中…」（postMessage 是异步的）
    post({ type: 'compare-open' });
  }

  function closeComparePanel() {
    if (!compareState) return;
    compareState = null;
    comparePanel.classList.remove('open');
  }

  function renderCompare() {
    if (!compareState) return;
    comparePanelSub.textContent = compareState.at
      ? '快照 ' + fmtTime(compareState.at) + (compareState.live ? ' · 取快照时那一轮仍在跑，此后的新消息不会进来' : '')
      : '';
    renderCompareVerdict();
    renderComparePane('a');
    renderComparePane('b');
  }

  /**
   * 判定区两行（分叉点 + 串话）。⚠️ **文案与警示等级都由扩展侧拼好**（判据在 branchCompare.ts），
   * 这里只排版 —— 两边各写一套判据必然漂移，而这条漂移的代价是「警示有时候不出现」。
   */
  function renderCompareVerdict() {
    compareVerdict.textContent = '';
    var items = [];
    if (compareState.split) items.push({ text: compareState.split.line, title: compareState.split.title, warn: false });
    if (compareState.crosstalk) {
      items.push({
        text: compareState.crosstalk.line,
        title: compareState.crosstalk.title,
        warn: compareState.crosstalk.level === 'warn',
      });
    }
    compareVerdict.hidden = items.length === 0;
    for (var i = 0; i < items.length; i++) {
      var el = document.createElement('div');
      el.className = 'cmp-verdict-line' + (items[i].warn ? ' warn' : '');
      el.textContent = items[i].text;
      el.title = items[i].title || '';
      compareVerdict.appendChild(el);
    }
  }

  /** 重画一栏。`pick === side` 时这一栏整体让给选择器（就地换内容，不用浮层菜单）。 */
  function renderComparePane(side) {
    var els = compareEls[side];
    var box = els.transcript;
    var keep = box.scrollTop;
    // ⚠️ 清法**不是** removeAllMessages()：那个刻意只删 .msg / .msg-fold、保留 #messages 里的
    // 空态提示节点（对照栏没有那个节点），在对照栏里它什么都删不掉。
    box.textContent = '';

    if (compareState.pick === side) {
      els.meta.textContent = '选择会话…';
      renderComparePicker(side, box);
      box.scrollTop = keep;
      return;
    }

    var pane = compareState.panes[side];
    if (!pane) {
      var empty = document.createElement('div');
      empty.className = 'rp-empty';
      // ⚠️ 三个状态必须分开说，别糊成一句：
      //   ① 还没收到任何快照（at 为 0）—— postMessage 的这几毫秒，不是「没数据」；
      //   ② 选中了一条但解不出来（已删 / 已空）；
      //   ③ 压根还没选。
      empty.textContent = !compareState.at
        ? '载入中…'
        : compareState.sides[side]
          ? '这条会话已被删除或清空 —— 点上面「选择会话」换一条'
          : '还没有可对照的会话 —— 点上面「选择会话」挑一条';
      box.appendChild(empty);
      els.meta.textContent = '';
      box.scrollTop = keep;
      return;
    }

    var meta = pane.title + ' · 此后 ' + pane.messages.length + ' 条';
    if (pane.frozen > 0) meta += ' · 冻结 ' + pane.frozen + ' 条';
    els.meta.textContent = meta;
    els.meta.title =
      (pane.dshId ? 'DSH 会话 ' + pane.dshId + '\n' : '') +
      '最后更新 ' + fmtTime(pane.updatedAt) +
      (pane.frozenNote ? '\n' + pane.frozenNote : '') +
      '\n（只读快照；要全文用「导出会话」）';

    // 共同前缀不渲染正文（两侧逐字相同）—— 只留一句说明 + 一条分叉线。
    var shared = document.createElement('div');
    shared.className = 'cmp-shared';
    shared.textContent = pane.sharedNote;
    box.appendChild(shared);
    var fork = document.createElement('div');
    fork.className = 'cmp-fork';
    fork.textContent = pane.shared > 0 ? '分叉点之后' : '双方各自的全部';
    box.appendChild(fork);

    renderTranscriptInto(pane.messages, compareTailExpanded[side], compareSink(box), function () {
      compareTailExpanded[side] = true;
      renderComparePane(side);
    });
    box.scrollTop = keep;
  }

  /**
   * 就地换掉这一栏的内容，列一列可选会话。数据源是 webview 侧那个 `sessions`
   * （由 history-update 维护）—— 扩展侧 `_sendHistory` 的 `active()` 过滤 = 在列且有内容，
   * 正好就是可对照的集合（一处实现，不另推一份）。
   */
  function renderComparePicker(side, box) {
    var selfId = compareState.sides[side];
    var otherId = compareState.sides[side === 'a' ? 'b' : 'a'];
    var list = document.createElement('div');
    list.className = 'cmp-list';
    if (!sessions.length) {
      var empty = document.createElement('div');
      empty.className = 'rp-empty';
      empty.textContent = '没有其它会话可选 —— 先「新建对话」，或从历史里挑一条。';
      box.appendChild(empty);
      return;
    }
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var row = document.createElement('div');
      row.className = 'lc-model-item cmp-item';
      var name = document.createElement('span');
      name.className = 'lc-mi-name';
      name.textContent = s.title || '（未命名）';
      row.appendChild(name);
      var tag = document.createElement('span');
      tag.className = 'cmp-item-here';
      if (s.id === selfId) tag.textContent = '本侧';
      else if (s.id === otherId) tag.textContent = '对侧';
      else tag.textContent = fmtTime(s.updatedAt);
      row.appendChild(tag);
      if (s.id === selfId || s.id === otherId) {
        // ⚠️ 置灰的行**连监听都不挂** —— 「灰了还能点出消息」是比不置灰更坏的一种
        // （C11/C12 同款，探针里有反控）。
        row.classList.add('disabled');
      } else {
        addComparePick(row, side, s.id);
      }
      list.appendChild(row);
    }
    box.appendChild(list);
  }

  function addComparePick(row, side, sessionId) {
    row.addEventListener('click', function () {
      // 只上报，不本地改动 —— 等扩展回整份 compare-set（回执）再重画，
      // 免得本地的乐观更新与扩展的解析结果各说一套。
      post({ type: 'compare-pick', side: side, sessionId: sessionId });
    });
  }

  function toggleComparePanel() {
    if (compareState) closeComparePanel();
    else openComparePanel();
  }

  /**
   * 重建浮层内容（逐条 createElement/textContent，防 XSS）。
   *
   * ⚠️ **必须存还 scrollTop**：这个面板在一轮里每收一帧就被重绘一次（run/tool 帧都算），
   * 朴素重渲染会把滚动位置每秒打回顶部好几次，用户永远读不到第 12 行。
   * `.review-list` 只在离散变化时重绘，没这个问题 —— 别照抄它这个省略。
   */
  function renderRunsPanel() {
    var keep = runsList.scrollTop;
    runsList.textContent = '';
    if (runsDetails === null) {
      // 刚点开、扩展的详情还没回来（postMessage 是异步的）。**必须与「确实没有记录」区分开** ——
      // 把这几毫秒画成「没有本会话的运行记录」，用户会当成真的没数据。
      var loading = document.createElement('div');
      loading.className = 'rp-empty';
      loading.textContent = '载入中…';
      runsList.appendChild(loading);
      runsPanelSub.textContent = '';
      runsPanelNote.textContent = '';
      runsList.scrollTop = keep;
      return;
    }
    var runs = runsDetails;
    if (!runs.length) {
      var empty = document.createElement('div');
      empty.className = 'rp-empty';
      empty.textContent = '没有本会话的运行记录。跑一轮后回来看。';
      runsList.appendChild(empty);
      runsPanelSub.textContent = '';
      runsPanelNote.textContent = '';
      runsList.scrollTop = keep;
      return;
    }
    // 序号按**列表位置**数（最新一轮在最上 = 第 runs.length 轮），不取 wire 的 turn：
    // DSH 身份丢失后新会话的 turn 会从 1 重数，用它当标题会出现两行都叫「第 1 轮」。
    for (var i = 0; i < runs.length; i++) {
      runsList.appendChild(buildRunNode(runs[i], runs.length - i));
    }
    runsPanelSub.textContent = '共 ' + runs.length + ' 轮';
    runsPanelNote.textContent = '只在内存里，重载窗口即清空 · 只保留最近 20 轮';
    runsList.scrollTop = keep;
  }

  /** 一轮 → DOM 子树。全部 createElement/textContent。`nth` 是浮层里的轮次序号（最新 = 共 N 轮）。 */
  function buildRunNode(r, nth) {
    var box = document.createElement('div');
    box.className = 'ri-run';

    var head = document.createElement('div');
    head.className = 'ri-run-head';
    var title = document.createElement('span');
    title.className = 'ri-run-title';
    title.textContent = runLine(r, nth ? '第 ' + nth + ' 轮' : undefined);
    head.appendChild(title);
    if (r.truncated) {
      var trunc = document.createElement('span');
      trunc.className = 'ri-badge';
      trunc.textContent = '已截断';
      head.appendChild(trunc);
    }
    var badge = document.createElement('span');
    badge.className = 'ri-badge ' + r.outcome;
    badge.textContent = RUN_OUTCOME_LABEL[r.outcome] || r.outcome;
    head.appendChild(badge);
    box.appendChild(head);

    // 本轮错误（扩展只写一条，见 runInspector.endRun 的单写者约定）
    for (var e = 0; e < (r.errors || []).length; e++) {
      var err = document.createElement('div');
      err.className = 'ri-err';
      err.textContent = '错误：' + r.errors[e].message;
      box.appendChild(err);
    }
    if (r.errorsDropped > 0) {
      var more = document.createElement('div');
      more.className = 'ri-note';
      more.textContent = '另有 ' + r.errorsDropped + ' 条错误未记录';
      box.appendChild(more);
    }

    // 工具按 step 分组：DSH 一步一次模型调用（可能带一次工具），步是天然的分节线。
    // **每个步骤都占一行**，工具挂在自己那一步下面。原先把「不含工具调用的步」折成一行脚注，
    // 代价是步骤号在列表里跳号（1、3、5 看着像丢了两步）—— 而纯模型步恰恰常是最慢的那一步，
    // 恰恰最该在时间线上占一格。判据（步数、耗时）一个字没变，只是不再折叠。
    var byStep = {};
    var stepMap = {};
    for (var s = 0; s < (r.steps || []).length; s++) stepMap[String(r.steps[s].step)] = r.steps[s];
    for (var t = 0; t < (r.tools || []).length; t++) {
      var tool = r.tools[t];
      var k = String(tool.step);
      if (!byStep[k]) byStep[k] = [];
      byStep[k].push(tool);
    }
    // 取并集：工具的 step 未必出现在 steps 里（步超上限被丢、step/start 帧缺失），两边的号都得露出来
    var order = [];
    for (var k1 in stepMap) order.push(Number(k1));
    for (var k2 in byStep) if (order.indexOf(Number(k2)) < 0) order.push(Number(k2));
    order.sort(function (a, b) { return a - b; });

    for (var oi = 0; oi < order.length; oi++) {
      var stepNo = order[oi];
      var st = stepMap[String(stepNo)];
      var stepRow = document.createElement('div');
      stepRow.className = 'ri-step';
      // 有步无耗时 = 那一步还没结束（轮被中断）→ fmtDuration 给「—」，不编数
      stepRow.textContent = '步骤 ' + stepNo + ' · ' + fmtDuration(st && st.durationMs);
      box.appendChild(stepRow);
      var rows = byStep[String(stepNo)] || [];
      for (var ri = 0; ri < rows.length; ri++) {
        box.appendChild(buildToolNode(rows[ri]));
      }
    }
    if (r.toolsDropped > 0) {
      var dropNote = document.createElement('div');
      dropNote.className = 'ri-note';
      dropNote.textContent = '另有 ' + r.toolsDropped + ' 次工具调用未记录（每轮上限 100 条）';
      box.appendChild(dropNote);
    }
    if (r.stepsDropped > 0) {
      var dropStep = document.createElement('div');
      dropStep.className = 'ri-note';
      dropStep.textContent = '另有 ' + r.stepsDropped + ' 个步骤未记录';
      box.appendChild(dropStep);
    }
    // 这两条是探针，措辞必须分清「运行时的账」与「我们的 bug」——
    // 原先只有 unmatched 一条、文案写「配对键失效」，把 DSH 正常补平的帧说成了我们的故障。
    if (r.repaired > 0) {
      var reps = document.createElement('div');
      reps.className = 'ri-note';
      reps.textContent = '另有 ' + r.repaired + ' 条中断补平的结果没配上调用（Harness 代写的，不是故障）';
      box.appendChild(reps);
    }
    if (r.unmatched > 0) {
      var un = document.createElement('div');
      un.className = 'ri-note';
      un.textContent = '有 ' + r.unmatched + ' 条工具结果没配上调用（配对键失效，正常应为 0）';
      box.appendChild(un);
    }
    return box;
  }

  /** 一条工具调用行。 */
  function buildToolNode(t) {
    var row = document.createElement('div');
    row.className = 'ri-tool ' + t.state;

    var idx = document.createElement('span');
    idx.className = 'ri-tool-index';
    idx.textContent = String(t.index);

    var name = document.createElement('span');
    name.className = 'ri-tool-name';
    name.textContent = t.name;

    var time = document.createElement('span');
    time.className = 'ri-tool-time';
    time.textContent = fmtDuration(t.durationMs);

    var state = document.createElement('span');
    state.className = 'ri-tool-state';
    // 「未知」是刻意的第四态：收尾时还没有结果 —— 可能跑了可能没跑，绝不折成「失败」（那是谎报）
    state.textContent = RUN_TOOL_LABEL[t.state] || t.state;

    row.appendChild(idx);
    row.appendChild(name);
    row.appendChild(time);
    row.appendChild(state);
    return row;
  }

  /**
   * C6：发起检索。`immediate` 用于「列表变了但查询词没变」的场景（软删/恢复/重命名后）——
   * 那种时候必须**跳过去抖立刻重发**，否则新结果要等 120ms 才回来，中间那段时间面板上
   * 显示的是一份已经过期的命中。
   */
  function requestSearch(immediate) {
    if (!historyQuery.trim()) {
      return;
    }
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    if (immediate) {
      runSearch();
    } else {
      searchTimer = setTimeout(runSearch, 120);
    }
  }

  function runSearch() {
    searchTimer = null;
    searchSeq += 1; // 单调递增，过期响应靠它丢弃
    post({ type: 'search-sessions', query: historyQuery, seq: searchSeq });
  }

  /** C6：切「会话 / 回收站」视图。两个 tab 的显隐与 aria 一起对齐。 */
  function setHistoryTab(tab) {
    historyTab = tab === 'trash' ? 'trash' : 'active';
    var tabs = historyPanel.querySelectorAll('.history-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === historyTab;
      tabs[i].classList.toggle('active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    renderHistory();
  }

  function renderHistory() {
    historyList.textContent = '';
    var isTrash = historyTab === 'trash';

    // 回收站页不检索（检索只在在列会话里做），也不显示搜索框
    historySearch.hidden = isTrash || sessions.length === 0;
    historyFoot.hidden = !isTrash;
    purgeTrashBtn.disabled = trashed.length === 0;
    // C7：留存关闭（days<=0）或扩展没给这个字段 → 整个按钮藏起来（够不到模态）。
    // 文案里的条数直接取扩展下发的 count —— 与扩展真正会删的那批**同一个数**。
    var days = retention && retention.days > 0 ? retention.days : 0;
    var expiring = days > 0 ? retention.count || 0 : 0;
    purgeExpiredBtn.hidden = !isTrash || days <= 0;
    purgeExpiredBtn.disabled = expiring === 0;
    purgeExpiredBtn.textContent = '清理 ' + expiring + ' 个过期会话';

    var shown;
    if (isTrash) {
      shown = trashed;
      if (shown.length === 0) {
        historyEmpty.textContent = '回收站是空的';
        historyEmpty.hidden = false;
      } else {
        historyEmpty.hidden = true;
      }
    } else if (historyQuery.trim()) {
      // C6：查询非空 → 渲染**扩展回传的命中**（正文匹配，本地拿不到正文，无从过滤）
      shown = searchHits;
      if (shown.length === 0) {
        historyEmpty.textContent = '没有匹配「' + historyQuery.trim() + '」的内容';
        historyEmpty.hidden = false;
      } else {
        historyEmpty.hidden = true;
      }
    } else {
      shown = sessions;
      if (shown.length === 0) {
        historyEmpty.textContent = '暂无历史会话';
        historyEmpty.hidden = false;
      } else {
        historyEmpty.hidden = true;
      }
    }

    for (var k = 0; k < shown.length; k++) {
      if (isTrash) {
        buildTrashItem(shown[k]);
      } else {
        buildHistoryItem(shown[k]);
      }
    }
  }

  /**
   * 构建单条历史项。必须独立成函数：每次调用都形成独立闭包，
   * 点击/删除回调里引用的 id 就是这一条自己的（写成循环内 var 会全体共享同一个 → 点错会话）。
   */
  function buildHistoryItem(s) {
    var li = document.createElement('li');
    li.className = 'history-item' + (s.id === activeId ? ' active' : '');
    var sid = s.id; // 本次调用专属，供下面几个监听器稳定引用

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

    // C6：检索命中 → 附一段上下文（三段分开落 textContent，只有 match 挂高亮类；
    // 全程不碰 innerHTML，正文里有什么标签都只是文字）
    if (s.snippet) {
      var sn = document.createElement('span');
      sn.className = 'history-snippet';
      sn.appendChild(document.createTextNode(s.snippet.before));
      var mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = s.snippet.match;
      sn.appendChild(mark);
      sn.appendChild(document.createTextNode(s.snippet.after));
      open.appendChild(sn);
      if (s.count > 0) {
        var count = document.createElement('span');
        count.className = 'history-count';
        count.textContent = '命中 ' + s.count + ' 处';
        open.appendChild(count);
      }
    }

    open.addEventListener('click', function () {
      post({ type: 'open-session', sessionId: sid });
      closeHistoryPanel();
    });

    var exp = document.createElement('button');
    exp.className = 'history-export';
    exp.title = '导出这个会话（Markdown / JSON）';
    exp.textContent = '⬇'; // ⬇
    exp.addEventListener('click', function () {
      post({ type: 'export-session', sessionId: sid });
    });

    var del = document.createElement('button');
    del.className = 'history-delete';
    del.title = '移到回收站（可恢复）';
    del.textContent = '✕'; // ✕
    del.addEventListener('click', function () {
      post({ type: 'trash-session', sessionId: sid });
    });

    li.appendChild(open);
    li.appendChild(exp);
    li.appendChild(del);
    historyList.appendChild(li);
  }

  /** C6 回收站条目：同样的主体 + 「恢复」/「彻底删除」。回收站里也允许导出（软删的照样能救出来）。 */
  function buildTrashItem(s) {
    var li = document.createElement('li');
    li.className = 'history-item';
    var sid = s.id;

    var open = document.createElement('button');
    open.className = 'history-open';
    open.title = '先从回收站恢复才能打开';

    var title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = s.title || '（无标题会话）';
    open.appendChild(title);

    var time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = '删除于 ' + fmtTime(s.deletedAt);
    open.appendChild(time);

    // 点主体 = 恢复（不是打开）：这是回收站里最常做的动作
    open.addEventListener('click', function () {
      post({ type: 'restore-session', sessionId: sid });
    });

    var exp = document.createElement('button');
    exp.className = 'history-export';
    exp.title = '导出这个会话（Markdown / JSON）';
    exp.textContent = '⬇';
    exp.addEventListener('click', function () {
      post({ type: 'export-session', sessionId: sid });
    });

    var restore = document.createElement('button');
    restore.className = 'history-restore';
    restore.title = '恢复这个会话';
    restore.textContent = '↩'; // ↩
    restore.addEventListener('click', function () {
      post({ type: 'restore-session', sessionId: sid });
    });

    var purge = document.createElement('button');
    purge.className = 'history-delete';
    purge.title = '彻底删除（不可撤销）';
    purge.textContent = '✕';
    purge.addEventListener('click', function () {
      post({ type: 'purge-session', sessionId: sid });
    });

    li.appendChild(open);
    li.appendChild(exp);
    li.appendChild(restore);
    li.appendChild(purge);
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
    searchHits = [];
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    setHistoryTab('active'); // 每次打开落在「会话」页（searchSeq **不**归零，见顶部声明）
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
    var rec = makeBubble(id, 'assistant', LIVE_SINK);
    rec.content.className = 'md';
    return rec;
  }

  /** `sink` 必填（C15）：漏传会当场 TypeError —— 那正是我们要的失败方式，静默画到直播面上才是最坏的。 */
  function makeBubble(id, role, sink) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-' + role;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var content = document.createElement('div');
    bubble.appendChild(content);
    wrap.appendChild(bubble);
    sink.container.appendChild(wrap);

    var rec = { id: id, role: role, wrap: wrap, bubble: bubble, content: content, text: '', status: 'streaming', caret: null };
    sink.registry.set(id, rec);
    return rec;
  }

  /**
   * 构建/更新一张工具调用卡（role:'tool'）。入参与输出一律 textContent（防 XSS）。
   * running 只转圈不出输出；ok/error/unknown 时把输出文本放进 pre。
   *
   * `unknown` 是第四态，不是「还没到」：那次调用**没能收到结果**（被杀进程、轮被中断），
   * 跑没跑完不可知。用中性色 + 「?」而**不是**红叉 —— 判成失败会让人去重试一个可能已经
   * 生效过的命令（`runInspector.toolResultVerdict` 与 `_finishTurn` 的注释是同一套理由）。
   */
  function applyToolState(rec) {
    rec.card.classList.toggle('running', rec.toolState === 'running');
    rec.card.classList.toggle('ok', rec.toolState === 'ok');
    rec.card.classList.toggle('error', rec.toolState === 'error');
    rec.card.classList.toggle('unknown', rec.toolState === 'unknown');
    rec.stateEl.textContent =
      rec.toolState === 'running'
        ? '运行中…'
        : rec.toolState === 'ok'
          ? '✓ 成功'
          : rec.toolState === 'error'
            ? '✗ 失败'
            : rec.toolState === 'unknown'
              ? '? 无结果'
              : rec.toolState || '';
    var showOutput = rec.toolState !== 'running' && !!rec.outputText;
    rec.outputEl.hidden = !showOutput;
    rec.outputEl.textContent = rec.outputText || '';
  }

  /**
   * C14：工具卡上那行「预计改动 / 实际改动」。**就地改同一个节点**，不重建卡片 ——
   * 卡片是一次建好、之后只改内容的（`applyToolState` 也只动 stateEl / outputEl）。
   *
   * 位置必须是 `card` 的**直接子节点、排在 `.tool-head` 之后**（`.tool-input` 之前）：
   * 顶栏是 flex、状态点与状态字都在里面，塞进去会把那行挤坏（C13 的 `#harness-shell`
   * 犯过同型的错：挂在头部里而不是它的兄弟）。
   *
   * 入参与 label/note 一律 textContent（防 XSS）；diff 逐行建元素，零 innerHTML。
   */
  function renderToolForecast(rec, data) {
    var box = rec.forecastEl;
    if (!box) {
      box = document.createElement('div');
      box.className = 'tool-forecast';
      var label = document.createElement('span');
      label.className = 'tf-label';
      var note = document.createElement('span');
      note.className = 'tf-note';
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tf-toggle';
      toggle.textContent = 'Diff';
      var diff = document.createElement('pre');
      diff.className = 'tf-diff';
      diff.hidden = true;
      toggle.addEventListener('click', function () {
        diff.hidden = !diff.hidden;
        toggle.textContent = diff.hidden ? 'Diff' : '收起';
      });
      box.appendChild(label);
      box.appendChild(note);
      box.appendChild(toggle);
      box.appendChild(diff);
      // 落在顶栏正下方：入参那块 JSON 可能上千字符，把读数排在它下面等于让人先滚过一坨参数。
      // 锚点是**入参节点**（有则插它前面），没有才退到 outputEl —— output 永远在末尾。
      rec.card.insertBefore(box, rec.inputEl || rec.outputEl);
      rec.forecastEl = box;
      rec.forecastLabel = label;
      rec.forecastNote = note;
      rec.forecastToggle = toggle;
      rec.forecastDiff = diff;
    }
    box.classList.toggle('warn', data.level === 'warn');
    box.classList.toggle('failed', !!data.failed);
    box.classList.toggle('unknown', !!data.unknown);
    box.classList.toggle('after', data.phase === 'after');
    rec.forecastLabel.textContent = data.label || '';
    // 走属性而不是 setAttribute：DOM 影子把 setAttribute 只当作「存起来」（class/hidden 才镜像），
    // `title` 这样写才既有真效果、也能被探针读到（C13 的 shell 段同款）
    box.title = data.title || '';
    rec.forecastNote.textContent = data.note || '';
    rec.forecastNote.hidden = !data.note;

    var lines = data.diff || [];
    while (rec.forecastDiff.firstChild) rec.forecastDiff.removeChild(rec.forecastDiff.firstChild);
    if (lines.length) {
      for (var i = 0; i < lines.length; i++) {
        var row = document.createElement('div');
        var kind = lines[i].kind === 'add' ? 'add' : lines[i].kind === 'del' ? 'del' : 'ctx';
        row.className = 'diff-line ' + kind;
        row.textContent = (kind === 'add' ? '+' : kind === 'del' ? '-' : ' ') + (lines[i].text || '');
        rec.forecastDiff.appendChild(row);
      }
      if (data.diffTruncated) {
        var cut = document.createElement('div');
        cut.className = 'diff-line ctx tf-cut';
        cut.textContent = '…（diff 过长，已只保留前段）';
        rec.forecastDiff.appendChild(cut);
      }
    } else {
      // 新载荷没有 diff（如「新建文件」或失败收尾）⇒ 把展开状态一并复位：
      // 否则按钮没了、上一次的 diff 还开着，看起来像这一条的结果
      rec.forecastDiff.hidden = true;
      rec.forecastToggle.textContent = 'Diff';
    }
    rec.forecastToggle.hidden = lines.length === 0;
  }

  /**
   * C15：工具卡的**落点化**实现 —— 直播面与对照面板共用这一份。
   * ⚠️ 它自己**没有** react-live 门规：门规在三个 `add*` 包装器与 `renderMessageInto` 里
   *    （共 4 处，探针钉着）。这样对照面板（`reactLive: false`）才能在 react-live 下照画。
   */
  function renderToolInto(msg, sink) {
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

    // ⚠️ 名字别叫 inputEl：模块顶上那个 inputEl 是 composer 输入框，同名会把后来读它的人骗惨
    var inputNode = null;
    if (msg.toolInput) {
      var input = document.createElement('div');
      input.className = 'tool-input';
      input.textContent = msg.toolInput;
      card.appendChild(input);
      inputNode = input;
    }

    var output = document.createElement('pre');
    output.className = 'tool-output';
    card.appendChild(output);

    wrap.appendChild(card);
    sink.container.appendChild(wrap);

    var rec = {
      id: msg.id,
      role: 'tool',
      wrap: wrap,
      card: card,
      stateEl: stateEl,
      outputEl: output,
      // C14：那行「预计/实际改动」的插入锚点（没有入参时是 null）
      inputEl: inputNode,
      outputText: msg.toolOutput || '',
      toolState: msg.toolState || 'running',
      status: 'done',
      caret: null,
    };
    sink.registry.set(msg.id, rec);
    applyToolState(rec);
    return rec;
  }

  /** 直播面的工具卡入口。门规**一字未改**地留在这里（C15 的落点化只把函数体挪进了 renderToolInto）。 */
  function addToolMessage(msg) {
    if (isReactLive()) return;
    return renderToolInto(msg, LIVE_SINK);
  }

  /** 居中灰字说明行（role:'note'，如「已开启全新 DSH 会话…」）。恒 done、不流式。 */
  function renderNoteInto(msg, sink) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-note';
    wrap.textContent = msg.text; // 纯文本渲染（CSS ::before/::after 加两侧 —）
    sink.container.appendChild(wrap);
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
    sink.registry.set(msg.id, rec);
    return rec;
  }

  /** 直播面的 note 入口（门规同 addToolMessage）。 */
  function addNoteMessage(msg) {
    if (isReactLive()) return;
    return renderNoteInto(msg, LIVE_SINK);
  }

  /**
   * C15：**把一条消息渲染进一个落点** —— 直播面与对照面板的唯一分派处。
   *
   * ⚠️ 门规必须在这里也有一份：`renderSnapshot` 重渲染整条转写时走的是 `renderTranscriptInto`，
   *    **不再经过 `add*` 包装器**。所以全仓一共 4 行门规（三个 `add*` + 这里），
   *    这是**有意保留的重复** —— 比「把门规藏进 sink 字段」更难写错：漏传 sink 会当场
   *    TypeError，而漏掉门规会静默把 DOM 画到 react-live 的直播面上。
   */
  function renderMessageInto(msg, sink) {
    if (sink.reactLive && isReactLive()) return;
    if (msg.role === 'tool') {
      return renderToolInto(msg, sink);
    }
    if (msg.role === 'note') {
      return renderNoteInto(msg, sink);
    }
    var rec = makeBubble(msg.id, msg.role === 'user' ? 'user' : 'assistant', sink);
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

  /** 直播面的通用入口。 */
  function addMessage(msg) {
    if (isReactLive()) return; // 真组件画面接管，DOM 消息面整体停用
    return renderMessageInto(msg, LIVE_SINK);
  }

  /** 只清掉消息气泡（与折叠行），保留 #messages 里的空状态提示元素。 */
  function removeAllMessages() {
    var children = Array.prototype.slice.call(messagesEl.children);
    for (var k = 0; k < children.length; k++) {
      if (children[k].classList.contains('msg') || children[k].classList.contains('msg-fold')) {
        children[k].remove();
      }
    }
  }

  /**
   * C10 转写折叠：只渲染**尾部** `FOLD_KEEP` 条，前面插一行「更早的 N 条已折叠」。
   *
   * 治的是「越跑越重」：`renderSnapshot` 是「清空 + 全量重建 DOM」，几百条消息的会话每来一帧
   * 就整批重建一遍，而这个函数在流式刷新里被反复调用。折掉头部之后，重建量不再随会话长度增长。
   *
   * ⚠️ **它只省 DOM，别的什么都不省** —— 这句必须留着，否则下一个人会以为折叠 = 归档：
   *   · 消息一条没丢，还在扩展侧的 `_active.messages` 里（这里只是不给它们建 DOM）；
   *   · `snapshot` 下发的 payload **一个字节都没少**（扩展照旧发全量）；
   *   · 更不省 DSH 的上下文占用 —— 那由 DSH 自己管，要那个去看 `hello.chat.compaction.thresholdRatio`。
   * 也就是说：**它不影响任何"记忆"，纯排版**。
   */
  var FOLD_KEEP = 60;
  /** 用户点过「显示」。**会话级**状态：换会话复位（见 snapshot 分支）。 */
  var foldExpanded = false;
  /**
   * 最近一次快照的消息（点「显示」时拿它整帧重渲染）。
   *
   * ⚠️ **别把它与上面那个 `lastSnapshotMessages`（react-live 的回放前缀）合并或重名** ——
   * 两者装的内容确实一样（都是最近一幅快照），但语义与初值都不同：那个初值是 `null`
   * （React 挂载早于任何快照时要靠它跳过回放），这个是数组。同名的话 `var` 会提升成同一个变量，
   * 于是 `maybeBridgeReplay` 会在该跳过的时候拿到一个空数组照发一遍。
   */
  var foldSource = [];

  /**
   * 那一行「更早的 N 条已折叠」。
   *
   * C15：点击动作**由调用方给**（`onExpand`）—— 折叠展开态是**每个落点自己的**状态：
   * 直播面是 `foldExpanded`，对照面板是 `compareTailExpanded.a/b`。写死成
   * `foldExpanded = true; renderSnapshot(foldSource)` 的话，在对照面板里点这一行会去展开
   * **直播面**（探针里有反控钉着这条串台）。
   */
  function buildFoldRow(n, onExpand) {
    var row = document.createElement('div');
    row.className = 'msg-fold';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-fold-btn';
    btn.textContent = '更早的 ' + n + ' 条已折叠（仅界面，DSH 记忆未变）· 显示';
    btn.title =
      '折叠只影响这一屏的渲染量。消息一条没丢，DSH 那边的记忆也没有被改动 —— ' +
      '真正的上下文压缩是 DSH 按它自己的阈值做的，与这里无关。';
    btn.addEventListener('click', function () {
      onExpand();
    });
    row.appendChild(btn);
    return row;
  }

  /**
   * C15：**把一份转写渲染进一个落点**的**唯一实现**（折叠判据也只此一处）。
   *
   * ⚠️ 它**不清记录表、不清容器** —— 那是调用方的事：直播面要 `byId.clear()` +
   *    `removeAllMessages()`（后者刻意保留 #messages 里的空态提示节点），对照面板直接换一张新表。
   */
  function renderTranscriptInto(messages, expanded, sink, onExpand) {
    // 折的是**头部**：尾部是正在生长的对话，滚动位置与流式气泡都在那一头。
    var head = !expanded && messages.length > FOLD_KEEP ? messages.length - FOLD_KEEP : 0;
    if (head > 0) sink.container.appendChild(buildFoldRow(head, onExpand));
    for (var i = head; i < messages.length; i++) {
      renderMessageInto(messages[i], sink);
    }
  }

  function renderSnapshot(messages) {
    byId.clear();
    removeAllMessages();
    foldSource = messages;
    renderTranscriptInto(messages, foldExpanded, LIVE_SINK, function () {
      foldExpanded = true;
      renderSnapshot(foldSource);
    });
    toggleEmptyHint();
    updateBusy();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- 文件附件 ----------

  /** 附件文本上限（与扩展侧一致），超出截断。 */
  var MAX_CHIP_TEXT = 200000;
  /** 浏览器 File 直接读取时的字节上限，再大就不读了（与扩展侧一致：10KB）。 */
  var MAX_FILE_BYTES = 10 * 1024;
  /**
   * C17：图片那一路的上限与类型表 —— **与扩展侧 `src/imageAttach.ts` 有意重复**（webview 加载不了
   * TS）。漂了会在 `scripts/probe-image-attach.mjs` 的 B4 条上红，那条专门对拍这几个字面量。
   *
   * 这里判断「是不是图片」用的是**文件类型 / 扩展名**，而**扩展侧一律按魔数重判** ——
   * 前端这一层只决定「用哪个 reader 去读」，真正的准入判定只有扩展侧那一份。
   */
  var IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
  var MAX_IMAGES_PER_MESSAGE = 4;
  /** 看着像图片的扩展名（与扩展侧 `IMAGE_EXT_HINTS` 同集合；`file.type` 常常是空串）。 */
  var IMAGE_EXT_RE = /\.(png|jpe?g|jpe|jfif|gif|webp|bmp|ico|cur|svg|tiff?|avif|heic|heif)$/i;

  /** 人读的字节数。口径与扩展侧 `imageAttach.formatBytes` 一致。 */
  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0 B';
    if (n < 1024) return n + ' B';
    var kb = n / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    var mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
  }

  /** 这个 File 该走图片那一路吗（类型或扩展名任一命中）。真伪由扩展侧按魔数说了算。 */
  function looksLikeImage(file) {
    if (IMAGE_MEDIA_TYPES.indexOf(file.type) >= 0) return true;
    return IMAGE_EXT_RE.test(file.name || '');
  }

  /** 待发送里已有几张图片（张数上限是**落盘量**的安全阀，不是模型的要求）。 */
  function countPendingImages() {
    var n = 0;
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].kind === 'image' && !pending[i].readError) n++;
    }
    return n;
  }

  /**
   * C20：图片通路的**两档措辞** —— **与扩展侧 `src/imageAttach.ts` 的 `IMAGE_ROUTE_TAGS` 有意重复**
   * （webview 加载不了 TS）。漂了会在 `scripts/probe-webview-render.mjs` 上红，那条专门对拍这几个字面量。
   *
   * 措辞本身**只在扩展侧解释一次**（见 `IMAGE_ROUTE_TAGS` 上面那段）：`blind` 说的是「这份配置」
   * 的事实、`readable` 说的是「取用方式」。⚠️ **两边绝不许写「模型看不到」** —— 那是把部署的事实
   * 说成模型的属性（C17 那条 chip 的老毛病）。判据（`read_image` 在不在工具表里）也在扩展侧，
   * 这里只**跟着 `snapshot.imageRead` 走**，自己不做任何判断。
   */
  var IMAGE_ROUTE_TAGS = {
    blind: {
      tag: '图片输入未接通',
      title: '图片不随消息发送、只落成一个文件：这份配置里没有图片输入通路（运行时没挂附件仓库，read_image 工具不存在），画面也就到不了模型那里'
    },
    readable: {
      tag: '模型需自行读取',
      title: '图片不随消息发送、只落成一个文件：模型要看画面得自己用 read_image 读它'
    }
  };
  /** 当前档位。**缺省 `blind`（fail-closed）**：`snapshot` 没带 `imageRead` 就是「关」，
   *  与扩展侧「没有证据 = 今天的行为」同一条纪律（老扩展 + 新 webview 的组合也照此）。 */
  var imageRoute = 'blind';

  /** 图片 chip 上的三个小标：图片 / 大小 / 通路判定。**全部 textContent**（零 innerHTML）。 */
  function appendImageBadges(chip, a) {
    var tag = document.createElement('span');
    tag.className = 'chip-tag';
    tag.textContent = '图片';
    chip.appendChild(tag);
    if (typeof a.bytes === 'number' && a.bytes > 0) {
      var dim = document.createElement('span');
      dim.className = 'chip-dim';
      dim.textContent = formatBytes(a.bytes);
      chip.appendChild(dim);
    }
    var warn = document.createElement('span');
    warn.className = 'chip-dim';
    // 末标**只从那张表取**，这里不许再出现字面量（探针有「仅此一处」的结构守卫）
    warn.textContent = IMAGE_ROUTE_TAGS[imageRoute].tag;
    warn.title = IMAGE_ROUTE_TAGS[imageRoute].title;
    chip.appendChild(warn);
  }

  function addPending(src) {
    var item = { key: 'p' + (++pendingSeq), name: src.name };
    if (src.path) item.path = src.path;
    if (src.content) item.content = src.content;
    if (src.truncated) item.truncated = true;
    if (src.readError) item.readError = src.readError;
    // C17：图片那一路的字段。**图片永不带 content** —— 带的是字节的 base64，落盘时被消费掉
    if (src.kind === 'image') item.kind = 'image';
    if (src.mediaType) item.mediaType = src.mediaType;
    if (typeof src.bytes === 'number') item.bytes = src.bytes;
    if (src.dataBase64) item.dataBase64 = src.dataBase64;
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
    } else if (p.kind === 'image') {
      // C17：图片 chip **说它是一张图、说它多大、说画面得模型自己读**。这里刻意不画缩略图：
      // 气泡里出现一张图，读起来就是「模型看见过它」—— 那是假的。
      chip.className = 'chip chip-image';
      appendImageBadges(chip, p);
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
      } else if (a.kind === 'image') {
        // C17：与待发送 chip **同一套标**（同一条消息在发出前后长得一样，只是少了移除钮）
        chip.className = 'chip readonly chip-image';
        appendImageBadges(chip, a);
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
      // C17：图片走自己那条路 —— **用 `readAsDataURL` 而不是 `readAsText`**（后者会把 PNG 读成
      // 乱码喂给模型），也不走 10KB 那道闸（截图动辄几百 KB，那道闸是给文本附件的）。
      // 为什么不用 `readAsArrayBuffer` + `btoa`：`readAsDataURL` 白送 base64，省掉
      // Uint8Array / 分块 fromCharCode 一整类问题（DOM 影子那边也只要补一个真回调，见 D5）。
      if (looksLikeImage(file)) {
        if (file.size > MAX_IMAGE_BYTES) {
          addPending({ name: file.name, kind: 'image', readError: '图片过大(>3.5MB)' });
          continue;
        }
        if (countPendingImages() >= MAX_IMAGES_PER_MESSAGE) {
          addPending({
            name: file.name,
            kind: 'image',
            readError: '图片最多 ' + MAX_IMAGES_PER_MESSAGE + ' 张',
          });
          continue;
        }
        // 立即闭包捕获这一个 file，避免异步回调读到循环末态
        (function (f) {
          var r = new FileReader();
          r.onload = function () {
            var data = String(r.result);
            var comma = data.indexOf(',');
            if (comma < 0) {
              addPending({ name: f.name, kind: 'image', readError: '无法读取' });
              return;
            }
            // 剥掉 `data:image/png;base64,` 前缀：扩展侧只收纯 base64（它会重新嗅探字节）
            addPending({
              name: f.name,
              kind: 'image',
              mediaType: f.type || '',
              bytes: f.size,
              dataBase64: data.slice(comma + 1),
            });
          };
          r.onerror = function () {
            addPending({ name: f.name, kind: 'image', readError: '无法读取' });
          };
          r.readAsDataURL(f);
        })(file);
        continue;
      }
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

  /**
   * 粘贴来的文件在 **`clipboardData`** 上，**不在 `dataTransfer` 上** —— 浏览器在 `paste` 事件上
   * 不给 `dataTransfer`（那是 `drop`/`dragover` 的字段）。
   *
   * ⚠️ C17 之前这里问的是 `dropHasFiles(e)`，于是它**恒为假**：粘贴这条路（Ctrl+V 一张截图，
   * 正是图片附件最常见的那条入口）从来没生效过，而且失效得毫无声响 —— 不会报错，只是什么都不发生。
   * 是 `probe-webview-render` 的 C17 组把它抓出来的（影子按真浏览器的语义只给 clipboardData）。
   */
  function pasteHasFiles(e) {
    return !!(e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0);
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
      // C17：`truncated` 今天在这里被丢掉了 —— 扩展侧于是在一条**已经被前端截断过**的附件上
      // 看到"完好内容"，永远不会补那句「已截断」。顺手修掉（协议里它已上移到 FileRef）。
      if (p.truncated) a.truncated = true;
      // C17：图片只发**元数据 + 字节的 base64**，`content` 一个字都不发（扩展侧落盘后丢弃字节）
      if (p.kind === 'image') {
        a.kind = 'image';
        if (p.mediaType) a.mediaType = p.mediaType;
        if (typeof p.bytes === 'number') a.bytes = p.bytes;
        if (p.dataBase64) a.dataBase64 = p.dataBase64;
      }
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

  /**
   * 「在新对话中分支」（真 DSH ChatView 轮尾动作栏）：ChatView 以壳模式挂载，宿主回调
   * forkAt 是空桩 → 这个按钮点了本来什么也不发生。这里在 **capture 阶段**（document 层，
   * 早于 React 在 host 根上的委托）抢先截获：组件自己标不可用的分支钮（旧消息/非轮尾 →
   * aria-disabled / data-unavailable）依旧尊重、不截；可用的则阻止继续下传（免得点进空桩）
   * 并转成扩展侧的 fork-session 动作，由扩展深拷贝当前会话成新会话并切换过去。
   * 只有真组件画面（react-live）里才有这个按钮 —— DOM 气泡回退态没有 → isReactLive 放行。
   */
  function onBranchCapture(e) {
    if (!isReactLive()) return; // 分支按钮只在真 ChatView 里存在
    if (!(e.target instanceof Element)) return;
    var btn = e.target.closest('button');
    if (!btn) return;
    var label = btn.getAttribute('aria-label') || '';
    if (!label.includes('分支')) return; // bundle i18n：t('message.branch') = 在新对话中分支
    if (btn.hasAttribute('data-unavailable') || btn.getAttribute('aria-disabled') === 'true') {
      return; // 组件判不可用 → 尊重其语义，不截、不误建会话
    }
    if (sending || runBusy) return; // 运行在途本就轮尾未落定，兜底再挡一道
    e.preventDefault();
    e.stopPropagation(); // 阻断下传到 React 根的空桩 onBranch
    post({ type: 'fork-session' });
  }

  function bindEvents() {
    // 分支按钮捕获（见 onBranchCapture）：必须在 React 自己的委托处理之前跑
    document.addEventListener('click', onBranchCapture, true);
    // 顶部模式切换：点 tab → 暂存本模式草稿并请扩展切模式
    for (var ti = 0; ti < modeTabs.length; ti++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          requestMode(tab.dataset.mode);
        });
      })(modeTabs[ti]);
    }

    // 底部配置条（仅 harness）：模型选择器 = 触发钮 + DOM 浮层菜单；点菜单外部任意处收起。
    liveModelBtn.addEventListener('click', function () {
      toggleModelMenu();
    });
    // C11 推理档位：同款触发钮 + 浮层菜单
    liveEffortBtn.addEventListener('click', function () {
      toggleEffortMenu();
    });
    // C12 项目 profile：同款触发钮 + 浮层菜单
    liveProfileBtn.addEventListener('click', function () {
      toggleProfileMenu();
    });
    // C22b 上下文占用环：同款触发钮 + **只读**浮层（内容由 paintContextRing 每帧画好）
    ctxRing.addEventListener('click', function () {
      toggleCtxMenu();
    });
    document.addEventListener('click', function (e) {
      // 四个菜单各自判断"点在外面"：一个处理函数里连判四次，比注册四条互不知情的监听器稳
      if (liveModelMenu.classList.contains('open') && !liveModelWrap.contains(e.target)) closeModelMenu();
      if (liveEffortMenu.classList.contains('open') && !liveEffortWrap.contains(e.target)) closeEffortMenu();
      if (liveProfileMenu.classList.contains('open') && !liveProfileWrap.contains(e.target)) closeProfileMenu();
      if (ctxRingMenu.classList.contains('open') && !ctxRingWrap.contains(e.target)) closeCtxMenu();
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
    // C23：点一下刷新。**没有 `if (sending || runBusy) return;`** —— 与上面两枚不同的地方正是
    // 这里：只读读数在跑动中也要能点（同那枚环）。扩展侧有在途闸，连点不会叠发。
    if (liveBalanceBtn) {
      liveBalanceBtn.addEventListener('click', function () {
        post({ type: 'refresh-balance' });
      });
    }

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
    // C6 搜索框输入 → 去抖 120ms 后向扩展发起全文检索（搜索框在面板内，点它不会触发「点外面收起」）
    historySearch.addEventListener('input', function () {
      historyQuery = historySearch.value;
      if (!historyQuery.trim()) {
        // 清空立刻回完整列表，别让上一次的命中和空白查询的输入打架
        searchHits = [];
        if (searchTimer) {
          clearTimeout(searchTimer);
          searchTimer = null;
        }
        renderHistory();
        return;
      }
      requestSearch(false);
    });

    // 回收站页按钮：清空回收站（不可逆 → 扩展侧会弹原生模态确认）
    purgeTrashBtn.addEventListener('click', function () {
      post({ type: 'purge-trash' });
    });
    // C7：清理过期（同样不可逆，扩展侧按同一套判据再算一遍条数并弹模态）
    purgeExpiredBtn.addEventListener('click', function () {
      post({ type: 'purge-expired' });
    });
    // 两个视图标签（点它不触发「点外面收起」：按钮在 #history-panel 内）
    var historyTabs = historyPanel.querySelectorAll('.history-tab');
    for (var ti = 0; ti < historyTabs.length; ti++) {
      historyTabs[ti].addEventListener('click', function () {
        setHistoryTab(this.getAttribute('data-tab'));
      });
    }
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
    // 粘贴文件（Ctrl+V 复制的文件 / 一张截图）→ 读为附件。
    // ⚠️ 判据必须是 `clipboardData`（见 pasteHasFiles 的注释）—— 这里曾用 dropHasFiles，
    // 于是整条粘贴路径静默失效。
    inputEl.addEventListener('paste', function (e) {
      if (pasteHasFiles(e)) {
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
    inputEl.addEventListener('input', autosizeInput); // 自动增高：多行向上长 / 超上限框内滚动
    window.addEventListener('resize', autosizeInput); // 侧栏宽度变化 → 换行数变 → 重算高度
    messagesEl.addEventListener('scroll', function () {
      atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    });

    // ---- C8「继续」条 ----
    retryBtn.addEventListener('click', function () {
      retryBtn.disabled = true; // 双保险：扩展侧 _retryLast 也会挡运行中的重发
      post({ type: 'retry-last' });
    });

    // ---- C1 事前审批确认条 ----
    approvalAllowBtn.addEventListener('click', function () {
      answerApproval(true);
    });
    approvalDenyBtn.addEventListener('click', function () {
      answerApproval(false);
    });
    // C16：「永久信任…」= 允许 + 记住。粒度取**画这条时**记下的那个值（不是此刻的 DOM），
    // 所以两条审批之间不会串味
    approvalTrustBtn.addEventListener('click', function () {
      answerApproval(true, approvalTrustKind);
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

    // ---- C9 运行检查器：条 / 浮层面板 ----
    runsViewBtn.addEventListener('click', function () {
      if (runsPanelOpen) closeRunsPanel();
      else openRunsPanel();
    });
    runsPanelClose.addEventListener('click', function () {
      closeRunsPanel();
    });

    // ---- C15 分支对照浮层：入口在 header（不在 composer —— 那是「本轮的读数/动作」的地方）----
    compareBtn.addEventListener('click', function () {
      toggleComparePanel();
    });
    comparePanelClose.addEventListener('click', function () {
      closeComparePanel();
    });
    compareRefresh.addEventListener('click', function () {
      // 幂等：再发一次 compare-open = 重新取一份快照（两侧都重读）
      if (!compareState) return;
      compareState.pick = null;
      renderCompare();
      post({ type: 'compare-open' });
    });
    for (var csi = 0; csi < 2; csi++) {
      (function (side) {
        compareEls[side].pick.addEventListener('click', function () {
          if (!compareState) return;
          compareState.pick = compareState.pick === side ? null : side;
          renderComparePane(side);
        });
      })(csi === 0 ? 'a' : 'b');
    }
    // Esc 收起浮层：审阅面板优先，否则历史面板。自带 Esc 的输入框（标题/历史搜索/自定义模型）
    // 各自处理并回焦，全局监听不抢（否则会二次触发）。
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (approvalId) { // C1：有待确认时 Esc = 拒绝（最紧急，且不受焦点在哪影响）
        answerApproval(false);
        return;
      }
      if (e.target === chatTitleInput || e.target === historySearch || e.target === liveModelInput) return;
      if (liveModelMenu.classList.contains('open')) { // 模型菜单开着 → 先收它
        closeModelMenu();
        return;
      }
      if (liveEffortMenu.classList.contains('open')) { // C11 档位菜单同理
        closeEffortMenu();
        return;
      }
      if (ctxRingMenu.classList.contains('open')) { // C22b 读数浮层：与另外三个菜单同一层，紧随其后
        closeCtxMenu();
        return;
      }
      if (reviewPanelOpen) {
        closeReviewPanel();
        return;
      }
      if (runsPanelOpen) {
        // C9：运行检查器浮层 —— 审阅面板之后、历史面板之前（层次顺序与 z-index 一致）
        closeRunsPanel();
        return;
      }
      if (compareState) {
        // C15：分支对照浮层 —— 三个浮层里最后开的那个，按 z-index 同层的顺序收
        closeComparePanel();
        return;
      }
      if (isHistoryOpen()) closeHistoryPanel();
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
    // C9：runs 每收一条**被记录的**帧就发一次（一轮里几十条，C3a 的 usage 亦然），而它的结果
    // 就摆在屏幕上那条里 —— 打进控制台只会把别的痕迹淹掉。要看实时读数就盯条本身。
    var quiet = type === 'runs';
    if (type && !reactOnly && !quiet && !(isReactLive() && domOnly)) {
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
        // C10：折叠状态是**会话级**的 —— 换会话就复位，否则「上一条长对话点开的显示」
        // 会把下一条的头部也整批渲染出来，而折叠本来就是为了省掉那一批。
        if ((data.sessionId || null) !== activeId) foldExpanded = false;
        activeId = data.sessionId || null;
        if (!titleEditing) {
          currentTitle = data.sessionTitle || '';
          refreshTitleDisplay();
        }
        // C20：图片通路的档位**必须在 renderSnapshot 之前落定** —— chip 的末标是渲染期读的
        // （`appendImageBadges`），晚一步就会用上一档把这一屏画完。缺字段 / false 一律「关」。
        imageRoute = data.imageRead === true ? 'readable' : 'blind';
        renderSnapshot(data.messages);
        // C6：切会话/删掉活动会话都会送来 snapshot，而此时查询词还是老样子 —— 结果集却变了
        // （活动会话的正文/存在与否都不同）。不重发的话 renderHistory() 会把命中集整片冲掉，
        // 用户看到的是「删一条，搜索结果就没了」。
        requestSearch(true);
        renderHistory();
        // C21/C22 两处读数随快照整帧重放（切会话/切模式/重开窗口）。没带就是真没有 → 那一处清空，
        // 都空则环与行都隐藏，免得带着上个会话的数字留在屏上。
        // ⚠️ 两个字段名**不一样**：快照带 `runs`，流式 `runs` 消息带 `readout`（见下面那个 case）。
        usageState = data.usage || null;
        runsState = data.runs || null;
        runsDetails = null;
        closeRunsPanel(); // 面板内容是会话级的，跨会话残留一份别人的时间线就是谎报
        renderReadouts();
        // react-live：把最新整幅消息中继给真 ChatView 作回放前缀（重建/切会话/清空/删除）。
        // 扩展不再直发 dsh-replay——快照可能早于 React 挂载，统一由此处按较晚者补发。
        lastSnapshotMessages = data.messages;
        maybeBridgeReplay(data.messages);
        break;

      case 'usage':
        // C3a/C22：每个 usage 样本一条 + 轮尾定稿一条，重绘那枚环（数据由扩展算好，这里只格式化）。
        usageState = data.usage || null;
        paintContextRing();
        break;

      case 'runs':
        // C9：每条**被记录的**帧一条（chunk 帧一条都不发，这是全部的体积故事）。
        // `details` 只在浮层开着时才有 —— 没带就别拿新的把旧的冲掉，否则每收一帧详情就空一次。
        // ⚠️ 这条消息的字段名是 `readout`（快照那条是 `runs`），别顺手统一。
        runsState = data.readout || null;
        if (data.details) runsDetails = data.details;
        renderStatusRow();
        if (runsPanelOpen) renderRunsPanel();
        break;

      case 'history-update':
        sessions = data.sessions;
        trashed = data.trashed || [];
        retention = data.retention || null; // C7：判据在扩展侧，这里只存下来给 renderHistory 用
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
        // C6：列表一变，正在显示的命中就可能是过期的（软删/恢复/重命名都会走到这里）→ 立刻重发
        requestSearch(true);
        renderHistory();
        // C15：对照面板的选择器数据源就是这份列表 → 一变就重画（pick 与 panes 都不受影响，重绘幂等）
        if (compareState) renderCompare();
        break;

      case 'compare-set':
        // C15：⚠️ 浮层已关时**迟到的快照必须丢掉** —— 否则用户关掉面板后它又被画回来
        // （打开/刷新是异步的，关掉之后那份快照一定还在路上）。
        if (!compareState) break;
        compareState.sides = data.sides || {};
        compareState.panes = data.panes || {};
        compareState.split = data.split || null;
        compareState.crosstalk = data.crosstalk || null;
        compareState.at = data.at || Date.now();
        compareState.live = !!data.live;
        // 收到快照 = 这次选择被处理了（被拒也回整份 set）→ 收起选择器，不卡在那一屏
        compareState.pick = null;
        compareTailExpanded = { a: false, b: false }; // 新快照复位展开态（同直播面换会话复位）
        renderCompare();
        break;

      case 'search-results':
        // C6：丢弃过期响应。双重校验 —— seq 对不上（已有更新的请求发出），或词已改（去抖窗口内）
        if (data.seq !== searchSeq || data.query !== historyQuery) {
          break;
        }
        searchHits = data.hits || [];
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
          autosizeInput(); // 已清空 → 输入框收回到一行
          updateBusy(); // 清空后刷新发送钮/空态提示（input-empty 归位）
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

      case 'forecast': {
        // C14：write/edit 卡的「预计 → 实际」。查不到 id（回放历史会话、切了会话、react-live
        // 下没建过 DOM 卡）→ **直接 break**，这不是错误。
        if (isReactLive()) break;
        var fcRec = byId.get(data.id);
        if (fcRec && fcRec.role === 'tool') renderToolForecast(fcRec, data);
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

      case 'retry-offer':
        // C8：上一轮中断/出错 → 亮「继续」条。判据在扩展侧（已落盘的 lastTurn）。
        renderRetryBar(!!data.on);
        break;

      case 'live-config':
        // 底部配置条：模型下拉(含自定义) + API/DSH 状态
        renderLiveConfig(data);
        break;

      case 'live-balance':
        // C23：那枚余额读数的正文与明细都在扩展侧算好了，这里只写文字
        renderBalance(data);
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

      case 'approval-request':
        // C1：破坏性命令待确认 —— agent 整轮正阻塞在这个答复上
        renderApproval(data);
        break;

      case 'approval-resolved':
        // C1：允许/拒绝/超时/取消 → 收起确认条（id 对不上说明是迟到帧，别误关新的那条）
        if (approvalId === data.id) clearApproval();
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
    autosizeInput(); // 按当前草稿初始高度归一（多为空 → 一行）

    window.addEventListener('message', function (evt) {
      onMessage(evt.data);
    });

    // 告诉扩展：本帧已就绪，请下发 snapshot 与历史列表
    post({ type: 'ready' });
    focusInput();
  }

  init();
})();
