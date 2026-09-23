/**
 * 前后端(扩展进程 ⇄ webview)共享的「单一事实源」：
 * 所有 id 常量、消息类型都只在这里定义一次，避免字符串拼写不一致导致静默失效。
 */
import type { DshEventFrame } from './dshRuntime';
// C9：运行检查器的读数形状。纯类型导入（编译后不留 require），且 runInspector.ts 零依赖 →
// 既不成环，也不影响任何探针加载（现有探针都不加载 protocol.js）。
import type { RunReadout, RunRecord } from './runInspector';

/** 活动栏容器 id（package.json 里 viewsContainers.activitybar 的 id） */
export const CONTAINER_ID = 'hello-chat';

/** webview view 的 id：必须与 package.json 里 views 中该 view 的 id 完全一致 */
export const VIEW_ID = 'hello.chatView';

/** 命令：新建对话 */
export const NEW_CHAT_COMMAND = 'hello.chat.newChat';

/** C16 命令：查看 / 清除审批白名单（「永久信任」的撤销入口）。
 *  ⚠️ 这份字符串必须与 package.json `contributes.commands` 里那条一字不差
 *  —— 不然命令面板里就没有它（自检里有一条钉着这个对应关系）。 */
export const FORGET_TRUST_COMMAND = 'hello.chat.forgetApprovalTrust';

export type MsgStatus = 'streaming' | 'done' | 'error' | 'interrupted';

/** 顶部模式：内嵌聊天 / harness（恒为 DSH 直播）。两套会话完全独立。 */
export type Mode = 'chat' | 'harness';

/** DSH 子进程连接状态（harness = DSH 直播时的状态灯）。 */
export type DshConnState = 'offline' | 'connecting' | 'online' | 'error';

/** 一条消息的角色。多一个 'note'：居中的灰色说明行（如「已开启全新会话」），
 *  像普通消息一样持久化/回放，但恒为 status:'done'，不流式、不带 tool 字段。 */
export type ChatRole = 'user' | 'assistant' | 'tool' | 'note';

/** 用户提到的文件引用（发送时 webview 提供：可能只有路径，内容在扩展侧读取）。 */
export interface FileRef {
  name: string;
  /** 绝对路径（能拿到时才有；浏览器拖拽/粘贴的文件没有） */
  path?: string;
  /** 已读出的文本内容（拖拽/粘贴时由 webview 先读出）。
   *  ⚠️ **图片附件永不带这个字段** —— 见下方 `dataBase64` 的注释。 */
  content?: string;
  /** 1.1 自动附选区注入的引用（非手动附件）：content = 编辑器缓冲里选中的确切文本（dirty 未保存
   *  也含）。组包时把它落成临时文件、只发 `@"临时文件"` chip → 原生 DSH 气泡保持干净（chip + 用户
   *  手打的话），agent 打开文件读到精确的选中行。写盘失败才回退内联摘录。 */
  selection?: boolean;
  /** C17：普通文件还是图片。缺省 = `'file'`（老 webview 不带这个字段，一切照旧）。 */
  kind?: 'file' | 'image';
  /** C17：图片的 MIME（只可能是上游认的那四种，见 `imageAttach.IMAGE_MEDIA_TYPES`）。
   *  **扩展侧不信这个值**：落盘时拿解出来的字节重新嗅探一遍（webview 不是可信输入）。 */
  mediaType?: string;
  /** C17：图片的原始字节数（webview 侧的 `file.size`；仅用于展示）。 */
  bytes?: number;
  /**
   * C17：图片字节的 base64（**不含 `data:` 前缀**）。
   *
   * ⚠️ 这是 **webview → 扩展的单向字段**：在 `_resolveAttachments` 里被消费掉（落盘成文件），
   * **绝不进 `Attachment`**。整份 `attachments` 会**原样落进 `sessions*.json`**，而用户提示词正文
   * 没有任何上限 —— 一次贴图就能把会话存储写成几十 MB。
   */
  dataBase64?: string;
  /**
   * 内容超限被截断。**C17 从 `Attachment` 上移到这里**：webview 自己也会截断（`MAX_CHIP_TEXT`），
   * 这个标记本来该由它发上来，扩展侧才好补一句「已截断」—— 而旧协议只允许扩展侧产出它，
   * 于是 webview 截过的那一段在扩展侧看起来是完好的（今天真实存在的一个缺陷）。
   */
  truncated?: boolean;
}

/** 读取/整理后的附件：带大小截断或读取失败的标记。 */
export interface Attachment extends FileRef {
  /** 读取失败原因（存在则 content 为空）。**图片的失败原因走它**：超限 / 不是可用图片 /
   *  二进制非文本，三条各有各的话（今天它们全都说成「文件过大（>10KB）」或干脆说成乱码）。 */
  readError?: string;
  // C17b：这里曾经有过一个 `note?: string`（图片附件「发给模型的那段说明文字」）。
  // 那段说明已经搬进**系统提示词**（见 `imageAttach.imagePromptText` / `imagePromptPlugin.ts`）——
  // 它不再随消息走，所以附件上也没有可缓存的东西了。字段整个退役：
  // 老会话存储里遗留的 `note` 是无人读的死数据（不迁移、不清理）。
}

/** 一条对话消息。id 由扩展签发，全局唯一（带会话前缀），webview 只消费。
 *  role:'note' 是居中的灰色说明行：恒 status:'done'、不流式、无 tool 字段，
 *  但和普通消息一样持久化/回放（如「已开启全新 DSH 会话…」）。 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  status: MsgStatus;
  /** 用户消息可携带的文件附件（助手消息不会有） */
  attachments?: Attachment[];

  // --- 仅 role:'tool'（harness/Agent 模式下的工具调用卡）可选；其余 role 没有 ---
  /** 工具名，如 bash / read / glob … */
  toolName?: string;
  /** 入参（等宽小字展示） */
  toolInput?: string;
  /** 工具输出文本 */
  toolOutput?: string;
  /**
   * 工具状态：running → ok / error / **unknown**。tool 不走 streaming，别用它做流式。
   * `unknown` 不是「待定」：是那次调用**没能收到结果**（进程被杀、轮被中断），
   * 跑没跑完不可知 —— 见 `runInspector.toolResultVerdict` 与 `_finishTurn` 的注释。绝不折成 error。
   */
  toolState?: 'running' | 'ok' | 'error' | 'unknown';
}

/** 历史会话列表里展示的摘要（不含整段消息，避免把大量文本塞进列表）。 */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** C6 软删除时间戳（epoch ms）。有值 = 在回收站；缺省 = 在列。 */
  deletedAt?: number;
}

// --- C6 会话全文检索 ---

/**
 * 命中处的上下文片段。**三段分开给**，不是拼好的 HTML —— webview 分别 `textContent`
 * 渲染、只给 `match` 挂高亮类，这样检索永远不会成为 innerHTML 的入口。
 */
export interface SearchSnippet {
  /** 匹配点之前的一段（被截断时前缀 `…`） */
  before: string;
  match: string;
  /** 匹配点之后的一段（被截断时后缀 `…`） */
  after: string;
}

/** 一条检索命中。`count` 只统计消息字段里的出现次数 —— 只在标题命中的会话 `count` 为 0、无片段。 */
export interface SearchHit {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
  /** 恒取第一条命中消息里的第一次出现（确定性：同一份历史 + 同一个词 → 同一片段） */
  snippet?: SearchSnippet;
}

// --- 改动审阅（2.1）：每轮 DSH 执行结束后对工作区根的文件改动做 Keep/Revert ---

/** 单个文件在本轮的改动方向 */
export type FileChangeKind = 'added' | 'modified' | 'deleted';

/** 行级 diff 的一行（扩展已按顺序排好，webview 逐行渲染即可，零前端算法）。 */
export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

/** 审阅列表里单个文件的改动项。diff 缺省 = 该文件不可预览（二进制/过大）。 */
export interface ReviewChange {
  kind: FileChangeKind;
  /** 动作主键：Keep/Revert 回指哪一项。**不能用 rel 当主键** —— C4 之后列表可能跨多个根，
   *  不同目录下可以有同名 rel（两个 `note.txt`）。 */
  id: string;
  /** 所在根的相对路径（`/` 分隔）；工作区内项目即工作区根相对路径，绝对路径不出进程 */
  rel: string;
  /** 仅展示用（basename） */
  name: string;
  /** C4：该项在工作区**外**时，这里是它的绝对目录（仅供展示；工作区内项缺省）。
   *  webview 需另起元素渲染，别并入 name —— 长路径的尾巴才是最该看见的部分。 */
  outside?: string;
  /** false（二进制/超大）→ webview 应禁用「还原」按钮 */
  reversible: boolean;
  diff?: DiffLine[];
  /** 行数或跨文件总量超护栏，diff 已被裁掉 */
  diffTruncated?: boolean;
}

// --- C3a 用量读数：每轮/每会话 token + 上下文占用率（不算钱，见 docs/backlog.md） ---

/**
 * 一份用量计数。**口径照 DSH 的 TokenUsage：三项互斥、不可叠加**——
 * `inputTokens` 是**未命中**输入，缓存命中单列在 `cacheReadTokens`；计价输入 = 两者之和
 * （DSH 另有 cacheWriteTokens，DeepSeek 不报，故不收）。
 * 注意 **`outputTokens` 已含 reasoningTokens**（适配器取的就是 completion_tokens），别再叠加。
 */
export interface UsageBuckets {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** 用量读数：扩展算好（含去重与累计），webview 只负责渲染。 */
export interface UsageReadout {
  /** 本轮（当前这一轮；无样本时三项皆 0） */
  turn: UsageBuckets;
  /** 本会话累计（跨轮、跨重开：随会话一起落盘） */
  session: UsageBuckets;
  /** C10：本会话被 DSH 压缩过几次。0 或缺省 = 没压过（条上就不显示这一段）。
   *  「发生过压缩」的正文说明是转写里那条 note；这里只是个持久的提醒 —— note 会滚走。 */
  compacted?: number;
  /** 上下文占用：拿不到上限或缺压力样本时整体缺省 */
  context?: {
    usedTokens: number;
    contextWindow: number;
    /**
     * C10：是否已接近 DSH 的压缩阈值。**判据在扩展侧算**（同 `runLine` 的分工，webview 只排版）。
     *
     * ⚠️ 口径必须诚实：这里的分子是 **provider 上报的 prompt 侧压力**，而 DSH 决定要不要压缩用的是
     * `token-meter` 的启发式估算（`CHARS_PER_TOKEN = 4`，还含输出）—— **两个不是同一个数**。
     * 所以界面只能说「接近」，绝不能说「距离压缩线还有 X」。
     */
    state?: 'ok' | 'near';
    /**
     * C10：这份读数**不是**本轮的实时值，而是上次落盘样本的回落。
     *
     * 上下文占用本来只活在内存里（`_turnUsage` / `_contextWindow`），于是"打开一个旧会话"
     * 时那条指示永远是空的 —— 而占用恰恰是这条读数唯一要说的东西。所以轮尾把最后一个样本
     * 存进会话，缺活值时拿出来用，并标上这个标志（渲染成「上次」，不冒充实时）。
     */
    stale?: boolean;
  };
}

/**
 * 扩展 → webview。
 * assistant-delta 的语义是「向 id 这条助手消息追加一段纯文本」，
 * 与真实 SSE 的 content_block_delta.text 一一对应 → 将来接真 API 协议零改动。
 */
export type ExtToWebview =
  /** 本帧当前应处于的模式（回复 ready，或在 set-mode 后确认切换完成） */
  | { type: 'mode-set'; mode: Mode }
  /** usage 可选：重开/重载会话时用它把读数条恢复出来（旧会话没存过则为缺省） */
  | {
      type: 'snapshot';
      messages: ChatMessage[];
      sessionId?: string;
      sessionTitle?: string;
      usage?: UsageReadout;
      /** C9：视图重建（重挂 webview / 切会话）时把运行读数恢复出来。
       *  纯内存、不落盘 → 窗口重载后是缺省，条上显示「本轮尚无」（旧 webview 收不到字段 = 条隐藏，不炸）。 */
      runs?: RunReadout;
      /** C20：图片通路这一档（chip 末标按它渲染）。**缺省即「关」** —— 老 webview 收不到字段
       *  就渲染成「图片输入未接通」，与今天的实际状态一致；将来通路开了，新 webview 才认这一档。 */
      imageRead?: boolean;
    }
  /** C3a：用量读数变化（每个 usage 样本一次 + 轮尾定稿一次），webview 整条重绘 */
  | { type: 'usage'; usage: UsageReadout }
  /** C6：`trashed` = 回收站内容，与 `sessions` 一起下发 —— 每次软删/恢复/彻底删都要重刷两个列表，
   *  合成一条消息比再开一条少一半触发点（也少一半渲染竞态）。 */
  | {
      type: 'history-update';
      sessions: SessionSummary[];
      trashed: SessionSummary[];
      activeId?: string;
      /** C7 留存：`days` = 当前设置（0 = 关闭），`count` = 回收站里已过期的条数。
       *  **判据只在扩展侧算**，webview 拿它决定按钮的隐藏/禁用/文案。
       *  老 webview 收不到这个字段 = 按钮不出现，不炸。 */
      retention?: { days: number; count: number };
    }
  /** C6：检索结果。`seq` 原样回传，webview 据此丢弃过期响应（配 `query` 双重校验）。 */
  | { type: 'search-results'; seq: number; query: string; hits: SearchHit[] }
  | { type: 'user-message'; message: ChatMessage }
  | { type: 'assistant-start'; message: ChatMessage }
  | { type: 'assistant-delta'; id: string; delta: string }
  | { type: 'assistant-done'; id: string; interrupted?: boolean }
  | { type: 'assistant-error'; id: string; message: string }
  /** harness 模式下：工具卡开始跑（message 为 role:'tool'，toolState:'running'） */
  | { type: 'tool-start'; message: ChatMessage }
  /** 工具卡出结果：id 更新 toolState，可选带输出文本。unknown = 结果没到（判据同 ChatMessage.toolState） */
  | { type: 'tool-result'; id: string; toolState: 'ok' | 'error' | 'unknown'; output?: string }
  /**
   * C14：工卡上那行「预计/实际改动」。`phase:'before'` = 按 `tool/call` 入参算的**预测**
   * （帧先于 dispatch，但只领先毫秒 —— 这是提示，不是审批）；同一条调用跑完再发一条
   * `phase:'after'`，**就地**换成 DSH 报的事实，或把预测明确撤掉（failed/unknown）。
   * 全是可选字段：老 webview 见到不认的 type 直接忽略，不会炸。
   */
  | {
      type: 'forecast';
      id: string;
      phase: 'before' | 'after';
      /** 一行主文案（含路径与增删数，由 changeForecast 的纯函数拼好） */
      label: string;
      /** 悬停展开的细节（原始入参路径、为什么不预览、diff 是谁算的…） */
      title?: string;
      level?: 'ok' | 'warn';
      diff?: DiffLine[];
      diffTruncated?: boolean;
      /** 没有 diff 时的那句人话（新建文件 / 二进制或超大不预览…） */
      note?: string;
      /** 事后：这条调用失败了 —— 预测作废，绝不能让它挂在卡上冒充结果 */
      failed?: boolean;
      /** 事后：本轮中断，这条调用改没改不可知 */
      unknown?: boolean;
    }
  /** harness（恒为 DSH 直播）连接状态广播：连接中/在线/错误 + 型号 + 忙否，webview 据此亮状态点 */
  | {
      type: 'backend-status';
      state: DshConnState;
      model?: string;
      detail?: string;
      busy: boolean;
      /**
       * C13：agent 的 bash 读数（顶栏那一小段）。**可选**：诊断还没算出来时不带这个字段，
       * 老 webview 收到它不认识的东西也只是不渲染（`media/chat.js` 只认 `shell`），互不打扰。
       */
      shell?: { label: string; level: 'wsl' | 'warn' | 'bad'; title: string };
    }
  /** live 运行在途（连接/等首事件期间也没有流式气泡）→ 用它锁住输入与后端开关 */
  | { type: 'run-busy'; busy: boolean }
  /** react-live（harness + DSH 直播 + dsh-live 产物齐全）：转发当前 DSH 会话的
   * 原始 session.event 帧，由真 DSH 对话组件（ChatView）增量装配成转录。 */
  | { type: 'dsh-event'; frame: DshEventFrame }
  /** react-live：把存储的 ChatMessage[] 作为「回放前缀」一次性发给真 ChatView
   * （先于任何后续 dsh-event 帧）。live 驱动据此渲染既有转录；新一帧到达后与
   * 前缀合并续聊。本消息不由扩展直发——由 chat.js 收到 snapshot 后、或在 React
   * 单包挂载完成后中继（快照可能早于挂载，取较晚者）。 */
  | { type: 'dsh-replay'; messages: ChatMessage[] }
  /** 一条 role:'note' 的居中灰字说明（如「已开启全新 DSH 会话…」），入列即渲染 */
  | { type: 'note-message'; message: ChatMessage }
  /** 回应 pick-files：系统选择器选中的文件已读好，请加入待发送列表 */
  | { type: 'files-picked'; attachments: Attachment[] }
  /** 发送被扩展拒绝（附件读取失败/过大等）；webview 应恢复输入态，已写内容不丢 */
  | { type: 'user-message-rejected'; reason: string }
  /** live 配置态广播：当前模型、可选预设、API key / DSH 运行路径是否已配置（供 composer 下的配置条渲染） */
  | {
      type: 'live-config';
      model: string;
      models: string[];
      apiConfigured: boolean;
      dshConfigured: boolean;
      /** C11：当前会话的推理档位；**null = 跟随配置**（绝不能省略 —— webview 要能区分
       *  「跟随配置」与「还没收到」，否则重连期间按钮会闪回默认文案） */
      effort: string | null;
      /** C11：可选档位（固定四档；由扩展下发而不是前端写死，防两边漂移） */
      efforts: string[];
      /** C11：底本 `thinking: disabled` —— 那时只有 `off` 合法，其余三档界面置灰 */
      effortThinkingDisabled: boolean;
      /** C12：本项目已激活的 profile 名；**null = 不用 profile**（同 effort，绝不能省略） */
      profile: string | null;
      /** C12：`.hello-chat/profile.json` 里声明了哪些 profile（名字 + 一行摘要，供菜单直接显示） */
      profiles: { name: string; summary: string }[];
      /** C12：当前 profile 钉住了模型 —— 模型菜单据此置灰（选它等于选了个不会生效的值） */
      profileModelPinned: boolean;
      /** C12：磁盘上的 profile.json 与激活时那份不一致（配置条据此提示"重新应用"） */
      profileStale: boolean;
      /** C12：解析 profile.json 攒下的错误条数（>0 时配置条要说出来，绝不静默） */
      profileErrors: number;
      /** C12：有工作区（才有 profile 文件可谈）；没有时整个菜单置灰 */
      profileAvailable: boolean;
    }
  /** 2.1：本轮 DSH 改动审阅（一轮 done 后推送整份；新一轮开始时清空/隐藏） */
  | { type: 'review-set'; changes: ReviewChange[] }
  /** 2.1：清空并隐藏审阅条与面板（新一轮开始 / 模式切换 / 全部处理完） */
  | { type: 'review-clear' }
  /** C8：这条会话该不该显示「继续」按钮（判据只有一条：上一轮以 interrupted/error 收场，
   *  见 turnState.ts）。随 snapshot 之后、以及每轮终态之后下发。 */
  | { type: 'retry-offer'; on: boolean }
  /** C9 运行检查器：本轮帧时间线（工具序列 / 轮·步·工具耗时 / 本轮错误）。
   *  `readout` 是每轮摘要（条与面板头部用，约 1 KB）；`details` 是完整记录，**只在面板开着时才有**
   *  —— 详情是 O(轮数 × 工具数)，每收一帧都发等于把最近 20 轮的工具表反复推给前端。
   *  条数/耗时/成败一律扩展侧算好，webview 只排版（同 C3a 的分工）。 */
  | { type: 'runs'; readout: RunReadout; details?: RunRecord[] }
  // --- C1 事前审批：破坏性 bash 命令在执行前弹确认条（DSH hook 阻塞整轮等用户） ---
  /** 有命令待确认：webview 弹确认条（挂在 composer 内，react-live 下也可见）。
   *  `command` 是**扩展预格式化好的展示串**：bash 调用是命令原文，C4 的 write/edit 调用是
   *  目标路径标签（模型给的 `tool_input.content` 绝不转发到前端）。 */
  | {
      type: 'approval-request';
      id: string;
      toolName: string;
      command: string;
      /**
       * C13：模型递上 POSIX 形态路径时的两读法说明（多行文本，**只显示**）。
       * 只有拿得到 hook 载荷里的 `cwd` 才算得出来 —— 缺了就不带这个字段。
       */
      pathNote?: string;
      /**
       * C16：这一条能不能「永久信任」——**能不能由扩展判定**，webview 只负责画拿到的东西
       * （命令过长、目标路径解析不出来、目录是盘根/家目录，都算不能，那时不带这个字段，
       * 拦停条上就不出现那个按钮）。带判定的文案都在扩展侧拼好，同 C15 的分工线。
       */
      trust?: { kind: 'command' | 'dir'; label: string; scope: string };
    }
  /** 这条审批有结果了：收起确认条（允许/拒绝/超时/取消） */
  | { type: 'approval-resolved'; id: string; outcome: ApprovalOutcome }
  /** C15 分支对照：一份**只读快照**（打开 / 换侧 / 点刷新时才发，没有持续推送）。
   *
   *  全字段可选 —— 旧 webview 见到不认的 type 直接忽略，不会炸（同 `forecast` 的约定）。
   *
   *  **分工线**（防两边各写一套）：**带判定的文案（`split` / `crosstalk`）扩展侧拼好**
   *  （那是判据 + level）；**纯排版（`title · 此后 N 条 · 时间`）webview 侧拼**
   *  —— 后者只是把 payload 里已有的字段摆出来。 */
  | {
      type: 'compare-set';
      /** 两侧**当前选中的会话 id**（**不是**「解出来了」的意思）。选择器要靠它置灰「本侧/对侧」，
       *  而解不出来的那一侧在 `panes` 里是缺的 —— 两个概念必须分开。 */
      sides?: { a?: string; b?: string };
      panes?: { a?: ComparePane; b?: ComparePane };
      split?: { shared: number; aAfter: number; bAfter: number; kind: 'same' | 'fork' | 'none'; line: string; title: string };
      /** 串话标注。`level: 'warn'` **只**由 `shared` 一档产生（无关会话不许出警示）。 */
      crosstalk?: { line: string; title: string; level: 'ok' | 'warn' };
      /** 快照时刻（epoch ms） */
      at?: number;
      /** 快照落下时那一轮还在跑 ⇒ 面板头要说「此后两侧的新消息不会进来」。 */
      live?: boolean;
    };

/**
 * C15 对照里的一侧。**只有分叉点之后的尾段** —— 共同前缀两侧逐字相同，不发也不渲染
 * （要全文用「导出会话」）。
 */
export interface ComparePane {
  id: string;
  title: string;
  /** 已**冻结**的尾段（`streaming`→`interrupted`、`running`→`unknown`，见 sessionStore.freezeTranscript）。
   *  冻结是为了与「真打开这条会话」看到的一致。 */
  messages: ChatMessage[];
  /** 这一侧共同前缀的条数。 */
  shared: number;
  /** 共同前缀那句说明（判定的部分扩展侧拼好，webview 只排版）。 */
  sharedNote: string;
  /** 尾段里被冻结的条数；>0 时 `frozenNote` 一并给出。 */
  frozen: number;
  frozenNote?: string;
  /** 只显示用（判据在 `crosstalk` 里），面板头写「DSH 会话 a1b2…」。 */
  dshId?: string;
  updatedAt: number;
}

/** C1 一条审批的最终去向（与 src/approvalServer.ts 的 ApprovalOutcome 同构） */
export type ApprovalOutcome = 'allowed' | 'rejected' | 'timeout' | 'cancelled';

/** webview → 扩展 */
export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'user-message'; text: string; attachments?: FileRef[] }
  | { type: 'stop' }
  /** C8：点「继续」= 把上一条用户消息**逐字重发**，接着同一个 DSH 会话再跑一轮 */
  | { type: 'retry-last' }
  | { type: 'clear' } // 新建对话
  | { type: 'list-sessions' } // 打开历史面板时刷新列表
  | { type: 'open-session'; sessionId: string }
  // --- C6：删除现在是**软删**（进回收站、可恢复），动作名跟着语义走，别再叫 delete ---
  | { type: 'trash-session'; sessionId: string }
  | { type: 'restore-session'; sessionId: string }
  /** 彻底删除（不可撤销；扩展侧会先弹原生模态确认） */
  | { type: 'purge-session'; sessionId: string }
  | { type: 'purge-trash' }
  /** C7 留存：清理回收站里超过 `hello.chat.retention.days` 的条目（不可撤销，扩展侧弹模态） */
  | { type: 'purge-expired' }
  | { type: 'export-session'; sessionId: string }
  /** C6 全文检索：扩展侧同步作答（`seq` 由 webview 单调递增，原样回传） */
  | { type: 'search-sessions'; query: string; seq: number }
  | { type: 'rename-session'; title: string } // 给活动会话重命名
  | { type: 'pick-files' } // +附件按钮 → 弹系统文件选择器
  | { type: 'set-mode'; mode: Mode } // 顶部模式切换（内嵌聊天 / Harness）
  // 下方几条来自 composer 下的配置条（仅 Harness 模式可见；Harness 恒为 DSH 直播）
  | { type: 'set-model'; model: string } // 改模型 → 扩展重启 live 子进程生效
  // C11：改会话级推理档位。`null`/缺省 = 跟随配置。与 set-model 不同，**通常不重启** ——
  // 档位是插件每次请求现读的，热生效（只有本进程第一次选档位要重连一次）。
  | { type: 'set-effort'; effort: string | null }
  // C12：切项目级 profile。`null`/缺省 = 不用 profile。**必定重连**（模型是 initialize 参数、
  // 工具白名单块要重新生成、审批 enabled 翻的是 hook matcher）；正跑着一轮时扩展会拒绝并提示。
  | { type: 'set-profile'; profile: string | null }
  | { type: 'configure-key' } // 点"API" → 扩展弹密码输入框写入 SecretStorage
  | { type: 'configure-dsh' } // 点"配置 DSH" → 扩展弹引导向导，写 hello.dsh.*（machine scope）
  // 2.1 改动审阅动作：id 为 ReviewChange.id（跨根唯一）；*-all 不带 id
  | { type: 'review-keep'; id: string } // 保留该文件改动（仅收起，不碰磁盘）
  | { type: 'review-revert'; id: string } // 用轮前快照还原该文件
  | { type: 'review-keep-all' }
  | { type: 'review-revert-all' }
  // 「在新对话中分支」：真 DSH ChatView 轮尾动作栏的分支按钮点击（无参数；MVP 固定
  // fork 整份当前会话 → 新会话保留全部转写并切换过去，记忆沿用源 DSH 会话）。
  | { type: 'fork-session' }
  /** C1：用户在确认条上拍了板（allow=true 允许执行；对失效的 id 扩展会静默忽略）。
   *  C16：`trust` 只在 `allow:true` 时有意义 —— 表示这一答还附带「记住它」。
   *  ⚠️ **webview 不是可信输入**：扩展侧会拿这次审批重算一遍可提供的粒度，对不上就不记
   *  （照样允许，只是没记住）。 */
  | { type: 'approval-answer'; id: string; allow: boolean; trust?: 'command' | 'dir' }
  /** C9：运行检查器浮层开/关。开着才把 `details` 随 `runs` 一起下发（体积控制）。 */
  | { type: 'run-panel'; open: boolean }
  /** C15：打开/刷新分支对照浮层。**幂等**（面板开着时再点 = 重新取一份快照）。
   *
   *  ⚠️ 有意**没有** `compare-close`：扩展对面板的开合**无状态**（快照只在打开/换侧/刷新时发，
   *  不像 `runs` 那样持续推送，所以不需要「开着吗」这个闸）。面板关了不必告诉扩展 ——
   *  不是漏了。 */
  | { type: 'compare-open' }
  /** C15：换某一侧的会话。`side` 只有两侧（`'a'` 左 / `'b'` 右）—— 不做第三栏。 */
  | { type: 'compare-pick'; side: 'a' | 'b'; sessionId: string };
