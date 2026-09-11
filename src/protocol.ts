/**
 * 前后端(扩展进程 ⇄ webview)共享的「单一事实源」：
 * 所有 id 常量、消息类型都只在这里定义一次，避免字符串拼写不一致导致静默失效。
 */
import type { DshEventFrame } from './dshRuntime';

/** 活动栏容器 id（package.json 里 viewsContainers.activitybar 的 id） */
export const CONTAINER_ID = 'hello-chat';

/** webview view 的 id：必须与 package.json 里 views 中该 view 的 id 完全一致 */
export const VIEW_ID = 'hello.chatView';

/** 命令：新建对话 */
export const NEW_CHAT_COMMAND = 'hello.chat.newChat';

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
  /** 已读出的文本内容（拖拽/粘贴时由 webview 先读出） */
  content?: string;
  /** 1.1 自动附选区注入的引用（非手动附件）：content = 编辑器缓冲里选中的确切文本（dirty 未保存
   *  也含）。组包时把它落成临时文件、只发 `@"临时文件"` chip → 原生 DSH 气泡保持干净（chip + 用户
   *  手打的话），agent 打开文件读到精确的选中行。写盘失败才回退内联摘录。 */
  selection?: boolean;
}

/** 读取/整理后的附件：带大小截断或读取失败的标记。 */
export interface Attachment extends FileRef {
  /** 内容超限被截断 */
  truncated?: boolean;
  /** 读取失败原因（存在则 content 为空） */
  readError?: string;
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
  /** 工具状态：running→ok/error。tool 不走 streaming，别用它做流式。 */
  toolState?: 'running' | 'ok' | 'error';
}

/** 历史会话列表里展示的摘要（不含整段消息，避免把大量文本塞进列表）。 */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
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
  /** 上下文占用：拿不到上限或缺压力样本时整体缺省 */
  context?: { usedTokens: number; contextWindow: number };
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
  | { type: 'snapshot'; messages: ChatMessage[]; sessionId?: string; sessionTitle?: string; usage?: UsageReadout }
  /** C3a：用量读数变化（每个 usage 样本一次 + 轮尾定稿一次），webview 整条重绘 */
  | { type: 'usage'; usage: UsageReadout }
  | { type: 'history-update'; sessions: SessionSummary[]; activeId?: string }
  | { type: 'user-message'; message: ChatMessage }
  | { type: 'assistant-start'; message: ChatMessage }
  | { type: 'assistant-delta'; id: string; delta: string }
  | { type: 'assistant-done'; id: string; interrupted?: boolean }
  | { type: 'assistant-error'; id: string; message: string }
  /** harness 模式下：工具卡开始跑（message 为 role:'tool'，toolState:'running'） */
  | { type: 'tool-start'; message: ChatMessage }
  /** 工具卡出结果：id 更新 toolState，可选带输出文本 */
  | { type: 'tool-result'; id: string; toolState: 'ok' | 'error'; output?: string }
  /** harness（恒为 DSH 直播）连接状态广播：连接中/在线/错误 + 型号 + 忙否，webview 据此亮状态点 */
  | { type: 'backend-status'; state: DshConnState; model?: string; detail?: string; busy: boolean }
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
  | { type: 'live-config'; model: string; models: string[]; apiConfigured: boolean; dshConfigured: boolean }
  /** 2.1：本轮 DSH 改动审阅（一轮 done 后推送整份；新一轮开始时清空/隐藏） */
  | { type: 'review-set'; changes: ReviewChange[] }
  /** 2.1：清空并隐藏审阅条与面板（新一轮开始 / 模式切换 / 全部处理完） */
  | { type: 'review-clear' }
  // --- C1 事前审批：破坏性 bash 命令在执行前弹确认条（DSH hook 阻塞整轮等用户） ---
  /** 有命令待确认：webview 弹确认条（挂在 composer 内，react-live 下也可见）。
   *  `command` 是**扩展预格式化好的展示串**：bash 调用是命令原文，C4 的 write/edit 调用是
   *  目标路径标签（模型给的 `tool_input.content` 绝不转发到前端）。 */
  | { type: 'approval-request'; id: string; toolName: string; command: string }
  /** 这条审批有结果了：收起确认条（允许/拒绝/超时/取消） */
  | { type: 'approval-resolved'; id: string; outcome: ApprovalOutcome };

/** C1 一条审批的最终去向（与 src/approvalServer.ts 的 ApprovalOutcome 同构） */
export type ApprovalOutcome = 'allowed' | 'rejected' | 'timeout' | 'cancelled';

/** webview → 扩展 */
export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'user-message'; text: string; attachments?: FileRef[] }
  | { type: 'stop' }
  | { type: 'clear' } // 新建对话
  | { type: 'list-sessions' } // 打开历史面板时刷新列表
  | { type: 'open-session'; sessionId: string }
  | { type: 'delete-session'; sessionId: string }
  | { type: 'rename-session'; title: string } // 给活动会话重命名
  | { type: 'pick-files' } // +附件按钮 → 弹系统文件选择器
  | { type: 'set-mode'; mode: Mode } // 顶部模式切换（内嵌聊天 / Harness）
  // 下方几条来自 composer 下的配置条（仅 Harness 模式可见；Harness 恒为 DSH 直播）
  | { type: 'set-model'; model: string } // 改模型 → 扩展重启 live 子进程生效
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
  /** C1：用户在确认条上拍了板（allow=true 允许执行；对失效的 id 扩展会静默忽略） */
  | { type: 'approval-answer'; id: string; allow: boolean };
