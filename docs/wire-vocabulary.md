# DSH wire 词汇盘点（jsonrpc-demo 这条 wire 到底发什么）

记录 2026-09-08 完成的「第 0 步：盘点运行时消息词汇表」。目标：弄清扩展作为
**裸 JSON-RPC 消费方**，在 jsonrpc-demo 这条 wire 上到底能收到哪些事件 —— 特别是
有没有审批 / 文件 / plan 类事件可依赖，避免把功能建在运行时根本不发的消息上。

方法：**静态（读 DSH 源码）＋ 动态（真跑抓帧对拍）**双验证。配套工具：
`scripts/capture-dsh-frames.mjs`（发一轮真实会话落帧）+ `scripts/frame-vocab.mjs`
（盘点帧词汇并可与基线出「新增差集」）。

## 一句话结论

> 这条 wire、当前 `examples/jsonrpc-agent/cordis.yml` 配置下：**改文件只以
> `tool/call`+`tool/result` 出现，破坏性操作（`rm`、写出工作目录）全程无审批事件，
> `reasoningEffort` 不能按会话经 initialize 下发**。要 diff 审阅与审批，都得扩展侧自造。

## 结论明细

| 路线图问题 | 结论 | 依据 |
|---|---|---|
| 有没有 file/编辑器事件可等？ | **没有**。核心事件表（`core/session/known-event-types.ts`）无 file/editor 类；实测对拍无新增。 | 静态 + 动态 |
| 有没有 approval/permission 事件可转发？ | **当前配置下没有**。`rm -f` + 写出工作目录均直接执行、零事件。 | 动态（真跑） |
| `reasoningEffort` / plan 能按会话下发？ | **不能**。initialize 多余参数被静默忽略（resp ok 但不生效）。 | 动态（C 发）+ 静态 |
| 工具失败时 wire 怎么表现？ | 只以 `tool/result` 文本回传 stderr，不产生独立事件。 | 动态 |

## 依据细节（别只看结论，防证伪）

**1. 传输层全量转发、不过滤。** jsonrpc sdk server（`packages/sdk/server/src/server.ts`
构造器）把 `ctx.on('session/event')` 原样 `notify('session.event', { sessionId, event })`。
所以「没看到 X」=「核心层没发过 X」，不是传输层吞了 —— 排除假阴性。

**2. 内部事件表确实有审批类，但本次没触发。** `known-event-types.ts` 含
`approval/asked`、`approval/decided`、`approval/policy`、`permission/preset`、
`plan/mode` 等，说明 agent 核心存在审批机制（tools 层有 `ctx.get('approval')`、
client session 有 `PendingWait('approval')`）。但当前部署配置下工具不请求审批，
所以这些事件从未上线。**将来若在配置层启用审批策略，它们会被转发** —— 扩展应把
`session.event` 里未知类型当「待观察」，别硬过滤。

**3. 实测证据（A 发，bash 工具真跑通后）。** 提示词要求 `touch a.txt → rm -f a.txt →
写 ../cap-a.txt`；实际 `tool/call=4` 全部执行成功、`turn/end reason=completed`，
写到了工作目录之外，`frame-vocab --baseline` 对基线**无新增**。5 步无任何阻断/确认。

**4. `reasoningEffort` 不是 initialize 语义字段。** `server.initialize` 只认并处理
`cwd / provider / model / maxTokens`，其余静默忽略。要调 effort 只能改
`cordis.yml` 里 `llm-deepseek`（当前写死 `reasoningEffort: max`）后重启运行时。

## 对扩展功能设计的含义

- **2.1 diff 审阅 + Keep/Revert**：扩展侧做（live 轮开始 git 快照 → 收尾 diff）。
  没有「官方 file 事件」可等。
- **审批（2.x）**：扩展侧自造（破坏性工具命令预审 / 确认条）。运行时当前不给任何
  wire 级审批入口；除非先在 DSH 配置层启用审批策略再另行评估。
- **3.1 Shield 的 reasoningEffort 菜单**：不是高优先 —— 这条 wire 下发不了，
  改配置重启才有意义。

## C8 补记：wire 方法全量清单 + 四条运行时行为（2026-09-16 实测）

C1/C5 都是「这条 wire 少东西」的教训。C8 之前把**方法的全量清单**和几条靠实测才知道的**行为语义**
补在这里 —— 这些不是推测，逐条有实证或上游源码依据，别再凭直觉重推一遍。

**方法全量清单（`dsh-sdk-jsonrpc-server` 的 `handleRequest` 是穷举 switch，故这份清单是完整的）**

| 方向 | 方法 | 说明 |
|---|---|---|
| 客户端 → 服务端 | `initialize` | 每个进程一次；只认 `cwd / provider / model / maxTokens` |
| | `session/prompt` | 提交一轮；**只回「收执」`{messageId}`，不回本轮结果** |
| | `shutdown` | |
| 服务端 → 客户端 | `session.event` | 所有转写事件（信封 `{type,seq,time,data}`，载荷在 `data`） |
| | `session.status` | 只用两个值 `running` / `idle` |
| | `subagent.started` / `subagent.finished` | |

- **没有 cancel。** 取消能力在进程内是有的（`dsh-agent-loop` 里有 `cancel`），只是**没接到这条 wire**。
  ⇒ **停止一轮的唯一手段就是杀子进程**（下一轮再惰性重启）。C8 的「中断续跑」全建立在这条约束上。
- **没有会话状态查询。** 只有 `session.status` 这条**翻转通知**（`if (status !== previousStatus) emit(...)`），
  **漏收一条就再也补不回来**。⇒ 它只能用来**放宽**判断（已知 running 就多等一会儿），
  **绝不能**用来认定「跑完了」—— 真完成信号是 idle 通知本身或子进程退出。（`TurnStatus` 的注释与
  `probe-turn-state.mjs` 里那条「已知 idle 不是完成信号」守的就是这个。）
- **同一 sessionId 的第二次 `session/prompt` 会排队，不并发、不报错。** 它进 inbox 的 `next-turn`
  队列，当前 turn 跑完后**作为独立的新一轮**被消费（`wakeDriver` 在非 idle 时只置 `wakeRequested`；
  一次 turn 只吃一条 next-turn）。收执是立刻给的，**没有幂等键**。
  ⇒ **「重发」不会造成工具重复执行** —— 这与「超时重发要防重复」的直觉相反（C8 已把这条纠正写进 backlog）。
- **resume 会自动补平未闭合的尾 turn。** 悬空 `tool/call` 补成 `tool/result`（错误码
  `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`，文案明说「结果未知，别盲重试」）+ `step/end` +
  `turn/end reason={kind:"interrupted"}`。
  ⇒ **杀掉进程之后 resume 是安全的**；也正因如此，`turn/end` 的 reason 白名单里必须有 `interrupted`
  （它是补平用的正常 reason，不是「本轮异常结束」）。
- **写盘是 200 ms 攒批**，而子进程的干净退出路径是
  `stdin end → disposeAndExit(0) → session/disposed → flush → fsync`。
  ⇒ `stdin.end()` 与 `child.kill()` 放在**同一 tick** 等于扔掉那批必然还在内存里的事件。
  实测：空闲进程 `stdin.end()` 后 **~25 ms** 就 `exit(0)`（3/3 轮），所以「先优雅、2 s 后硬杀」是划算的。
  ⚠️ 但**优雅停止只争取一次 flush，不是事务**：超时后仍是硬杀，那 ≤200 ms 的窗口只是变小、没消失。

**读 DSH 会话日志的坑**：`dsh-sessions/**/session.jsonl.zstd` 是**一串拼接的 zstd 帧**（每批落盘一个帧），
而 `zstdDecompressSync` 与 `createZstdDecompress` **都只解第一帧就收工**（实测 15 帧的文件两者都只吐 1 行）。
要读全必须自己按魔数 `28 b5 2f fd` 切帧、逐帧解。`scripts/probe-c8-runtime.mjs` 里有可直接抄的实现。

## 复现前置：bash 工具必须可用

抓「改文件/破坏性」这类帧依赖 dsh-bash-local 真能跑 bash。它在 Windows 上就是
`spawn(['bash','-c',cmd])` —— **靠 PATH 找 bash**，没有换 shell 的配置项。

本机踩过的坑：PowerShell / 从资源管理器启动的进程，PATH 里 `C:\Windows\System32` 在前，
`bash` 命中 **WSL shim**（`System32\bash.exe`）；若 WSL 没有带 bash 的默认发行版
（只有 docker-desktop），工具会一路报错。修法：装 Ubuntu 并 `wsl --set-default Ubuntu`
（让 shim 落到真 bash），加 `[wsl2] networkingMode=mirrored` 消除 Clash 本地代理告警。

## 相关

- 抓帧：`node scripts/capture-dsh-frames.mjs`（`DSH_CAP_NODE/ENTRY/CONFIG/RUNCWD/TSCONFIG/
  TOOLCWD/CRED/PROMPT/INIT_EXTRA`；key 走 `DSH_CAP_CRED` 的 YAML 或 `DEEPSEEK_API_KEY` env）
- 对拍：`node scripts/frame-vocab.mjs <帧目录> --baseline <基线帧>`
- DSH 检出对拍源：`core/session/src/known-event-types.ts`、`sdk/server/src/server.ts`、
  `shell/bash-local/src/index.ts`
- 运行时依赖治理见 `docs/runtime-dependency.md`
