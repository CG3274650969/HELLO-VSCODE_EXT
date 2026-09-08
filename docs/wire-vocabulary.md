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
