# 待办清单 · 商业化缺口（DSH 侧）

面向「这个插件要能商业化卖」的缺口盘点。每条含：现状 → 缺口 → 补法（标受不受 DSH wire 限制）→ 验收。
**工作方式**：一次处理一条 —— 说编号（如「C1」），我先做现状核实（含必要时在 DSH 检出侧实证），再给改造计划 → 实现 → 验收，然后回来把本行状态打勾。

状态图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[-]` 暂缓（写原因）

## 索引

| 编号 | 标题 | 优先级 | 阻塞/依赖 | 状态 |
|---|---|---|---|---|
| C1 | 事前审批（破坏性操作确认条） | P0 | 无（走 hooks 路线，不必改 DSH）。**已实现、真机实测通过**；自检 **19/19**。三轮踩坑（PATH 里的 bash 是 WSL shim / 探 shell 有竞态 / **冷启动那次的失败不该算数**）逐条见正文 | [x] |
| C2 | DSH 运行时零配置分发 | P0 | 上游 Windows 制品缺失（明文 non-goal）；阶段一自建便携包已就绪 | [~] |
| C3a | 用量可视化（每轮/每会话 token + 上下文占用） | P0 | 无（wire 带 usage，已实证） | [x] |
| C3b | 费用估算 + 预算拦截 | P0 | 无价目数据（DSH 不带）；wire 无 prompt-cancel，超限只能拦下一轮 | [ ] |
| C4 | 工作区外写护栏与可见性 | P0 | 沙箱路线已 spike 否决（bash 侧 fail-closed）；改走 C1 的 hook 扩 matcher（`bash\|write\|edit`）+ 审阅多根。**已实测通过**（2026-09-11 F5）：挡/看/还原/临时区豁免/关设置只停问不停看/同名文件不连坐，逐条见正文 —— 期间修掉一个守卫极性 bug（区外可见性曾整个不生效） | [x] |
| C5 | 会话记忆跨重启（复用 DSH_SESSION_ROOT） | P1 | wire 无 resume；已自建运行时补丁接上（upstream 有现成 resume-first 写法）。**阶段 0 闸门 + 构建冒烟 + F5 真机均已通过**（2026-09-11）：未补丁必现 id collision，补丁后跨进程答出暗号；真机五条用例逐条见正文 | [x] |
| C6 | 会话全文检索 + 导出 + 软删除 | P1 | 无。**已实现、自检 47/47、构建冒烟无回归；F5 真机七项全过**（2026-09-14，含回收站跨重启）—— 逐条见正文 | [x] |
| C7 | 删除即彻底 + 回收站留存（原「转写敏感内容治理」，**脱敏/加密已砍**） | P1 | 无。**已实现、自检 20/20、C6 自检 47/47 无回归；F5 真机八项全过**（2026-09-15）—— 逐条见正文 | [x] |
| C8 | 运行可靠性：中断续跑 + 超时幂等（原「/ 重试 / 大转写分片」，收窄，见正文） | P1 | 受「无 cancel RPC」限制。**已实现、自检全绿；F5 真机全过**（2026-09-17，用户确认） | [x] |
| C8c | 存储层写入：`persist()` 原子写 / 写入成本 / `toolInput` 上限（从 C8 ③ 拆出） | P1 | 无。**已实现、自检 64/64 + 真实数据往返无回归；F5 待办** —— 实测推翻了「`toolInput` 无上限导致增长」与「需要写入防抖」两条预设，分片/异步/防抖按实测不做，见正文 | [ ] |
| C9 | Run inspector（本轮帧时间线/耗时/工具统计） | P1 | 无（现有帧已够）。**已实现、自检 31/31 + DOM 影子自检、四项探针无回归；F5 待办** —— 耗时全靠信封自带 `time` 相减（零计时器），体积故事 = 丢弃 819/823 条 chunk；F5 实测推翻了两条预设（「配对失败恒 0」「按 `isError` 判成败」），见正文 | [ ] |
| C10 | 上下文窗口指示 + 超限压缩/归档 | P1 | 数据前置已解（C3a 已透出窗口/占用）；压缩动作本身待做 | [ ] |
| C11 | 会话级推理档位（reasoningEffort） | P1 | **受限**：wire 下发不了，需 runtime 先支持 | [ ] |
| C12 | 项目级 agent profile（工具白名单/默认模型/审批策略） | P1 | 与 C1 同源 | [ ] |
| C13 | Windows / 跨环境 shell 与路径收口 | P1 | 无（扩展侧为主） | [ ] |
| C14 | 事前 diff 预览（近似实现） | P2 | 受 wire 无 file 事件限制 | [ ] |
| C15 | 多会话并行 / 分支对照视图 | P2 | 无 | [ ] |
| C16 | 审批白名单记忆（信任一次/永久） | P2 | 依赖 C1 | [ ] |
| C17 | 多模态 / 图片附件 | P2 | 取决于模型能力 | [ ] |
| C18 | 企业集成：代理 / 远程开发 / 审计日志 | P2 | 无 | [ ] |

---

## P0 — 不补就没法谈商用

### C1 · 事前审批（破坏性操作确认条）
- **现状**：对 agent 改文件只有**事后**审阅（2.1 `_scheduleReviewAfterTurn`）；工具能 `rm -f`、能出网、能写工作区外，全程无确认（[wire-vocabulary.md](wire-vocabulary.md) 实测）。
- **缺口**：破坏性命令在执行**前**弹确认；拒绝即不执行。

**补法（已定稿，与原设想不同）**：原计划第③步「用户抉择回一条 RPC 给 runtime」**在我们的 wire 上做不到** ——
实证：`dsh-sdk-jsonrpc-server` 只暴露 `initialize / session/prompt / shutdown`，没有任何审批应答方法，
也没有服务端反向请求客户端的通道（那只有 ACP 桥与 web 的 apiproxy 有）。因此改走 **hooks 直答式**（零 DSH 源码改动）：

- DSH 的 `hooks-claude-code` 插件把 CC 风格 `PreToolUse` hook 的 `permissionDecision` 映射成 `PreToolDecision`；
  hook 由 `ctx.shell` 跑（**`bash -c`**）、**可阻塞**（默认 600s），且 `PreToolUse` 是 awaited waterfall
  → **整轮真的会停下来等人**，正是要的语义。stdin 载荷含完整工具参数（`tool_input.command`）。
- 扩展本来就拥有 `DSH_CORDIS_CONFIG` 注入权 → 指向一份**派生配置**（用户 cordis.yml 原文 + 末尾追加插件块，
  不改用户文件）；hook 脚本把命令 POST 回扩展的**本机审批服务**（127.0.0.1 + 随机端口 + 令牌），
  连接挂起到用户拍板为止。
- 留痕走两路：转写里补一条 `role:'note'`，以及 DSH 自己的 `hook/invoked` / `hook/result` 事件（现有 wire 已全量转发）。
- fail closed：扩展不可达/超时 → 脚本按内置危险清单拒绝、其余放行（不让扩展挂掉就废掉 bash）。

**实现落点**：[approvalServer.ts](../src/approvalServer.ts)（本机审批服务 + 正则策略 + 挂起表）、
[dshHooks.ts](../src/dshHooks.ts)（三件套生成 + 自检）、[chatViewProvider.ts](../src/chatViewProvider.ts)（启停/接线/留痕）、
`media/chat.*`（composer 内的确认条）、设置 `hello.chat.approval.{enabled,patterns,timeoutSec}`（`enabled` **默认开**，
不需要这道护栏的用户可自行关掉）。
覆盖范围：**仅 bash 工具**（加一个 matcher 即可扩到 fs 写工具）。已知边界：`hello.dsh.command` 整段覆盖启动命令时不可用。

- **踩到的坑（已修）**：hook 由 DSH 用 `bash -c` 跑，而**本机 agent 的 bash 是 WSL**（`pwd` 给 `/mnt/d/…`），
  不是 Git Bash —— WSL 下 `"D:\…\node.exe"` 直接 command not found，会静默失效（hook 起不来 = 非阻塞错误 = 审批形同虚设）。
  现在起服务时先用扩展进程 spawn `bash -c 'uname -s'` **探 shell**，再决定路径形态：WSL 要 exe 用 `/mnt/d/…`
  + 脚本参数用 Windows 形式（混着写），Git Bash 两边都用 Windows 形式。**两种形态都已端到端实测**。
  顺带：不能在自己工具 shell 里判 shell 类型（PATH 被污染），必须由扩展进程探。

- **踩到的坑之二（2026-09-17 已修）：探测本身是个竞态，「探 shell」不足以定形态。**
  线上症状是一条弹窗：`审批 hook 自检未通过，审批不会生效：bash 退出码 1` —— 外加上当时**只收集了 stderr**，
  而这条 bash 的话全打在 stdout 上，于是线索是一句查不下去的「退出码 1」。
  根因是**扩展宿主的 `bash` 与你的工具 shell 里的 `bash` 不是同一个东西**：扩展宿主是 GUI 起的纯 Windows 进程，
  合并 PATH 里 `%SystemRoot%\system32`（WSL shim `bash.exe`）**排在** `E:\Git\cmd` 之前 ⇒ `spawn('bash')` 命中的是 WSL shim；
  而在 Git Bash 里跑 `where bash` 会被自己的 bin 抢到前头 —— 这也是当初「两种形态都已实测」却仍然线上翻车的原因（测的环境是偏的）。
  更要命的是 `probeShell` **只采一次样**、超时 8 s 就静默回落 posix，而实测冷启动的 WSL shim 跑 `uname -s` 要 **4.8–5.5 s**
  —— VS Code 重载那一刻恰好是 WSL 最冷的时候，猜错 = 用 Windows 形态的路径去喂 WSL = `command not found` = 审批静默失效。
  **修法：`probeShell` 降级成「首猜」而非判据；真正的判据是自检本身** —— 首猜那个形态自检不过就换另一种再自检一遍，
  哪个过用哪个（两种形态互斥：A 形态的命令在 B 里必然 `command not found`，所以「谁过」无歧义）。
  两种都不过才是真接不上，此时**干净地不启用**：丢掉派生配置（不往用户 DSH 里塞一条跑不起来的 hook）、清掉 `_approval`,
  让下次 spawn 重试（冷启动失败是暂时的，热了会自愈；弹窗有 `_approvalWarned` 兜着不刷屏）。
  同时 `testApprovalHook` 的失败话术改成**同时带 stdout 与 stderr**（两边都空则明说），别再把可诊断性丢掉。
  **真机确认（2026-09-17，用户）**：重载窗口后那条弹窗**不再出现**。
  ⚠️ 这句后来**被推翻了一半**：同一天用户再次报告同一条弹窗，而且这次带全了两个形态的失败 —— 见下一条「坑之三」。
  坑之二修的是「谁先谁后」，坑之三修的才是「那次失败算不算数」。

- **踩到的坑之三（2026-09-17 已修）：换形态只解决了顺序，没解决「冷启动那次失败不该算数」。**
  线上原文：`审批 hook 自检未通过，审批不会生效：posix 形态：自检超时（15s）；wsl 形态：bash 退出码 1`。
  重载那一刻**两种形态的自检都可能在 WSL 冷启动里失败**，而这两条失败**都不说明形态写错了**：
  - `posix 形态：自检超时（15s）` —— `probeShell` 8 s 采样超时后，旧代码静默回落 **posix**，
    等于在一台 WSL 机器上把唯一跑不通的形态排在**第一个**去自检，15 s 全花在等 WSL 开机上（顺序反了）；
  - `wsl 形态：bash 退出码 1`（stdout/stderr 都是空的）—— 启动器半路熄火，不是形状不对。
  **判据**：真写错形态时 bash 又快又响 —— 实测 79–183 ms、退出码 127、stderr 上明写
  `bash: line 1: /mnt/d/…/node.exe: No such file or directory`。所以「超时」与「退出码非 0 却一个字都不说」
  是另一档：**不可判**（`HookSelfCheck.retriable`），它只说明那一刻 shell 还没起来，不说明形态错。
  修法三条，判据全落在纯函数上（`classifyShell` / `shellGuessOnTimeout` / `nextShellCheck`，探针逐条钉）：
  ① `probeShell` 的失败/超时回落从「一律 posix」改成 `shellGuessOnTimeout()` = **win32 → wsl**
  （Git Bash 答 `uname -s` 约 130 ms，永远撞不到 8 s 超时；能撞到的只有 WSL 冷启动 ⇒ **超时是 WSL 的正面证据**）；
  ② 不可判的失败**不判形态死刑**：把它排到队尾再验一次 —— 中间那次自检恰好把冷启动的时间花掉了，
  回头再验就是实测的 **359 ms 通过**（`classifyShell` 认不出的 uname 同样返回 `undefined` 而不是默认 posix）；
  ③ **重试全局只给一次**（`_approvalRetried`）：两种形态各自超时两遍 = 用户干等一分钟才看到「发不出去」。
  冷启动只发生一次，一次足够 —— 这条不是优化，是防止修法本身变成一个卡顿源。
  失败话术也改了：`事前审批未生效：审批 hook 自检没通过（**下一条消息会自动再试一次**）：…`
  —— 原话只说「审批不会生效」，没说会自动重来，用户只能以为功能坏了去翻设置。
  ⚠️ **本机复现不了冷的那一端**（`wsl --shutdown` 会杀掉用户正在跑的东西），验的是热的一端：
  把 System32 排在 PATH 最前（复刻扩展宿主那份合并 PATH）跑一遍真实排程 → `probeShell 首猜 = wsl`，
  wsl 形态 **359 ms 第 1 次就过**。
- **自检**：[`scripts/probe-approval-shell.mjs`](../scripts/probe-approval-shell.mjs) —— 用真实的 `probeShell()` + 真实生成物
  跑两种形态，钉住三个前提：至少一种能过（否则确实该弹窗）、两种互斥（所以判据无歧义）、首猜猜错时另一种能救回来；
  外加四条失败话术断言（带 stdout / 带 stderr / 两边都空要明说 / stdout 有内容却 exit 0 不能算通过）；
  坑之三的九条纯函数断言（`classifyShell` 三态含「认不出来必须 undefined」、`shellGuessOnTimeout` 的平台先验、
  `nextShellCheck` 的顺序/只重试不可判的/重试全局仅一次）与三条 `retriable` 分类断言
  （超时 → true；空手退出码 1 → true；exit 127 带 stderr → **false**）。
  `npm run compile && node scripts/probe-approval-shell.mjs` → **19/19**（本机 Git Bash 环境下跑出「posix 过、wsl 不过」，
  正是扩展宿主那边的镜像）。不需要 VS Code、不需要 API key。
  ⚠️ backlog 早先写的「由 `probe-approval.cjs` 双形态端到端自检 16/16」**不准确**：那个 `probe-approval.cjs` 只存在于当时的
  `$TEMP`，从未进过仓库（`git log --all` 无此路径），16/16 是按一次性脚本的结果记的。现以仓内这份为准。

- **默认策略放宽**：原默认只拦 `rm -f`/`rm -rf`，**漏掉裸 `rm <文件>`**（正是最常见的那种删）→ 改为 `\brm\b`（任何 rm）。
- **状态**：**已完成（运行态实测通过）**。代码 `tsc` 通过；生成物与 hook 命令由 `probe-approval.cjs` 双形态端到端自检 16/16
  （放行/拒绝/兜底/留痕/自检全过）；真机 F5 实测：开 `hello.chat.approval.enabled` + 重载窗口后，让 agent 删
  `D:\metabase\8.31数据处理\test.py`，agent 的 `rm -v "test.py"` **被执行前拦下**、整轮暂停，选「拒绝」后命令未执行，
  模型收到的工具结果是「用户在 Hello Chat 中拒绝了该命令，未执行。」并据此正确回话 —— 正是 C1 要的语义。
  （引文按当时原文保留：更名 AlohaDSH 后该句已改为「用户在 AlohaDSH 中拒绝了该命令，未执行。」，语义一字未变。）
- **验收**：开 `hello.chat.approval.enabled` → 发一句让 agent 删工作区文件 → 弹确认条、整轮暂停；选「拒绝」命令未执行、转写留痕。
  （已按此路径实测通过。）

### C2 · DSH 运行时零配置分发
- **现状**：跑起来要求本地 DSH 检出 + 新版 node + tsx + cordis.yml，靠 `hello.dsh.*` 向导手工配（[package.json](../package.json)）；runtime 锁 `rc.8` tag 靠本地脚本治理（[runtime-dependency.md](runtime-dependency.md)）。
- **缺口**：终端用户能「装完即用」的可分发包。

**核实结论（2026-09-10）：Windows 上今天没有任何上游 DSH 制品**，所以"要不要从检出构建"不是设计选择，而是唯一字节来源：
- `python/sdk-runtime/platforms.json` 只列 `linux-x64` / `linux-arm64` / `macos-arm64`，**无 windows**；
  单文件 exe 构建脚本的 `Target` 注释原话：*"Windows is a documented non-goal"*。
- npm 轨未成熟（[runtime-dependency.md](runtime-dependency.md)）→ `npm i` 拿不到可交互 stdio runtime。
- 上游把 node 载体（`packaged-bin.js`）定位为 dev-only、不进发行物 —— 我们走的正是这条路，**记为已知风险**。

- **阶段一（已完成，`[~]`）**：「**能被指向**」—— 扩展支持指向一个便携运行时目录，去掉 tsx 依赖。
  - [`scripts/build-runtime.mjs`](../scripts/build-runtime.mjs)：从 DSH 检出产出便携运行时目录。复用 DSH 为
    Python SDK 定义的零配置契约 —— `pnpm --filter dsh-jsonrpc-agent-pkg deploy --legacy …` 出闭包 →
    补 legacy hoist 漏掉的依赖 → materialize 符号链接（闭包必须无链接才可搬迁）→ 补便携 node +
    [`runtime/cordis.default.yml`](../runtime/cordis.default.yml) → 写 `runtime.json` 清单 → 收尾裸冒烟。
  - [`scripts/smoke-runtime.mjs`](../scripts/smoke-runtime.mjs)：不依赖扩展与 F5 的分离器 —— 裸 spawn 包内
    node + 入口 + 配置，喂一条 `initialize`（**不需要 API key**），断言收到 id 对得上的 JSON-RPC 回执。
    **这是整条路线的判定点**：这条不过，后面全白写。
  - 扩展侧 `hello.dsh.runtimeDir`（machine scope）：非空且 `runtime.json` 合法时**优先于** nodePath/entry/config/runCwd
    （`hello.dsh.command` 仍最高）；目录不可用**明确报错，不静默回落**。C1 的派生配置照常从运行时自带的
    `cordis.yml` 派生（`dsh-hooks-claude-code` 已核在闭包依赖集内）。
  - **我们偏离上游默认的两处**：① 不跑 `pkg`（那是 linux/macos 专有）；② 默认配置用我们自己的 ——
    上游那份 `runtime/cordis.yml` 太精简，没有 `dsh-tool-fs`（其 `fs-local` 自注写明"自身不暴露模型可见的文件工具"），
    直接用会让用户**丢掉 `read`/`write`/`edit` 文件工具**。改配置要同步保证每条 `name:` 都在闭包依赖集内。
  - **实测**（2026-09-10，win32-x64）：deploy 闭包 → 无符号链接收敛（1 轮）→ 裸冒烟
    `initialize` 回执 `{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}`，全程无 tsx。

- **阶段二（待做）**：获取入口 —— 下载/解压/校验/写 machine 设置的一键引导；产出 `.zip`（`build-runtime.mjs --zip`
  已留好出口）；把「目录从哪来」做成可插拔供给方（上游 Windows 制品 / 内网包 / 自建）。上游成熟后换 npm。
- **验收（阶段二）**：全新机器（无 DSH 检出、无 node）按引导走完 → 状态点转绿并发通一轮，且 `read`/`write`/`edit` 工具齐全。
  阶段一的验收是「手工指向一个便携运行时目录后上述成立」。

### C3a · 用量可视化（每轮/每会话 token + 上下文占用）✅ 2026-09-10
- **原文（保留，见下方旁注）**：成本与用量可视化 + 预算拦截 —— 现状：代码里无任何 token/费用统计；`reasoningEffort` 写死 max，跑一轮烧多少只能看账单。缺口：每轮/每会话 token+估算费用；月累计；达阈值提示/停跑。补法：先核实 runtime 是否在 `turn/end` 或 `tool/result` 带 usage 元数据（抓帧未见，需在 DSH 检出侧确认）；拿不到就在 llm 插件层记并透出。UI 挂在配置条/状态点旁。验收：发一轮后能看到本轮 token/费用；设 ¥ 上限后超限被拦。
- **旁注（2026-09-10 核实）**：「抓帧未见」是当时的准确记录 —— 当时抓帧里**确实没有** usage。后来两路实证都指向 wire 是带的：① DSH 源码 `packages/llm/token-meter/src/usage-projection.ts:75-80` 只从 `assistant/chunk`(`chunk.type==='usage'`) 与 `assistant/message`(`data.usage`) 取数，而这两个都是持久事件、sdk/server 承诺逐个透出；② 本仓 2026-09-08 起新增的抓帧里能直接看到 usage 与 `request/context`。**故不必在 llm 插件层记账，纯扩展侧即可。**
- **本次做的（C3a）**：每轮 + 每会话累计 token（按计价口径：`↑` = 计费输入 = 未命中 + 缓存读；`↓` = 输出，已含 reasoning，**不加**）、缓存命中率、上下文占用（`已用 / 窗口`）；读数条挂在 composer 内输入卡正上方（react-live 与 DOM 两态都可见）；会话累计随会话落盘。
- **三个必须记住的线上语义**（实现正确性全靠它们，都有实证）：
  1. 计数**互斥** —— `inputTokens` 是**未命中**输入，缓存读单列 `cacheReadTokens`；`reasoningTokens` 是 `outputTokens` 的明细，**绝不另加**。
  2. **每 step 的 usage 会报两次**（`assistant/chunk(usage)` 早样本 + `assistant/message` 终样本，二者逐字节相同）→ 按 `(turn,step)` 为键**后到覆盖**；天真累加恰好是真实值的 **2 倍**（三份抓帧实测全部 2 倍）。
  3. `request/context` **每会话恰好一条**（会话开头），带 `{provider, model, contextWindow}` → 占用率的分母从会话开始就有。
- **验收（已过）**：跑一轮后读数与本仓抓帧离线去重真值同量级（`…09-07T07-36-29` 那份：2 step / 未命中 80 / 缓存读 3712 / 输出 118，命中 97.9%）；切会话/切模式/新建 → 本轮归零、累计跟随；重开窗口 → 累计仍在；fork → 继承源会话累计。

### C3b · 费用估算 + 预算拦截
- **阻塞**：① DSH 全仓无任何价目数据（`packages/` 已 grep，命中的都是 compaction 的 "token cost" 启发式）→ 做费用就得自己维护一张会变的价目表；② wire **没有 prompt-cancel**（`sdk/server` README 明说无 per-session close / prompt-cancel），中途叫停只能 `kill()` 子进程 → 「超限被拦」最多只能拦**下一轮**，拦不了正在跑的那轮。
- **补法**：价目表 + 月累计（需跨会话聚合）+ 阈值提示；拦截做成「下一轮发送前拦」。
- **验收**：发一轮后能看到本轮费用；设 ¥ 上限后下一轮被拦。

### C4 · 工作区外写护栏与可见性
- **现状**：2.1 审阅只对比工作区根，agent 写到工作区外的改动**完全看不见**（wire 实测已发生过）。
- **缺口**：越界写要能被挡住，或至少显式可见 + 可还原。
- **原文的补法（保留，见下方旁注）**：与 C1 同源（审批策略里对「路径出工作区」这类规则开审批）；扩展侧在 tool/call 的 `arguments` 里做路径解析，越界即标红/需确认。纯 wire 无法枚举文件事件，故以「命令级预判」近似。
- **原文的验收（保留）**：让 agent 写工作区外路径 → 弹确认或标红；工作区内改动仍走 2.1 审阅。

#### 旁注（2026-09-11 沙箱 spike 核实）

先查了「DSH 自带的沙箱能不能直接挂上」，结论是**挂得上、也真拦得住，但在这个部署里护不住 bash，因此当不了护栏**。全程用 `scripts/probe-sandbox.mjs` 实测（把用户那份 `cordis.yml` **原样派生**到临时目录：块内改 `fs-local`→`@deepseek-ai/dsh-fs-sandbox`、追加 `sandbox-policy`（`mode: workspace-write`）与 `sandbox-local`，其余一字不动）：

1. **挂载成功**：便携运行时 boot 通过，`initialize` 回执正常；`write`/`edit` 的工具描述里**自动多出了 `sandbox_permissions` + `justification` 两个参数** —— 这正是「后端确实在围栏」的信号。
2. **fs 围栏真拦得住**：让它写 `../escape-probe.txt`（工作区外、且**不在 `os.tmpdir()` 里**）→ `Error: [sandbox: file access denied under workspace-write mode]`，文件没落盘。
   ⚠️ 第一次测的时候目标放在了 `Temp` 下，**写成功了** —— `workspace-write` 明确把平台临时区算作可写根（见 `dsh-fs-sandbox` README 的 `writableRoots`）。挑越界目标时必须避开 `os.tmpdir()`，否则测了个寂寞。
3. **升权是死路**：模型被拒后按工具提示重试 `sandbox_permissions: "danger-full-access"` → `Error: sandbox escalation to "danger-full-access" requires approval, but no approval service is composed`。升权走的是 DSH 内部的 `ctx.approval.request(...)`，**本部署没挂审批服务**；而 C1 那个 PreToolUse hook 的 matcher 是 `bash`，fs 工具的调用**根本到不了它那儿**。fail-closed 属实 —— 但在我们这儿等于「升级通道不存在」。
4. **bash 一换沙箱就废（本次最关键的一条）**：把 `bash-local` 换成 `@deepseek-ai/dsh-bash-sandbox` 后，**连 `echo hello-bash` 都跑不起来** —— Windows ACL 受限令牌创建不了 Bash 服务实例，回的是 UTF-16 的 `Bash/Service/CreateInstance/E_ACCESSDENIED` + `[exit code: 1]`，裸看是乱码。fail-closed 的设计没错，代价是 agent 的主工具**全没了**。
5. **只护 fs 等于没护**：保持 `bash-local`（不沙箱）时，一条 `bash` 命令就把 `../escape-probe.txt` 写出来了（实测内容 `hello\n`）—— bash 是**另一条执行路径**，fs 围栏看不见它。所以「只挂 fs-sandbox」给不了任何保证。
6. **顺带**：`@deepseek-ai/dsh-bash-sandbox` **不在便携运行时的闭包里**（它是 `dsh-agent-spine-demo` 的 devDependency，不是 prod 依赖）→ 真要用得先改分发包；本次是临时拷进去测的，测完已删。

**一条软性观察，值得记着**：第一轮把提示词写成「这是越界写测试，请照做」时，模型读到 `sandbox:policy` 上下文后**自己就拒绝了**（零 tool call）。换成不点名的相对路径 `../escape-probe.txt` 才写出真实调用。→ **策略上下文能让模型收敛，但那是模型的自觉，不是围栏**，验收时别拿"它没写"当"拦住了"。

#### 旁注之二（同日补齐）：沙箱不是唯一的路，C1 的 hook 本来就覆盖所有工具

上面第 4/5 条把沙箱判了死刑，但**别因此以为「挡住」没戏了** —— 查 C1 那条路时发现它比当初以为的宽：

- `dsh-hooks-claude-code` 的 README 明写：`PreToolUse` 映射到 harness 的 **`tools/pre-execute`**，而**「matcher 的主语就是工具名」**（没有任何"只对 bash 生效"的限制）。
- `packages/core/tools/src/index.ts:152` 的 `tools/pre-execute` 签名确认它是**逐次工具调用的注册表级闸门**（收 `(name, parsed arguments, caller agent)`），不是 bash 专用。
- 因此 C1 那套「阻塞式 hook + 本机 HTTP 回问扩展」**原样就能管住 `write`/`edit``：hook 脚本读 `tool_input.file_path`、判是否在工作区内，越界就弹同一条确认条。**不需要沙箱，也不需要新机制。**

一个必须绕开的坑，README 和源码注释都点了名：`PreToolDecision.ask` 在**没有审批服务时会退化成拒绝**（同上面第 3 条的死因）。C1 当初正是绕开了它 —— 用 `deny` 拦住 + 自己起 HTTP 问扩展，用户点「允许」再放行。C4 沿用这个模式即可，别去碰 `ask`。

**已实测（`probe-sandbox.mjs --fs-hook`）**：不挂任何沙箱，只挂一条 matcher `write|edit` 的 stub hook，让它写**工作区内**的 `note.txt` —— 结果 `hook/invoked` + `hook/result` 各一条，stub 收到 `tool_name: "write"`，`note.txt` **始终没被创建**。→ **拦在工具执行前，没有绕过面。** 写工作区内路径是刻意的：这样"没落盘"只可能来自 hook，跟路径包含判定无关，一次只问一个问题。

载荷形态（照抄，C4 的脚本按这个写就对了）：

```json
{"session_id":"…","transcript_path":"…","cwd":"<会话工作区>","hook_event_name":"PreToolUse",
 "tool_name":"write","tool_input":{"file_path":"note.txt","content":"hello"},"tool_use_id":"call_…"}
```

两个省事的地方：**`cwd` 就是会话工作区**、`file_path` 是模型给的原始路径（可以是相对的）→ containment 判定在 hook 脚本里自己就能做完，不必让扩展额外把工作区根传过去（C1 现在传给脚本的只有 url/token/timeout）。

顺带一条配置纪律：`fs-sandbox` 缺 `ctx.sandboxPolicy` 时**在 boot 期就 fail-fast**（报 `pending (waiting for service: sandboxPolicy)` 并整体启动失败），不会静默降级 —— 探针第一次就是这么撞上的。

#### 已实现（2026-09-11）：hook 扩 matcher + 审阅多根

**范围由用户拍板**：① 「挡」和「可见」一起做；② **bash 侧本次不扩**（不解析命令串里的路径），局限写进设置说明与本文档。

**挡（`_askNeedsApproval`）**：hook matcher 从 `bash` 改成 `bash|write|edit`；hook 脚本按 `tool_name` 分叉 —— bash 那段一字未动（含兜底清单），write/edit 段把 `{toolName, filePath, cwd, toolUseId}` POST 回来。`ApprovalServer` 只管传输与挂起，**策略全部外移到扩展注入的谓词**（连带把 C1 的正则循环抽成导出的 `matchesAnyPattern`）。扩展侧 `_isOutsideWorkspace` 判目标是否越出**载荷里的 `cwd`**（拿不到才退回工作区根；**绝不用 `_dshCwd()`** —— 它无工作区时会退成用户主目录，拿家目录当"界内"等于放行一切）。

两条防呆，都写进了注释：
- 谓词抛异常 → **当 ask 处理，不是 deny**（否则 containment 里一个 bug 会把**所有** bash 与写文件全拒掉）。
- `onObserved` 抛异常 → **吞掉**（它做同步磁盘 I/O，观察失败绝不能反过来拒掉这次写）。
- hook 脚本侧：扩展不可达时 bash 走兜底清单，**fs 工具一律放行** —— 护栏失效可以，让 agent 连正常写文件都做不了不行。

**可见（`_onApprovalObserved` + 审阅多根）**：同一条 hook 在**工具执行之前**额外回调扩展一次，给越界目标抓一张轮前快照。于是：被拒绝的写从不落盘 → 轮末对比自然没有它；用户自己同一轮的编辑不会被算成 agent 的（只快照目标那一个文件）。2.1 的单根 `_baseline`/`_reviewRootAbs` 换成 `_reviewRoots: Map`，区内是树根、区外是**单文件根**（`snapshotSingleFile`，新加在 `fileSnapshot.ts`，与树根共用抽出来的 `readEntry`，所以 `compareTrees`/`applyRevert` 一行没改）。区外根**键用目标文件绝对路径**（不是父目录 —— 同目录两个目标会撞键），先到先得（第二次写的"轮前"已被第一次写污染），上限 20 个且**满了不做淘汰**（淘汰会丢已有可还原项）。临时区（`os.tmpdir()`）双向豁免：不弹条也不进审阅。

`ReviewChange` 因此多了 `id`（动作主键，`review-keep`/`review-revert` 从 `{rel}` 改成 `{id}` —— 跨根之后不同目录会有同名 `rel`）与 `outside`（仅供显示的绝对目录）。

**验收（本次）**：
- `npm run compile` 通过；`node probe-approval.cjs` **26/26**（两种 shell 形态 × 非 bash 工具放行 / 非破坏性命令放行 / 裸 `rm` 拒绝 / write 载荷拿到 deny / 服务端收到 filePath+cwd / onObserved 每次回调 / 扩展不可达时 bash 拒绝而 write 放行 / 其它工具不表态 / 留痕成对）。
- `snapshotSingleFile` 的增/改与还原（added 还原=删掉）已用一次性脚本实测；containment 判定的 8 个刁钻输入（含 `C:\proj2` 不被 `C:\proj` 骗过、`..foo` 正常子目录不误判）全部符合预期。
- **F5 真机已通过**（2026-09-11，见下节记录）。

#### 真机验收（2026-09-11，F5 · 会话 `a47e28a9`）

> 首次真机自检**没通过**，且失败是静默的 —— 见下方「验收中发现并修掉的 bug」。修完重跑，下列各项逐条压在盘上/留痕上。

| 项 | 判据（可复核） | 结果 |
|---|---|---|
| 区内写 | `c4-note.txt` 不弹条、轮末出 `M` 行；点还原 → 内容回到轮前的 `hello` | ✓ |
| 区外写·拒 | `D:\c4-verify\hello.txt` 首次被拒 → 文件不存在；轮末审阅里也没有它 | ✓ |
| 区外写·许 | 允许后落盘；轮末审阅出现该行，带 `工作区外 · D:\c4-verify` | ✓ |
| **区外还原** | `D:\c4-verify\d.txt`（13:14 agent 自己 `ls` 过）被「还原」删掉，留痕落 `已还原本轮 DSH 改动：d.txt` | ✓ |
| 临时区 | `%TEMP%\adsh-temp-test.txt` 落盘但**无审批留痕**；「问」与「看」共用 `_isTempPath`，同免 | ✓ |
| 关 `outsideWorkspace` | `D:\c4-verify\e.txt` 落盘、**无审批留痕**（确实不问）；审阅行照旧出现 | ✓ |
| 改设置不重启 | 全场 **0 条**「已开启全新 DSH 会话」留痕 —— 子进程一重启，UI→DSH 会话映射就没了，必然插一条 | ✓ |
| 同名文件 | `D:\c4-verify\same.txt`(aa) 与 `D:\c4-verify2\same.txt`(bb) 两行并存；对一行「保留」后**它还在**，对另一行「还原」后**它没了** —— 两个同名 `rel` 不连坐 | ✓ |
| bash 不回归 | `rm -rf /mnt/d/mnt` 与 `rm -v "test.py"` 照常弹条 | ✓ |

**验收中发现并修掉的 bug（`chatViewProvider._onApprovalObserved` 首行守卫极性写反）**：

```ts
if (this._abort || !this._reviewChangesOn()) return;   // 错
if (!this._abort || !this._reviewChangesOn()) return;  // 对
```

`_abort` 是**本轮**的 AbortController —— `_sendUser` 里设上、`_runLive` 的 finally 里清掉，所以**一轮跑着的时候它恰恰非空**；而 PreToolUse hook 只在**轮中**触发。于是这个方法每一轮都在第一行当场 return，行都没执行过。文件里其余 6 处 `if (this._abort)` 都是「轮跑着 → 别动」的意思，只有这一处把它读成了「没轮在跑」。

症状之所以静默：**区内行来自轮首播种的工作区树根，根本不走这个方法**，所以区内审阅一切正常；区外一条也记不上 → 轮末 `pending` 为空 → 不发 `review-set`，而轮首已发过 `review-clear` → **整条审阅条消失**。用户看到的是「没有还原按钮」，实际是「一条都没有」。这也是为什么先前 F5 那轮把 `hello.txt` 判成「用户没点还原」是误判 —— 那条路从来没通过。

**教训（值得记着）**：这个 bug 的全部代价都由「可见」那半承担，而用户视角里最像的解释是「UI 少了个按钮」。真机验收时要盯**留痕**（notes 是扩展自己写的，不受 UI 影响）而不是盯界面元素 —— 三条 `已允许执行：写工作区外的文件：…` 都在，说明「问」那半好着；`已还原本轮 DSH 改动：…` 缺一条，才是「看」那半断了。

**局限（明确不做，验收时别当 bug）**：
- **bash 未覆盖**：不解析命令串里的路径。→ 护栏可被一条 `cp`/`mv`/`>` 绕过，且**bash 写出的区外文件也不会出现在审阅里**（那句"没看见"不等于"没发生"）。
- 定位不了目标路径时（如 hook 递上来的是 POSIX 形态的 `/mnt/...`）按**越界**处理：会问，但抓不到快照 → 只在确认条出现，不进审阅。**F5 真机撞上过这条**（2026-09-11）：agent 在 WSL 侧先探到 `PWD=/mnt/d/...`，于是拿 `/mnt/d/metabase/8.31数据处理/c4-note.txt` 调 `write` —— DSH 的 fs 工具把这个 POSIX 绝对路径当 **Windows 相对路径**解析，落到了 `D:\mnt\d\metabase\8.31数据处理\c4-note.txt`（多出一层 `mnt\d`，模型自己发现后删掉了）。我们这边：确认条按预期弹了（fail-safe 生效），但因为路径定位不了，**没抓快照 → 没进审阅**，`D:\mnt\...` 那棵树对本轮审阅完全隐形。
  ⚠️ 这是 **DSH 侧**的路径解析行为，不是我们的 bug；但它意味着「区外写」在 WSL 视角下很容易落到一个谁也想不到的位置。真要覆盖，得让 hook 把 `cwd` 和 `file_path` 都按 Windows 形态归一（`/mnt/<盘>/…` → `<盘>:\…`）再判 —— 本次没做。
- 符号链接按**解析后**的位置判定。
- 扩展不可达 → fs 一律放行：护栏降级，**可见性同时停摆**。
- `hello.dsh.command` 整段覆盖启动命令 → 没有 hook → 两样都没有。
- 轮次被停止/报错 → 该轮的区外条目随 `_dropReview` 一并丢弃，没有还原路径（与 2.1 原有行为一致）。
- 区外改动**不跨轮留存**，仍随轮清理。

**复测工具**：① 沙箱能否重开 —— `node scripts/probe-sandbox.mjs --base-config <你的 cordis.yml>`（哪天 DSH 的 Windows ACL runner 兼容 WSL，或换 Linux/macOS 跑，重跑第 4 条即可）。② hook 通路 —— `node probe-approval.cjs`。

---

## P1 — 商用体验硬伤

### C5 · 会话记忆跨重启（复用 DSH_SESSION_ROOT）  [x] 2026-09-11
- **现状（改前）**：`_dshSessions` 映射只在单次 activation 有效；host 重启/切模型即清空，续聊开全新 DSH 会话并插「失忆」note。会话其实**已经落盘**（`DSH_SESSION_ROOT` → `globalStorage/dsh-sessions/`），通道是通的，我们没复用。
- **实证（2026-09-11，DSH 0.1.0-rc.8 / win32-x64）—— 推翻了本轮开工前的乐观假设**：
  1. **wire 上根本没有 resume 方法**：`dsh-sdk-jsonrpc-server` 的 `handleRequest` 只认 `initialize` / `session/prompt` / `shutdown`。
  2. **把已落盘的 id 硬塞给 `session/prompt` 不是「续上」是「炸」**：它走 `createSession` → `ctx.agents.create`（纯内存、从不读盘），随后持久化协调器在 `session/created` 上 `adoptLivePrefix`，`seedCoversPrefix([], storedEvents)` 失败 →
     `session "<id>" already has a persisted log on disk that does not match this live session (id collision)`。故障在第一次 LLM 流之前的 checkpoint 上以 fail-closed 姿态出现。
     → 顺带治掉一个既有的潜在雷：`_cancelActiveRun` 中止后不清 `_dshSessions`，下一次发送会在新子进程里复用同一个已落盘 id，走的**正是**这条炸路。
  3. **能力是有的，只是没接到 wire 上**：`ctx.agents.resume(options)` 是公开接口（`@deepseek-ai/dsh-agent` 的 `index.ts`，单参、内部自持 `ownerCtx`），upstream 自己就有现成的 **resume-first** 写法 `restoreOrCreateConfigured`（`@deepseek-ai/dsh-agent-loop`）—— 先 resume，**只有确实没有磁盘工件**时才 create，损坏/后端失败一律照抛（其注释原话：*"corruption and backend failures stay loud"*）。
- **补法（路线 A，用户拍板）**：在**我们自己的构建脚本**里对**构建产物**做这一处替换，用户的 DSH 检出**一个字不动**。
  - [scripts/runtime-patch.mjs](../scripts/runtime-patch.mjs)：唯一持有锚点文本的地方；锚点出现次数 ≠ 1 就 throw（不是 `includes`）。
  - [scripts/build-runtime.mjs](../scripts/build-runtime.mjs)：构建期打补丁，并把 `patches: ['resume-first-session']` 写进 `runtime.json`；打不上直接构建失败（静默放过 = 交付一个一 resume 就炸的运行时）。同时断言扩展侧判据常量与本模块 `PATCH_NAME` 一字不差 —— 改了名字只改一边是**静默**丢记忆，只能靠构建期钉死。
  - 扩展侧：`StoredSession.dsh = { id, cwd }`（嵌套 = 两者同生共死）随会话落盘；`_ensureDshSession` 在「运行时带补丁 **且** 盘上身份属于当前工作区」时复用旧 id，否则维持每 activation 新铸。note 二分：「已恢复此前的 DSH 会话记忆」/「已开启全新 DSH 会话」。
  - 分支（`_forkSession`）继承 `src.dsh` → 「分支共享同一份 DSH 记忆」的既定语义跨重启也成立。
- **闸门**：[scripts/probe-resume.mjs](../scripts/probe-resume.mjs) 跑两个对照组（同 sandbox / 同 `DSH_SESSION_ROOT` / 同 sessionId，只差补丁）—— A 未打补丁**必现** id collision；B 打补丁后模型答出轮 1 埋的暗号。**A：轮 1「好的」→ 轮 2 id collision（零输出）；B：轮 1「好的」→ 轮 2「7413」** ✅
- **回归**：`smoke-runtime.mjs --resume` 并入 `build-runtime.mjs` 收尾冒烟（拿不到 key 就打醒目 ⚠ 跳过、以 0 退出，**不假装验过**）。实跑四项全过，含 `裸 initialize` 判据（无回归）。
- **已知局限**（接受并记录）：
  - **补丁悬空**：日志被手工删除、或同一工作区从别的机器同步过来只有转录没有 `dsh-sessions/` —— 此时 `list()` 说「不存在」，补丁按 upstream 纪律回落 create，于是**静默**开新会话（note 却说是「已恢复」）。这是唯一残留的静默窗口。
  - **改动前建的旧会话，第一次续聊必丢一次记忆**：那时盘上还没有 `dsh` 字段，我们无从知道它上次用的 id，只能铸新的（note 会如实说「已开启全新 DSH 会话」），从那一刻起才稳定。
    *考虑过但不做*：`dsh-sessions/<cwd 桶>/` 的目录名前缀就是 uiId，本可按「uiId 前缀 + cwd」反查、唯一命中就认领旧 id，把这一次失忆省掉。用户 2026-09-11 明确不做 —— 收益只有一次性的一次失忆，代价是要处理同前缀多条的歧义（已有会话就有两条）。
  - **只有便携运行时带补丁**：开发者路径（手配 `nodePath`/`entry`）与 `hello.dsh.command` 走用户自己的 DSH，**没有补丁** → 那里维持「每 activation 新铸 + 失忆 note」的老行为（硬复用会撞 id collision，门控就是为了不把这条炸路递给用户）。手配路径指向我们已打补丁的产物则能用。
  - 删会话不删磁盘 DSH 日志 → **C7 已接手**：「彻底删除」现在会把该会话的 DSH 日志目录一并删掉（仍被分支引用的除外）。软删（回收站）期间日志照旧保留。
  - 不验跨 DSH 版本的日志兼容（升级 DSH 后旧日志能否 resume，未验）。
  - resume 失败**不自动换新 id 重试**：错误照抛、用户可见。⚠️ C8 收窄后这条**仍然成立**：wire 上没有会话状态查询，自动重试等于赌博，C8 只做了「人点一下」的重试。
  - 分支不做「真分叉」（复制日志成新 id），延续既定的共享语义。
- **验收（2026-09-11 F5 真机，五条全过）**——沿用 C4 的教训，**盯留痕（note / 盘上指针），别盯界面元素**：
  1. 发两轮埋暗号 → 重载窗口 → 点回**那个**会话问 → 答出暗号，note「已恢复此前的 DSH 会话记忆」。
  2. 完全关掉 VS Code 再开 → 点回该会话 → 仍记得（hostRand 换了新值，证明**存储里的 id 说了算**）。
  3. 中止后再发 → 不报 id collision（阶段 0 那条潜在雷一并治掉）。
  4. 建分支 → 分支的 `dsh.id` 与源**逐字相同**，继续聊记得。
  5. 换工作区打开 → note 是「已开启全新 DSH 会话」（**不假装记得**），且切回原工作区后**仍然记得** —— 盘上指针的 `cwd` 一字未变，没被覆盖。
  - 踩过的坑（记下来免重犯）：**「续聊」必须点回原会话**。新建一个对话再问暗号，那是另一个 DSH 会话，模型当然不知道 —— 一度被误判成缺陷。盘上会话 `dsh` 指针 + note 文本是唯一可靠的判据。

### C6 · 会话全文检索 + 导出 + 软删除  [x] 2026-09-14
- **现状（改前）**：历史是 per-mode JSON；有改名/按**标题**搜索/物理删除（`remove()` 直接 filter 出数组）；无内容检索、无导出、无回收站，且删会话**没有二次确认**。
- **用户拍板的四个决策**：检索面 = 正文 + 工具的**命令名与入参**（不搜 `toolOutput`）；回收站**纯手动**清理（单条彻底删 + 清空，不做自动过期）；导出 = **单会话** Markdown + JSON；彻底删除**不碰** `dsh-sessions/` 日志（归 C7）。
  - 一处**有意偏差**：**`note` 消息不参与检索**。全库的 note 都是我们自己写的状态播报（「已开启全新 DSH 会话…」「已允许执行：…」），搜「会话」「DSH」会命中几乎每个会话、片段毫无信息量；它想提供的信息（我上次跑过什么命令）本就由 `toolInput` 覆盖。
- **补法**：三个纯模块 + 协议 + webview。
  - [src/sessionStore.ts](../src/sessionStore.ts)：`deletedAt` 软删。**软删必须原地打标记，绝不 filter 出数组** —— `_active` 就指向数组里那个对象，而 `replace()` 是「找不到就 push」，代码里已有两条现成复活路径（`_afterTurn` 轮尾、`_openSession`），摘出去的话「删了再发一条消息就自己回来」。`_load` 的 `.filter(s => s.messages.length > 0)` **保持原样**（回收站会话必有消息，天然活过重启；补一句 `&& !s.deletedAt` 就会让回收站一重启就空）。`normalize` 里 `deletedAt` 非有限正数一律删掉 —— 失败朝**可见**方向倒。过滤规则收口进 `active()`，顺手删掉 `_sendHistory` 里那份会漏改的重复 filter。
  - [src/sessionSearch.ts](../src/sessionSearch.ts) / [src/sessionExport.ts](../src/sessionExport.ts)：新增纯模块，**只 `import type`、绝不 import `vscode`**（自检脚本要在扩展宿主之外加载它们；这是那条约束的唯一守卫）。
    - 检索用 `new RegExp(escapeRegExp(q), 'gi')` 而非 `toLowerCase()+indexOf`：`İ`(U+0130) 小写后长度变 2，那种写法会让下标整体错位、片段切在别处且不报错。片段按 `match.index` 取原文三段交给 webview 分别 `textContent`（**检索不是 innerHTML 的入口**）。
    - `toolInput` 只搜**前 400 字符**：它由 `prettyValue()` 生成、**没有长度上限**（对比 `toolOutput` 有 4000），write/edit 的入参里是整份文件正文 —— 不截就是「搜文件内容」。
    - Markdown 导出的**围栏按内容里最长的反引号串 +1 动态加长**：这是唯一能静默毁掉整个文件的 bug（正文里一行 ``` 就提前闭合围栏）。`toolInput`/`toolOutput` 在 md 里截到 4000 并标「已截断」；**JSON 导出不截**，要无损用它。
    - 文件名消毒（非法字符 / 结尾点空格 / 长度 / Windows 保留名）**非做不可**：`_renameSession` 用用户原样输入、不封顶，直接拿标题当默认名会在 Windows 上预填非法名。
  - 导出流程：先 `showQuickPick(['Markdown','JSON'])` 定格式（**不用扩展名反推** —— `path.extname('讨论 v1.2')` 返回 `.2` 不是空串，那条路上「无扩展名」分支根本进不去）→ **点击那一刻就冻结会话快照**（对话框是 await 的，期间活动会话还在流式追加）→ `showSaveDialog` → `vscode.workspace.fs.writeFile`（不是 `fs.writeFileSync`，只读/远端路径交给 VS Code 报错）。
  - 不可逆动作走**原生模态**（`showWarningMessage({modal:true})`）：彻底删单条 + 清空回收站（文案带**点击那一刻**的条数）。软删**不加**确认（可恢复，弹条反而碍事）。
  - 检索走 `seq` 防过期：webview 侧 **seq 全局单调**（开关面板/切标签都**不**归零，否则关闭前在途的 `seq=1` 会撞上重开后的 `seq=1`）+ 回包时 `query` 双重校验；扩展侧 handler **全程同步**（同步 ⇒ `postMessage` FIFO ⇒ 响应顺序 = 请求顺序，seq 才有意义）。`history-update` / `snapshot` 到达时若查询非空**立刻重发检索**，否则「删一条，搜索结果就整片没了」。切模式清检索态。
  - `_openSession` 加守卫：回收站里的会话不许被打开（真实路径：点检索命中 → 列表里把它删了 → 再点那条仍在屏上的命中），否则会给一个「已删」会话继续烧 DSH 记忆。`purge` 顺带清 `_dshSessions` 缓存；`softDelete`/`restore` **不碰**它（回收站期间记忆保持可用）。
- **自检**：[scripts/probe-session-tools.mjs](../scripts/probe-session-tools.mjs)（入库；`npm run compile && node scripts/probe-session-tools.mjs`，用 `await import(pathToFileURL(...))` 加载 `out/` 产物）—— **47/47 通过**，覆盖：正文命中（验收那条）、`toolOutput`/`note` 的**反向**断言、`toolInput` 400 字符窗口、`a.c` 不匹配 `abc`、`İ` 错位、emoji 不切出落单代理项、count/snippet 确定性、围栏穿透（含「整串就是围栏」「四连反引号」）、JSON 往返深等 + `undefined` 被丢弃、文件名消毒、以及**软删生命周期**（幂等 / `restore` 顶 `updatedAt` / **软删 → persist → 重开 store 仍在回收站**这条真回归闸门 / 坏 `deletedAt` 值回到在列 / `purge` 拒绝在列会话 / 清空回收站空时不动文件）。
  - 期间修掉一个**测试写坏**的真缺陷：标题按 UTF-16 截断会切出半个 emoji（代理对中间），已改为回退一格。
- **验收（F5 真机 2026-09-14 全过）**：
  | 项 | 判据 | 结果 |
  |---|---|---|
  | 正文检索 | 只出现在**正文**里的词命中，片段就是那句话 | ✓ |
  | 不搜工具输出 | 只出现在 `toolOutput` 里的词**搜不到** | ✓ |
  | 导出 Markdown | 打开文件与转写**逐条**对得上（含工具卡） | ✓ |
  | 导出 JSON | 能 `JSON.parse`，含 `dsh` / `usage` | ✓ |
  | 软删 → 恢复 | 从列表消失、进回收站；恢复回列表且**排到最前**，内容完好 | ✓ |
  | 彻底删除 | 原生模态确认后才消失 | ✓ |
  | **跨重启** | **重载窗口 / 完全关掉 VS Code 再开**，回收站里的东西仍在 | ✓ |
- **本次不做**：批量导出与导入（JSON 已无损，将来做导入不用改格式）；跨模式统一检索；不把附件正文内联进 Markdown（JSON 里有）；不加 `contributes.menus` / 命令面板入口（入口全留在 webview 内）。
- **已知局限**：
  - **没有 per-message 时间戳**（`ChatMessage` 没这字段）→ Markdown 只有会话级的创建/更新时间。
  - **Markdown 是忠实转储、不做转义**：正文里以 `#` 开头的一行会渲染成标题。要无损请用 JSON 导出。
  - 回收站 **per-mode**（chat 与 harness 各一个），与历史列表一致。
  - 软删只打标记，**转写仍完整留在磁盘 JSON 里**（直到彻底删除）—— C7 保留了这个语义（回收站期间记忆仍可用），只是给回收站补了「彻底删除」与手动留存清理两个出口。
  - **落盘只增不减**：回收站不自动清理，而 `toolInput` 无长度上限、`persist()` 又是同步全量覆盖写（每轮 `_afterTurn` 一次）⇒ 文件随使用单调增长、轮尾同步写耗时渐增。**C7 给了出口但不改这个成本**（删一条 = 真的回收空间了，但回收站仍不自动过期，而且每轮那次全量写一个字节都没省）—— 写入成本归 C8。

### C7 · 删除即彻底 + 回收站留存
- **现状（改前）**：删会话只是 `SessionStore.purge()` 把条目从内存数组里摘掉，**磁盘上一个字节都没删**；`dsh-sessions/<项目>/<会话>/session.jsonl.zstd` 那份 DSH 自己的记忆日志更是只增不减。于是**没有任何办法真正删掉一次对话** —— 而转写里装的是 agent 读过的文件正文、工具输出、你贴过的东西。C6 的回收站让这件事更糟：软删只打标记，转写完整留在盘上（C6 已知局限里就写着「与 C7 有交集」，决策 4 原话是彻底删除「**先不删**（`dsh-sessions/`），留给 C7」）。
- **用户 2026-09-15 拍板收窄**：原条目是「脱敏 / 加密 / 留存 / 彻底删」四件套，**砍掉脱敏与加密，只做后两件**。
  - **为什么砍掉脱敏**（记下来，别再当新点子重提）：**默认关等于不保护任何人**；开了又**有损且不可逆** —— `persist()` 是整文件改写，一次误配的规则 + 发一条消息，全库每个会话的磁盘副本当场被改写，原文只活在这一窗口的内存里。而且它**遮不住 `dsh-sessions/**/session.jsonl.zstd`**（DSH 自己那份 append-only、带 offset 修复的**压缩**日志，改它 = 破坏帧边界 = 续聊全废）。于是「开了脱敏」给的是**安全感**而非安全：用户看到 `sessions.json` 里全是遮蔽串，会以为没事了，而同一目录下那份原文还在。真实场景只剩三个（交接机器 / AppData 上云 / 公司合规硬要求），都不成立就不值得背着这些地雷做。
  - **加密**同理砍掉：密钥只能落在同一个 AppData 里（或又一个用户要记的口令），挡不住「拿到这台机器的人」；而它会把 `persist()`/`_load()` 的每一步都变成可能失败的加解密。
- **补法**：三个纯模块 + 一处接线 + 一个设置。
  - [src/dshPaths.ts](../src/dshPaths.ts)（新）：**逐字复刻** DSH 持久化插件的路径算法（`encodeSegment` / `projectKey` / `sessionDir` / `logPath`，抄自 `dist-runtime/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:84-158`），外加受控删除 `removeDshSessionDir()`。只 import `node:fs`/`node:path`，**绝不 import `vscode`**（自检要在扩展宿主之外加载它）。
    - ⚠️ **只准对着插件抄，别「整理」它**：`~XXXX` 的宽度、251 那个截断长度、`/ \ :` 折叠成一个 `-`，任何一处改对了算出来的才是**同一个目录**，改错了就是**别人的目录**。三层守卫：① 自检拿插件**公开且无副作用**的 `locate()` 做逐字对账 + 冻结插件版本与 `lib/index.js` 哈希；② 运行时**内容闸门**（叶子目录里只认 `session.jsonl(.zstd)` 及其 `.tmp` 中间产物，别人的目录里不会恰好长着这些名字）；③ 拿不准一律 `refused`，绝不「删了再说」。
  - [src/sessionStore.ts](../src/sessionStore.ts)：`isExpired()` + `expired()` + 导出纯函数 `dshStillReferenced()`（判据放在这里而不是 provider 里，就是为了能被自检加载）。⚠️ `days <= 0` 一律 false —— **0 是「关闭」**，少了这道闸 `now - at > 0` 会把回收站**全部**条目判成过期，用户点一下就转写连带 DSH 日志一起清光。
  - [src/chatViewProvider.ts](../src/chatViewProvider.ts)：`_purgeOne` 成为唯一咽喉，**顺序是承重的** —— `dsh` 必须在 `store.purge()` **之前**读（purge 把对象摘出数组后 `get(id)` 就返回 undefined，日志会被**静默**漏删，而那正是本项的验收项）。删之前先过 `_dshStillReferenced` 引用计数（**两个 store 都扫**）：`_forkSession` 里 `fork.dsh = src.dsh` 是**同一个对象引用**，分支与源共享一份日志 —— 删分支不能把源的记忆一起删了。确认框里那句补充说明也按同一判据给（独占的才说「日志会一并删除」，共享的明说「日志会保留」）。
  - 留存是**手动按钮**，不是定时器（仓库目前零 `setInterval`，不为这条开这个头）：回收站页出现「清理 N 个过期会话」，确认框里同时报告「另有 M 个在列会话也超过 N 天没动，本次不动」。新设置 `hello.chat.retention.days`（默认 `0` = 关闭）。**只清回收站**：从没被删过的在列会话哪怕一年没动也不入选 —— 一个手动、无预览的按钮若连没删过的会话一起清，是「一键数据丢失」级别的地雷。条数与文案一律由扩展算好下发（`history-update.retention`），webview 只显示，**绝不重算判据**。
- **自检**：[scripts/probe-purge.mjs](../scripts/probe-purge.mjs)（入库）—— **20/20 通过**。⚠️ 路径对账需要 Node ≥ 22.15 / 24（插件的 `node:zlib` zstd API），**宿主 node 太老会响亮失败**并告诉你去用运行时自带的：`./dist-runtime/node/node.exe scripts/probe-purge.mjs`；只有根本没有 `dist-runtime` 时才跳过（打醒目 ⚠ 且明说「别把这次通过当成验过了」）。覆盖：11 组路径向量逐字对账（非 ASCII / 连续分隔符 / 超长截断 / `..` / emoji）+ 版本哈希冻结闸门 + 一万次结构 fuzz；受控删除（只掉叶子、项目目录与兄弟会话都在、`missing`、内容闸门三种、穿越、空 root、junction、绝不抛）；引用计数（fork 共享 / 跨 store / 同 id 不同 cwd）；留存边界（恰好 N 天 false、N+1ms true、`0/-1/NaN/Infinity` 全 false、坏 `deletedAt` 全 false、只挑回收站、恢复后立刻不过期）。
- **验收（F5 真机 2026-09-15 全过）**——沿用 C4 的教训，**盯盘上文件，别盯界面元素**：

  | 项 | 判据 | 结果 |
  |---|---|---|
  | **删除即彻底** | 彻底删除后叶子目录消失；**项目目录与兄弟会话目录一个不少** | ✓ |
  | 无 dsh 的会话 | 盘上本就没日志 → 静默 `missing`，不报错（回收站里那条「你好」就是这种） | ✓ |
  | **分支不连坐**（引用计数） | 删分支 → 共享日志**还在**；点回源会话问暗号仍答对；删到源才没 | ✓ |
  | C5 不回归 | 重载窗口后点回活着的会话，note 与模型答话**都对得上**（C5 记过「note 撒谎」的静默回退） | ✓ |
  | 留存按钮 | `days` 设小 + 手改 `deletedAt` 到 40 天前 → 按钮显示「清理 1 个过期会话」；确认框同时报在列超期数；确认后条目**与它的 DSH 日志**都没了 | ✓ |
  | 留存关闭 | `days = 0` → 按钮**隐藏**（不是禁用），够不到确认框 | ✓ |
  | 不回归 | `probe-session-tools.mjs` 47/47、`probe-purge.mjs` 20/20、检索/恢复/清空照旧 | ✓ |
  | 非 ASCII 工作区 | `--d-metabase-8.31~6570~636E~5904~7406--` 与 DSH 实建目录**逐字相同**（`dsh.cwd` 原样是小写 `d:`，我们不做规范化） | ✓ |
- **本次不做**：**脱敏**（理由见上）；**加密**（同上）；**自动/定时清理**（决策是手动按钮）；不动 `.hello-chat/selection-attach/` 的临时选区文件（那是给 agent 读的，只受 6h TTL 清扫）；`sessionExport.ts` 一行不改（它保持纯、与删除无关）。
- **已知局限**：
  - **多窗口会互相覆盖**：`globalStorage` 按 profile 共享，每个窗口各持一份内存里的 `_sessions` 全量覆盖写。窗口 A 删掉的会话会被窗口 B 的下一次 `persist()` **推回磁盘** —— 而它的 DSH 日志已经被 A 删了，于是留下一条「看着能恢复、点开却接不上记忆」的会话。设置描述里已写「单窗口使用」。
  - **DSH 日志路径靠复刻插件内部算法**：上游改版会漂移。三层兜底之后，**漂移后「删不掉」仍比「删错」更可能**（内容闸门偏向 `refused`）—— 这是刻意的偏向。
  - `persist()` **非原子**：C7 之后盘上那份成了删除后的**唯一副本**，这个既有隐患被放大了 —— 已交给 **C8c**（C8 收窄时把它连同写入成本一起拆了出去）。
  - 回收站**仍不自动过期**：留存是手动的，不点就一直留着。
  - `toolInput` 无长度上限 + `persist()` 每轮同步全量写：删除能**回收空间**，但**写入成本**这个既有问题没变（归 **C8c**）。

### C8 · 运行可靠性：中断续跑 + 超时幂等  [x] 2026-09-16（F5 2026-09-17）
- **原文三条**：① 崩溃/停止后给「接着这个会话再发一轮」入口；② `session/prompt` 超时后的重发要防重复执行；③ 大转写改增量写或分片。
  **2026-09-15 拍板收窄**：本次做 ① + ②，**③ 拆成新的 C8c** —— 它动的是存储层核心（`persist()` 原子写 / 写入成本），与运行时行为改动的风险性质不同，混在一起验收会很脏。
- **⚠️ 本项调研纠正了原文的两条预设。写在这儿，否则下次又按错误的直觉做：**
  1. **「超时重发会产生重复工具执行」——反了。** 运行时对同一 sessionId 的第二次 `session/prompt` **不并发、不报错**：它被塞进 inbox 的 `next-turn` 队列，当前 turn 跑完后**作为独立的新一轮**被消费（`dist-runtime/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js` → `agent.followup` → `dsh-agent-loop`，`wakeDriver` 在非 idle 时只置 `wakeRequested`，不抢占当前 turn；一次 turn 只吃一条 next-turn）。**排在后面 ≠ 重复执行**，所以 ② 不需要「防重发」。
  2. **真正的隐患是反过来：界面报 error，工具还在跑。** 回执超时（原硬编码 120 s）会把界面标成 error、清掉 `_liveRunning`，**但子进程没被杀、那一轮还在执行工具**；此后 `_onDshEvent` 的 `if (!this._liveRunning) return;` 把后续事件全丢掉 ⇒ 用户看不见那份工作，而 DSH 记忆里有 ⇒ UI/转写与记忆失配。所以 ② 的修法是 **①别把长轮当超时 + ②让 error 名副其实（出错就杀进程）**。
- **补法**：
  - [src/dshRuntime.ts](../src/dshRuntime.ts)：`request()` 支持 `timeoutMs <= 0`（不挂计时器）；`prompt()` 的回执超时提为具名常量 `PROMPT_ACK_TIMEOUT_MS = 10 * 60_000` 并配注释说明**回执只是服务端「收下了」的收条**，本轮何时结束看 `session.status` idle；超时错误带 `name = DshTimeoutError`（`isDshTimeout()` 导出），调用方据此把「超时」与「真失败」分开。`kill()` 改**两段式**：`stdin.end()` → 立即 `dead = true`（语义与从前一致）→ `setTimeout(强杀, GRACEFUL_KILL_MS = 2000)`，子进程自己退出就清掉计时器；签名与同步返回的契约不变，只是强杀延后。
  - [src/turnState.ts](../src/turnState.ts)（新，纯模块，**绝不 import `vscode`** —— 自检要在扩展宿主之外加载编译产物）：`readLastTurn()` / `needsContinue()`（「继续」按钮的**唯一判据**）+ `TurnStatus`（`session.status` 通知的状态跟踪，从 `_onDshStatus` 抽出来才盖得住）。
  - [src/sessionStore.ts](../src/sessionStore.ts)：`StoredSession` 增 `lastTurn?: 'interrupted' | 'error'`；`normalize()` 里**只认这两个值**，其余一律 `delete`（方向与 `deletedAt` 相反：坏值朝「不打扰」倒 —— 最多让按钮不出现，而一个不该出现的按钮会把「上一轮其实跑完了」说成中断）。
  - [src/chatViewProvider.ts](../src/chatViewProvider.ts)：`_surfaceLiveError` 收尾子进程（**② 的核心**）；`turn/end` 的 reason 白名单加 `interrupted`（它是运行时补平悬空 turn 用的 reason，不是异常）；`_onDshStatus` 改用 `TurnStatus`；`_sendUser` 增 `_dshRunning` 闸；`_runLive` 的 catch 里**回执超时且已知仍在跑 → 继续等**，只有真失败才上浮；`_finishTurn('interrupted')` 落 `lastTurn` + 插一行灰 note；新增 `_sendTurnState()` / `_retryLast()`，`_sendUser` 增 `opts.replay`（重发时**跳过选区自动附加与「整行=路径」再解析** —— 那两处都取「此刻」，而重发要逐字复现上一轮）。
  - [src/protocol.ts](../src/protocol.ts)：`retry-offer {on}`（扩展→前端）/ `retry-last`（前端→扩展）。
  - `media/chat.{html,js,css}`：「继续」条挂**composer 内**（同 review-bar / approval-bar）。⚠️ **有意偏离方案原话**：原写「消息列表尾部」，但 react-live（真 DSH 组件画面）只接管 `#messages`、会把那里整个藏掉 —— 挂在消息区尾部的按钮在默认模式下**根本看不见**。
- **自检**：
  - [scripts/probe-c8-runtime.mjs](../scripts/probe-c8-runtime.mjs)（新，运行时前提 spike，需 key、**发真实模型轮**）：三条前提。① 跑到一半再发一条 prompt → 确认排队成第二轮；② 硬杀后同 id 重新 boot → 确认 resume 不报 corruption 且尾 turn 被补平；③（`--kill-compare`，指示性）优雅退出 vs 硬杀。
    - ⚠️ 读 DSH 日志**必须自己按 zstd 魔数 `28 b5 2f fd` 切帧**：文件是一串拼接的帧，而 `zstdDecompressSync` 与 `createZstdDecompress` **都只解第一帧就收工**（实测 15 帧的文件两者都只吐 1 行）。这一条踩过 —— 探针第一版因此把「补平数 = 0」报成前提不成立，纯属读错了盘。
  - [scripts/probe-turn-state.mjs](../scripts/probe-turn-state.mjs)（新，零依赖零 key）：`needsContinue` / `readLastTurn` 边界（垃圾值、`completed`、消息形状不能影响判据）+ `TurnStatus`（非当前会话忽略、翻转、重复幂等、`reset(id)` 归零、垃圾通知不认领）+ 与 `SessionStore` 的落盘往返（重开还在、发新消息消失、坏值被 `normalize` 丢掉）。**13/13 通过**。
- **验收（spike 全过；F5 真机 2026-09-17 通过）**：
  - **运行时前提（已复验）**：① 两轮都跑完 `turn/start=2 turn/end=["completed","completed"]`、状态序列 `["running","idle"]`，期间第二条 prompt 不并发不报错；② 硬杀后 resume 回执正常、**盘上补平 1 个 `turn/end reason=interrupted` 且含 `TOOL_OUTCOME_UNKNOWN`**、无 corruption（16 帧 → 47 条）；③ `stdin.end()` → `exit(0)` 实测 **~25 ms**（空闲，3/3 轮），故 2000 ms 的窗口是 80 倍余量。⚠️ ③ 的「盘上条数」对比（硬杀 24 / 优雅 21）**不可用**：两轮 token 数不同（线上 234 vs 149），数的是转写长度而非 flush 窗口，别拿它当结论。
  - **F5 真机（2026-09-17 通过，用户确认）**：停止 → 灰 note + 末条 interrupted + 「继续」条出现；点「继续」接上**同一个** DSH 会话（盘上 `dsh.id` 与日志目录不变）且模型答得出上一轮的暗号；停止后**重载窗口**按钮仍在且同样接得上；长轮不再被误判 error；制造真错误 → 界面 error **且任务管理器里没有残留 node 子进程**；不回归 `probe-purge` 20/20、`probe-session-tools` 47/47、`smoke-runtime --resume` 4/4。
    （以上是待验清单原文；用户 2026-09-17 确认整轮通过，未逐条留痕。）
- **本次不做**：**自动重试**（wire 无法查询会话状态，只有翻转通知且漏收不可补拉 —— 自动重试等于赌博，本项只做「人点一下」的重试）；**不改重复 prompt 的排队语义**（那是运行时的正确行为，不去规避它）；不碰 C1 审批、2.1 审阅、C6 检索/回收站、C7 删除路径。
- **已知局限**：
  - **`_dshRunning` 可能停在错误值**：`session.status` 只在翻转时发、漏收不可补拉 ⇒ 它**只用于放宽**判断（已知 running 就继续等），**绝不用来「据此认为已完成」**；真完成信号仍是 idle 通知或子进程退出。代价是：若 idle 漏收，用户会被那条闸挡在门外 —— 出路与今天一样，是点「停止」。
  - **优雅停止只争取到一次 flush，不是事务**：2 s 后仍是硬杀，那 ≤200 ms 的窗口只是**变小**而非消失。
  - **两边的「中断」措辞不同**：DSH 记忆里是补平的 interrupted turn（含 `TOOL_OUTCOME_UNKNOWN` 结果），我们的转写里是一条 `status:'interrupted'` 的助手消息 + 一行 note —— 别指望逐字对齐。
  - **停止 = 杀进程**这条底层约束没变（wire 无 cancel）；本项只是把它做得**可见、可续、可解释**。

### C8c · 存储层写入：`persist()` 原子写 + 写入成本（2026-09-17 完成，F5 待办）
- **来源**：C8 收窄时从 ③ 拆出来（原话「大转写改增量写或分片」），并接住 C7 交接的两条：`persist()` **非原子**（C7 之后盘上那份是删除后的唯一副本）、**每轮同步全量覆盖写**且 `toolInput` 无长度上限 ⇒ 文件随使用单调增长、轮尾同步写耗时渐增（垃圾回收只是回收了空间，没省下每轮那次全量写）。
- **开工前先实测，推翻了上面两条预设的一半** —— 量的是本机真实数据（`sessions-harness.json`，20 会话 / 457 条消息 / 用了 9 天，366,242 字符 ≈ 427 KB）：

  | 项 | 实测 | 上面那句预设 |
  |---|---|---|
  | **`toolOutput`** | **占 50.4%** | （没提，它才是大头） |
  | `toolInput` | 占 14.0%，**没有一条超过 3000 字符** | 「无长度上限 ⇒ 文件单调增长」—— **不成立** |
  | 其它字段 | 其他 21.2% / assistant 12.0% / user 1.2% / note 0.7% / 附件 0.5% | — |
  | `usage` | 599 字符（全 20 会话合计） | — |
  | 一次全量写 | `stringify` **0.93 ms**（紧凑格式 0.81 ms，只省 9.9%）+ 写盘 ⇒ 约 **2–3 ms/轮**；数据 ×10 也才 9.47 ms | 「轮尾同步写耗时渐增」—— 量级远够不上问题 |

  1. **「`toolInput` 无上限导致增长」在真实数据上不成立** —— write/edit 带整份文件正文那件事一次都没发生过（225 条 tool 消息，平均 `toolOutput` 733 字符、最大 4012）。上限照做，但定位改成**病态输入的保险丝**，不是成本优化。
  2. **「写入防抖」是个空招**：`persist()` 只在轮尾（`_afterTurn`）与 9 处用户动作时调用，**轮中一个字节都不写** —— 没有高频写入可合并。
- **拍板（2026-09-17，用户）**：**只做「不丢数据」这层**。分片 / 异步写 / 防抖**一律不做**，重启条件是「文件长到十 MB 级再评估」。
- **补法**：
  - [src/sessionStore.ts](../src/sessionStore.ts)：`persist()` 改**原子写**（`<file>.<12hex>.tmp` → 尽力 fsync → 滚动备份 → rename 盖主文件，rename 对瞬时 `EPERM/EACCES/EBUSY` 退避重试 3 次）；`_load()` 改**三级回退**（主文件 → `<file>.bak` → 空）并给出 `LoadReport { source, reason, detail }`。新增 `capToolInput()` / `MAX_TOOL_INPUT_CHARS = 20000`、`STALE_TMP_MS`、构造末尾一次性的陈旧 `.tmp` 清扫。
    - 顺序即设计：**备份必须在 rename 之前滚** —— 写后再复制，`.bak` 就恒等于当前，坏内容会被立刻镜像进去，等于没有备份。备份自己也走 tmp + rename（`copyFileSync` 是「打开即截断」，半路 ENOSPC 会把上一份**好备份**毁成半截）。
    - ⚠️ **`_holdBackup` 是全案最容易写错、也最值钱的一处**：主文件损坏、回退成功后，盘上主文件仍是坏字节；此时若下次 `persist()` 照常「copy main → bak」，就把**唯一那份好数据**覆盖成坏字节 —— 备份在最需要它的那一刻自杀。对策：加载期置位，**写成功之后**才清。
    - ⚠️ **`reason: 'missing'` 与 `'corrupt'` 必须分开** —— 前者是首次运行（文件还没建），报给用户就是误报，而误报会让真正的损坏告警被当噪音忽略。这是唯一能区分二者的判据。
    - ⚠️ 回退判据**到此为止**：不要因为「主文件 0 条、备份 40 条」就回退 —— 用户把会话全删光是合法状态，那样等于把删掉的东西复活。
    - 扫 `.tmp` 两道闸缺一不可：**只扫自己文件名前缀**（chat store 永不碰 harness store 的）、**只扫够老的**（> 1 h —— 新鲜的可能正是**另一个 VS Code 窗口**在写的，删了就是把别人的原子写打断在半路）。
    - `normalize()` 与那两条 filter **一字未改**（含「只按 messages 过滤、绝不补 `!s.deletedAt`」的注释）；`persist()` 签名与 10 个调用点**一行未动**。
  - [src/chatViewProvider.ts](../src/chatViewProvider.ts)：保险丝接在**消息产生处**（`tool/call` 分支 `toolInput: capToolInput(prettyValue(d.arguments))`）—— 内存 / webview / 盘上 / 导出 / 检索读到的才是同一串字符（放存储层会让内存留全文 ⇒「同一个工具卡，重载窗口前后显示不一样」这种难复现的 bug）；新增 `_storageWarn()` / `_checkStorageHealth()`，照 `_approvalWarn` 的体例但**用独立旗标**（共用会让先到的告警吞掉后到的），挂在 `case 'ready'`（那时面板已开、弹窗有人看），`source === 'file'` 或 `reason === 'missing'` 一律跳过。
  - [scripts/probe-session-tools.mjs](../scripts/probe-session-tools.mjs)：⚠️ **`scratchStore()` 必须同步改** —— 它从前只删主文件，「主文件不存在」等于「没有历史」；有了 `.bak` 之后构造会回退备份、把上一条用例的数据读回来，**一整片用例连环假失败**。改成清 `FILE` + `FILE.*`（一把罩住 `.bak` / `<hex>.tmp` / `bak.<hex>.tmp`）。新增「C8c 落盘加固」一节 17 条断言。
  - [src/sessionSearch.ts](../src/sessionSearch.ts)：**只改注释** —— 它写着「`toolInput` 没有任何长度上限」，加熔断后不再成立；`SEARCH_TOOL_INPUT_CHARS = 400` 的理由换成「前 400 字符覆盖 bash 命令原文与路径参数，够了」，并说明它与 2 万那条**不重叠、也不是一回事**（真实数据里入参中位数才几百字符，2 万几乎永不触发）。
- **自检（全绿）**：
  - `scripts/probe-session-tools.mjs` **64/64**（原 47 + 新增 17）；其中两条是本次的核心回归闸门：**★ `.bak` 恒为上一代**、**★★ 从备份回退之后第一次 `persist` 不许把备份冲掉**。
  - 不回归：`probe-purge.mjs` **20/20**、`probe-turn-state.mjs` **13/13**、`probe-approval-shell.mjs` **7/7**。
  - 静态守卫：`grep "import \* as vscode" src/sessionStore.ts` 无输出。
  - 真实数据往返（一次性脚本，跑在用户 globalStorage 的**副本**上）：`sessions-harness.json` 20 条、`sessions.json` 6 条，`persist()` 后**逐字节等于原文件**、无 `.tmp` 残留；把主文件截成半截重开 → 回退到备份、条数一致、主文件写回完整内容、且那份好备份**没被冲掉**。
  - ⚠️ 途中一条自己写错的断言：拿「刚好超限 1 个字符」当有界性的证据 —— 那时结果反而**更长**（标记本身要占字）。保险丝要挡的是几 MB 的病态输入，不是省那几个字节；断言已改成量「上限 + 标记」的封顶。
- **只能真机 F5 盖住**（盯盘上留痕，别盯界面元素 —— C4 的教训）：① 跑一轮后主文件在、同目录**无 `.tmp`**；再发一条消息 → `.bak` 出现且内容是**上一代**。② 手工把主文件截成半截 → 重载 → 历史**回来了**、**只弹一条**告警、console 有 `[storage]` 细节；再重载**不再弹**。③ 删掉 `.bak` 再把主文件写坏 → 重载 → 列表空 + 「没有可用备份」那条；**干净 profile 首次运行绝不能弹**。④ 正常一轮：工具卡显示、重启回放、Markdown/JSON 导出与检索均无变化。
  - **部分真机确认（2026-09-17，用户 F5 + 盘上核对）**：①**通过** —— `sessions-harness.json` 与 `.bak` 都在、同为 20 条合法数组、**两者 md5 不同**（备份确实是上一代，不是「写后复制」的镜像，那会完全相同）、标题序列一致而 `updatedAt` 不同、同目录**无 `.tmp`**；且整轮日志里**没有任何 `[storage]` 行**，即正常加载路径不误报。② ③ ④ 的异常路径**尚未验**。同一份日志还顺带印证 `[approval] 事前审批已就绪（shell=wsl，hook 自检通过）`。
  - ⚠️ **核盘时差点误判**：`.bak` 的 mtime 比主文件早，看着像「这次没滚动」。实测原因是 `copyFileSync`（Windows `CopyFileW`）**会连时间戳一起复制**，所以 `.bak` 的 mtime 恰好是它那份内容当初被写下的时间。**别拿 mtime 判断有没有滚过**，比对内容/md5 才算数（已把这条写进 `_rollBackup` 的注释）。
- **本次不做**：按会话分片、异步写、写入防抖（按实测否掉）；不碰审阅快照（本就不落盘）、DSH 会话日志、C6 检索与 C7 删除的语义；不动 `persist()` 签名与 10 个调用点、不动 `normalize()`、**不回改盘上已有的超长 `toolInput`**；不加 `.corrupt` 留档文件；**不给 `persist()` 失败加弹窗**（轮尾高频，会成告警风暴）。
- **已知局限**：
  - **优雅写盘不是事务**：rename 保证「要么旧的完整、要么新的完整」，但崩溃丢失的是**本轮开始以来尚未落盘的那部分**（现状本来如此，本次不改变）。
  - **双窗口并存时告警可能假阳性一次**：两个扩展宿主共写一个 globalStorage，另一个窗口 `writeFileSync` 截断的瞬间被读到会判成 `corrupt` 并去回退备份。随机 tmp 名 + rename 让这个窗口比从前小得多，但没消除；console 里留足细节以便排查。
  - **磁盘占用翻倍**：一份 `.bak`（现在 427 K → 854 K），可忽略。
  - **`persist()` 失败仍只有 console 可见**（既有行为，本次刻意不动）。
- **顺带修掉的（与本项相邻、已随手处理，不属于本项范围）**：`scripts/smoke-runtime.mjs` 与 `scripts/probe-c8-runtime.mjs` 结尾的 `process.exit(...)` → `process.exitCode = ...`。原因：Windows 上被重定向/管道的 stdout 是**异步**写，`process.exit()` 会把还没冲出去的**结论行整段丢掉** —— 表现为「只打印了前半段、退出码却是 0」，一份会吞掉自己结论的报告比不跑还坏（本轮 `smoke-runtime` 就是这么被发现的：exit=0 但只有第一行）。

### C9 · Run inspector（2026-09-17 完成，F5 待办）
- **原文验收**：每轮结束后可查看本轮工具调用序列与耗时。
- **缺口**：调试 DSH 直播只有 `hello.dsh.debug` 往输出通道打 stderr 原始帧 —— 用户看不到「这一轮到底跑了什么、慢在哪、哪次工具失败了」。
- **关键发现（本项成立的前提）：数据本来就在流里，一个计时器都不用加。** 每个 `session.event` 信封都带 `seq` 与 `time`（epoch ms，与 `Date.now()` 同一口钟，见 [src/dshRuntime.ts](../src/dshRuntime.ts) 的 `DshEventFrame`），此前一个字都没读过。耗时 = 两个信封的 `time` 相减。
- **用户拍板（2026-09-17）**：① **纯内存**，只留最近 20 轮（不落盘、不动 `StoredSession`）；② **composer 摘要条 + 点开全屏浮层**；③ **以工具为中心 + 轮/步耗时**。
- **实测锚点**（`logs/dsh-frames/frames-2026-09-08T04-17-26-078Z.jsonl`，抓帧文件是 JSON-RPC 外层包装：首行是握手响应，会话 id 在 `params.sessionId`、帧在 `params.event`）：

  | 帧类型 | 条数 | 记不记 |
  |---|---|---|
  | `assistant/chunk` | **819** | ✗ |
  | `step/start` / `step/end` | 5 / 5 | ✓ |
  | `tool/call` / `tool/result` | 4 / 4 | ✓ |
  | `turn/start` / `turn/end` | 1 / 1 | ✓ |
  | `user/message` / `request/header` / `session/title` / `agent/inbox/spliced` | 1/1/1/2 | ✗ |

  这一份：1 轮 / 4 工具 / 5 步 / 轮耗时 **11226 ms** / 工具 1 = **2610 ms** / 步 1 = **5229 ms** / 步 5（无工具）= **1433 ms** / 配对失败 0 条。
  → **丢弃 `assistant/chunk` 就是全部的体积故事**（819/823 帧）；而**步与工具不冗余**（步 = 模型延迟 + 工具延迟），所以两样都留。
- **补法**：
  - [src/runInspector.ts](../src/runInspector.ts)（新，**纯模块**：零 import，连 `dshRuntime` 都不 import，入参是结构型的 `RunFrameLike` —— 自检要在扩展宿主之外加载编译产物，同 `turnState.ts` 的理由）。三条写进文件头的约束：① **只留时间线，不留正文**（chunk 不入账，**工具入参也不留** —— 消息卡里那份已过 `capToolInput`，这里再存一份既是双份内存又是绕过保险丝的新路）；② **判据只此一处**（配对键与「这次工具算不算失败」由本模块导出，provider 改成调用它们）；③ **有界**（一个全局环 + 读取时过滤，**不建 `Map<sessionId, ring>`**，那会随「开过的会话数」无界增长；文件头点名 `_afterTurn()`，防后人「顺手」持久化）。
    - 帧 → 记录：`turn/start`（建轮 + `startedAt`）/ `step/start` / `step/end` / `tool/call`（推 `running` 行）/ `tool/result`（配对收尾）/ `turn/end`（`reasonKind` 原样留档 + 临时终态），**其余一律 `return false`**。
    - 配对：① 键相同且仍 `running` 的**最后一行**（实测 100% 命中）→ ② 否则最后一条 `running` 行 → ③ 否则计数（不建行、不报错）。①②分开是为了让「键没对上」这件事能被 `unmatched` 看见 —— provider 原有的兜底把它静默盖掉了。⚠️ **② 对补平帧不开放**（`isRepairResult`，见下）：它的 `message.id` 是补出来的，让「就近关一条」接手等于把结果安到另一次工具头上（耗时、成败全错）。
    - 轮的键是**三路** `(uiSessionId, dshSessionId, turn)`：DSH 身份丢失后新会话的 turn 会从 1 重数，两路键会撞。`RunRecord.id` 是我们自己的单调序号，**列表主键用它而不是 wire 的 turn**。
  - [src/chatViewProvider.ts](../src/chatViewProvider.ts)：帧咽喉一处接线 `if (this._runs.apply(frame, this._active.id)) this._postRuns();`，插在 switch **之前** —— 一处咽喉，六个 case 一个不用改，将来新加 case 也不会「忘了记一笔」；⚠️ **不插在 `_liveRunning` 闸之前**（闸内丢的帧本就不属于这一轮，为记个时间戳去放宽它等于 re opening C8 ② 修掉的 bug）。`_finishTurn` / `_surfaceLiveError` / `_runLive` 的 `finally` 三处收尾各一行 `endRun`。`_toolKey` 与 `tool/result` 的 `failed` 计算改成委托模块导出的两个函数（行为不变的重构，消掉「转写里是红卡、检查器里是绿行」）。
  - [src/protocol.ts](../src/protocol.ts)：`runs {readout, details?}` / `snapshot` 加可选 `runs` / `run-panel {open}`。`details` **只在浮层开着时**才随帧下发（详情是 O(轮数 × 工具数)，每收一帧都发等于把最近 20 轮的工具表反复推给前端）。
  - `media/chat.{html,js,css}`：条挂在 **composer 内**（同 review-bar / usage-bar 的道理：react-live 只藏 `#messages`）；浮层是 body 直系元素并**复用 `.review-panel` / `.rp-*` 整套配方**（同一种「铺满视口、`.open` 展开」的浮层，复制一份 CSS 只会让两处将来各自漂移）。两处必须做对：**重绘要保 `scrollTop`**（这个面板在一轮里每收一帧就重绘一次，朴素重渲染会把滚动位置每秒打回顶部好几次 —— `renderReviewList` 只在离散变化时重绘，别照抄它这个省略）；**与审阅浮层互斥**（两个 `z-index:40` 的满屏浮层没有视觉仲裁）。
- **⚠️ F5 实测推翻的两条预设（2026-09-17，别改回去）**：真机跑完去看面板，发现那一轮写着「1 结果未知」＋「有 N 条工具结果没配上调用」。
  1. **「`unmatched` 正常恒为 0，非 0 就是我们的 bug」是错的。** DSH **补平中断轮**时会**补写结果帧**，那些帧本来就配不上任何调用。两条真实变体（逐字取自 `%APPDATA%\Code\User\globalStorage\…\dsh-sessions\…\session.jsonl.zstd` 的 turn 1 seq 242/243）：
     - `message.id = interrupted-tool-result-<callId>-<seq>`，正文「…but no result was durably recorded. **Its outcome is unknown.**」—— 已记录、结果没落盘；
     - `error.code = 'TOOL_NOT_STARTED'`，正文「…interrupted before the Harness recorded it as started.」—— **从未被记录为开始**（那个 `call_01_…` 通篇没有对应的 `tool/call`）。
     ⇒ 拆成两个计数：`repaired`（**运行时代我们写的**）与 `unmatched`（真正的键失效，恒 0 的才是我们的 bug）。面板文案跟着分开：「另有 N 条中断补平的结果没配上调用（Harness 代写的，不是故障）」vs「有 N 条工具结果没配上调用（配对键失效，正常应为 0）」。**原来那一句「（配对键失效）」是在拿运行时的正常行为诬告我们自己**。
  2. **「按 `isError` 判成败」是错的 —— 判据必须是三态。** 上面两条补平帧**正文说「未知」、帧上却带 `isError: true`**。若照旧判 `isError`，面板会把「未知」画成红叉「失败」，而这正是本项开头点名要避免的谎报（**失败会让人去重试一个可能已经生效过的命令**）。⇒ `toolResultFailed(boolean)` 换成 `toolResultVerdict(): 'ok' | 'error' | 'unknown'`，`isRepairResult` 先判补平帧。派生的四处根因也跟着从 `'error'` 改成 `'unknown'`（`_finishTurn` 中断分支、`_surfaceLiveError`、`_cancelActiveRun`、`_openSession`，以及 `sessionStore.normalize` 的落盘归一化）—— **C8 那条中断 note 本来就说「结果未知」，卡上却画红叉，是自相矛盾**；`sessionExport` 补一个 `结果未知（没收到结果）` 标签。
  - 顺带证伪的一件**我自己的假警报**：我曾据一份贴出来的转写断言「条上 1 工具 vs 屏幕上 8 张工具卡 = 记账漏了」。盘上对账后条是对的 —— 那份转写属于第 3 轮（49 工具 / 562662 ms），条上那 1 工具是第 8 轮（1 工具 / 36520 ms，15.6s 步 + 20.8s 模型步）。**面板只留最近 20 轮且纯内存**，两次贴出的内容本就不同轮。
- **同一次 F5 修掉的四个问题（①②正确性，③④表达）**：
  - ① 三态判定（上面第 2 条）。
  - ② `unmatched` / `repaired` 拆分（上面第 1 条）。
  - ③ **面板把每个步骤都渲染成一行**（含没有工具调用的纯模型步），工具挂在自己那一步下面。原先「不含工具调用的步」被折成一行脚注，代价是**步骤号在列表里跳号**（1、3、5 看着像丢了两步）—— 而纯模型步恰恰常是最慢的那一步（实测第 8 轮那 20.8s）。步号取 `steps` 与工具行的 **step 并集**（工具的 step 未必在 `steps` 里：步被上限丢过 / `step/start` 缺帧），耗时未知给「—」。
  - ④ **`runs.length > 1` 时条上前缀写「最新一轮」而不是「本轮」**；浮层里每行写「第 N 轮」（N 按**列表位置**数，不取 wire 的 `turn` —— DSH 身份丢失后 turn 从 1 重数，会出现两行都叫「第 1 轮」）。**只换前缀、后缀逐字不动**，所以同一轮在两处的读数仍逐字可比。
- **⚠️ 调研中改掉的一条自相矛盾**：方案里那张终态优先级表写着「wire `completed` + 用户在此之前按了停止 → `completed`」，但同一张表的 `interrupted` 秩比 `completed` 高，实际行为是 **`interrupted` 赢**。**保留后者**：它与转写里那条气泡同一口径（`_finishTurn('interrupted')` → `_finalizeOpenAssistant`），面板说「已完成」而气泡说「已中断」是更坏的结果。秩表：`running` 0 < `completed` 1 < `aborted`/`interrupted` 2 < `error` 3，`endRun` **只在严格更大时**覆盖；`reasonKind` 无条件留原值 ⇒ 徽章看着不对时永远可诊断。
- **单写者约定**：`turn/end` 那条 case **只记 `reasonKind` + 临时终态，绝不写 error 条目** —— 非白名单 kind 会走 `_surfaceLiveError`，两边都写就是每条错误显示两遍。唯一的 error 条目来自 `endRun('error', msg)`；`_errorClaimed` 旗标让重复调用安全，同时保留「一轮都没开始就出错」（spawn / prompt 回执失败）时的合成记录。
- **自检**：
  - [scripts/probe-run-inspector.mjs](../scripts/probe-run-inspector.mjs)（新，零依赖零 key）**31/31 通过**，六块：计时 / 帧过滤 / 配对 / 终态 / 有界·过滤·垃圾 / 两份真帧回放。
    - 载荷最重的两条：**灌 5000 条 `assistant/chunk` → 每次 `apply` 都 `false` 且记录逐字节不变**（把「819 条 chunk」这件事编码进断言）；**150 call + 150 result → 留 100 行、`toolsDropped === 50`、`unmatched === 50`、`repaired === 0`**（被丢掉的 call 的 result 绝不许去关留存的行，也**不许拿 `repaired` 当垃圾桶**）。
    - **补平帧那两条断言（把上面那次实测纠正钉住）**：`REPAIR_PAYLOAD_RECORDED` / `REPAIR_PAYLOAD_NOT_STARTED` **逐字**取自那份真实日志，断言 `toolResultVerdict` 对它们给 `unknown`（而非 `error`）、`isRepairResult` 不误伤普通失败帧、配得上行的补平帧落 `unknown` 且两个计数都不动、配不上的进 `repaired` 而 `unmatched` 保持 0。**别把这两份载荷改成「编一个像的」** —— 可识别特征（`message.id` 前缀、`error.code`）就是从原文里读出来的。
    - **真帧回放一：抓帧文件**（`logs/dsh-frames/*.jsonl`，JSON-RPC 外层包装：首行握手响应，会话 id 在 `params.sessionId`、帧在 `params.event`）喂进 `RunInspector`，**同时**用一条独立的、直接从原始 JSON 重算 per-(turn,step) min/max 的直算式 oracle 对拍（轮数/每条工具耗时/每步耗时/轮耗时全等）—— 用**另一条代码路径**验状态机，而不是硬编码一个数字。
    - **真帧回放二（最值钱的一条）：真实会话日志**（`dsh-sessions/**/session.jsonl.zstd`，**不硬编码机器路径**：从 globalStorage 根往下找最新的，也可用 `HELLO_DSH_SESSIONS_DIR` 指定）。断言 `unmatched === 0`（真实运行时行为不许被算成我们的 bug）＋一条**守恒律**：`被补平帧收掉的行数 + repaired === 补平帧总数`（每条补平帧恰好落在某一处，既不许多也不许少）。跑出来是 **1722 事件 / 8 轮 / 6 条补平帧 → 收掉 4 行 + 记 2 次**。日志是 zstd **首尾相接的帧**，`zstdDecompressSync` 只认第一帧，得按 magic 切段、每段往后多要一帧再试。
    - 两份真帧都依赖 `logs/` 或本机 globalStorage，**缺失时打一行醒目的跳过提示**（不把「没跑到」当「验过了」）。
  - **探针抓到的两个真 bug**（这就是 oracle 存在的理由）：① `step/start` 与 `step/end` 各 `stepsDropped++` 一次 → 同一个步被数两遍（50 报成 100），改成 `Map<step, Set<stepNo>>` 去重；② 我自己的 oracle 里一个**缺花括号的 dangling-else** 让后续分支全绑到了内层 `if` 上，`res`/`steps` 永远空 —— **实现是对的，测试是错的**。
  - 不回归：`probe-session-tools` **64/64**、`probe-purge` **20/20**、`probe-turn-state` **13/13**、`probe-approval-shell` **7/7**（三态那次改动也动了 `sessionStore.normalize` 与 `sessionExport`，这两个的覆盖就在 64/64 里）。
  - 静态守卫：`grep "import \* as vscode" src/runInspector.ts` 无输出；`media/chat.js` 里 `innerHTML` 的 2 处命中**全是注释**（真实使用 0）。
  - **DOM 影子自检（一次性脚本，跑在 `logs/`，不入库）**：用最小 DOM 影子把 `media/chat.js` 载进 Node（加载期依赖只有 `acquireVsCodeApi()` 与 `window.addEventListener('message')` 两处），喂 C9 消息断言文案/结构/状态类/scrollTop/浮层互斥 —— F5 之前唯一能跑通那 ~150 行 DOM 代码的路子。**它抓到两个真 bug**：
    - ① `runLine` 同时喂 `RunSummary`（条上有 `toolCount`）与完整 `RunRecord`（**没有**那个字段，只有 `tools` 数组）⇒ 浮层头把 4 工具的轮写成「**无工具调用**」。修法是 `runCounts()` 按形状取数，**派生口径与扩展侧 `_summary()` 逐字一致**（`tools.length + toolsDropped`），否则同一条记录在条上和浮层里会给出两个数。
    - ② 影子自己的 `classList.toggle` **不认第二个 `force` 参数**（真 DOM 认）⇒ `applyToolState` 那四条 `toggle(cls, cond)` 全变成无条件添加，每张工具卡同时挂着 `running/ok/error/unknown`，而断言读到「都在」还挺绿。**这个 bug 是本轮加 unknown 类断言时才暴露的** —— 一个不忠实的影子比没有影子更坏：它会把「没验到」显示成「验过了」。
    - 本轮新增断言：③ 步骤行齐（`1,2,3,4` 不跳号、纯模型步给耗时、只有工具行才有的步号给「—」）且「不含工具调用的步骤」那句脚注**彻底消失**；④ 两轮在册时条写「最新一轮」、浮层两行写「第 2 轮 / 第 1 轮」，且**条与浮层对同一轮的后缀逐字相同**；unknown 工具卡画成 `? 无结果` 且不与 `error` 同时挂类。
- **只能真机 F5 盖住**（9 条清单见方案）：① 4 工具轮 → 条与面板的数字量级对上抓帧锚点；② 跑动中手动下滚，位置不被打回顶部；③ 停止 → 未回结果的工具行在**面板**里写「未知」、**工具卡**上写「? 无结果」并用**警示色而非红叉**（刻意的第四态，绝不折成 error —— 那是谎报）；④ 制造一次出错 → 错误原文**只显示一条**（不是两遍）；⑤ 切会话条回「本轮尚无」、切回来那一轮还在；⑥ 重载窗口清空（**这是决策不是 bug**）；⑦ react-live 画面下条与浮层都可见；⑧ 内嵌聊天整条隐藏、两个浮层不会同时开着；⑨ C8c/C8/C3a 抽查。
- **本轮（2026-09-17 补修）要复看的**：跑第二轮后条上应写「最新一轮…」；面板里每行的步骤号**连续**（不许跳号）、纯模型步自己占一行且给出耗时；中断轮里若 DSH 补平过，面板底部说明是「**Harness 代写的，不是故障**」而不是「配对键失效」。
- **本次不做**：不落盘（不碰 `persistedSession` / `_afterTurn`）；不记 `assistant/chunk` 与工具入参/输出正文；不做跨会话的历史运行记录；不做导出；不加速度计时器/折线图；不放宽 `_liveRunning` 闸去抓「轮外帧」。
- **已知局限**：
  - **只记轮内帧**：连接期、被杀进程的迟到帧一律不入账 —— 这是 C8 ② 的正确行为，不是缺口。
  - **不跨会话、不跨窗口重载**：纯内存的直接代价（切会话即看不到，故意的）。
  - **fork 出来的会话运行记录是空的**（`_forkSession` 给了新 UI id）。刻意如此：`usage` 是累计账（显示 0 像 bug），运行记录是「这段对话刚跑过什么」，而 fork 还没跑过。
  - **单次长工具调用期间条上耗时是停住的** —— 全仓零 `setInterval` 是成文惯例，不为一个装饰性秒数开口。
  - **同轮工具超 100 次、步超 100** 只留前 100，但计数继续涨、面板明说「另有 N 次未记录」（上限是为了在跑飞时不冻住面板）。此时浮层头的派生计数只是**下限**（被丢掉的调用没有状态可数），差额由那一行说清。

### C10 · 上下文窗口指示 + 超限压缩/归档
- **现状**：无窗口占用感知，长对话无策略。
- **补法**：依赖用量可得（C3）或本地长度估算；超限时提示并给出「归档旧轮 / 摘要压缩」策略。
- **验收**：接近上限时 UI 提示；选择归档后新轮正常且记忆有说明。

### C11 · 会话级推理档位（reasoningEffort）
- **现状**：`initialize` 只认 `cwd/provider/model/maxTokens`，`reasoningEffort` 静默忽略；改只能动 `cordis.yml` 的 `llm-deepseek`（当前 max）后重启（[wire-vocabulary.md](wire-vocabulary.md)）。
- **缺口/阻塞**：**这条不是我们单方面能补的** —— 需 runtime 先支持 per-prompt 或配置热加载。
- **补法**：先给 runtime 侧提需求/做实验；在此之前 UI 只能显示"当前档位（配置决定）"。
- **验收**：能在会话级切换档位并生效（依赖 runtime 能力）。

### C12 · 项目级 agent profile
- **现状**：工具白名单、默认模型、审批策略都散在 `cordis.yml`（用户手动改的外部文件）。配置条的模型选择器只覆盖模型这一项。
- **补法**：定义可共享的 profile（每工作区/每项目一份），扩展负责写回 runtime 配置并重启；含默认模型、审批策略（C1）、工具开关。
- **验收**：切换 profile 后模型/审批策略随之生效。

### C13 · Windows / 跨环境 shell 与路径收口
- **现状**：bash 靠 PATH 找，`System32\bash.exe` 会命中 WSL shim，WSL 无发行版就全线报错（[wire-vocabulary.md](wire-vocabulary.md)）；跨盘/跨环境路径语义有坑。
- **补法**：shell 探测 + 明确降级提示；UI 表达「工具将在哪个 cwd、能否出工作区」；必要时自带 bash 或推荐配置。
- **验收**：无 WSL 的机器上给出可读引导而非一串 bash 报错。

---

## P2 — 加分项

### C14 · 事前 diff 预览（近似）
- **现状**：只能跑完再还原。wire 无 file 事件 → 无法拿"将改动的文件清单"。
- **补法**：用 tool/call 的 `arguments` 预判 + 轮前快照做近似「预计改动」提示。
- **验收**：写文件类工具调用前，能提前显示预计触及的路径。

### C15 · 多会话并行 / 分支对照视图
- **现状**：刚做的 fork 是「切过去 + 同记忆」，没有 A/B 对照。
- **补法**：并排渲染两条分支转写；明确标注共享记忆的串话风险（现 fork 与源会话共用同一 DSH 会话，回源继续发消息会被彼此看到）。

### C16 · 审批白名单记忆
- **现状**：无（依赖 C1）。
- **补法**：确认条上加「信任这次/永久信任此命令/目录」，持久化策略。

### C17 · 多模态 / 图片附件
- **现状**：附件只吃文本，包成 `<file>` 文本块。
- **补法**：取决于模型与 runtime 是否支持图片内容块；支持则协议加 image 附件类型 + 气泡渲染。

### C18 · 企业集成：代理 / 远程开发 / 审计日志
- **现状**：无。子进程 env 直接继承宿主 `process.env`（[chatViewProvider.ts](../src/chatViewProvider.ts) `_dshEnv`）。
- **补法**：可配置代理；Remote-SSH / devcontainer / Codespaces 场景验证；可选审计日志（谁在何时跑了什么命令，不含密钥）。

---

## 交叉说明

- **最小可用商业化 = C1 + C2 + C3**（敢用、装得上、花得起）。C3 的用量部分（C3a）已完成，剩 C3b 的费用/拦截。
- C1/C4/C12 同源（审批策略），做 C1 时一并设计，别拆散。
- ~~C3 与 C10 共用「用量可得性」前置验证，建议合并做一次 spike。~~ 该前置已达（C3a 已把窗口与占用透出），C10 只剩压缩动作本身。
- C11、C14 受 DSH wire 能力限制，属"要等上游"或"只能近似"——排期时不要按能 100% 达成的预期承诺。
