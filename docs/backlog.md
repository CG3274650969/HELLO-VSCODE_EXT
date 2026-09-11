# 待办清单 · 商业化缺口（DSH 侧）

面向「这个插件要能商业化卖」的缺口盘点。每条含：现状 → 缺口 → 补法（标受不受 DSH wire 限制）→ 验收。
**工作方式**：一次处理一条 —— 说编号（如「C1」），我先做现状核实（含必要时在 DSH 检出侧实证），再给改造计划 → 实现 → 验收，然后回来把本行状态打勾。

状态图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[-]` 暂缓（写原因）

## 索引

| 编号 | 标题 | 优先级 | 阻塞/依赖 | 状态 |
|---|---|---|---|---|
| C1 | 事前审批（破坏性操作确认条） | P0 | 无（走 hooks 路线，不必改 DSH） | [x] |
| C2 | DSH 运行时零配置分发 | P0 | 上游 Windows 制品缺失（明文 non-goal）；阶段一自建便携包已就绪 | [~] |
| C3a | 用量可视化（每轮/每会话 token + 上下文占用） | P0 | 无（wire 带 usage，已实证） | [x] |
| C3b | 费用估算 + 预算拦截 | P0 | 无价目数据（DSH 不带）；wire 无 prompt-cancel，超限只能拦下一轮 | [ ] |
| C4 | 工作区外写护栏与可见性 | P0 | 沙箱路线已 spike 否决（bash 侧 fail-closed）；改走 C1 的 hook 扩 matcher（`bash\|write\|edit`）+ 审阅多根。**已实测通过**（2026-09-11 F5）：挡/看/还原/临时区豁免/关设置只停问不停看/同名文件不连坐，逐条见正文 —— 期间修掉一个守卫极性 bug（区外可见性曾整个不生效） | [x] |
| C5 | 会话记忆跨重启（复用 DSH_SESSION_ROOT） | P1 | wire 无 resume；已自建运行时补丁接上（upstream 有现成 resume-first 写法）。**阶段 0 闸门 + 构建冒烟 + F5 真机均已通过**（2026-09-11）：未补丁必现 id collision，补丁后跨进程答出暗号；真机五条用例逐条见正文 | [x] |
| C6 | 会话全文检索 + 导出 + 软删除 | P1 | 无 | [ ] |
| C7 | 转写敏感内容治理（脱敏/加密/留存/彻底删） | P1 | 无（本地实现） | [ ] |
| C8 | 运行可靠性：中断续跑 / 重试 / 超时幂等 | P1 | 受「无 cancel RPC」限制 | [ ] |
| C9 | Run inspector（本轮帧时间线/耗时/工具统计） | P1 | 无（现有帧已够） | [ ] |
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
  - **只有便携运行时带补丁**：开发者路径（手配 `nodePath`/`entry`）与 `hello.dsh.command` 走用户自己的 DSH，**没有补丁** → 那里维持「每 activation 新铸 + 失忆 note」的老行为（硬复用会撞 id collision，门控就是为了不把这条炸路递给用户）。手配路径指向我们已打补丁的产物则能用。
  - 删会话不删磁盘 DSH 日志（归 C7）→ 日志只增不减。
  - 不验跨 DSH 版本的日志兼容（升级 DSH 后旧日志能否 resume，未验）。
  - resume 失败**不自动换新 id 重试**：错误照抛、用户可见（自动重试归 C8）。
  - 分支不做「真分叉」（复制日志成新 id），延续既定的共享语义。
- **验收（2026-09-11 F5 真机，五条全过）**——沿用 C4 的教训，**盯留痕（note / 盘上指针），别盯界面元素**：
  1. 发两轮埋暗号 → 重载窗口 → 点回**那个**会话问 → 答出暗号，note「已恢复此前的 DSH 会话记忆」。
  2. 完全关掉 VS Code 再开 → 点回该会话 → 仍记得（hostRand 换了新值，证明**存储里的 id 说了算**）。
  3. 中止后再发 → 不报 id collision（阶段 0 那条潜在雷一并治掉）。
  4. 建分支 → 分支的 `dsh.id` 与源**逐字相同**，继续聊记得。
  5. 换工作区打开 → note 是「已开启全新 DSH 会话」（**不假装记得**），且切回原工作区后**仍然记得** —— 盘上指针的 `cwd` 一字未变，没被覆盖。
  - 踩过的坑（记下来免重犯）：**「续聊」必须点回原会话**。新建一个对话再问暗号，那是另一个 DSH 会话，模型当然不知道 —— 一度被误判成缺陷。盘上会话 `dsh` 指针 + note 文本是唯一可靠的判据。

### C6 · 会话全文检索 + 导出 + 软删除
- **现状**：历史是 per-mode JSON；有改名/按标题搜索/物理删除；无内容检索、无导出、无回收站。
- **补法**：转写已全量在 `_active.messages` → 全文检索基于 JSON 即可；导出 Markdown/JSON；删除改软删（加 `deletedAt`，历史面板给回收站视图）。
- **验收**：搜一条只出现在正文里的词能命中；导出的 md 与转写一致；删掉的会话可从回收站找回。

### C7 · 转写敏感内容治理
- **现状**：附件正文、工具输出明文躺在 globalStorage JSON；密钥已走 SecretStorage（这点是对的）。
- **补法**：提供「脱敏存储」开关（对匹配模式如密钥/证件号做遮蔽）+ 可选加密存储 + 留存策略（N 天清理）+ 「删除即彻底」（含 dsh-sessions 落盘）。
- **验收**：开启脱敏后，转写里不再出现被匹配的敏感串；删除会话后磁盘无残留。

### C8 · 运行可靠性：中断续跑 / 重试 / 超时幂等
- **现状**：wire 无 cancel RPC → 停止 = kill 子进程，整轮状态丢（[dshRuntime.ts](../src/dshRuntime.ts)）；崩溃只上浮错误。单 JSON 每次整段覆盖写。
- **补法**：① 崩溃/停止后给「接着这个会话再发一轮」入口（转写已持久，DSH 会话若在盘上可续 → 与 C5 合并考虑）；② `session/prompt` 超时后的重发要防重复执行（先用 `session/status` 判定是否仍在跑）；③ 大转写改增量写或分片。
- **验收**：跑到一半杀掉子进程 → 能一键续跑；超时重发不产生重复工具执行。

### C9 · Run inspector
- **现状**：调试只有 `hello.dsh.debug` 往输出通道打 stderr，用户看不到本轮发生了什么。
- **补法**：本轮帧已在 `_onDshEvent` 流过 → 留一份 per-turn 事件时间线（类型/耗时/工具次数/错误），面板展示。
- **验收**：每轮结束后可查看本轮工具调用序列与耗时。

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
