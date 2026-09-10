# 待办清单 · 商业化缺口（DSH 侧）

面向「这个插件要能商业化卖」的缺口盘点。每条含：现状 → 缺口 → 补法（标受不受 DSH wire 限制）→ 验收。
**工作方式**：一次处理一条 —— 说编号（如「C1」），我先做现状核实（含必要时在 DSH 检出侧实证），再给改造计划 → 实现 → 验收，然后回来把本行状态打勾。

状态图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[-]` 暂缓（写原因）

## 索引

| 编号 | 标题 | 优先级 | 阻塞/依赖 | 状态 |
|---|---|---|---|---|
| C1 | 事前审批（破坏性操作确认条） | P0 | 无（走 hooks 路线，不必改 DSH） | [x] |
| C2 | DSH 运行时零配置分发 | P0 | 上游 Windows 制品缺失（明文 non-goal）；阶段一自建便携包已就绪 | [~] |
| C3 | 成本与用量可视化 + 预算拦截 | P0 | 需先核实 runtime 是否透出 usage | [ ] |
| C4 | 工作区外写护栏与可见性 | P0 | 依赖 C1；部分受 wire 限制 | [ ] |
| C5 | 会话记忆跨重启（复用 DSH_SESSION_ROOT） | P1 | 需实证「新进程 + 旧 sessionId」可续 | [ ] |
| C6 | 会话全文检索 + 导出 + 软删除 | P1 | 无 | [ ] |
| C7 | 转写敏感内容治理（脱敏/加密/留存/彻底删） | P1 | 无（本地实现） | [ ] |
| C8 | 运行可靠性：中断续跑 / 重试 / 超时幂等 | P1 | 受「无 cancel RPC」限制 | [ ] |
| C9 | Run inspector（本轮帧时间线/耗时/工具统计） | P1 | 无（现有帧已够） | [ ] |
| C10 | 上下文窗口指示 + 超限压缩/归档 | P1 | 需 usage/长度可得（见 C3） | [ ] |
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

### C3 · 成本与用量可视化 + 预算拦截
- **现状**：代码里无任何 token/费用统计；`reasoningEffort` 写死 max，跑一轮烧多少只能看账单。
- **缺口**：每轮/每会话 token+估算费用；月累计；达阈值提示/停跑。
- **补法**：先核实 runtime 是否在 `turn/end` 或 `tool/result` 带 usage 元数据（抓帧未见，需在 DSH 检出侧确认）；拿不到就在 llm 插件层记并透出。UI 挂在配置条/状态点旁。
- **验收**:发一轮后能看到本轮 token/费用；设 ¥ 上限后超限被拦。

### C4 · 工作区外写护栏与可见性
- **现状**：2.1 审阅只对比工作区根，agent 写到工作区外的改动**完全看不见**（wire 实测已发生过）。
- **缺口**：越界写要能被挡住，或至少显式可见 + 可还原。
- **补法**：与 C1 同源（审批策略里对「路径出工作区」这类规则开审批）；扩展侧在 tool/call 的 `arguments` 里做路径解析，越界即标红/需确认。纯 wire 无法枚举文件事件，故以「命令级预判」近似。
- **验收**：让 agent 写工作区外路径 → 弹确认或标红；工作区内改动仍走 2.1 审阅。

---

## P1 — 商用体验硬伤

### C5 · 会话记忆跨重启（复用 DSH_SESSION_ROOT）
- **现状**：`_dshSessions` 映射只在单次 activation 有效；host 重启/切模型即清空，续聊开全新 DSH 会话并插「失忆」note（[chatViewProvider.ts:711-734](../src/chatViewProvider.ts#L711-L734)）。但 runtime 已把会话落盘到 `DSH_SESSION_ROOT`（env 已注入）——通道是通的，我们没复用。
- **缺口**：跨重启保住模型记忆。
- **补法**：① 先在 DSH 检出实证「新进程 + 旧 sessionId + DSH_SESSION_ROOT 指向同一目录」能否续上；② 把 `dshId`（含校验它对应的 disk 会话存在）持久化进会话存储；③ 续聊时优先复用，成功则不插失忆 note。
- **验收**：发两轮 → 重载窗口 → 继续问「刚才聊的 X」 → agent 记得。

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

- **最小可用商业化 = C1 + C2 + C3**（敢用、装得上、花得起）。
- C1/C4/C12 同源（审批策略），做 C1 时一并设计，别拆散。
- C3 与 C10 共用「用量可得性」前置验证，建议合并做一次 spike。
- C11、C14 受 DSH wire 能力限制，属"要等上游"或"只能近似"——排期时不要按能 100% 达成的预期承诺。
