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
| C9 | Run inspector（本轮帧时间线/耗时/工具统计） | P1 | 无（现有帧已够）。**已实现、自检 31/31 + DOM 影子自检、四项探针无回归、F5 通过（2026-09-17 用户真机）** —— 耗时全靠信封自带 `time` 相减（零计时器），体积故事 = 丢弃 819/823 条 chunk；F5 先后推翻三条预设（「配对失败恒 0」「按 `isError` 判成败」，以及**「DSH 一步一次工具」**—— 实测一步可带 2–3 次并行调用），见正文 | [x] |
| C10 | 上下文窗口指示 + 超限压缩/归档 | P1 | 数据前置已解（C3a 已透出窗口/占用）。**已实现；F5 的 ①②⑤ 过了（真压缩 6 次：5 成功 1 失败；wire note 与落盘 note 逐字相同）；③ 的两半分头都过了但组合未验、④ 百分比那半过了（⚠ 那半与续聊回落未验）** —— 三个前提被推翻：压缩 DSH 早已自己做（`compaction-basic`，已 compose）、那三个事件早就在流里而我们从没读、**「归档旧轮」按字面做不到**（无 wire RPC + 日志 append-only）。另，`DSH_CORDIS_CONFIG` env 赢过位置参数这条命脉（C1 与 C10 共用）**首次被反控证住**。⚠️ **F5 之后揪出一个真 bug（C10b）**：`request/context` 只在路由**变化**时才发，续聊时一条都不发 ⇒ 分母恒缺、整条占用指示安静地不存在（那次真机的读数里就没有百分比）。已修：分母记在会话上，新增纯模块 `contextWindow.ts` + `probe-context-window.mjs`（14/14），见正文 | [~] |
| C11 | 会话级推理档位（reasoningEffort） | P1 | **原判「受限：需 runtime 先支持」已推翻** —— 机制早就在（provider 按请求解析档位、`agent/request` 瀑布的返回值就是请求 config），缺的只是入口。**已实现：自检 25/25 全绿；F5 五项全过**（④ 当场揪出一个真 bug：换会话不重播配置条，已修 `a7e5bab` + 加了结构守卫，复验通过；③ 有盘上留痕 —— 两会话各拿各的档位，且拿到「`reason=change` ⇒ 不重启就改档」的直接证据）（热切 + 真会话级；DSH 侧一行不改、用户配置一行不碰，纯追加一个我们自己的插件块） | [x] |
| C12 | 项目级 agent profile（工具白名单/默认模型/审批策略） | P1 | **原文「扩展负责写回 runtime 配置」只对了三分之一** —— 模型是 `initialize` 参数（必重连）、审批是扩展内部三个读口（零新机制）、**工具白名单运行时压根没有配置键**（要靠自挂插件调 `tools.restrict`，见正文源码坐标）。**已实现：自检 32/32 + webview 段 8 条全绿**（含端到端反控：盘上 `request/header.header.tools` 里 bash 真的没了）；profile 文件落在工作区 `.hello-chat/profile.json`，**不写用户任何文件**，「只能加严」由 `compileProfile` 一个纯函数守死；**F5 五条 2026-09-19 真机全过**（模型跟着 profile 走、`header.tools` 里 bash/write/edit 真的没了而 read 还在、忙碌时切被拒且盘上不动、「写成想关审批」弹条照旧出现） | [x] |
| C13 | Windows / 跨环境 shell 与路径收口 | P1 | **原文「必要时自带 bash 或推荐配置」没走到那一步，也不用走** —— 上游到今天确实没有换 shell 的配置键，但**PATH 是活的**（`spawn` 按传入 env 的 PATH 搜索，`dsh-subprocess` 只擦敏感键、`ENV_OVERRIDES` 不含 PATH）⇒ 扩展侧前置一个目录就能换掉 agent 的 bash，**DSH 一行不改**。**已实现：诊断 + 可选钉住 bash（`hello.dsh.bashPath`，`scope: machine`）+ 顶栏一段读数 + 坏时一次性可读告警 + 批准条的 `/mnt/…` 两读法说明**（只显示，**不做路径归一化**）；自检 **62/62 + webview 段 10 条（全套 57/57）+ C1 自检 21/21**，7 条结构守卫做过变异测试**全被抓红**；**F5 六条全过（2026-09-19 用户真机）** —— 真弹窗文案与三个按钮、窄面板下顶栏不被挤、`钉住这个 bash` 写进用户设置后真换成、`/mnt/…` 两读法在真 WSL 一轮里的排版、第三条监听器的重连、与「审批未生效」弹窗互不干扰 | [x] |
| C14 | 事前 diff 预览（近似实现） | P2 | **原文「wire 无 file 事件 → 拿不到将改动的文件清单」只对了一半** —— 真 hunk 一直在线上（`tool/result.meta.diffs`），是扩展此前一个字没读；缺的只有「事前」那半，靠 `tool/call` 的入参预判（帧先于 dispatch）。**已实现：卡片上一行「预计 → 实际」**（事前按入参算近似 diff + 命中检查，事后换成 DSH 报的 `meta.diffs`，失败/中断当场作废）；自检 27/27 + webview 段 65/65，6 条结构守卫变异测试全被抓红；**F5 未跑**（2026-09-21 用户跳过那条 react-live 回落验证，直接转 C15）—— 六条用例仍在正文里挂着 | [~] |
| C15 | 多会话并行 / 分支对照视图 | P2 | 无。**已实现：一个只读的全屏浮层把两条会话的转写在分叉点之后并排摆出来，并按数据标注它们是否共享 DSH 记忆**（串话判据**双证据：先看本次运行的映射、再看盘** —— 只看盘会漏报「补丁不可用 / `hello.dsh.command` 覆盖」那两条绝不写盘的路）；自检 **28/28（新）+ webview 段 78/78**，8 条变异测试**全被抓红**（累计 21/21）；**F5 十条 2026-09-22 真机全过**（用户确认，无逐条留痕） | [x] |
| C16 | 审批白名单记忆（信任一次/永久） | P2 | **已实现：拦停条上多一个「永久信任此命令 / 此目录」**（`<globalStorage>/approval-trust.json`，tmp+rename；匹配**逐字精确 + 所在目录**，一个字符都不归一化；撤销走命令面板 + 转写留痕）。**这一处不碰运行时**：谓词返回 false 时服务端直接放行、根本不弹条 ⇒ hook / `hooks.json` / 派生配置 / 令牌一个字节都没改；被白名单放行的区外写**照样进轮前快照**（放行 ≠ 隐身）。**顺手揪出并修掉一个真 bug：生成的 hook 从来不给 bash 带 `cwd`** ⇒ 键少了一半、「同一条 `rm` 在另一个工作区」会被静默放行。自检 **55/55（新）+ roundtrip 24/24 + webview 89/89**，11 条变异**全被抓红**（累计 32/32）；**F5 八条待跑** | [~] |
| C17 | 多模态 / 图片附件（**诚实降级**） | P2 | **原文「取决于模型与 runtime 是否支持图片内容块」已问死：今天图片到不了模型**（三层墙，两层不在我们手里：wire 的 `prompt()` 从不调 `admitEncodedImages`、便携运行时没挂附件仓库 ⇒ `read_image` 都不存在、`deepseek-v4-flash` 没声明 `inputModalities`）。**已实现：图片被认出来 + 一条 agent 够得着的落点（`.hello-chat/images/`）+ 一枚说明它是图片的 chip + 提示词里一段明说「你看不到它」的说明**，字节永远不发。顺手修掉**两个真缺陷**：① 截图（>10KB）被报成「文件过大（>10KB）」；② 小图标被 `readFileSync(…,'utf8')` 读成乱码喂进提示词（PDF/ZIP 同罪）；另揪出**第三个真 bug —— 粘贴判据读的是 `e.dataTransfer`**（那条路从来没通过）。自检 **47/47（新）+ webview 97/97**，16 条变异**全被抓红**；**F5 已跑第 2、3 条（真机确认，见正文「F5 实录」）**，余下待跑。真机那次还捎带发现两条：**路径得给 WSL 第二读法**（已修）与 **bash 越界动作完全没护栏**（已立 **C19**）。**C17b（2026-09-23 当日反转）**：那段说明**已整个搬出用户消息**、改由系统提示词承载 —— 气泡里只剩用户自己的话（见正文末「C17b 反转」）。**C20（2026-09-23 立）**：chip 末标此后由「通路判定」定稿，三处（chip / 导出 / 那段说明）一起跟着走 —— 今天判为**关**（**C20 已实现并提交 `e026b5d`**，见正文；探针 attach 49/49 + prompt 32/32 + webview 99/99、12 条变异全红；**F5 四条 2026-09-23 真机全过**） | [~] |
| C19 | bash 越界动作护栏（装包 / 下载 / 提权） | P1 | **2026-09-23 C17 真机现场发现的缺口**：agent 为了「看一眼」一张图，在 WSL 里下了 `get-pip.py`、装了 pip/Pillow/numpy/opencv/onnxruntime/rapidocr、还试了 `sudo`，**一次审批都没弹** —— 而这不是漏判：bash 只按 `matchesAnyPattern` 判，十条默认正则全是**破坏性命令**的模式，`pip install`/`curl`/`sudo` 一个不匹配（C4 的「工作区外」只覆盖 `write`/`edit`）。C4 的已知局限里写着「bash 写进某目录不在内」，**真机露出来的是它的更大一半：在区外装东西、下东西、提权**。**未开工**（补法要先拍板：见正文三条路线） | [ ] |
| C20 | 图片通路的**单一判定**（chip / 导出 / 系统提示词那段一起跟着走） | P2 | **不是新功能，是 C17 的收尾**（C17 的 F5 第 1 条此后由本项定稿；F1「字节永不发给模型」与三条拒绝文案一个字不动）。判定用**现成的 wire 事实**：`read_image` 在不在这一轮的 tool 表里 —— 它注册在 `ctx.inject(['attachments'], …)` **里面** ⇒ 在 ⟺ 运行时挂上了附件仓库，那正是 C17 三层墙里**唯一一层在我们手里**的；读法与 C12 的工具白名单同一处，而且**比直接问附件仓库好**（看得见 profile 的 deny 表）。**今天实测 = 关**（`bash, edit, read, subagent, todo_write, write`）。三处从**一个纯函数**派生；缺值 / 老会话 / 读不到一律按「关」（fail-closed）。⚠️ 它与 C17b 的张力一句话说清：C17b 改措辞的理由是「两个世界都为真」，而**一句在两个世界都为真的话没有东西可跟着动** —— 本项补的是那个「事实」。**已实现、已提交并已推 `origin/dev`（2026-09-23，`e026b5d` + F5 记录 `4cdac84`）**：措辞按用户拍板的候选 1（关 =「图片输入未接通」／开 =「模型需自行读取」），判定 = `read_image` 在不在 `request/header.header.tools` 里，三处（chip / 导出 / 系统提示词那段）从一个纯模块派生，**缺值一律按关**（fail-closed）；探针 attach **49/49** + prompt **32/32** + webview **99/99**，**12 条变异全被抓红**。**F5 四条 2026-09-23 真机全过**（① chip 是「关」那版 + 盘上 tools 无 `read_image`，同一条日志两证；② 手改会话 flag 为 `imageRead: true` ⇒ 重载后 chip 与导出都变「开」那版，发一轮后**轮尾自动翻回「关」**；③ 新会话贴图是「关」；④ 重载后 chip 不漂）。⚠️ **「开」档在真运行时 `header.system` 里的端到端留痕未取到**：那一刻的会话日志还在活进程的内存缓冲里（DSH 的 jsonl 是**进程退出才 flush**，用户收尾时没关窗）⇒ 「开」档到今天仍只有单元级证据 + 状态表级旁证，**别读成「双控已过」**。三条「不做」不变（头一条是**不加能撒谎的用户开关**） | [x] |

> **C18 已删（2026-09-23，用户决定不做）** —— 原为「企业集成：代理 / 远程开发 / 审计日志」。编号**空着不补**：C19 / C20 在提交历史、正文与外部记录里已经用这两个号叫开了，重排只会让历史对不上号。

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

- **决策回路自检（2026-09-18 补）**：`scripts/probe-approval-roundtrip.mjs` → **18/18**。此前「点了拒绝，命令真的没执行」
  这条只有 C1 的真机人眼见证过一次，**判据住在一个 import vscode 的类里**（同一个病灶正是 C10b 那次事故的成因）。
  现在把整条回路——真 `ApprovalServer` + 真 hook 脚本 + 真 HTTP + 真子进程——整个搬到扩展宿主之外跑：
  允许 = 不表态、拒绝 = 落到 `permissionDecision` 且是我们的话术、不要问就**根本不弹条**、同一 id 二次答复返回 false、
  超时与「停止」都以拒绝收尾、**两条兜底各钉一遍**（bash 不可达时按内置清单 fail-closed，write/edit fail-open），
  外加令牌不对 → 403 → 走兜底。⚠️ 探针**不执行任何命令**：hook 脚本只问不跑（末条断言直接扫脚本源码里没有进程调用）。
  它第一次跑就抓到一条真问题：`ApprovalServer.answer()` 的原因串写死「该命令」，于是 hook 里按工具分开的「该写入」
  **在可答路径上从来没生效过** —— 而这条原因是要回给模型看的（已修：`nounOf()` 按 `ask.toolName` 选名词，取消那条同理）。
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
     - ⚠️ **这条写于 2026-09-07，只对「新建会话那一次连接」成立**（C10b 更正，2026-09-18）：「恰好一条」是**日志**里恰好一条，因为它 append 前拿**从日志折出来的**上一次比对，值相同就跳过 —— 于是**续聊的整个连接里它一条都不发**。当时的措辞让人以为「分母稳拿」，C10 的占用指示就是照这个假设写的，结果在「继续旧会话」这条最常见的路径上整条指示安静地不存在。详见 C10 的 **C10b**。
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

#### 旁证（2026-09-18）：区外「还原」确实会删掉 agent 本轮**新建**的文件

一次跟本项无关的清理里冒出来的证据：`D:\metabase\8.31数据处理\_tool_test_scratch\`（某轮 agent 自己建的临时目录）在 18:05 被清空，用户当时以为有外部进程在动他的盘。逐个动作对时间线排除了这个解释 —— **那是用户自己在审阅条上点了「丢弃 / 回滚」**（用户已确认）。

它补的是 2026-09-11 那张表没单独钉住的一条：那次验的是区外**已存在**文件被改后还原（`d.txt` 被删），这次是**本轮新建**的文件被还原 → 文件消失、目录留下。两件事在 `applyRevert` 里本来就是同一条路（`added` → 删掉），判据也同源，所以机制上不算新发现，**真机第二次确认**而已。
（⚠️ 那条路径对本轮而言算不算「工作区外」，取决于该会话载荷里的 `cwd` —— containment 判的是它，不是 VS Code 的工作区根（见上节）。我这边没有留痕能钉死当时是哪种，但两条路共用同一个还原实现，结论不受影响。）

**值得记的不是机制，是观感**：用户看到的只是「那个目录被清空了」，**完全没把它和「审阅条上点了一次还原」联系起来** —— 还原按钮点下去没有二次确认，也不会回一句「已删除本轮新建的 N 个文件」。C4 的「可见」在**文件级**是兑现的（有留痕、可还原），缺的是**目录级**那一眼：一次还原抹掉一个目录的内容，用户不会去数。真要改的方向是还原前给一份「将删除 N 个文件」清单（或至少一句计数回执）；本次只记现状，不改代码。

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

### C9 · Run inspector（2026-09-17 完成，F5 通过）
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
- **F5 实测（2026-09-17 用户真机，两轮真跑，补修后复看的三条见末）**：
  - **步分组拿 wire 对拍**（把 `dsh-sessions/**/session.jsonl.zstd` 按 zstd magic 切帧解出来，用 `step/start`–`step/end` 切段重算 —— **另一条代码路径**，与 `probe-run-inspector` 的 oracle 同一个套路）：面板 `8.5 / 2.5 / 3.5 / 3.8 s` ⟷ wire `8496 / 2542 / 3514 / 3804 ms`；每步工具数 `2/2/2/3/2` **全等**；11 行工具序列**逐字相同**；面板里第 3 行那条 `read`「失败」在 wire 上就是一次真实失败。
  - **⚠️ 又推翻一条预设 —— 我写方案时那句「DSH 一步一次工具（3 份抓帧全如此）」是错的**：实测**一步可以带 2–3 次并行工具调用**（该轮 9 步 / 15 工具，每步 `2/2/2/3/2/2/1/1/0`）。按 step 分组因此是**必要的**（照 1:1 切会给这一轮造出 15 个假步）；而「步 = 模型延迟 + 工具」仍然成立（另一轮步 1 用了 30.2 s，其中工具只占约 6 s）。
  - **中断**：未回结果的工具行写「未知」+ 耗时「—」（**不是**「失败」）—— 正是本项开头点名要避免的那个谎报。条 `最新一轮已中断 · 11 工具 · 60.0s · 3 失败` 与浮层 `第 2 轮已中断 · 11 工具 · 60.0s · 3 失败` **同屏逐字可比**（只差称呼），这是第 ④ 条设计目标的直接证据。⚠️ 这条读数当时**漏了「1 结果未知」**（`else if` 链把它吞了），已于 2026-09-18 改为并列，见下方已知局限最后一条。
  - ② 跑动中手动下滚**位置不被打回顶部**、⑤ 切会话条回「本轮尚无」且切回来记录还在、⑧ 两个浮层互斥 + 内嵌聊天整条隐藏、⑦ react-live 画面下条与浮层**都可见**：**通过**（用户真机）。
  - ④ **出错：通过（用户确认），未留痕**。⚠️ 两屏证据里能看到的 `3 失败` 是**工具级**失败（`edit` 被 fs 观察策略挡、两条 `read` 撞路径映射），**不是轮级「出错」** —— 沿用 C8 那次「逐条未留痕 → 记『通过（用户确认）』」的成例，别把这条读成我们亲眼看过。
  - ⑥ 重载窗口清空：实测（重载后浮层只列重载**之后**的两轮）。
  - **补修后复看的三条全部成立**：条上前缀写「最新一轮」；面板步骤号连续（1→6 不跳号）；该轮没触发补平帧，那三条判据仍由 `probe-run-inspector` 的 `REPAIR_PAYLOAD_*` 钉着。
  - 顺带白拿的一条旁证：该轮转写里 `hook/invoked=8 / hook/result=8` —— **C1 的审批 hook 在真实会话里是活的**（8 次全部 pass，都不是 `rm`）。
- **本次不做**：不落盘（不碰 `persistedSession` / `_afterTurn`）；不记 `assistant/chunk` 与工具入参/输出正文；不做跨会话的历史运行记录；不做导出；不加速度计时器/折线图；不放宽 `_liveRunning` 闸去抓「轮外帧」。
- **已知局限**：
  - **只记轮内帧**：连接期、被杀进程的迟到帧一律不入账 —— 这是 C8 ② 的正确行为，不是缺口。
  - **不跨会话、不跨窗口重载**：纯内存的直接代价（切会话即看不到，故意的）。
  - **fork 出来的会话运行记录是空的**（`_forkSession` 给了新 UI id）。刻意如此：`usage` 是累计账（显示 0 像 bug），运行记录是「这段对话刚跑过什么」，而 fork 还没跑过。
  - **单次长工具调用期间条上耗时是停住的** —— 全仓零 `setInterval` 是成文惯例，不为一个装饰性秒数开口。
  - **同轮工具超 100 次、步超 100** 只留前 100，但计数继续涨、面板明说「另有 N 次未记录」（上限是为了在跑飞时不冻住面板）。此时浮层头的派生计数只是**下限**（被丢掉的调用没有状态可数），差额由那一行说清。
  - **条上那三种后缀已改成并列**（2026-09-18，`media/chat.js` 的 `runLine`）。旧版是 `else if` 链（错误 → 失败 → 结果未知），同时命中时只显示优先级最高的那个：实测中断轮「1 未知 + 3 失败」，条上只剩「3 失败」—— 而「结果未知」恰恰是中断轮里最该被看见的一条（**工具可能跑了也可能没跑，别盲重试**，与 C8 的措辞同源）。并列后为 `本轮已中断 · 11 工具 · 59.1s · 3 失败 · 1 结果未知`，顺序固定（重 → 轻），所以「条与浮层对同一轮的后缀逐字一样」那条断言仍然成立。
    **只动条这一层的排版，浮层与工具卡一个字没改**：它们本来就分别写「未知」和「? 无结果」，信息从没丢过（这正是当初把它记成「局限」而不是 bug 的原因）。DOM 影子钉死了新形状（含 F5 那一轮的比例：3 失败 + 1 未知）；**真机 F5 复看未做** —— 这条改动没有新的运行时行为，C9 索引行的 `[x]` 依据仍是 2026-09-17 那次。

### C10 · 上下文窗口指示 + 超限压缩/归档（2026-09-18 实现；F5 ①②⑤ 已过，③④ 剩人眼半步；C10b 修正见文末）
- **原文验收**：接近上限时 UI 提示；选择归档后新轮正常且记忆有说明。
- **调研后，这条的形状跟 backlog 写的不一样 —— 三个前提被推翻**：
  1. **「压缩」DSH 自己已经做了，而且已经接在便携运行时上。** `runtime/cordis.default.yml:90-96` compose 了 `@deepseek-ai/dsh-compaction-basic`（`thresholdRatio: 0.8` / `retainRatio: 0.16` / `auto` 默认 `true`）。它在 `agent/pre-step` 压力（`totalTokens >= floor(contextWindow × 0.8)`）或 provider 报 `CONTEXT_WINDOW_EXCEEDED_CODE` 时，把一段旧事件摘要成 `<compacted-summary>` checkpoint，并 append `compaction/start|summary|end` 三个会话事件。
  2. **但它现在是完全静默的。** 那三个事件按 wire 的全量转发规则**已经到扩展手里了**，而 `_onDshEvent` 的 case 只有 6 个（`assistant/chunk` / `assistant/message` / `request/context` / `tool/call` / `tool/result` / `turn/end`），**一个都没读**；压缩写回的那条 `user/message` 也没有 case，被整个忽略。⇒ 一旦触发，模型记忆被折叠成摘要，界面上一个字都没有。
  3. **「归档旧轮」按 backlog 的字面意思做不到。** ① wire 上没有任何 compaction 方法（全量清单只有 `initialize` / `session/prompt` / `shutdown`），`/compact` 那条命令插件没 compose，且 `CommandRuntime.execute()` 在 JSON-RPC 通路里**没有调用方** ⇒ 无法按需触发；② DSH 的 `session.jsonl.zstd` 是 append-only + zstd 帧边界 + offset 修复的日志，改它 = 续聊全废（C7 已实证）。⇒ 能做的是**让压缩可见、让阈值可调**，不是自己去裁记忆。
- **实测锚点（决定阈值政策的那两个数）**：`request/context` 一致报 **`contextWindow: 1000000`**（`deepseek-official` / `deepseek-v4-flash`，8 个会话全同）；同一批抓帧里 prompt 侧压力**峰值只有 2K–6K token**（`inputTokens + cacheReadTokens`，缓存读占 ~94%）。⇒ DSH 那条线（0.8 × 1M = **80 万**）离日常用量差**两位数量级**。要让它触发，阈值得压到 0.01–0.02，而压缩**有损且不可撤销**。
- **用户拍板（2026-09-18）**：四件都做 —— ① 占用指示 + 接近上限提示；② 把 DSH 的压缩变成可见；③ 调低阈值让它真的会发生；④ 折叠我们自己的转写（旧轮）。提示落在 **`#usage-bar`**（不新开条/浮层）。阈值**做成设置项、默认仍 0.8**（零行为改变）。
- **D1 · 占用指示（扩 `#usage-bar`）**：数据与 UI 位都已有了，缺的只是「接近上限喊一声」。
  - [src/protocol.ts](../src/protocol.ts) 的 `UsageReadout.context` 加 `state?: 'ok' | 'near'` 与 `stale?: boolean`，`UsageReadout` 加 `compacted?: number`。**判据在扩展侧算**（同 `runLine` / `_summary` 的分工，webview 只排版）。
  - [src/chatViewProvider.ts](../src/chatViewProvider.ts)：警告线 = `thresholdRatio × 0.85`（默认 0.8 → **0.68**），留 15% 余量是为了在 DSH 真的动手**之前**给个信。
  - ⚠️ **口径必须诚实，且写进了 title 与注释**：分子是 **provider 上报的 prompt 侧压力**（`turn.pressureTokens`），而 DSH 的判据是 `token-meter` 的 `totalTokens`（`CHARS_PER_TOKEN = 4` 的启发式估算，还含输出）—— **两个不是同一个数**。所以界面只说「接近压缩阈值」，**绝不说**「距离压缩线还有 X」。这条有探针钉着（断言 title 里必须出现「不是同一个数」、且不许出现「还有」）。
  - **「打开旧会话」那条永远是空的** —— 占用本来只活在内存里（`_turnUsage` / `_contextWindow`），而占用恰恰是这条读数唯一要说的东西。⇒ 轮尾把最后一个样本存进 `StoredSession.context?: { usedTokens; contextWindow; at }`（**新落盘字段**），`_usageReadout()` 在活值缺席时回落到它并置 `stale: true`，界面标「上次」（不冒充实时）。
  - ⚠️ **但只有这条回落是不够的**：`stale` 也只能在「盘上记过样本」时才有得回，而续聊时连**分母**都缺 ⇒ 样本也永远记不下来（死循环）。这是 F5 之后才揪出来的（见文末 **C10b**）：`resolveContextWindow()` 补上「分母也可以从会话上记的那个来」。
  - [media/chat.js](../media/chat.js) 的 `renderUsageBar()`：`state === 'near'` 时追加 `⚠ 接近压缩阈值` 并给条挂 `.usage-bar.near`；`stale` 时标「· 上次」；`compacted > 0` 时加一段「已压缩 N 次」。**这两个后缀是并列的不是 `else if`** ——「上次」说的是读数有多旧，「接近阈值」说的是量级，两者可同时成立。
  - **不动**现有分段与那个 `pct >= 1` 才显示百分比的规矩 —— 有警告状态时百分比必然远超 1%，自己就出来了。
- **D2 · 压缩可见**：[src/compactionNotice.ts](../src/compactionNotice.ts)（新，**纯模块**：绝不 import vscode，入参是结构型载荷，于是探针能在扩展宿主之外加载它 —— 同 `runInspector.ts` / `turnState.ts` 的体例）。`readCompactionEvent(type, data)` 认 `compaction/summary` 与 `compaction/end`，其余类型返回 `undefined`，垃圾输入不抛。
  - 三条写进文件头的约束：**① 压缩发生了就绝不沉默**（字段漂移时降级成「细节缺失」，而不是返回 undefined —— 静默正是这个功能要消灭的东西）；**② 成功只报一次**（成功路径上 `summary` 后面紧跟一个无 `error` 的 `end`，两边都报就重复了）；**③ 不读摘要正文**（note 里不许出现 `data.summary` 的正文 —— 那是往转写里灌二手记忆）。
  - 载荷形状**逐字抄自**插件 `commitCompactionBody` 与 `compactRegion` 的 catch 分支：`summary` = `{compactionId, sourceCommandId?, summary, rawOutput?, llmStreamCall?, shadowedRange:{start,end}, shadowedSeqs[], shadowedTokenCount, provider, model, maxTokens?, usage?}`；`end` = `{compactionId, sourceCommandId?, turn}` 或同样内容加 `error`（`errorChain(error)` 返回的是**字符串**，已对照 `dsh-llm/lib/index.js:313` 验证）。
  - [src/chatViewProvider.ts](../src/chatViewProvider.ts) 的 `_onDshEvent` 加两个 case，命中就 `this._pushNote(text)`（C8 那条中断 note 走的同一个口子）；note 入 `_active.messages`、随轮尾 `persist()` 落盘。另记一个计数（`StoredSession.compacted?: number`）让 D1 的条能写「已压缩 N 次」—— note 会滚走，条上那段才持久。
  - **不做**：不渲染那条 checkpoint `user/message`（它是 DSH 内部的 surface 操作，不是用户说的话）；不读 `summary` 正文。
- **D3 · 阈值设置项（派生配置）—— 风险最高的一环**：新设置项 `hello.chat.compaction.thresholdRatio`（number，默认 **0.8** = DSH 原值，范围 `(0,1]`，`scope: "window"`，中英双语 description），进「AlohaDSH · 发送与审阅」块。
  - **结构障碍**：原来的派生（`dshHooks.ts`）是「用户原文 + 末尾追加一个**写死的** hooks 块」，**没有覆盖已有插件 config 的机制**；而且派生**只在 C1 审批就绪时发生**。
  - **锚点文本替换**（照 `scripts/runtime-patch.mjs` 的成例：锚点出现次数 ≠ 1 就 throw，不用 `includes`）：`patchCompactionRatios()` 只改 `- id: compaction-basic` 块**内部**的两行比例。行匹配排除注释行，且不许跨出该块（块的结束 = 下一个缩进归零的行）；按检测到的行尾重组，**不把 CRLF 洗成 LF**；值本来就相等 ⇒ **原样返回**（于是默认设置下产出与今天**逐字节相同**）。
  - ⚠️ **必须同时改 `retainRatio`**：插件有硬约束 `retainRatio >= thresholdRatio` → **加载期** throw（`validateRatioRetention`，已逐字核对）。默认 0.16 与 0.8 是 1:5 的关系，所以按 `retainRatio = thresholdRatio × 0.2` 同步缩放 —— **只调 thresholdRatio 会让插件加载失败**，这是这一项最容易踩的坑。
  - `retainRatio` **缺失时补插**（不能假定基础配置里一定有它），插在 `thresholdRatio` 行之后；底本改用绝对 `retainTokens` 的（与 `retainRatio` 互斥）**拒绝改写**并响亮告警。
  - **「派生」从「审批」里拆出来**：`_overlayConfigPath` 与 `_approvalFiles` 分开（生命周期不同 —— 审批关掉时后者会被清空，而压缩阈值覆盖必须继续生效）；`_refreshDerivedConfig()` 是**唯一**的刷新点，位于 `_doConnectLive()` 里 `await this._ensureApproval()` **之后**（那一行就是「审批关着时覆盖也生效」的落点，因为 `_ensureApproval` 在关着时是空返回）。**补丁失败绝不 throw** —— `_setupApproval` 的 catch 会 `server.dispose()` 并禁用 C1，为可选旋钮换掉主功能是荒谬的；失败以 `warning` 返回、走独立的告警旗标、`_overlayConfigPath` 置空（回到用户原配置），绝不阻断连接。
  - **零回归是构造保证的，不是靠运气**：默认 ratio 下 `compactionOverride()` 返回 `undefined` ⇒ `writeDerivedConfig` 根本不调补丁 ⇒ 派生文件与今天逐字节一致。
  - ⚠️ **顺手证掉的一颗雷**：便携运行时那条路上位置参数给的是 `runtime.config`（**基础**配置），派生文件**只走 `env.DSH_CORDIS_CONFIG`**（`_makeSpawnRequest`）。C1 能生效说明 env 赢，但这件事此前**从没被单独钉过**，而它失效的样子是「一切正常，只是护栏与旋钮从不生效、无任何报错」。⇒ 新增 [scripts/probe-derived-config-boot.mjs](../scripts/probe-derived-config-boot.mjs)（**4/4**）一正一反：正控 = 合法比例的派生配置能 `initialize`；**反控 = 故意写成 `retainRatio >= thresholdRatio` 的派生配置必须起不来**。反控如实失败——DSH 原话 `BasicCompactionConfig: retainRatio (0.5) must be less than the resolved thresholdRatio (0.02)` ⇒ **`DSH_CORDIS_CONFIG` 确实赢过位置参数**，C1 与 C10 共用这条命脉，现在有证据了。
- **D4 · 折叠我们自己的转写（仅界面）**：[media/chat.js](../media/chat.js) 的 `renderSnapshot()` 是「清空 + 全量重建 DOM」，几百条消息的会话每来一帧就整批重建一遍 —— 那就是「越跑越重」的来源。改成只渲尾部 `FOLD_KEEP = 60` 条，前面插一行 `.msg-fold`「更早的 N 条已折叠（仅界面，DSH 记忆未变）· 显示」，点一下整帧重渲染（消息一条不丢，还在 `_active.messages` 里）。展开状态是**会话级**的：`case 'snapshot'` 里 sessionId 变了就复位（否则「上一条长对话点开的显示」会把下一条的头部也整批渲染出来，而折叠本来就是为了省掉那一批）。
  - ⚠️ **别把它说成省内存**：它只省 DOM 重建，**不减少 `snapshot` 下发的 payload**（`_postSnapshot` 照旧发全量），也不碰 DSH 的上下文占用。这句写进了函数注释与按钮 title，探针也钉着（按钮文案必须含「仅界面」与「DSH 记忆未变」）。
- **F5 记录（2026-09-18 真机）**：把阈值调到 **0.02** → 重连 → 跑一段够长的对话 → 按用户指令改回 **0.8**。
  - ✅ **压缩真的发生了，而且真的可见**：DSH 日志里 6 × `compaction/start` / 5 × `compaction/summary` / 6 × `compaction/end`（其中一次带 `error` 失败）；转写里出现 note，读数条写出「已压缩 N 次」。盘上那个会话最终 `compacted = 5`（与 6 条 note = 5 成功 + 1 失败守恒）。⚠️ 中途我用一次 `grep` 的结果误判过它（显示 `"compacted": 0`），实际去看盘上那份是 5 —— **别拿 grep 的一行当数据**。
  - ✅ **阈值覆盖真的生效**：派生文件是唯一带 0.02 的那份 ⇒ 真机上再次确认 `env.DSH_CORDIS_CONFIG` 赢过位置参数（此前只有反控探针这一条证据）。
  - ⚠️ **比错底本会看成灾难**：便携运行时下基础配置是 **`dist-runtime/cordis.yml`**（仓库那份中文注释的模板），不是 `hello.dsh.config` 默认指向的上游英文示例。拿错了底本去 diff 会看到一堆「注释被改写」，那是**底本不同**，不是补丁脏。正确底本下差异恰好是两条比例 + 审批块。
  - ✅ **⑤ 的机器可验部分**：拿盘上最长的真实会话（99 条消息 / 56 张工具卡）过影子 —— 折 39 / 渲 60、展开后一条不少、同会话刷新不折回、切走切回复位。
  - 🟡 **③ 的两半分头验过、组合没验**：那次真机跑里 `hook/invoked × 40` ⇒ 审批是**开着**跑的（文件级那半已验：`_doConnectLive` 里 `_refreshDerivedConfig()` 是无条件调用，且 `writeDerivedConfig(hooksPath='')` 的产出只差那两行、无 hooks 块）。**2026-09-18 补验**：人眼那半过了（关审批 → `rm -f` 直接执行、不弹条、18 个既有文件 md5 全等；重新勾选后弹条照旧），决策回路那半由新探针机器盖住。⚠️ **但组合仍空着**：那次关审批时阈值是默认 0.8，而 0.8 下本来就不产出覆盖 ⇒ 「审批关 + 阈值非默认」没被走到。要验：0.02 → 重载 → **关审批** → 看派生文件那两行确实变了且 DSH 连得上。
  - ⚠️ **调回 0.8 不会立刻生效**：cords 只在插件启动时读配置，**要等一次重连**；在那之前线上那份仍是 0.02、还会继续压。改设置是定点手术（只动那一行、全文其余逐字节不变、留了 `.hello-c10-backup`）。
- **C10b · 续聊时分母永远拿不到（F5 之后揪出来的真 bug，已修）**：
  - **现象**：那次真机的读数条写着「本轮 ↑65.5K ↓11.3K · 缓存 66% · 累计 … · 已压缩 3 次」，**没有百分比、也没有 ⚠**。而当时警告线 = 0.02 × 0.85 = 1.7%（= 17000），活分子 65.5K/1M = 6.5% —— 本该 `near` 且百分比远超 1% 自己就该出来。
  - **根因（三层，逐层从源码与真数据核过）**：`request/context` 的 emit 先拿 `session.requestContext()` 比对（`dsh-agent-loop/lib/index.js:749`），而那个 fold 是**从已落盘的日志**折出来的（`dsh-session/lib/index.js:1512`）⇒ 续聊时「上一次的上下文」早就在日志里且值相同 ⇒ **不 append ⇒ 不上 wire**。实测那份 1704 条事件的日志里 `request/context` **只有 1 条**（位置 8，会话第一次请求）。⇒ `_contextWindow` 在整个连接里恒为 undefined ⇒ ① 读数条不显示占用；② `_foldTurnUsage` 的落盘分支永不成立 ⇒ `StoredSession.context` **一次都没写过**（23 个会话 / 12 个有 `usage` / **0 个**有 `context`）⇒ `stale` 回落根本没有数据源。一句话：**「继续一个旧会话」这条最常见的路径上，整条占用指示安静地不存在**。
  - **排除掉竞争解释**：真要是重连时重放了历史事件，旧的 `compaction/summary` 会被重复收到、`compacted` 会翻倍 —— 实测正好是 5（与成功 note 数守恒）。对照组：`request/header` **每次连接都重发**（实测 `reason` = initial / resume / resume，因为那个「已记录」标志在内存里），**但它不带窗口**（`config` 只有 provider/model/maxTokens/reasoningEffort）⇒ 没有近路可抄。
  - **修法**：分母当**会话属性**记下来 —— 新增 `StoredSession.contextWindow?: number`，`request/context` 真到了就顺手记进 `_active`，读数与落盘一律走 `resolveContextWindow(活值, 记住的)`（活值优先，模型/路由一变活值就变，所以必须先看它）。算术与回落规则搬进**纯模块** [src/contextWindow.ts](../src/contextWindow.ts)（**不 import vscode**）。
  - **为什么非搬不可**：这个 bug 400+ 条既有断言**一条都够不着** —— 判据全藏在 `import vscode` 的类里，而它失效的样子是「本该出现的东西没出现」。肉眼是当时唯一的判据，可肉眼那时在看别的东西。
  - **覆盖**：[scripts/probe-context-window.mjs](../scripts/probe-context-window.mjs)（新）**14/14**，其中「★★ 活值缺席、会话记住了 ⇒ 仍然拿得到分母」就是**那次事故的回归用例**；另钉住：坏值一律当「不知道」、阈值写坏时按默认算、`ratio = 1` 的线在 85%（余量照乘，不是「满了才喊」）、分母不可用时不谎报 near、以及**分母与读数都要能落盘往返**。
  - **遗留（别当成已解决）**：**盘上已有的老会话补不回来**（它们从没记过分母）—— 要从下一个新会话起才生效，除非哪天路由真的变一次。另外 `_openSession()` 仍不清 `_contextWindow`（现在良性：两个来源同源同值，且窗口是 (provider, model) 的属性）。
  - **教训（写死）**：凡「判据」都要能**在扩展宿主之外被加载**。放进 `import vscode` 的类里 = 放弃机器验证，等于承认这条只能靠肉眼 —— 而肉眼抓不住「缺失」。
- **自检（全部零依赖、零 key、不过模型）**：
  - [scripts/probe-compaction-notice.mjs](../scripts/probe-compaction-notice.mjs)（新）**20/20**：载荷逐字抄自插件；断言禁止摘要正文、成功不重复上报、错误截断、**降级而非静默**、垃圾输入安全、`fmtTokens` 档位。
    - **后半段是真帧对拍**（2026-09-18 补上）：把盘上会话日志里的 `compaction/*` 解出来逐条喂进 `readCompactionEvent`，要求产出与**落盘的 note 逐字相同、顺序相同**，成功 note 数与 `compacted` 字段守恒，note 里的条数/token 数确实来自帧上那两个字段（独立重算，不复制我们的格式化规则）。实测 17 条真帧：start 6 / summary 5 / end 6。
    - ⚠️ 头部那条「**唯一**一条没有真帧可回放的探针（5270 条已抓事件里一条 `compaction/*` 都没有）」**已经不成立** —— 那是默认阈值太高、从没触发过的结果，不是「不可能有」。同一个坑别再踩：**「我们没抓到过」不等于「它不会发生」**。
    - 顺带钉住一条我们**故意不用**的东西：`shadowedRange` 实测可以是**反的**（`start 36129 > end 36125`）⇒ note 里一个数字都不许出现它。
  - [scripts/probe-context-window.mjs](../scripts/probe-context-window.mjs)（新，C10b）**14/14**：见上面 C10b 那条。
  - ✅ **`ApprovalServer` 被改过一行**（2026-09-18）：新探针抓到拒绝话术写死「该命令」，对 fs 工具说错了名词 —— 改成按 `toolName` 选（`nounOf()`）。动了 C1 的代码，所以 C1 的两条探针都重跑过（见下）。
  - [scripts/probe-compaction-override.mjs](../scripts/probe-compaction-override.mjs)（新）**31/31**：以仓库里真的 `runtime/cordis.default.yml` 为黄金输入 —— 恰好 2 行不同、CRLF 保持、幂等、行内注释/尾随空格、相邻块同名键不误伤、`modelPolicies[].thresholdRatio` 不受影响、9 个拒绝用例、全范围 `retainRatio < thresholdRatio` 不变量、以及「默认值 ⇒ 逐字节相同」。
  - [scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs)（新，**重建并入库**；C10 落地时 42/42，**现为 57/57** —— 多出的 5 条是 2026-09-18 配置条三钮的第三次收窄（见 C12 的 D5），另 10 条是 2026-09-19 C13 的读数与路径两读法，见 C13 的 D5）：用最小 DOM 影子把 `media/chat.js` 载进 Node（加载期依赖只有 `acquireVsCodeApi()` 与 `window.addEventListener('message')` 两处），断言 D1 的 near / stale / compacted 各态与 `.near` 类的挂/摘、D4 的折叠条数与位置（折的是头部、首条渲染的是第 41 条）、点「显示」后全部回来、同会话刷新保持展开而**换会话复位**；外加 C9 运行条与浮层的一小段回归样、**C11 档位菜单**（默认「跟随配置」；当前档位才打勾；点一次只发一条 `set-effort` 且带对值；点当前项**不发**；`thinking: disabled` 下三档既置灰**又根本没挂 click 监听** —— 所以"置灰的行点不动"是结构保证、不是靠回调里再判一次）、**C12 profile 菜单** 8 条，以及一段 **D4 真数据**（最长真实会话 99 条 / 56 张工具卡：折 39 / 渲 60）。
  - [scripts/probe-agent-profile.mjs](../scripts/probe-agent-profile.mjs)（新）**32/32**：C12 四段（解析 / 「只能加严」表驱动 / 插件决策表 / 端到端 `header.tools` 正反双控），详见 C12 正文。
    - 真数据那两条断言各假红过一次，都是**断言写错了而不是代码错了**：① 拿 `msg.text` 去比 `role: 'tool'` 的消息（工具卡渲的是 `msg.toolName`）⇒ 改成按 role 取签名；② 真实助手消息里有反引号与 `D:\…` 反斜杠，markdown 渲染会转义 ⇒ 改成归一化后再比（`plainText()` 只留实词）。**探针的红要先怀疑自己**。
    - **这次它又抓到两个真 bug**，且第 ① 个正是「不忠实的影子比没有影子更坏」的又一例：① 影子的 `className` setter **换掉了**那个 `Set`，而 `classList` 的闭包捕获的是构造时那一个 ⇒ `wrap.className = 'msg msg-user'` 之后 `classList.contains('msg')` 为假、`removeAllMessages` 一个都删不掉（断言全空转）。改成**原地改**。② 我自己按旧影子抄的期望值是过期的（`24K` 应为 `24.0K`、C9 条文案已改成三后缀并列）。③ 顺带发现旧脚本以为 `{type:'run-panel', open:true}` 是**入站**消息 —— 它其实是**出站**（扩展据此下发 details），浮层要靠点 `#runs-view` 才开；现在按真路子驱动，并断言那条回执确实发出去了。
  - [scripts/probe-approval-roundtrip.mjs](../scripts/probe-approval-roundtrip.mjs)（新，C1/C4 的决策回路，2026-09-18）**18/18**：真服务 + 真 hook 脚本 + 真 HTTP + 真子进程，整个搬出扩展宿主。逐条见 C1 正文。
  - 不回归：`probe-approval-shell` **19/19**（D3 动了派生，这条是 C1 的主力证据）／`probe-session-tools` **64/64**（D1 加了落盘字段）／`probe-run-inspector` **31/31**／`probe-turn-state` **13/13**／`probe-purge` **20/20**／`probe-derived-config-boot` **4/4**／`probe-resume` ✓／`smoke-runtime --runtime dist-runtime` exit 0。
  - **全套实跑一次（2026-09-18）**：`approval-roundtrip 18/18`、`approval-shell 19/19`、`compaction-notice 20/20`、`compaction-override 31/31`、`context-window 14/14`、`effort-plugin 25/25`、`purge 20/20`、`run-inspector 31/31`、`session-tools 64/64`、`turn-state 13/13`、`webview-render 34/34`、`c8-runtime ✓`、`resume ✓`，全部 exit 0。
  - **两条探针各修掉一处「假红」和一处「说谎的收尾」**（都是这次新增真帧/真数据段时暴露的）：① `probe-run-inspector` 的补平帧计数原来把「同时带两种特征」的帧算了**两遍**（`byId + byCode`）⇒ 改成**并集**（实测 6 条里占 2 条）；`repaired > 0` 那条断言也是样本依赖的（只有恰好挑中含 `TOOL_NOT_STARTED` 变体的日志才成立）⇒ 去掉，改成守恒律当判据。② `probe-run-inspector` 与 `probe-compaction-notice` 都在**有红时**照样打出过「✓ 全部通过」—— `✓` 那行现在必须在 `else` 里，本文件里也写了注释：**一个会说谎的收尾比没有收尾更坏**。
  - 静态守卫：`grep "import \* as vscode" src/compactionNotice.ts` 无输出。
  - **顺带修掉一条探针的假红**：`probe-run-inspector` 的真日志回放原本**无脑取最新那份**会话日志，而补平帧只在「一轮被中断」时才产生（稀有）——新会话一多它必然变红。改成**从新往旧找第一份含补平帧的**，一份都没有才响亮跳过；现在跑的是 09-17 那份（1722 事件 / 8 轮 / 6 条补平帧）。
- **本次不做**：不按需触发压缩（wire 没口子）；不改 DSH 的 `session.jsonl.zstd`；不新开 `#context-bar` / 第三个浮层（用户选了扩 `#usage-bar`）；不做「把旧消息真的折成一段摘要文本」（要动存储，且那是 DSH 那侧的事）；不改 `token-meter`（它没有任何可配置项，加任何键都会加载失败）。
- **已知局限（要留着）**：
  - **我们的分子 ≠ DSH 的判据**：指示条显示的是 provider 上报的 prompt 侧压力，压缩判据是 `token-meter` 的启发式 `totalTokens`。⇒ 指示是**近似**，不能承诺「到了这条线就一定会压缩」。
  - 默认阈值下（0.8 × 1M）这条线在日常用法里**基本不可能接近**：指示与警告长期不会出现。这是实测结论，不是 bug。
  - **压缩按需触发不了**（无 wire RPC；`/compact` 未 compose 且 `commands.execute` 在 JSON-RPC 通路里没有调用方）。
  - **归档 DSH 日志做不到**（append-only + 帧边界 + offset 修复）。
  - **折叠只省 DOM，不省 payload**。
  - **续聊时那个事件一条都不发**（C10b 之前这条写的是「有变化才 append」，方向对但**低估了后果**：它是拿**日志里的**上一次比对，而续聊的日志里早就有它 ⇒ 不是「偶尔不发」而是**永不再发**）。⇒ 分母必须自己记（已修），**但盘上已有的老会话补不回来**（它们从没记过），要等下一个新会话。
  - `_openSession()` **不清 `_contextWindow`**（只有 `_teardownLive()` 清）。C10b 之后这条**良性**：窗口是 (provider, model) 的属性，两个来源同源同值；真换了模型，`request/context` 会重发并把活值刷新。
  - **便携运行时那条路上派生配置只靠 `env.DSH_CORDIS_CONFIG` 传**：位置参数给的仍是基础配置，两条通路指的不是同一个文件。现已由 `probe-derived-config-boot.mjs` 的反控证住；若哪天 DSH 改了优先级，**C1 与 C10 会一起静默失效**，那个探针是唯一的警报。
- **只能真机 F5 盖住**（2026-09-18 状态）：
  - ✅ ① **压缩事件真的会透传** —— 已证（0.02 → 重连 → 跑一段：6 start / 5 summary / 6 end，note 与「已压缩 N 次」都出现了）。
  - ✅ ② 阈值非默认值**重连生效**，且派生文件里只有那两行变了、`retainRatio` 跟着缩放 —— 已证（见 F5 记录那条「比错底本」）。
  - 🟡 ③ **审批关掉时覆盖仍生效**（D3 那个调用点的落点）**＋** 审批打开时弹条不回归 —— 两半各自验了一半，**组合仍未验**：
    - 人眼那半**已过**（2026-09-18 真机：关掉审批 → `rm -f -- ./destructive_test_workspace.txt` **直接执行、不弹条**，
      exit 0，随后 18 个既有文件 md5 全等，证明被放的只是那一条命令；重新勾选「发送与审阅」后弹条照旧）。
    - **决策回路那半已由 `probe-approval-roundtrip.mjs`（18/18）机器盖住**，见 C1 正文。
    - ⬜ 真正还没验的是**组合**：那次关审批时阈值正好是默认的 0.8，而 0.8 下**本来就不产出覆盖**（`override = ratio === 0.8 ? undefined : …`）
      ⇒ 「审批关掉 **且** 阈值非默认」这条路径没被走到。要验：阈值调 0.02 → 重载 → **关审批** → 看派生文件里那两行确实变了且 DSH 连上了。
  - ⬜ ④ 占用指示在长会话里真的会 `near` —— **C10b 之前不可能出现**（分母恒缺）；修完之后的正确预期：**新会话**跑一段长对话应当出现百分比，越过 `阈值 × 0.85` 时出现 ⚠；**老会话**（C10b 之前建的）仍然不会有，除非路由变一次。
    - **半过**：百分比那半在真机上出现过 —— F5 那次读数「上下文 15.6K / 1.0M（2%）」，会话 `4f49f56f`
      （创建 14:40，**C10b 修复后 2 分钟**，盘上是**唯一**带 `contextWindow` + `context` 的一条）。
    - ⚠ 那半**没造出来**：那次只到 2%，离 `0.8 × 0.85` 十万八千里。要在真机看一眼 ⚠，得把阈值调到 0.02 之类再跑一段。
    - ⬜ **C10b 真正修的那条路（续聊回落）真机没验** —— 上面那条读数是走**活值**拿到的（新会话的首次请求会发 `request/context`）。
      盘上现成有个 30 秒验法：**重开 `4f49f56f`**（它有 `contextWindow` 与 `context`），占用条应当**立刻**出现且带「上次」，
      而这一次 DSH 一条 `request/context` 都不会发（`ff54dc78` 那条 09-17 的老会话反面对照：两个字段都没有 ⇒ 仍然什么都不显示，
      这是**已知局限不是 bug**）。
  - ✅ ⑤ 折叠的机器可验部分（真数据 99 条）—— 已过；**手感**（几百条会话滚动/切会话不卡）仍要人眼。

### C11 · 会话级推理档位（reasoningEffort）（2026-09-18 实现；机器可验部分全过，F5 待人眼）
- **原文**：**现状**「`initialize` 只认 `cwd/provider/model/maxTokens`，`reasoningEffort` 静默忽略；改只能动 `cordis.yml` 的 `llm-deepseek`（当前 `max`）后重启」；**缺口**「**这条不是我们单方面能补的** —— 需 runtime 先支持 per-prompt 或配置热加载」。
- ⚠️ **「需 runtime 先支持」这条已推翻 —— 机制早就在，缺的只是入口。** 四条源码坐标（都在 `dist-runtime/node_modules/@deepseek-ai/`，逐条核过）：
  1. **provider 本来就按请求解析档位**：`dsh-llm-deepseek/lib/index.js:27` 的 `resolveThinking(options, defaults)` —— `options.reasoningEffort` 一旦给到就**盖过**插件配置里的 `defaults.reasoningEffort`，并直接落到出网的 `reasoning_effort`（`:226`）。合法值 `off | low | high | max`（schema `:808`），别的值抛 `UNSUPPORTED_REASONING_EFFORT`。
  2. **每步请求都过一个瀑布**：`dsh-agent-loop/lib/index.js:708` 的 `dispatch.waterfall("agent/request", {turn, step, signal}, () => seedConfig)` —— **它的返回值就是这次请求的 config**。
  3. **已经有一个现成的覆盖者**：`dsh-agent/lib/index.js:287`（`installModelSelection`）正是照这个口子覆盖 `provider/model/reasoningEffort` 的。但它在整个闭包里**没有任何调用方** —— 它是留给"入口"的公开 API，而 `dsh-sdk-jsonrpc-server` 没调它。⇒ **走 wire 下发确实不行**（`initialize` 依旧静默忽略多余参数），**但那不是唯一的路**。
  4. **settings 热改也走不通**：`dsh-llm-deepseek` 装了 settings section（`:939`，`options()` 每次现读 ⇒ 真能热改），但 `installSettingsSection` 是 `ctx.inject(["settings"], …)`（`dsh-settings/lib/index.js:619`），而闭包里**没有 `settings` 服务的具体实现**（`SettingsProvider` 是抽象类，`load/persist` 钩子无人实现）⇒ 这条注入永远不激活。
- **两条实测证据（本次策划期间的实验，一次性件在 gitignored 的 `logs/c11-plugin-probe/`）**：
  - ① 便携运行时**能从本机文件加载 cordis 插件**：派生配置里挂 `name: 'file:///D:/…/effort-probe.mjs'`，`apply()` 真的跑了（`cordis-plugin-loader/lib/index.js:265` 那条 `new URL(name, baseUrl)` 分支）。
  - ② 插件挂 `agent/request` 覆盖档位，**确实落到了请求上**：真跑一轮后盘上日志里那条 `request/header` 的 `config` 是 `{provider, model, reasoningEffort:"low", maxTokens:256000}`，且 `adapterDefaults` **只**记了 `{maxTokens:true}` —— 即这是"显式提案"而不是适配器默认值（`adapterDefaults.reasoningEffort !== true` 也保证下一步不会把它清掉，`dsh-agent-loop/lib/index.js:330`）。
- ⇒ **结论：C11 能做，而且比原来想的更好 —— 热切（下一步就生效，不重启）+ 真会话级。** 进程只有一个、跨会话共用，所以必须**按会话键分流**：`agent/request` 的载荷里有 `agent`（`dsh-agent-loop/lib/index.js:377`），而 `agent.id` 就是 DSH 会话 id（`session/prompt` 校验时那句 `agent id … does not match session id …` 拿它比的就是这个）。
- **形状**：DSH 侧**一行不改**。我们挂一个自己的小插件（纯追加进派生配置），外加一个会话字段 + 模型选择器旁边的一个菜单。
- **D1 · 新纯模块** [src/effortPlugin.ts](../src/effortPlugin.ts)（**不 import vscode** —— 探针要在宿主之外加载它，体例同 `contextWindow.ts`；C10b 的教训）：
  - `EFFORT_VALUES` 四档 + `normalizeEffort(v)` —— 认不出来一律 `undefined`（= 不覆盖），**绝不猜**。
  - `EFFORT_PLUGIN_SCRIPT`：插件本体（`String.raw` 模板，体例同 `dshHooks.ts` 的 `HOOK_SCRIPT`；**不是可执行脚本，所以没有 shebang**）。三条纪律写进文件头：① `next()` 调用**不在** try 里（我们自己的失败只该退化成"不覆盖"，请求链自身的异常必须原样抛出去）；② 读表查表整段 try/catch，任何异常都原样返回上游结果（插件里抛一下就是整轮挂掉）；③ **表里没有这个会话 ⇒ 连对象都不新建**（`return resolved` 返回同一个引用）—— "按需挂载能保持零回归"的根据就是它。
  - `writeEffortPluginFiles({storageDir})` → `{scriptPath, statePath, pluginUrl}`，落在 `<storageDir>/dsh-plugins/`（与 `dsh-hooks/` 并列）。`pluginUrl` 用 `pathToFileURL().href` —— 盘符/空格/非 ASCII 目录名全靠它，别手拼 `file:///`。
  - `writeEffortState(statePath, byId)`：**整份重写**（不是增量 —— 一个进程服务多个会话，表里必须同时有它们的档位）、tmp + rename 原子写（插件**每次请求**都读它，读到半截 JSON 就会静默不覆盖 —— 那不是崩溃，是"档位偶尔不生效"，最难查的那种）、非法键值一律丢掉。
  - `thinkingDisabledInConfig(base)`：底本 `llm-deepseek` 是不是 `thinking: disabled`。锚点纪律同 `patchCompactionRatios`（只看那个块里的 `thinking:` 行）；**锚点不唯一/没有 → false**，理由是代价不对称：判成 true 会让三档白白不可选，判成 false 顶多让用户在 disabled 配置下选了非 off 档，而 provider 会**响亮地报错**。
- **D2 · 派生配置的第三个"只增不改"的块**（[src/dshHooks.ts](../src/dshHooks.ts)）：`writeDerivedConfig` 多一个可选入参 `effort`，在 hooks 块之后追加 `- id: hello-chat-reasoning-effort`（`name:` 写 `file:///…`、`config.statePath` + `config.thinkingDisabled`）。
  - ⚠️ **根不是块状序列时不 throw，只回 `effortWarning`** —— 同比例补丁那条纪律：一个可选旋钮**绝不能拿 C1 的主功能去换**（`_setupApproval` 对 throw 的反应是 `dispose()` + 不启用审批）。`hooksPath` 那条既有 throw 一个字没改，两条都要追加且根不合法时 throw 仍照旧先生效。
  - 返回值新增 `effortMounted` —— **改档位要不要重连一次，只看它**。
- **D3 · 提供者接线**（[src/chatViewProvider.ts](../src/chatViewProvider.ts)）：
  - 会话字段 `StoredSession.reasoningEffort?: ReasoningEffort`（[src/sessionStore.ts](../src/sessionStore.ts)），语义写进注释：**未设 = 跟随配置**（DSH 用它自己那行，当前 `max`），**不是"默认 low"**。
  - `_effortNeeded()` = 「本 activation 内动过一次档位」**或**「存量会话里有任何一个设过档位」。两个条件互补：重载窗口后靠后者（会话字段是落盘的），全新会话的第一次选择靠前者。**一旦为真就不再变假**（挂了就不摘）⇒ 切会话永远不需要重连。
  - `_writeEffortState()`：从 store 里**所有**带 `dsh.id` 且设了档位的会话重建整张表（不是只写活跃那个）。调用点三处：连接前（`_refreshDerivedConfig`）、改档位时、以及 `_ensureDshSession()` 拿到 `dsh.id` **之后**那一行（新会话在此之前没有身份、表里也无从写起 —— 漏了这行，新会话的第一轮会静默沿用上一次的档位）。
  - `case 'set-effort'` → `_setLiveEffort()`：落字段 → `_persistActiveSession()` → 块**还没挂**才 `_restartLiveProcess()`（本进程第一次选档位的代价，"按需挂载"已拍板接受）；块**已在**则**什么都不重启**，只重写表 + `_postLiveConfig()`（**热生效**）。⚠️ 与 `_setLiveModel`（必定重连）形成对照，两处注释都写明了为什么不一样。
  - `_postLiveConfig()` 多带 `effort`（**`null` 而不是省略** —— webview 要能区分"跟随配置"与"还没收到"）、`efforts`（四档由扩展下发，前端不写死，防两边漂移）、`effortThinkingDisabled`。
- **D4 · webview**（[media/chat.html](../media/chat.html) / [media/chat.js](../media/chat.js) / [media/chat.css](../media/chat.css)）：`#live-config-bar` 里模型选择器之后加一个同款浮层菜单，**复用现有 `.lc-model-*` 类**（CSS 只多了个 `.lc-item-disabled` 置灰态，**不隐藏**不可选的档位 —— 让用户看见"有这几档、只是当前配置下不行"）。菜单项：`跟随配置` / `off · 关闭思考` / `low` / `high` / `max`，当前项打勾；两个菜单互斥（开一个收另一个），外部点击与 Esc 都收。
- **自检（零依赖、零 key、不过真模型）**：[scripts/probe-effort-plugin.mjs](../scripts/probe-effort-plugin.mjs)（新）**25/25**，三段：
  - 纯判据：`normalizeEffort` 的四个合法值 + 12 种垃圾输入；`thinkingDisabledInConfig` 的引号形态 / 块边界 / 相邻块同键不误伤 / 锚点不唯一；派生块文本（id、`file:///`、`statePath`、`thinkingDisabled`、路径里单引号写成两个）；**零回归：没给 `effort` 时派生文件里一个字都不多**；根不合法时只 warning 且 **C1 那条 throw 没被改软**；`writeEffortState` 的清洗与"整份重写、不留 `.tmp`"。
  - **决策表**：把**生成出来的插件文件**当纯模块 `import()`，喂假 ctx 抓住它的 `agent/request` 监听器逐条喂载荷 —— 命中 / 未命中（**返回的是上游那个对象的引用本身**）/ 载荷没 `agent` / 文件不在 / 坏 JSON / 值非法 / 没给 `statePath` 就不注册 / `thinkingDisabled` 下只放行 `off` / **上游抛错必须原样抛出去** / 上游返回非对象不许 spread 成 `{}`；以及一条**"每次请求现读表 ⇒ 换掉盘上的表下一步就变"** —— 这就是"热生效"的机器判据。
  - **端到端**：派生配置挂真插件 → 真跑一轮 → 读盘上日志的 `request/header`，断言 `config.reasoningEffort === 'low'` 且 `adapterDefaults.reasoningEffort !== true`；**反控**：表里没有该会话 ⇒ 这次请求带的是**底本自己的默认档位**（从底本原文里读，并断言它 ≠ `low`，否则这条反控没有鉴别力）。⚠️ 这一段的靶子**不是"没有这个键"** —— 实测它**有**，值是底本 `llm-deepseek` 自己的 `reasoningEffort`；真正要证的是"这个值的来源不是我们"。用**假 key**（`sk-000…`）跑：请求会 401，但 `request/header` 在请求**构建期**就落盘了，所以断言照样成立且**不花真钱**；"压根没跑起来"会响亮报错，绝不读成"验过了"。
  - **菜单渲染也进了 DOM 影子**（[scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs)，该文件 **30/30 → 34/34**）：默认「跟随配置」、当前项才打勾、每次点击只发一条 `set-effort` 且值对、点当前项不发、`thinking: disabled` 下三档既置灰又不挂监听。⚠️ 那一条断言**第一次是假红**：我按计划书写了「推理 · 跟随」，实际文案是「推理 · 跟随配置」—— **又是断言错了而不是代码错了**（本文件第三次）。
  - 静态守卫：`src/effortPlugin.ts` 不含 `vscode`。
  - 不回归（动了派生配置，全套实跑一次）：`probe-derived-config-boot` **4/4**、`probe-compaction-override` **31/31**、`probe-approval-shell` **19/19**、`probe-approval-roundtrip` **18/18**、`probe-compaction-notice` **20/20**、`probe-context-window` **14/14**、`probe-webview-render` **34/34**、`probe-run-inspector` **31/31**、`probe-session-tools` **64/64**、`probe-turn-state` **13/13**、`probe-purge` **20/20**、`probe-c8-runtime` ✓、`probe-resume` ✓，全部 exit 0。
- **只能真机 F5 盖住**：
  - ✅ ① 档位菜单出现、默认「跟随配置」；选 `low` ⇒ **重连一次**（本进程第一次）；此后在菜单里来回切 ⇒ **不重连**、下一步就变。（2026-09-18 用户真机确认）
  - ✅ ② **盘上证据（我代查的，不必用户学解 zstd）**：`71bab594…::0a31398b` 那份 `session.jsonl.zstd` 里两条 `request/header`（`initial` + `resume`）都是 `data.header.config.reasoningEffort === "low"`，且 `adapterDefaults` **只有** `{maxTokens:true}`（没有 `reasoningEffort:true`）。同一次比对里的反证：另两个会话（`4f49f56f` / `ff54dc78`）跑的是**底本自己的 `max`** —— 与 `dist-runtime/cordis.yml` 的 `llm-reasoningEffort: max` 一致。
  - ✅ ③ **会话级的真判据**（2026-09-18 用户真机，**盘上留痕，不必只记「用户确认」**）：同一时间窗内两个会话各拿各的档位 —— `f1164f0d…` 四轮都是 `low`、`71bab594…` 最后一轮是 `high`，而状态表 `reasoning-effort-state.json` 里正是 `{71bab594…:"high", f1164f0d…:"low"}`。**进程只有一个**（扩展的 live 进程按会话键分流，表是整份重写的）⇒ 档位确实是**会话属性**，不是全局开关。
    - **顺带拿到「热切」的直接证据**：`f1164f0d` 的第一轮 `request/header` 是底本自己的 **`max`**，13 秒后的下一轮就变成 **`low`**，且那条 header 的 `reason` 是 **`change`** —— **不是 `initial`/`resume`**（那两个才是"重连"的标记，C10b 已经用过这个判据）。⇒ **同一进程、同一会话、没重启，档位就变了**。这是 ① 那条「此后不重连、下一步就变」的机器证据，比界面手感硬。
    - ⚠️ **新事实（已同步进 [wire-vocabulary.md](wire-vocabulary.md)）**：`request/header` 的 `reason` 至少有**第三个取值 `change`**（此前只见过 `initial` / `resume`）。
  - ✅ ④ 重载窗口后档位还在（会话字段落盘），且不需要再重连（刚起就连、块一开始就在）。**F5 当场揪出一个真 bug，已修（`a7e5bab`）并复验通过（2026-09-18 用户真机）**：重载 → 从「历史」点回那条设过 `low` 的会话，菜单显示 `推理 · low`、不重连。⚠️ 重载后落在**全新空会话**上显示「跟随配置」是**对的**（C5 的设计：要接着聊得点回原会话），别把它当 bug。
  - ✅ ⑤ 不回归（2026-09-18 用户真机）：**C1 弹条与「拒绝」通过**，且留了痕 —— agent 收到的工具结果原文就是 `Error: 用户在 AlohaDSH 中拒绝了该命令，未执行。`，命令没跑、文件还在。**C10 占用条在同一屏上直接可见**：`上下文 12.8K / 1.0M（1%）`（带分母 = C10b 的修法在真机上成立；没出 ⚠ 是对的，阈值已回 0.8）。**C8 走的是「中断后再发一条」** —— 中断与重跑都对（agent 自己先 `pgrep` 查残留再重试），但「继续」条本身这次没被点到（该项目已另有 2026-09-17 的整轮 F5 记录）。
  - ⚠️ ⑤ 里那条「工作区内改文件不弹条」曾让我误判过一次：C1 只拦**破坏性 bash** 与**工作区外写入**两种，工作区内的 `write`/`edit` **按设计不弹**（否则每改一个文件都要点确认），它该出现在 2.1 的审阅条里。**测 C1 必须给一条真的破坏性命令**（`rm -v …` / 工作区外写），别拿普通编辑当用例。
- **★★ F5 揪出的真 bug（2026-09-18，`_setActive` 咽喉）**：用户报「重载之后档位变成跟随默认」。查盘：字段**落盘了**（`sessions-harness.json` 里 `71bab594` 有 `"effort":"low"`）、状态表在（`dsh-plugins/reasoning-effort-state.json` = `{"71bab594…::0a31398b":"low"}`）、派生配置里块也在 —— **三层盘的都对，错在界面**。
  - 病根：`_postLiveConfig()` 每次都从 `_active` **现读**档位，而 `_actives[this._mode] = …` 有**四处**（新建 / 打开 / 分支 / 删掉当前那条），**一处都没重播配置条**。⇒ 菜单留着上一个会话的档位：点开设过 `low` 的老会话显示「跟随配置」，反过来「新建对话」会显示上一个会话的 `low`。重载后 `_active` 是**全新的空会话**，所以那一眼看到的 `null` 是对的 —— **错的是随后点回老会话那一下没刷新**。
  - ⚠️ 这与 C10b 是**同一型**：会话级的东西只在某一条路径上重播 ⇒ 它在别的路径上安静地不存在。失效的样子都是「本该出现的东西没出现」，肉眼抓不住。
  - 修法照本仓库自己的「唯一咽喉」体例：新私有方法 `_setActive(session)` 成为**唯一**赋值处（里面顺手 `_postLiveConfig()`），四处调用点全改过去。另：**分支继承档位**（同 `usage` 的理由 —— 分支是「接着这件事往下做」，悄悄掉回 `max` 只会让人以为「分了个支怎么变笨了」；没设过就仍不设，不替用户做他没做过的选择）。
  - **守卫**：`probe-effort-plugin.mjs` 加一条**结构判据**（这个文件探针载不了 —— 它 import vscode）：`_actives[this._mode] =` 只准出现 **1** 次、且 `_setActive` 体内必须调 `_postLiveConfig()`。25/25。
- **已知局限（要留着）**：
  - **档位不落在 DSH 的会话数据里**：它是我们在请求构建期覆盖的 config，DSH 只记下"这次请求用了什么"。换个不带我们插件的运行时（用户自己的 DSH CLI）跑同一个会话，档位就没了 —— 这是**扩展侧行为**，不是会话属性。
  - **第一次选档位要重连一次**（"按需挂载"的既定代价）：在那之前派生配置里没有我们的块，插件根本没加载。
  - 热生效的粒度是**请求**（= 每一步、每一轮），所以改档位不影响**正在进行中**的那一步 —— 这是对的，一次请求的 config 是冻结的。
  - 底本 `thinking: disabled` 时只有 `off` 可用（provider 的请求期约束），其余三档界面上置灰。
  - 用户的基础配置若把根写成流式 YAML（`plugins: […]`）或非块状序列 ⇒ 档位块挂不上（warning，功能不生效，其余一切照旧）。
- **本次不做**：不动 wire、不改 runtime、不给上游提需求（`initialize` 依旧不收 effort）；**不碰用户 `llm-deepseek` 那两行**（这是与 C10 路线最重要的区别 —— C10 是"改已有两行"，C11 是**纯追加**）；不做"每会话默认档位"的设置项、不做"单轮临时档位"、不做 `maxTokens` 的同类覆盖；不做 C12 那套项目级 profile（档位将来并进去）。

### C12 · 项目级 agent profile（2026-09-18 实现；2026-09-19 F5 五条真机全过）
- **原文**：**现状**「工具白名单、默认模型、审批策略都散在 `cordis.yml`（用户手动改的外部文件）。配置条的模型选择器只覆盖模型这一项」；**补法**「定义可共享的 profile（每工作区/每项目一份），扩展负责写回 runtime 配置并重启；含默认模型、审批策略（C1）、工具开关」。
- ⚠️ **backlog 那句「扩展负责写回 runtime 配置并重启」只对了三分之一。** 三件事的机制**各不相同**，拆开看才看得见（逐条核过源码）：
  1. **模型**：`initialize` 的参数（`_dshInitParams()`）。机制现成，**必须重连**。
  2. **审批策略**：本来就是扩展内部读设置（三个读口）。加一层 profile 覆盖即可 —— **零新机制**。
  3. **工具白名单**：**运行时的配置面里根本没有这个键**。`dsh-tools` 的 `ToolRuntime.Config` 只有 `{mode, maxParallelSubCalls}`，**没有** allow / deny / enabled 任何一个。工具集不是一份配置清单 —— 每个模型可见的工具都是一个 `ctx.tools.register(…)` 的插件，可用性 = `cordis.yml` 里挂了哪些。
- ⇒ **但运行期有一个 API**（C11 那条「wire 没这个方法 ≠ 做不到」的第二次应验，这次是配置面没键而 API 有）：
  - `ToolRuntime.restrict({allow, deny})`（`dsh-tools/lib/index.js:2779`，*"Restrict global tools for the calling agent scope"*）——
    要求 **agent 作用域的 ctx**（它明确拒绝上下文全局的限制：*"a context-global restriction would mask every agent"*），
    且**名字不在已知集合里会 throw**（而且是**整批**校验 —— 一个坏名字废掉整张表，见下面 D1 那条硬约束）。
  - 闭包里两处现成用法样板：`dsh-subagent/lib/index.js:582`（`childCtx.tools.restrict(composition.toolFilter)`）、
    `dsh-goal-round-driver/lib/index.js:204`（`ctx.on("agent/created", ({agent}) => …)`）。`Agent.ctx` 就是 agent 作用域的 `Context`（`dsh-agent/lib/types/runtime-types.d.ts:72`）。
  - ⇒ **挂我们自己的插件，在 `agent/created` 里对 `agent.ctx` 调一次 `restrict` 即可。DSH 侧一行不改、用户的 `cordis.yml` 一行不碰。**
- **硬判据（不需要人眼看、不需要真模型请求）**：`request/header` 的 `header` 里**带 `tools`**（`dsh-agent-loop/lib/index.js:729` 的 `...tools.length > 0 ? { tools } : {}`），
  而这份表来自 `dsh-tools` 的 `wireSchemas(scope)` —— 它读的是 `this.view(scope).visible`，也就是**加了限制之后**的视图。
  ⇒ 被禁的工具**真的不在模型视野里**，这件事**在盘上就能机器验**（`scripts/probe-agent-profile.mjs` 第四段就是这么钉的）。
- **形状**：DSH 侧一行不改。一份工作区文件 + 一个纯模块（编译）+ 一个小小的自挂插件 + 配置条上第三个菜单。
- **D1 · 新纯模块** [src/agentProfile.ts](../src/agentProfile.ts)（**不 import vscode** —— 判据必须能在扩展宿主之外加载，C10b 的教训）：
  - **`compileProfile(profile, settings)` 是本功能的命门，也是「只能加严」唯一住的地方**：
    `patterns` 与设置**取并集**（并集只会变多，删不掉默认那十条）；`enabled` / `outsideWorkspace` 与设置**取或**（`setting || profile === true`）；
    `tools` **只有 deny，没有 allow**（allow 表达不了"只能加严"，写进文件是一条**错误**）。
  - **写 `false` 不是"关掉"，是一条会被说出来的错**：`approval.enabled: false` / `outsideWorkspace: false` 在**解析期**就进不了 spec。
    静默忽略用户明明白白写下的意图，比报错更坏。
  - 解析**永不抛**：文件不存在 / 不是 JSON / 根不是对象 / 字段类型不对 / 未知字段 / profile 名空或超长 ⇒ 逐条进 `errors[]`，
    **好的部分照用**（`errors` 里带上"是哪个 profile、哪个字段" —— 「文件有问题」这种话等于没说）。
  - ⚠️ **`KNOWN_TOOL_NAMES` 的校验非做不可，而且必须在编译期**：`restrict()` 是**整批**校验名字的，运行期撞上一个未知名字会让**整张 deny 表**一起抛掉 ——
    于是「禁 bash」会因为旁边写错一个词而**静默失效**。编译期丢掉并告警，就把它变成一条看得见的错（插件里那个 try/catch 是真·最后兜底）。
- **D2 · 新纯模块** [src/toolPolicyPlugin.ts](../src/toolPolicyPlugin.ts)（体例照抄 `effortPlugin.ts`）：`TOOL_POLICY_PLUGIN_SCRIPT` + `writeToolPolicyPluginFiles()` → `{scriptPath, pluginUrl}`，落在 `<storageDir>/dsh-plugins/`（与 C11 并列）。三条纪律：
  ① `deny` 为空 ⇒ **一个字节都不动**（惰性 —— "按需挂载能保持零回归"的根据就是它）；② 整段 try/catch（插件里抛一下就是整个会话起不来）；
  ③ **只挂 `agent/created`，不挂 `agent/pre-step`** —— `restrict` 是**追加式**的，每步调一次会让限制层层累加。
  - **没有状态文件**（与 C11 档位的关键结构差异，不是风格差异）：档位是**每次请求**现读 ⇒ 热生效、要状态表；
    工具策略在 **agent 创建期**只读一次、只在切 profile（= 重连）时变 ⇒ 直接把 `deny` 写进派生配置块的 `config` 里。少一个文件、少一次读盘、少一类竞态。
- **D3 · 派生配置的第四个"只增不改"的块**（[src/dshHooks.ts](../src/dshHooks.ts)）：`writeDerivedConfig` 多一个可选入参 `toolPolicy`，在档位块之后追加 `- id: hello-chat-tool-policy`。
  同样是**挂不上只 warning 不 throw**（独立一条 `toolPolicyWarning`，不与档位那条共用一句话 —— 挂不上的东西不同，话术也不同）。`hooksPath` 那条既有 throw 一个字没改。
- **D4 · 提供者接线**（[src/chatViewProvider.ts](../src/chatViewProvider.ts)）：
  - **活跃 profile 存 `workspaceState`**（每工作区、扩展内部），存的是**校验过的原始 spec + 激活时的文件原文**，不是编译结果
    —— 编译每次现算（这样用户改设置之后并集仍是新鲜的）。
    ⇒ 顺带得到一条重要性质：**agent 改写 `profile.json` 没有任何效果**，运行期用的是激活时存下的副本，要重新激活才生效。
  - 三个审批读口改成分工两层：`_approvalSettingEnabled/Patterns/Outside()` 只读设置原文，`_approvalEnabled/Patterns/OutsideEnabled()` 走 `_effectiveProfile()`。
    松紧方向全在纯函数里定死，UI 侧没有任何"该不该灰"的判断。
  - `_dshModel()` 前面多一层：`profile.model` 最优先（它是**项目声明**，比"上次在这台机器上点过哪个"更该赢）。`_setLiveModel()` 里加了**明确拒绝**并指出出路 —— 绝不静默收下再被 profile 盖掉。
  - `_setProfile(name | null)`：`this._abort` ⇒ 弹「当前有回复在生成中，先停止或等它结束，再切换 profile。」**什么都不做**；否则读盘 → 存 spec → `_postLiveConfig()` → `_restartLiveProcess()`（**三个菜单里唯一必定重连的一个**）。
  - `workspace.createFileSystemWatcher` 盯 `.hello-chat/profile.json`（事件驱动，不轮询）⇒ 置 `profileStale`，配置条上亮出「profile.json 已改动 · 点这里重新应用」。
- **D5 · webview**（[media/chat.html](../media/chat.html) / [media/chat.js](../media/chat.js) / [media/chat.css](../media/chat.css)）：配置条里档位菜单之后再挂一个同款浮层，**复用 `.lc-model-*` 全套类**（CSS 只多了 `.lc-model-item.has-sub` + `.lc-mi-sub`，让摘要另起一行）。
  首项固定是**「不用 profile」**（退路永远排第一，任何 profile 出问题都知道往哪退）。**profile 钉住模型时模型菜单整片置灰 + 触发钮 title 说明被谁固定、往哪退 + 不给"自定义模型…"入口**（那个值同样不会生效）。
  - **触发钮的形状另有三次收窄**（2026-09-18，落在同一个配置条上，跨 C11/C12）：**药丸 → 裸文字 → 图标 + 值 → 26px 方块图标钮**。判据是「**轴名是常量，值是变量**」—— 省宽该省常量那一段；模型钮是唯一还带文案的（模型名自证身份）。第三次收窄把值从钮里挪进 `title` / `aria-label`（方块钮没有文字 ⇒ 可访问名只能靠后者），非默认态改由**角上 6px 状态点**（`.on`）表示。形状守卫在 `probe-webview-render.mjs` 独立 5 条（每一类钮只准有一处定义、`.lc-model` 不许长回 `border`/`background`/`height`、轴线必须是**两个不同的真 `<svg>`**、状态点必须 `position:absolute` 否则吃掉刚省下的 13px）；逐轮的理由写在 [media/chat.html](../media/chat.html) 那三个钮上方的注释里。⚠️ **再想收窄已经没有料了** —— 第三次之后轴名已完全撤出文案，那个 `<svg>` 就是**唯一还看得见的轴标**，再省就等于把"这是哪个轴"也省掉。想动它之前先读那段注释。
  - ⚠️ `renderLiveConfig` 末尾**必须重画一次 `renderModelMenu()`** —— 模型菜单的画法取决于 profile 有没有钉模型，早画一步就会留着上一份的置灰状态（**同 C10b 那个 bug 的形状**，这次是预防性钉住的：`probe-webview-render.mjs` 里那条"没钉模型时模型菜单照旧能点"就是它的反控）。
  - `pickProfile` **故意不比 `v !== liveProfile`** —— 「已改动」那一行点的就是当前项，它的语义是"重读并按现在的内容重新激活"，必须发得出去。
- **自检**：[scripts/probe-agent-profile.mjs](../scripts/probe-agent-profile.mjs)（新，**32/32**）四段 ——
  ① 解析（含 `readProfileFile` 的读不到/超大/目录当文件）；② **「只能加严」表驱动正反双控**（本节命门）；
  ③ 插件决策表（把生成的插件文件当纯模块载入，喂假 ctx 抓 `agent/created`：给了 deny ⇒ `restrict` 收到恰好那个 filter；deny 空/缺失 ⇒ **一次都没被调**；`restrict` 抛 ⇒ 不冒泡）；
  ④ **端到端真跑一轮**：派生配置挂真插件 ⇒ 盘上 `request/header.header.tools` 里**没有** `bash`、**有** `read`；**反控**：不带 profile 那轮 `bash` **必须在**（否则"没有 bash"可能只是这轮压根没装配工具）。
  第四段与 C11 探针同款：**刻意用假 key**（`sk-000…`，请求 401 但 header 在请求构建期就落盘），"没跑起来"响亮报错、绝不读成"验过了"。
  - [scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs) 的 C12 段 8 条（渲染/打勾/恰好一条 `set-profile`/`null`/钉住置灰且不发/未钉时可点（反控）/「已改动」行发得出去/错误条数/没工作区/忙碌时禁用且菜单收起）；**这套影子探针在 C12 落地时为 47/47**（另外 5 条是同期配置条三钮**第三次收窄**（药丸 → 裸文字 → 图标+值 → 26px 方块图标钮）新增的形状守卫）；**2026-09-19 起为 57/57**（C13 又添 10 条，见 C13 的 D5）。
- **只能真机 F5 盖住**：
  1. 放一份 `.hello-chat/profile.json`（两个 profile）⇒ 配置条出现 profile 菜单 ⇒ 选一个 ⇒ **重连一次** ⇒ 模型变成 profile 的、审批变严。盘上证据：新 `request/header` 的 `config.model` 跟着走。
  2. **工具白名单的真判据**：profile 里 deny `bash` ⇒ 重连后让 agent 做一件需要 shell 的事 ⇒ 它**说没有这个工具**（而不是「命令被拒」）。盘上对拍：`request/header.header.tools` 里没有 `bash`。
  3. **忙碌时切** ⇒ 弹「当前有回复在生成中…」，且**盘上什么都不变**（配置、profile 名字、模型全不动）。
  4. **只加严的反证**：把某个 profile 写成想关审批 ⇒ 弹条**照旧出现**。
  5. 不回归：C1 弹条与「拒绝」、C10 占用条 / 压缩 note、C11 档位菜单、C8「继续」按钮各抽查一次。
- **验收（F5 真机 2026-09-19 五条全过，用户确认）** —— 沿用 C4 的教训，**盯盘上留痕，别盯界面元素**：
  - ✅ ① 模型与审批跟着 profile 走：选一个钉了模型的 profile ⇒ 重连 ⇒ 模型变成 profile 那个、审批变严。盘上证据：新 `request/header` 的 `config.model` 跟着走。
  - ✅ ② **工具白名单的真判据（本节最值钱的一条）**：profile 里 deny `bash`/`write`/`edit` ⇒ 重连后让 agent 做需要 shell 的事 ⇒ 它**说没有这个工具**，不是「命令被拒」。
    盘上对拍（`header.tools` 是**加过 `restrict` 之后**的可见视图）：那几个名字真的不在这张表里，而**没禁的 `read` 还在** —— 「少的就是少的、没误伤」一次看全。
  - ✅ ③ **忙碌时切被拒**：弹「当前有回复在生成中…」，且**盘上什么都不变**（配置、profile 名字、模型全不动）。
  - ✅ ④ **「只能加严」的现场反证**：把一个 profile 写成想**关**审批（`approval.enabled: false`）⇒ 弹条**照旧出现**。这条是拿真机把纯函数那条纪律又验了一遍。
  - ✅ ⑤ 不回归：C1 弹条与「拒绝」、C10 占用条 / 压缩 note、C11 档位菜单、C8「继续」按钮各抽查一次，全通过。
- **F5 现场的坑与复现料（写规程时撞出来的，记下来省下一次）**：
  - **Extension Development Host 启动时没有工作区文件夹**（`.vscode/launch.json` 只传了 `--extensionDevelopmentPath`）⇒ profile 菜单一开始是「没有打开工作区，无法读取 profile」，**这是对的不是 bug**。要先在 EDH 里打开一个工作区目录再放 `.hello-chat/profile.json`。
  - **`request/header` 是每个请求写一条**，切完 profile **必须再发一句话**才有新的留痕可对拍；只看旧的会以为"切了没生效"。
  - 复现这套的料：随便拿个空目录当工作区，放一份 `.hello-chat/profile.json`（两三个 profile，分别钉模型 / deny 工具 / 写 `enabled:false`）+ 一个给 agent 读写的文本文件即可。读会话日志要 `./dist-runtime/node/node.exe`（系统 node 没有 `zstdDecompressSync`）。
- **已知局限**：
  - **工作区内的写按 C1 的设计不弹条**，所以 agent 技术上能改 `.hello-chat/profile.json`；而 `.hello-chat` 又已被快照忽略（`fileSnapshot.ts:21`），改了也不会出现在本轮审阅里。**三重缓解**：① 字段里没有任何放松方向；② 运行期读的是激活时的副本；③ 想生效必须用户手动重新激活。**残留**：重新激活时若不看内容，等于签了字。
  - **profile 是扩展侧行为，不是会话属性**：换个不带我们插件的运行时跑同一份会话，这些策略全都没有。
  - **`.hello-chat/profile.json` 进 git 是刻意的**（可分享给同事）；代价是它会被 `git status` 看见。不写进 `.gitignore`（写了就没法共享），改由手册说明（`docs/manual.md` / `docs/manual.zh-CN.md`）。
  - **两个 VS Code 窗口开同一扩展**时派生配置文件路径共享（C1/C10/C11 的既有性质，非本次引入），profile 只是又一位乘客。本次不修。
- **本次不做**（含两条**否掉的路**，都记下来免得后人重推）：
  - 不写 `.vscode/settings.json`、不写用户的 `cordis.yml`、不新增任何 `scope: resource` 的设置项（配置条 + 文件就够）。
  - 不做 profile 的图形化编辑器（**文件就是接口**，菜单只负责切）；不做继承 / 变量插值 / YAML 格式；不做工作区多根（沿用 `workspaceFolders[0]`，不在 C12 开新战线）。
  - **❌ 不走 `dsh-user-approval` / `dsh-sandbox-policy` / `dsh-permission-presets` 那条路**：这三个策略插件在闭包里确实存在，但**当前配置里一个都没挂载**；而且它们的 config（presets 表、`defaultPreset`）是**进程级**的、运行期只能"在既有预设里选"。起了它们等于同时换掉 C1 这一整套**已经实测过**的审批机制 —— 与「C1/C4/C12 同源，别拆散」正相反。
  - **❌ 不做 `allow` 型工具白名单**：allow 表达不了"只能加严"（决定 5 的推论）。
  - 不动 wire、不改 runtime、不给上游提需求。

### C13 · Windows / 跨环境 shell 与路径收口（2026-09-19 实现，F5 六条通过）
- **原文**：**现状**「bash 靠 PATH 找，`System32\bash.exe` 会命中 WSL shim，WSL 无发行版就全线报错（[wire-vocabulary.md](wire-vocabulary.md)）；跨盘/跨环境路径语义有坑」；**补法**「shell 探测 + 明确降级提示；UI 表达「工具将在哪个 cwd、能否出工作区」；必要时自带 bash 或推荐配置」；**验收**「无 WSL 的机器上给出可读引导而非一串 bash 报错」。
- **两个已拍板的决定（不再讨论）**：范围 = **诊断 + 可选「钉住 bash」**，**不做路径归一化**；落点 = **顶部状态条一段读数 + 坏时一次性可读告警**，**不加配置条第四个钮**（那条刚收窄三轮）。
- **实测四条**（2026-09-19 本机复现，**四条都决定了设计**）：
  - **F1 `spawn('bash', …, {env})` 按传入 env 的 PATH 搜索**，不是调用进程的 PATH（`PATH=E:/Git/bin` → `MINGW64_NT`；`PATH=C:/Windows/System32` → `Linux`）⇒ **「钉住 bash」真能换掉 agent 的 shell**，上游一行不改。
  - **F2 libuv 完全不看 `PATHEXT`**（硬编码 `.exe`）：`PATHEXT='.COM;.BAT'`、甚至没有 `PATHEXT`，照样命中 `bash.exe` ⇒ ⚠️ **不许照抄** `dsh-subprocess-local` 的 `executableCandidates`（它认 PATHEXT）—— 抄了会算出**错的赢家**，在不含 `.EXE` 的机器上谎报「没有 bash」。
  - **F3 PATH 的五条语义**：`PATH=''` → ENOENT 且**不回退 cwd**；空项跳过；相对项按**子进程 cwd** 解析；`Path`/`PATH` 并存时大写 `PATH` 胜；**完全没有 PATH 键时回退宿主真实环境** ⇒ `prependPathDir` **绝不能删了 PATH 不补**（否则 pin 静默失效）。
  - **F4 WSL shim 起不来时的话是 UTF-16LE 打在 stdout 上**（stderr 空、退出码 4294967295）：解出来是「不存在具有所提供名称的分发。错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND」 ⇒ **这就是「一串 bash 报错」的成因**（按 utf8 读就是乱码）。诊断先按**奇位 NUL 占比 ≥ 0.4** 认出 UTF-16LE（夹具实测 0.690），再认 `WSL_E_*` 这个**语言无关**令牌。
  - **链路核实**：`_dshEnv()` → `dshRuntime` 的 `spawn(…, {env})` → `dsh-subprocess` 的 `childEnv`（只擦敏感键与 `DSH_*`，**PATH 原样保留**）→ `dsh-bash-local` 的 `ENV_OVERRIDES` **不含 PATH**。**全程没有一处覆盖 PATH。**
- **四条被推翻的预设**（记下来防后人重推）：
  1. 「上游没有换 shell 的配置项 ⇒ 做不到」—— 上游**今天仍然没有**，但那不构成"做不到"：**PATH 是活的**（F1+F3）。
  2. 「bash 的赢家按 `PATHEXT` 算」—— 那是 `dsh-subprocess-local` 的行为；bash 那一次 spawn 走的是 libuv（F2）。
  3. 「WSL 起不来时会打一行可读的错」—— 是 UTF-16LE 乱码（F4）。
  4. 「探不到 = 坏」—— 超时是 WSL 冷启动的**正面证据**（既有 `shellGuessOnTimeout` 的结论），诊断里它属于**不可判**，不是**坏**。
- **D1 · 新纯模块** [src/shellDiag.ts](../src/shellDiag.ts)（**不 import vscode** —— 判据必须能在扩展宿主之外加载，C10b 的教训）：`pathValue` / `resolveOnPath` / `classifyBashPath` / `usabilityOf` / `shellWarnFor` / `shellStatusSegment` / `adviceFor` / `prependPathDir` / `shellPin` / `readPosixTarget` / `gitBashCandidateDirs`。
  - **三值 `usable|broken|indeterminate` 复用 C1 的 `HookSelfCheck.retriable` 纪律**：超时、或退出码非 0 而**两流都空** ⇒ indeterminate；`shellWarnFor` **只对 `broken` 给文本** —— 这就是「冷启动不误报」的全部保证，也是探针里那条配对断言盯的东西。
  - `prependPathDir`：`dir` 空 ⇒ **同内容同键序**返回（「未设 = 逐字节相同」取最强形式）；否则删掉所有大小写变体的 PATH 再前置一个，**幂等**、不改入参、**永不删了 PATH 不补**。
  - `readPosixTarget` **只显示，永不改写**：`intended` 只认 `/mnt/<盘>/…` 与 `/<盘>/…`（`/etc/passwd` 不猜）；`actual` 用显式 `path.win32.resolve(cwd, raw)`（跨宿主一致，探针在 Linux 上也能钉）。⚠️ 它的准入集合**恰好等于** `_fsTargetAbs` 里 `raw.startsWith('/') && !raw.startsWith('//')` 的集合 —— **会印这段话的路径，正好就是不会抓轮前快照的那些**；两处各写各的，就会出现「提示说这次改动不在审阅里，实际却抓了快照」那种自相矛盾。
- **D2 · 设置项** `hello.dsh.bashPath`（`type: string`、默认空、**`scope: machine`**）：它是**一台机器的事实**（某个 exe 的路径），不是项目策略；而 `window` 会允许写进 `.vscode/settings.json`，那正是本仓库最不想发生的事（一台机器的路径被提交进别人的仓库）。与 `runtimeDir`/`nodePath`/`command` **正交**（那三个决定跑哪份字节，它只改那个子进程的 PATH）⇒ **`hello.dsh.command` 整段覆盖时 pin 照样生效**，所以**诊断与告警绝不能住在 `_setupApproval` 里**（那个分支下审批整个不接入，可 bash 工具照样天天在用；住进去 = 那类用户永远看不到告警，文案还会错误地指向「审批」）。指向不存在的文件 ⇒ **不前置**，诊断如实报出 + 一键清除。
- **D3 · 接线**（[src/chatViewProvider.ts](../src/chatViewProvider.ts)）：`_ensureShellDiag()` 幂等 promise；时序上**起诊断但不 await**（`.then()` 里发状态 + 可能告警），只有审批去 await 同一个 promise ⇒ 激活延迟是 `max` 不是 `sum`，且 WSL 只被唤醒一次；**冷启动重试预算与审批共享**（`_coldStartRetried`）。告警**独立旗标**（与审批共用会让先到的吞掉后到的）。一键修法：`钉住这个 bash`（**仅当备选是本次会话实测通过的**）/ `怎么装 WSL 发行版`（给两条**文本**命令，**不代跑 `wsl.exe`**）/ `打开设置`；**不给「不再提示」**（每 activation 一次已是既有体例）。
- **D4 · 自检与 hook 的 env 一致性修**（探路时发现的**真问题**）：`testApprovalHook` / `probeShell` 原来用 `env: process.env` 从**扩展宿主** spawn，而 hook 是在**运行时子进程**里跑的 —— 今天两者碰巧相同，**一旦有 pin 就不同**；而 `buildHookCommand` 的 Windows-vs-WSL 形态**就是从这个答案推出来的**，推错 = 审批直接失效。抽 `spawnProbe` 让「不可判」的判定**只有一份实现**，三处调用加 `{env?, program?, timeoutMs?}`（**opts 省略时行为与今天一字不差**）。
  - ⚠️ **`probeShell` 的返回类型必须保持 `ShellKind`**：`probe-sandbox.mjs` 拿它跟 `'wsl'` 直接比，改成对象会让比较**恒假**、静默挑错形态，而探针还是绿的（那种 bug 没人能看见）。要分辨「坏」与「不可判」用 `probeBash`。
  - ⚠️ hook 自检**仍传 `program: 'bash'`、不传 pin 的绝对路径** —— 同一条解析路径才算数。
  - ⚠️ **`spawnProbe` 的 argv 里不含可执行名**（`program` 是另一回事）：重构时写成 `['bash','-c',cmd]` 就成了 `bash bash -c …`，MSYS bash 会去把 `/usr/bin/bash` 当**脚本**读 ⇒ 一堆 `cannot execute binary file` / `line 1: … No such file or directory`，而**形态判定看起来还在工作**（探针里两条判据一红一绿才把它揪出来）。
- **D5 · webview**（[media/chat.html](../media/chat.html) / [media/chat.js](../media/chat.js) / [media/chat.css](../media/chat.css)）：顶栏 `#harness-status` **之后**一个**兄弟** `<span id="harness-shell">`（⚠️ 必须是兄弟 —— `renderHarnessStatus` 整段重写 `#harness-status` 的 textContent，挂成子节点会被下一次重连静默抹掉，**C10b 那个形状**）。三态：能用且非 WSL ⇒ **整段不出现**；能用但在 WSL ⇒ `bash=WSL` 琥珀；不可判 ⇒ `bash=?` 琥珀；坏 ⇒ `bash=坏` 红。
  - **可见性两道闸**：① 载荷不带 `shell`（老扩展 / 诊断还没算出来 / 一切正常）⇒ 不出现；② **chat 模式下也不出现**。⚠️ 第二道闸必须在 `renderShellStatus` **里面** —— 扩展会在任意时刻重发 `backend-status`（连上、重连、改设置），只在 `applyMode` 里藏的话，chat 模式下一帧就把它重新点亮了（探针里「chat 模式下连**重发**的也点不亮」就是为它写的）。切回 harness 时扩展**不会**重发 ⇒ 靠 `shellSeg` 缓存把那段补回来（`applyMode` 只藏、不扔缓存）。
  - 确认条多一段 `#approval-note`（`<pre>`，初始 hidden）：`已按 POSIX 形态给出 / 模型想指的应是 / 按 DSH 的解析方式会落到 / 本次不会为它抓轮前快照`（最后一行收益最大 —— C4 那次真事故里确认条弹对了，但用户不知道这次改动对审阅是**隐形的**）。`cwd` 只取 hook 载荷里的 `ask.cwd`，缺了整条不显示（盘符来自 cwd，缺了会自信地印一个错位置，比不说更糟）。**绝不给按钮** —— 一个「改用 D:\x」的按钮就等于借 UI 把本次明确不做的路径归一化偷偷做掉。
- **已知局限**：
  - `actual` 是**预测不是事实**：真实写入还可能被沙箱拒或父目录不存在，所以文案写的是「**按 DSH 的解析方式**会落到」。
  - 诊断的 probe 在冷启动时最坏 8s×2 —— 与审批共享重试预算后**总预算与今天持平**；若 F5 发现仍太慢，唯一旋钮是诊断的 `timeoutMs`。
  - `git-bash` 的识别是**形状启发式**（`…/Git/bin`、`…/Git/usr/bin`）：便携 Git 会落到 `other`。无害 —— 判定不依赖它，只影响文案；`other` 里也可能有真能用的 Cygwin/MSYS2，那会显示「可用」而不报错。
  - **本机复现不出「无 WSL 的机器」**（这台机器 WSL 里有 Ubuntu、冷启 ≈5s）：那半条验收只能靠**夹具 + 纯函数 + 自适应正控**（见下）。
- **本次不做**（写死，防后人重推）：**不做路径归一化**（`/mnt/d/x` → `D:\x` 是 DSH 侧的解析行为，改它等于改 agent 的文件落点；本次只**显示**两种读法，且**不给按钮**）；不写 `.vscode/settings.json`、不写用户的 `cordis.yml`、不新增 `scope: resource` 设置项；不代跑 `wsl.exe --install`、不在没有用户点击的情况下自动选一把 bash；**不新增配置条旋钮**；不改 wire、不改 runtime、不给上游提需求。
- **自检**：[scripts/probe-shell-diag.mjs](../scripts/probe-shell-diag.mjs)（新，**62/62**，八组）—— A 解析（假 PATH + 假 `isFile`：含 **PATHEXT 反控**、显式扩展名、空项、`PATH=''` 不回退 cwd、相对项按 cwd、`Path`/`PATH` 并存、无 PATH 键的地雷、平台隔离）；B 分类（含 **Cygwin / 裸 `bash.exe` ⇒ `other` 的反控** —— 没有它，一个恒返回 `wsl-shim` 的实现也能过前两条）；C 三值表 + **`shellWarnFor` 配对断言**（usable/indeterminate 必须 `undefined`、broken 必须有）+ pin 指空的例外 + 五条话术 + 状态段三档 + 平台隔离；D 解码（**F4 那段 116 字节 / 奇位 NUL 0.690 当夹具常量** + ASCII/UTF-8/png 三个反控样本 + 「拼接后只解一次」的理由）；E `prependPathDir`（身份 / 幂等 / 已有该目录 / 无 PATH 键 / posix 分隔符 / 入参未改）；F 两读法（含 UNC 反控与跨宿主不变性）；G 不许漂移（同一份事实，`classifyShell` 与 `usabilityOf` 必须说同一句话）；H 真机（自洽 + `probeShell` 返回类型仍只是一个形态 + 未设 pin 的同一性 + **自适应 Git bash 正控**（钉住后 posix 成立；一把都找不到 ⇒ **响亮 ⚠ 跳过，绝不静默通过**）+ 端到端不等式）。
  - **「无 WSL 的机器」那条验收怎么机器可验**（三道）：① F4 那段夹具 + 假 env 端到端（假 PATH 只含 System32 ⇒ headline 指向 shim 且 action 是 pin；清空 PATH ⇒ 得到**另一条** headline，**不等式**断言）；② 判定全是探针记录的纯函数（真机那半只做记录，不做判定）；③ 真机正控自适应找一把真 Git bash、找不到就响亮跳过（`E:\Git\bin` **永不入库**）。
  - [scripts/probe-approval-shell.mjs](../scripts/probe-approval-shell.mjs) **21/21**（原 19 + 新增 2）：`testApprovalHook` 的调用改 options bag；新增「**`opts.env` 真的换掉了搜索路径**」（这是 pin 的机制基础 —— 它不过就说明 pin 会**静默失效**：用户改了设置、什么都没发生、也没有任何报错）与「**`opts.env` 就是 hook 真正跑在里面的 env**」（C1 一致性修的判据）。
  - [scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs) **57/57**（原 47 + 新增 10）：读数三态与「不带就不出现」/ **chat 模式连重发的也点不亮、切回来靠缓存** / `pathNote` 多行与收起（含迟到帧不许误关）/ 两条结构守卫（`#harness-shell` 必须是**兄弟**；CSS 的 `flex:0 0 auto`、`white-space`、`[hidden]` 不许被 `display` 覆盖；`readPosixTarget(` 全文**只准出现 1 次**且在 `_approvalPathNote` 体内；`_fsTargetAbs` 的 POSIX 早退必须原样在）。
  - **变异测试**：上述守卫逐条做过变异（塞成子节点、拿掉 `flex:0 0 auto` / `pre-wrap`、去掉模式闸、切模式扔缓存、改掉 `_fsTargetAbs` 的早退、在判定链路上多调一次 `readPosixTarget`）—— **7/7 全被抓红**，且每个变异**先自证插进去了**（本仓库 `media/`+`docs/` 是 CRLF，字面 pattern 不匹配会静默空转、绿着骗人）。
  - **C13 动了 C1 的自检 env ⇒ C1 的两条探针重跑过**：`probe-approval-shell`（21/21）与 `probe-sandbox --fs-hook`（C1 那条「hook 能不能拦 fs 工具」真机跑通：`hook/invoked` + `hook/result` 各一条、`note.txt` **始终没被创建**、`shell=posix`）。
- **只能真机 F5 盖住（六条，2026-09-19 用户真机全过）**：
  1. ✅ 真弹窗的文案与三个按钮各自的措辞（三种修法）。
  2. ✅ 顶栏那段读数在**窄面板**下没被挤（`flex:0 0 auto` 只能肉眼）。
  3. ✅ 「钉住这个 bash」写进用户设置后真换成（探针验不了 VS Code 的设置写入与重启时序）。
  4. ✅ `/mnt/…` 那几行在真 WSL 一轮里的排版。
  5. ✅ 第三条配置监听器的重连行为（改 `hello.dsh.bashPath` ⇒ 清诊断 + 重连）。
  6. ✅ `hello.dsh.command` 整段覆盖时弹的是 **shell 告警**而不是「审批未生效」（两个弹窗互不干扰）。
  - 本轮**没有逐条留痕**（未存截图/日志），故沿用 C8 ④、C9 ④ 的成例记作「通过（用户确认）」，别把它读成我们亲眼看过。
    可复查的只有跑之前那份清单（每条都写了「该看到什么」与「不过长什么样」，见本轮对话）——
    ⚠️ 其中两条是清单里**明确标注造不出来、只能靠别的东西顶**的：`WSL_E_DISTRO_NOT_FOUND` 那个具体文案（本机 WSL 里有 Ubuntu，那段话由 116 字节夹具钉着）、以及本段末尾那条按钮的可用性前提。
- **⚠️ 与实现有关、F5 时才浮出来的一条可用性事实**：`钉住这个 bash` **只在本次实测探得通的备选存在时才出现**，而备选只有两个来源 —— **PATH 上真命中的 `git-bash` 形态路径**、**厂商默认位置**（`%ProgramFiles%\Git\bin`、`%ProgramFiles(x86)%\Git\bin`、`%LOCALAPPDATA%\Programs\Git\bin`、`%ProgramW6432%\Git\bin`）。**Git 装在非默认位置又没把 `Git\bin` 放进 PATH 时，两个来源都不命中 ⇒ 那个按钮不出现**（本机正是这种：Git 在 `E:\Git`，而 PATH 上第 9 位的 `E:\Git\cmd` 目录里没有 `bash.exe`）。此时一键修法退化成「打开设置」/「清除这项设置」—— 仍然能修，只是不省事。要看到那个按钮，得先把 `E:\Git\bin` 挂到用户 PATH 上，**并完整重启 VS Code**（扩展宿主的 env 是启动时继承的，Reload Window 不够）。**这是「按钮只跟随实测、不跟随愿望」的代价，刻意留着** —— 宁可少给一个按钮，也不给一个按下去没用的按钮。
  - 现场提醒沿用 C12 那两条：EDH 启动时**没有打开工作区文件夹**；`request/header` **每请求才写一条**（改完设置必须再发一句话才有新留痕）。

---

## P2 — 加分项

### C14 · 事前 diff 预览（近似）（2026-09-21 实现，F5 六条待跑）
- **原文**：**现状**「只能跑完再还原。wire 无 file 事件 → 无法拿"将改动的文件清单"」；**补法**「用 `tool/call` 的 `arguments` 预判 + 轮前快照做近似「预计改动」提示」；**验收**「写文件类工具调用前，能提前显示预计触及的路径」。
- **原文的「现状」只对了一半**（先说清，免得后人接着信）：wire 里确实**没有** file 事件，但**实际的 hunk diff 一直在线上** —— `tool/result.meta.diffs` 带着 DSH 用真 before/after 算出来的 `[{path,oldText,newText}]`，而扩展此前**一个字都没读**（`tool/result` 分支只取 `message.content[].text`）。所以「只能跑完再还原」是**我们没读**，不是拿不到。真正的缺口只剩「**事前**」那半：它只能靠入参预判。
- **两个已拍板的决定（不再讨论）**：① 落点 = **工具卡里**（不是新的 composer 条、不是新面板）；② **含「预计 → 实际」对齐** —— 那条调用的 `tool/result` 一到就把预测换成事实。
- **实测五条**（2026-09-21 逐条核过源码/抓帧，**每一条都决定了设计**）：
  - **F1 `tool/call` 帧是真·事前**：`dsh-agent-loop` 里 `appendToolCall` 在前（`lib/index.js:191`）、`scheduler.dispatch` 在后（`:197`）⇒ 帧一定先于执行。⚠️ 但领先只有**毫秒级**，**它不是可拦截的窗口** —— 真正的阻塞窗口只有 C1 的 hook（且只覆盖破坏性 bash 与工作区外的写）。
  - **F2 `data.arguments` 是 JSON 字符串**（抓帧实测 `"{\"command\": \"echo …\"}"`）⇒ 必须先 `JSON.parse`，且类型是 `unknown`，畸形/非对象都要**不抛**地退化。
  - **F3 `meta` 只挂顶层 exec、且只是可选的**：`dsh-tools` 把 `output.presentationMeta(args, value)` 挂进 `result.meta`（`lib/index.js:3417-3424`），agent loop 的 `appendToolResult` 用 `...result.meta !== void 0 ? { meta: result.meta } : {}` 原样透出（`dsh-agent-loop/lib/index.js:302-314`）⇒ **失败路径、嵌套（Code Mode）调用、没挂 `presentationMeta` 的工具都不带**。这就是「不许把一条预测永远挂在卡上」的由来。
  - **F4 `computeHunkDiffs` 是「每个 hunk 一条」**（`dsh-tool-fs/lib/index.js:487-512`，context 3）：一次写到同一个文件也可能给**多条** `diffs`（纯插入的 `oldText` 是 `null`），而**前后文本完全相同时它返回空数组** ⇒ `diffs: []` 的两种成因是**新建文件**与**内容与改动前一样**，**我们分不出来**（所以话要说得能容下两者，不许硬说「新建」）。
  - **F5 真实工具清单里 `todo_write` 存在**（27 个存档会话统计：`plan, bash, glob, read, write, edit, todo_write, subagent`）⇒ 写文件的只有 `write`/`edit`（与 C1 的 hook matcher 同集合的 fs 部分），且**判据必须精确匹配** —— `name.includes('write')` 会把 `todo_write` 当成写文件的工具。
- **D1 · 新纯模块** [src/changeForecast.ts](../src/changeForecast.ts)（**不 import vscode** —— 判据必须能在扩展宿主之外加载，C10b 的教训）：`parseToolArgs` / `isPosixShapedPath` / `resolveTargetPath` / `forecastFileChange` / `forecastProblem` / `forecastLine` / `actualForecast` / `actualLine` + 三句「预测作废」的常量。diff 复用 C4 的 `lineDiff` 与 `MAX_DIFF_ROWS`（[src/fileSnapshot.ts](../src/fileSnapshot.ts)），不另起一套。
  - **`resolveTargetPath` 是本项唯一一处对既有代码的搬动**：把 `_fsTargetAbs` 的解析规则原样搬进来，`_fsTargetAbs` 改成一行委派。理由只有一条 —— **卡片上的路径与批准条上的路径必须是同一个函数算的**，两处各写一份就会出现「同一轮里两个读数指向不同文件」那种最坏的错。⚠️ 有回归风险（3 个调用点：批准文案、越界判断、写前快照），所以单独重跑了三条审批探针 + `probe-sandbox --fs-hook`。
  - `write` 的近似 diff = `lineDiff(现在盘上的文本, content)`（读盘复用 C4 的 `snapshotSingleFile` ⇒ 二进制/超大/预算闸与审阅**同一套**，不另写读文件逻辑）；`edit` 的 diff = `lineDiff(old_string, new_string)` —— **只在替换片段上算，不模拟「替换哪一处」**（那是 DSH 的语义，猜了就是说谎）。
  - **命中检查先归一化行尾**（`\r\n` → `\n`）：本仓库自己就是 CRLF/LF 混排，拿模型给的 LF `old_string` 去 `indexOf` 一个 CRLF 文件会**假报「找不到」**（而 DSH 那边其实能成功）。归一化**只用于检查**，不参与 diff 的文本。
  - **事前就能说出「这次会失败」**（这一小块最值钱）：`old_string` 命中 0 次 / 命中 >1 且 `replace_all` 没开 / `old_string === new_string`（DSH 的 `parseEditArgs` 自己就会拒）/ 盘上没这个文件。**读不出盘就不给 `finding`**（不猜）。
- **D2 · 接线**（[src/chatViewProvider.ts](../src/chatViewProvider.ts)）：`_forecastBefore`（`tool/call` 分支）/ `_forecastAfter`（`tool/result` 分支 + `_finishTurn`、`_surfaceLiveError` 两处 unknown 收尾）；一张 `_forecastPaths`（工具消息 id → 事前算出的路径）兼作「这条卡上有预测」的集合，在 `_captureBaselineAtTurnStart` 里清 —— 与 `_reviewRoots` 同一生命周期，不另起状态机。**三种收尾都只在真发过预测时才说话**，且都遵守同一条：**卡上不许留着一条没有下文的「预计」**。
  - **不落盘**：`ChatMessage` 一个字不加（预测是直播提示，不是转录内容）⇒ 重载窗口/切会话后那行消失、历史会话回放也不长它。`sessionStore` 零改动（探针里有结构守卫钉着）。
  - **与 C1 解耦**：整条链只吃 `session.event`，与审批开关、hook、`hello.dsh.command` 整段覆盖**全无关**（F5 第 5 条正面证明）。
- **D3 · 协议**（[src/protocol.ts](../src/protocol.ts)）：`{ type:'forecast'; id; phase:'before'|'after'; label; title?; level?; diff?; diffTruncated?; note?; failed?; unknown? }`；[src/dshRuntime.ts](../src/dshRuntime.ts) 的 `DshEventData` 加 `meta?: unknown`（F3 的载体，唯一的字段新增）。
- **D4 · webview**（[media/chat.js](../media/chat.js) / [media/chat.css](../media/chat.css)）：那行是 `card` 的**直接子节点、落在顶栏正下方、入参 JSON 之前**（锚点是入参节点，没有才退到 `outputEl` —— 入参那块可能上千字符，把读数排在它下面等于让人先滚过一坨参数）。⚠️ **绝不塞进 `.tool-head` 里**（顶栏是 flex 行，塞进去会被挤坏；C13 的 `#harness-shell` 是同一型教训）。事后帧**就地改**同一个节点（不重建 —— 重建会丢展开状态与位置），失败/中断/没带回 diff 三种收尾会**当场把展开区与按钮一并收掉**（否则上一次那份 diff 看起来像这一条的结果）。CSS 里 `.tf-toggle`/`.tf-diff` **不写 `display`**（那会盖掉 `[hidden]` 的 `display:none`），diff 行复用审阅面板那套 `.diff-line.add/.del/.ctx` token。
- **已知局限**：
  - **这是「即将/正在」，不是「可拦截」**（F1）：别把那行读成事前审批。
  - **两个「改动」读数会不一样，且是有意的**：卡片上的 diff 是「相对现在盘上」，轮尾审阅（C4）是「相对轮前快照」。同一文件一轮内写两次 ⇒ 卡片是两次增量、审阅是一条累计。文案里写着「按现在盘上的内容算的」。
  - `edit` 的行尾归一化会让**一类真失败漏报**：真的因为 CRLF 不匹配而失败的编辑，我们检查时会认为命中（容错方向是对的，但要知道它不完备）。
  - `meta.diffs` 的 `path` 形态**未定**（注释说它盖的是 model-facing `file_path`）：可能是入参原文、也可能被后端相对化过 ⇒ 只显示、不断言（F5 第 6 条去定）。
  - 二进制/超大的目标**不预览**（只报性质）；`edit` 的 diff **不含上下文行**。
  - 不落盘的代价：重载窗口/切会话后那行消失（它是直播提示）；重放的历史会话也不长这行。
- **本次不做**（写死，防后人重推）：**不预判 `bash` 的写**（重定向 / `rm` / `tee` 都是 shell 语法，猜错比不说更坏 —— 它们仍走 C1 的审批与 C4 的轮尾审阅，**别让用户以为「没出现在卡片上 = 这轮没动文件」**）；**不给按钮**（不「按这个路径改」、不「改用 D:\x」—— 那等于借 UI 把 C13 明确不做的路径归一化偷偷做掉）；不做跨调用的汇总条（用户选了卡片落点）；不做整文件 diff 的编辑模拟；不加设置项、不动 wire/runtime/上游、不改 C4 的快照与审阅语义、**不改 `_fsTargetAbs` 的行为**（只搬实现位置，判据一套）；不在 react-live 画面里渲染（真组件接管，硬塞会两套 UI 打架）。
- **自检**：[scripts/probe-change-forecast.mjs](../scripts/probe-change-forecast.mjs)（新，**27/27**，八组）—— A 解析（JSON 字符串正面 + 畸形/非对象 `undefined` 且不抛）、B 工具门（**`todo_write` 反控**）、C 路径（相对/绝对/POSIX/UNC 原样放行/空/无 base）、D kind 与 diff（新建 / 相对现在盘上 / 三种「没法预览」各有话说 / 片段 diff / 超长截断）、E 命中检查（0-1-2-2 四条结论 + **CRLF 反控** + 同文本 + 文件不存在 + 入参不完整 + 读不出盘不给 finding）、F 文案（事前那行 + 两档 level）、G 实际那半（正常 hunk / 多 hunk 合并 / **`diffs: []` 不是 undefined** / 畸形 `undefined` 不抛 / path 优先 / 三句作废的话互不重复）、H 结构守卫（`_fsTargetAbs` 必须委派且体内无 POSIX 字面量、**全仓该字面量只准 `changeForecast.ts` 与 `shellDiag.ts` 两处**、三处 `_forecastAfter` 调用点、轮首清表、`ChatMessage`/`sessionStore` 里不许出现 forecast）。
  - [scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs) **65/65**（原 57 + 新增 8）：落位与「不在顶栏里」/ 点开才出 diff（逐行 kind 与行首 `+`/`-`）/ **`tool-result` 之后那行原地被换成事实**（比节点身份，防重建）/ 不带 diff 时按钮与展开区当场收掉（反控）/ 失败与中断两档 class 与文案、**id 对不上的迟到帧不许改别的卡** / id 找不到什么都不做 / 没发过预报的卡不长那行 / CSS 守卫（`flex-wrap`、两个 `[hidden]` 元素不许有 `display`、label 必须省略号）。C13 那条 `_fsTargetAbs` 守卫**同步改形**：现在断言它**委派**给 `resolveTargetPath`、且体内不再有那个字面量。
  - **变异测试：C14 这 6 条全被抓红**（塞进顶栏里面、`FORECAST_TOOLS` 换成子串判据、删掉 POSIX 早退、拿掉行尾归一化、把 `diffs: []` 判成「读不懂」、拆掉一处 unknown 收尾），加上 C13 那 7 条 = **`probe-webview-render` 累计 13/13**（手册那行说的就是这个累计数）—— 每个变异**先自证插进去了**（字面量不匹配就直接报「这条测试无效」，绝不静默空转绿着骗人；本次第 6 条又踩了一次 CRLF 的坑，正因为有这道自检才没变成假绿）。
  - **搬 `_fsTargetAbs` 的回归**：`probe-approval-roundtrip` 18/18、`probe-approval-shell` 21/21、`probe-sandbox --fs-hook`（真机：`hook/invoked`+`hook/result` 各一条、fs 工具被拦下、`isError` 落到 tool/result）全部照常；另 `probe-run-inspector` 31/31、`probe-turn-state` 13/13、`probe-c8-runtime` 全过、`probe-context-window` 14/14、`probe-shell-diag` 62/62、`probe-compaction-notice` 20/20、`smoke-runtime` 通过。
- **只能真机 F5 盖住（六条，⚠️ 2026-09-21 用户跳过未跑）**：
  1. 发一句让 agent 写文件的话 ⇒ 卡片上那行在结果出来**之前**就在（`write` 与 `edit` 两种都要看）。
  2. 近似 diff 与轮尾审阅的 diff 对得上/差异可解释（同一轮多次写就会不同，那是有意的）。
  3. `tool/result` 一到就翻成「实际」并换成 `meta` 那份；**新建文件那条**说的是「新建/没报改动」而不是「没有」。
  4. 制造一次失败/中断 ⇒ 卡上**不许**再挂着「预计」。
  5. `hello.dsh.command` 整段覆盖（审批不接入）+ 审批关掉两种情况下，那行**照样出现**（与 C1 解耦的正控）。
  6. 路径带 `/mnt/d/…` 时卡片怎么显示，**`meta.diffs` 报的 `path` 落在哪** —— 顺手用事实回答 C13 悬着的那条。

### C15 · 多会话并行 / 分支对照视图（2026-09-22 实现，F5 十条真机全过）
- **原文**：**现状**「刚做的 fork 是『切过去 + 同记忆』，没有 A/B 对照」；**补法**「并排渲染两条分支转写；明确标注共享记忆的串话风险（现 fork 与源会话共用同一 DSH 会话，回源继续发消息会被彼此看到）」。
- **问题**：C5/C6 的「在新对话中分支」今天只是**切过去 + 同记忆** —— 分完支，源会话就看不到了，用户回答不了「这两条支各自长成什么样了」。而「它们共享同一份 DSH 记忆」这件事**在界面上一个字都没有**：回源会话继续发消息，模型两边都看得见，用户不知道。
- **三个已拍板的决定（不再讨论）**：① 落点 = **全屏浮层**（同 `#runs-panel` / `#review-panel` 的体例），不做常驻第二栏；② 范围 = **只读对照**（面板里不发消息、不并行跑）；③ 串话 = **只标注**（不给「断开共享」之类的动作，只把风险说出来）。
- **实测（逐条核过源码，**每一条都决定了设计**）**：
  - **F1 `_forkSession` 是深拷贝**（`JSON.parse(JSON.stringify(src.messages))`，[chatViewProvider.ts](../src/chatViewProvider.ts)）⇒ 副本与源**逐字相同**，有稳定的共同前缀。
  - **F2 消息 id 里嵌着产生它的会话 uuid**（`_nextMsgId()` 返回 `` `${this._active.id}#${++this._msgSeq}` ``）⇒ 副本里的 id 仍带**源会话的** uuid，fork 之后的新消息才带 fork 的。于是**共同前缀 = 分叉点**，且**跨代也成立**（F2 从 F 分出来，与源比仍是源那一段）；两条无关会话的前缀恒为 0。
  - **F3 `_openSession` 打开历史会话时会归一化残留态**（`status:'streaming'` → `interrupted`、`toolState:'running'` → `unknown`，**两个 `if` 不是 else 关系**）⇒ 对照栏**必须走同一条规则**，否则「面板里看到的一条」与「打开那条会话看到的」不一样。而**源会话拷完之后还会被原地归一化、fork 那份不会** ⇒ 会出现「同 id 不同 status」，这也是面板上 `drifted` 那个提示的由来。
  - **F4 只看盘会漏报真串话**：补丁不可用时 `_ensureDshSession` 的 `existing` 分支**提前 return、从不查盘**，且三条路里只有一条写盘 ⇒ 那种模式下 fork 与源两侧盘上都没有 `dsh`，但 `_dshSessions` 里确实共用同一个 id。所以串话判据**双证据：先看本次运行里的映射、再看盘**（这一条是对「只从盘上算」的**有意加强**）。
  - **F5 同 id 不同 cwd 不该警示**：DSH 会话日志按 cwd 归属（resume 的条件就是 `stored?.cwd === cwd`）⇒ 判 `unknown`/`cwd-differs`，不是 shared。
  - **F6 react-live 会把消息面整个藏掉**（`body.react-live #messages { display:none !important }`），但**浮层是 body 直系子元素、照常可见** ⇒ 这是选「全屏浮层」形态的**唯一理由**（C14 刚在这上面栽过）。
  - **F7 三个 `add*Message` 入口各自第一行都是 `if (isReactLive()) return;`** ⇒ 直接复用它们，面板在 react-live 下**画不出任何东西**。
  - **F8 渲染走模块单例**（`messagesEl` + `byId`）⇒ 对照栏必须用自己的容器与**一次性记录表**：把「属于别会话的 id」写进 `byId`，等于给迟到帧开一扇门。
- **D1 · 新纯模块** [src/branchCompare.ts](../src/branchCompare.ts)（**不 import vscode** —— C10b 的教训）：`divergenceOf` / `divergenceLine` / `divergenceTitle` / `sharedPrefixNote` / `crossTalkOf` / `crossTalkLine` / `crossTalkTitle` / `frozenTail` / `pickCounterpart` / `FORK_SUFFIX`。
  - `divergenceOf` 按 **id 逐条比**（零正文参与），给 `{kind, shared, aAfter, bAfter, drifted}`。`shared === 0` 时**绝不说「分叉点在第 1 条」**，说的是「两侧没有共享消息 —— 不是同一次分支的结果（或源会话的那一段已被清掉）」。`drifted` 是「同 id 但内容不同」的条数，**是提示不是逐字 diff**（比的是 `role/status/toolName/toolInput/toolOutput`）。
  - `crossTalkOf(a, b, live?)` 的证据优先级**写死一处**（F4）：live 两侧都有 → 用它；否则看盘（同 id 同 cwd → shared；**同 id 不同 cwd → unknown**；其余 → unknown）。**判据全是数据、文案是常量映射**：三句 `unknown` 两两不同，`warn` 只挂在 `shared` 一档。
  - `frozenTail(s, from)` 深拷贝尾段 + 归一化，**绝不改原对象**（探针里有正面证明：改前 `JSON.stringify` 存一份比）。
- **D2 · 唯一一处对既有代码的搬动**：F3 那段归一化搬进 [src/sessionStore.ts](../src/sessionStore.ts) 的 `freezeTranscript`（那里才能被探针加载，理由同 `capToolInput`），`_openSession` 改成一行委派。**两个 `if` 保持不是 else 关系**，别顺手「修」。⚠️ 有回归面（打开历史会话那条路），所以搬完**立刻**重跑了四条探针。
- **D3 · 接线**（[src/chatViewProvider.ts](../src/chatViewProvider.ts)）：`_openCompare` / `_pickCompareSide` / `_resolveCompareSide` / `_comparePane` / `_postCompare` + `case 'compare-open'` / `case 'compare-pick'`。
  - `_compareSides` **纯内存、不落盘、不新增任何持久化状态**：`StoredSession` 一个字不加，**不给 fork 加 `forkedFrom`** —— 识别只靠消息 id 与标题后缀这两条既有痕迹（`[FORK_SUFFIX]`，`_forkSession` 用它命名分支）。
  - `_resolveCompareSide` 用 `_store.get` 就够：活动会话与数组里那个对象**是同一引用** ⇒ 直播中它也是最新的。解不出来的（软删 / 空）**就地清掉记录**，绝不留一条指向空气的 id。
  - **只在打开/换侧/刷新时发快照**（不做每帧推送）⇒ 不需要「面板开着吗」这个闸，也绕开了「两轮之间 `_dshSessions` 变化」的坑；`dispose()` 里什么都不做。
- **D4 · 协议**（[src/protocol.ts](../src/protocol.ts)）：webview→ext 两条（`compare-open` 幂等 / `compare-pick`）；**故意不加 `compare-close`** —— 扩展对面板开合**无状态**，关了不必通知（与 `run-panel` 的差别就在这儿：那条是为体积闸存在的）。ext→webview 是 `compare-set`，**全字段可选**（旧 webview 忽略不认的 type，同 `forecast` 约定）+ `interface ComparePane`。
- **D5 · webview**（[media/chat.js](../media/chat.js) / [media/chat.css](../media/chat.css) / [media/chat.html](../media/chat.html)）：
  - **渲染器落点化**（本项唯一一处有回归风险的重构）：单例换成落点对象 `LIVE_SINK = {container, registry, reactLive}`，拆出 `renderToolInto` / `renderNoteInto` / `renderMessageInto` / `renderTranscriptInto`。**「把一份转写渲染进一个落点」只此一处实现**，直播面与对照栏共用。⚠️ `renderMessageInto` 第一行也是门规 —— 直播面整条重渲染走 `renderTranscriptInto`，**不再经过 `add*` 包装器**，所以全仓一共 4 行门规，这是**有意保留的重复**（漏传 sink 会当场 TypeError，漏掉门规会静默画到直播面上）。折 `buildFoldRow(n, onExpand)` 的点击动作**由调用方给**：折叠态是**每个落点自己的**（直播面 `foldExpanded` / 对照栏 `compareTailExpanded.a|b`）。
  - 对照栏用**一次性记录表**（`compareSink()` 每次 `new Map()`，绝不写进 `byId`）与 `reactLive:false`（这正是「在 react-live 下也照画」）。`compareState = null` **同时就是「开着吗」**（不另起布尔，两个标志必然漂移）。
  - **三个状态分开说**：还没收到快照（「载入中…」，postMessage 的这几毫秒不是「没数据」）/ 选中了解不出来（「已被删除或清空」）/ 压根没选（「还没有可对照的会话」）。
  - **共同前缀不渲染正文**（两侧逐字相同），改成一句说明 + 一条「分叉点之后」的界线。
  - 选择器**就地换内容**（不用浮层菜单：面板内的滚动容器会裁掉绝对定位层，且「触发钮 + 菜单」的配方仓库里已有三份）。**已选的两行置灰且不挂 click 监听**；点一行只上报，`compare-set` 一到就收起选择器（= 这次选择被处理了的**回执**，被拒也回整份 set）。
  - 入口 = header `.header-actions` 里的「对照」文字钮（**不放 composer**：那里四条 bar 都是本轮的读数/动作；**恒显示、不按「有没有第二条会话」隐藏** —— 要等有对手才出现的入口等于没有入口，C9 的老调）。Esc 链按层次插一条（审阅 → 运行 → 对照 → 历史）。
  - CSS：`.cmp-transcript` **必须 flex column**（`.msg` 的 `align-self` 与 `max-width:92%` 都是 **flex 项**属性，块容器下用户消息就不右对齐了），且**不许**抄 `.messages` 的 `max-width:760px` / `margin:0 auto`；`@media (max-width: 520px)` 改竖排；警示色**复用仓库已有的 warning token**，不新造颜色。
- **已知局限**：判据是消息 id ⇒ **只认拷贝关系**，手工复制粘贴出来的两条相似会话算不出共同前缀（会说「没有共享消息」）—— 这是**有意的**，宁可说不知道也不按正文相似度猜；`drifted` 是提示不是逐字 diff；串话的 `by` 字段会在悬停里说清这次是拿**哪份证据**判的（进程内重连会 `_dshSessions.clear()` ⇒ 退回盘上那份）；同 id 不同 cwd 判 unknown（只有手改过 `sessions.json` 才见得到这一档）；选择器只有标题与时间（`SessionSummary` 里没有条数）；侧栏窄时并排读不了；不另设条数上限（与 `snapshot` 同口径：全量下发、渲染侧折叠）。
- **本次不做**（写死，防后人重推）：**不从面板发消息、不做并行跑**（`_liveRunning`/`_abort`/`_currentDshId`/`_turnStatus` 的语义一个字不动，「停止 = 杀子进程」照旧 —— C8 的核心，回归面太大）；不做 N 路 / 第三栏；**不做同步滚动**（要 scroll 重入闸，而影子看不到布局 ⇒ 那是「上了没人验」的代码）；不渲染共同前缀；不给 fork 加 `forkedFrom`、不落任何新状态；不在 React ChatView 的动作栏加入口；**不做转写侧的差异着色**（`.diff-line` 是给文件改动的，套到对话上会把「这段文字不同」说成「这行被改了」）；摘要里不放 usage / reasoningEffort（usage 口径只认当前活动会话，照抄会与用量条当场打架）；不动 `byId`/`foldSource`/`foldExpanded` 的单例语义。
- **自检**：[scripts/probe-branch-compare.mjs](../scripts/probe-branch-compare.mjs)（新，**28/28**，七组）—— A 共同前缀（fork 拷贝 / 源分叉后又长 / 无关会话 / 同一条 / 一侧为空 / **跨代**）、B `drifted`（含反控：id 不同但正文完全相同 ⇒ 不进前缀）、C 冻结只读的**正面证明**（原对象一个字段都没变 + 尾段是副本）+ `aAfter === 尾段长度` 同源、D 串话六态 **+ live 优先的反控**、E 三句 `unknown` 文案两两不同 / 无关会话不许出警示 / 标题写出判据、F `pickCounterpart` 三级回退、G 结构守卫（`freezeTranscript` 在 provider 里恰好 1 处且 `_openSession` 必须委派、`_comparePane` 必须走 `frozenTail`、`compare-set` 的构造点只在 `_postCompare`、`sessionStore`/`ChatMessage`/`StoredSession` 里不许出现 `compare`/`forkedFrom`、`side` 只有 `a|b`、`FORK_SUFFIX` 字面量全仓唯一）。
  - [scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs) **78/78**（原 65 + 新增 13）：开关与幂等（恰好一条 `compare-open`）/ **三个空态分开说** / 两栏各自渲染 + 判定区两行且只有串话那行是警示色（**外加一条 `level:'ok'` 的正面反控**）/ **折叠各自独立**（反控：展开对照栏不许把直播面也展开）/ 选择器行数与置灰行**点了不发消息** / `compare-set` 收起选择器 / **关掉之后迟到的快照不许把面板画回来** / **对照栏不许污染直播面的 `byId`**（给对照栏里的卡发一条同 id 的 `tool-result`，它的 class 与文案一个都不许变）/ 对照渲染前后 `#messages` 子节点数相同 + 冻结过的终态视觉（`unknown`、**不带** `running`、没有 `.caret`）/ 三浮层互斥 / Esc 逐层收 / CSS 与 `chat.html` 的结构守卫（`#compare-panel` 必须是 body 直系且**不在 `#messages` 区间里**、`#compare-btn` 在 `.header-actions` 内）。顺带补上了影子的一处**测试性缺口**：`document.addEventListener` 原本是 no-op，全局键盘链（Esc 那串）**从来没被验过**，现在改成捕获式。
  - **变异测试：C15 这 8 条全被抓红**（sink 换成 `byId`、折叠接到 `foldExpanded`、置灰行也挂监听、关掉时不丢弃状态、`.cmp-transcript` 改回 `display:block`、不冻结尾段、**调换 live 与盘的证据优先级**、把对照状态写进盘上的 `StoredSession`），加上 C13 那 7 条 + C14 那 6 条 = **`probe-webview-render` 累计 21/21**（手册那行说的就是这个累计数）。每条**先自证插进去了**（字面量不匹配就报「这条测试无效」）。
    ⚠️ 本次踩到一枚**新坑**，记下来：`probe-branch-compare` 载的是 `out/` 里的**编译产物**，所以「改 `.ts` 源文件」的变异对它是**整份全绿**的 —— 看着像「漏网」，实际是**根本没插进去**。改 `.ts` 的变异必须**重新编译**（且跑完要把产物**再编译回来**）。这正是「先自证」那道闸的价值：没有它，这一次会被记成「探针盖不住」而白白加固错的地方。
  - **回归**：`probe-session-tools` 64/64、`probe-purge` 20/20、`probe-turn-state` 13/13、`probe-branch-compare` 28/28、`probe-webview-render` 78/78（搬 `freezeTranscript` 与渲染器落点化之后**各跑一遍**，全绿）。
- **只能真机 F5 盖住（十条，✅ 2026-09-22 用户真机验收全过，无逐条留痕）**：
  1. 侧栏拉宽 ⇒ 真的并排、各自独立滚动、栏间发丝线在；拉到 ≤520px ⇒ 竖排（阈值只有真机试得出）。
  2. **在 react-live 画面下打开浮层，两条转写照样可见** —— 本项选这个形态的**唯一理由**，必须正面证明（C14 刚栽过）。
  3. 真 fork 走一遍：分支 → 源里再发 2 条 → fork 里再发 3 条 → 打开对照，两侧「此后 N 条」与肉眼一致、分叉点行位置对得上。
  4. 串话三态看**脸色**（不只文案）：真 fork（同 `dsh.id`）⇒ warning 色那行在；两条无关会话 ⇒ 没有警示行；从没连过 DSH 的会话 ⇒ unknown 那行。
  5. 快照是**每次重取**：发一条后回面板点「刷新」⇒ 数字与内容都动（不是缓存的旧图）。
  6. 开着面板时那一轮正在跑 ⇒ 面板头说「快照时仍在跑」，且**卡不转圈**、没有闪烁光标。
  7. 三浮层互斥 + Esc 逐层收（对照 → 运行 → 审阅 → 历史）。
  8. 重载窗口后：分完支立刻关窗口的那种 fork ⇒ 对照里是「无身份」**不警示**（与「记忆真的断了」一致）；正常落过盘的 ⇒ 仍是 shared。
  9. header 挤不挤：三个钮 + 标题在 300px 侧栏下标题还剩几个字（`.chat-title` 会 ellipsis 先让）。
  10. 深/浅两套主题下 `.cmp-*` 与栏里气泡的配色。

### C16 · 审批白名单记忆（2026-09-22 实现，F5 八条待跑）
- **原文**：**现状**「无（依赖 C1）」；**补法**「确认条上加「信任这次/永久信任此命令/目录」，持久化策略」。
- **问题**：C1 的确认条是**一次性**的 —— 同一条 `rm -rf ./dist` 在一条长会话里会被问十遍，用户只有两个选择：每遍点一次，或者去设置里把 `\brm\b` 整条正则删掉。**后者是拆护栏，不是记住决定**。中间那一档「这条我准了，别再问」今天不存在。
- **四条已拍板（不再讨论）**：① 落盘 = **扩展存储里一份 JSON**（`<globalStorage>/approval-trust.json`，tmp+rename）；② 匹配 = **逐字精确 + 所在目录**（bash 的键是 `(command, cwd)` 二元组，一个字符都不归一化）；③ 撤销 = **命令面板 QuickPick + 转写留痕**；④ 三个按钮读作 **允许执行 / 永久信任此命令（此目录）/ 拒绝**。
- **实测（逐条核过源码，每一条都决定了设计）**：
  - **F1 这道功能不需要碰运行时**：`_askNeedsApproval` 是注入给 `ApprovalServer` 的谓词，返回 false 时 `_handle` **直接 `send(200,{decision:'allow'})`、根本不调 `_askUser`** ⇒ **hook 脚本、`hooks.json`、派生配置、令牌一个字节都不用改**，白名单全落在这一处（F5 面因此极小）。
  - **F2 放行 ≠ 隐身**：`_handle` 里的顺序是 `_onObserved(ask)` → `_shouldAsk(ask)` ⇒ 被白名单**静默放行**的区外写**照样进 C4 的轮前快照**（探针 ⑲ 用 `observed.length === 2` 钉着）。
  - **F3 截断会把两条命令变成同一条**：`str(parsed.command, 32*1024)` 是 `slice(0,max)` ⇒ 触顶的命令可能被截成同一个字符串。**宁可少给功能**：命中上限的命令既不提供信任也不参与匹配（判据 `length >= MAX_COMMAND_CHARS`，常量与 `approvalServer` **同一个** —— 两处各写一遍迟早漂）。
  - **F4 `_pending` 不留 `ApprovalAsk`**（只存 `{settle,timer,toolName}`）⇒ 要建信任就得把 command/cwd/filePath 取回来，所以 provider 侧新开一张 `Map<id, ApprovalAsk>`（同 `_approvalCmds`/`_approvalNotes` 的体例），`_onApprovalAsk` 存、`_onApprovalResolved` 删。**不动 `_onResolved` 的签名**（探针 ⑪⑫ 钉着它）。
  - **F5 为什么不是「新加一个设置项」**：`hello.chat.*` 全是 `scope: window`，仓库里两处 `config.update(…, Global)` 都只写 `hello.dsh.*` —— 写一个 window 级设置会让扩展**第一次开始改用户的 `settings.json`**（那文件里有明文 key）。所以落盘介质只能是扩展存储里的 JSON。
  - **F6 `writeEffortState` 就是现成的体例**：净化 → tmp → rename。**不需要 `.bak`**：坏文件退化成「每次都问」，方向是安全的。
  - **F7 🐞 实测揪出一个真 bug：生成的 hook 从来不给 bash 带 `cwd`**（只有 fs 那条分支带，[dshHooks.ts](../src/dshHooks.ts)）。后果不是「少个字段」而是**键少了一半** —— 白名单里每条 bash 信任都会绑在空工作区上，于是「同一条 `rm` 在另一个工作区」被静默放行（正是 ② 要挡的那件事），而 `offerTrust` 的边界说明还会照着空 cwd 说「本次没有工作区」。**抓它的方式**：`probe-approval-roundtrip` ⑲ 断言 `ask.cwd === 'D:/ws'`，一跑就红。修法是 bash 分支补一行 `cwd` —— C1/C4/C13 都不看 bash 的 cwd（区外写与 POSIX 两读法只走 write/edit），所以这是**纯增量**（改完立刻重跑了五条探针）。
- **D1 · 新纯模块** [src/approvalTrust.ts](../src/approvalTrust.ts)（**不 import vscode** —— C10b 的教训）：`matchTrust` / `offerTrust` / `isForbiddenTrustDir` / `addTrust` / `removeTrust` / `identityOf` / `describeTrust` / `parseTrustFile` / `readTrustFile` / `writeTrustFile`。
  - **命中判定**：`command` 档只对 bash（`entry.command === ask.command` **且** `(entry.cwd ?? '') === (ask.cwd ?? '')`），`dir` 档只对 write/edit（`isInsideDir(target, entry.dir)`）。**两个档绝不互相覆盖**。`includes`/`trim`/大小写/前缀包含一律不做 —— 代价是「模型换个写法就再问一次」，这是**有意**选的方向（折叠空白在引号内不成立；前缀包含等于把设置里那条 `\brm\b` 整条作废）。
  - **能不能提供信任由扩展判**（webview 只画拿到的那份文案）：bash 永远给 `command`（除非触顶）；write/edit 只有在目标路径可解析、且目录**不在硬禁名单**里才给 `dir`。硬禁 = ① 盘根 ② 目录**包含或等于**家目录（一条规则同时挡住 `C:\` 与 `C:\Users`）。
  - **包含判定只有一份实现**：搬进 [src/changeForecast.ts](../src/changeForecast.ts) 的 `isInsideDir`（`path.relative` 版），provider 的 `_isInside` 改成一行委派 —— `startsWith` 会让 `D:\proj2` 被 `D:\proj` 骗过。
  - **条目没有 `id`**：撤销与去重都用 `identityOf`（`command\0cwd\0command` / `dir\0dir`）⇒ 文件是人手能读、能手改的（字段就是全部判据）。
  - **坏文件 = 空表**，逐条校验（丢掉那**一条**而不是整份）：字段类型、kind 白名单、命令/目录非空、目录绝对且不在硬禁名单。⚠️ `{"kind":"bash"}` 这种**缺 command 的条目必须丢掉** —— 否则就是「一条命令都没写却什么都匹配」的后门。
  - `MAX_TRUST_ENTRIES = 200`，满了**拒绝**（不淘汰最旧的：静默累积权限比报个错更坏）；三条拒绝理由两两不同。
  - **只写「读回来还在」的东西**（`writeTrustFile` 先过 `normalizeEntries`）⇒ 不变量 `readTrustFile(writeTrustFile(x)) === x` 是**结构上**成立的，不是巧合。
- **D2 · 接线**（[src/chatViewProvider.ts](../src/chatViewProvider.ts)）：`_askNeedsApproval` 的**第一句** `if (this._isTrusted(ask)) return false;`；`_isTrusted` 每次**现读盘、不缓存**（手改/手删文件即时生效）；`_offerTrust` 随 `approval-request` 下发；`_createTrust(id, kind)` **重算一遍粒度**（webview 传来的 kind 不是可信输入）+ 写盘 + 留痕；`forgetApprovalTrust()` 用 `showQuickPick` 列出/逐条/全部清除（首项「全部清除」）。
  - **记不记得住都不改变这次允许**：`_answerApproval` 先回话（`this._approval?.answer`）、再记盘，每条失败路径只往留痕里写一句。
  - **失败一律 fail-closed**：读盘失败/解析坏 ⇒ 返回 false ⇒「每次都问」；坏的降级方向**永远不会是「全放行」**。
  - `_onApprovalResolved` 里删 `_approvalAsks`（超时/取消/已答都会经过那里）⇒ 不泄漏。
- **D3 · 协议**（[src/protocol.ts](../src/protocol.ts)）：`approval-request.trust?: {kind,label,scope}`（**可选** —— 老载荷/不可提供时不带 ⇒ 前端不画那个按钮）、`approval-answer.trust?: 'command'|'dir'`（只在 `allow:true` 时有意义）。
- **D4 · webview**（[media/chat.js](../media/chat.js) / [.html](../media/chat.html) / [.css](../media/chat.css)）：`#approval-trust` 进 `.approval-actions`（`#approval-deny` 之前），`#approval-scope` **另起一行**（整段文本塞进按钮行会把按钮挤走）；两者**初始 hidden**（老载荷下不留空壳）。**文案不在前端拼**（同 C15 的分工线）：`label`/`scope` 全由扩展给，`textContent` 落字。
  - `renderApproval` 对三个字段**无条件赋值**、`clearApproval` 一起复位 —— **两条互为备份**（见变异测试里那条踩坑记录）。**「允许执行」这个标签不动**（它本来就是「信任这次」），改字只会让既有断言白白重跑。
  - CSS：`.approval-scope` 走 **`--dsw-alias-state-warn-primary`**（⚠️ 是 `warn` 不是 `warning`：`dsh-live.css` 里只定义了前者，写 `-warning-` 会静默退到 VS Code 兜底色 —— 现有 `.approval-note` 正是这个情况，**本次不顺手改它**）。
- **已知局限**：**信任是机器级、跨工作区的**（键里带了 cwd，但文件本身不按工作区分仓 —— 同一条命令在另一个工作区不会命中，因为 cwd 不同）；逐字精确 ⇒ 模型换个写法就再问一次（有意）；命令 ≥32KB 的既不能信任也不能命中；`dir` 档只覆盖 `write`/`edit`，**bash 命令写进那个目录不在内**（与 C4 的既有局限同源）；文件损坏/被删 = 退回「每次都问」。
- **本次不做**（写死，防后人重推）：不按命令首词/前缀记忆（那等于把 `\brm\b` 整条正则作废 —— 那件事今天就能在设置里做，本项刻意不重复它）；不做归一化匹配；**热路径零写盘**（不记 `uses`/`lastUsedAt`）；不做过期/自动清理；不加设置开关（撤销路径够用，再加一个「全局暂停白名单」的键是给以后留的口子）；不给 bash 提供「信任此目录」、不给 write/edit 提供「信任此命令」（按不出来的按钮不该出现在拦停态里）；不改 hook 脚本/派生配置/令牌（F1）；不动 `_onResolved` 签名（F4）；不做图形化管理面板。
- **自检**：[scripts/probe-approval-trust.mjs](../scripts/probe-approval-trust.mjs)（新，**55/55**，七组）—— A bash 逐字+cwd（空白/大小写/前缀/另一个 cwd/通配五条**反控**）、B dir 档（含兄弟目录 `D:\out2` 那个坑）、C `offerTrust`（触顶/盘根/家目录/未知工具 + 反控）、D `addTrust`（去重/上限/伪造粒度/写→读往返）、E 坏文件解析（**缺 command 的后门**、相对目录、整份丢光 ⇒ `corrupt`）、F 读盘写盘（往返、写前净化、缺失文件**不算坏**、tmp 残渣、父目录不存在 ⇒ 抛）、G 展示文案 + 硬禁判定。
  - [scripts/probe-approval-roundtrip.mjs](../scripts/probe-approval-roundtrip.mjs) **24/24**（原 18 + 新增 6）：⑲ 用**真白名单文件 + 真 hook 子进程**走完整条回路（命中 ⇒ 条不弹、脚本不表态、`observed` 照旧），⑳ 逐字精确四条（正控 + 表非空≠全放行 + cwd 是键的一半 + 多一个空格照样弹），㉑-㉔ 把「白名单接在 `_askNeedsApproval` 第一句」「判定只有一处（`matchTrust`/`offerTrust`/`isInsideDir`）」「失败一律 false」「先回话再记盘、`_createTrust` 里不许出现 `allow`」钉在源码上。
  - [scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs) **89/89**（原 78 + 新增 11）：带 trust ⇒ 按钮与说明都出来且**逐字**；不带 ⇒ 两个都藏且不留字（反控）；点永久信任 ⇒ 恰好一条 `allow:true` + 粒度原样；连点只发一条；dir 档不被前端改成 command；**Esc 仍是拒绝且不带 trust**；「允许执行」不许静默升级；收起即复位；**已隐藏的按钮按下也不带上一条的粒度**；结构守卫（按钮在 `.approval-actions` 内、说明另起一行、两者初始 hidden、「允许执行」没被改字）；CSS 守卫（`warn` 而不是 `warning`、没写 `display`）。
  - **变异测试：C16 这 11 条全被抓红**，加上 C13 七条 + C14 六条 + C15 八条 = **`probe-webview-render` 累计 32/32**（手册那行说的就是这个累计数）：① 逐字相等→前缀包含、② 键里去掉 cwd、③ 去掉触顶拒判、④ 硬禁表恒 false、⑤ 解析去掉逐条校验、⑥ kind 不校验就建、⑦ 包含判定换成 `startsWith`、⑧/⑧b 去掉两处上限、⑨ 收起不复位、⑩c **allow 闸松开 + Esc 也传 kind**、⑪c **复位没了 + `renderApproval` 只在有 trust 时赋值**。每条**先自证插进去了**（字面量不匹配就报「这条测试无效」）。
    - ⚠️ 两条**踩坑记录**：**(a)** ⑩/⑪ **单独改是无效变异** —— `allow &&` 闸与 `clearApproval` 的复位各自兜着对方，单独拆一边**一条都不红**，只有**两处一起**拆才红。**这正是「先自证 + 变异必须能红」那道闸的价值**：不这么查，就会误以为「探针盖住了」，而真相是那两处互为备份。**(b)** 变异驱动的第一版拿「等 900ms 看有没有弹条」当判据，编译并行时 900ms 内连子进程都没起来 ⇒ **假红**。改成**两个真实结局赛跑**（要问 ⇒ hook 挂着等答复；不问 ⇒ 服务端当场放行、hook 自己退出），这也顺带把那条判据从「等一个时间窗」改成了「等一个事实」。
- **只能真机 F5 盖住（八条，待跑）**：
  0. ⚠️ **两条前提（2026-09-22 真机踩过）**：**(a)** `write`/`edit` 的目标必须是**写得出绝对路径**的形式 —— POSIX 形态（`/mnt/d/...`，WSL 侧 bash 让模型习惯这么写）会被 `resolveTargetPath` **故意**判成 undefined（宁可判不出来也不乱认：那条路径下 `intended` 与 `actual` 是两个不同的目录）⇒ 条**照样弹**但**永远不会有**目录按钮。想看目录档就用工作区相对路径或 `D:\...`。**(b)** 拦停条挂在 composer 里、react-live 只藏 `#messages` ⇒ **这八条都不需要挪 `media/dsh-live/`**（那是 C14 看工具卡读数才要做的）。
  1. bash 拦停条上出现「永久信任此命令」+ 边界说明行，**说明里要写出具体的工作区**（那正是 F7 那个 bug 的可见症状）；write/edit 上出现的是「永久信任此目录」。
  2. 点永久信任 ⇒ 模型重发**同一条**命令不再弹条，且转写里有留痕 —— **一条 note、两段**（`已允许执行：<命令>；已永久信任 命令 <命令>（工作区 <cwd>，<时间>）—— 可在命令面板「AlohaDSH: 查看/清除审批白名单」里撤销`），**不是两条**。反控：点「允许执行」的那一次，同一条命令下次**仍弹**（两个按钮只差一个字段）。
  3. 同一条命令**在另一个工作区**照样弹条（cwd 是键的一半）；多一个字符的 `rm` 也照样弹（逐字精确）。
  4. write/edit：信任某目录后，写进它**子目录**不弹条；写进**兄弟目录**仍弹条（用 `D:\f5-out` 与 `D:\f5-out2` 这种**共享前缀**的名字，才真正验到 `path.relative` 与 `startsWith` 的差别）。
  5. 重载窗口后白名单还在（证明真落盘、不是内存）—— 命令面板能列出来。
  6. 命令面板撤销一条 ⇒ 下一次立刻又弹条（**不用重连**）。
  7. 手工删掉 `approval-trust.json` ⇒ 下一次弹条（文件是唯一真相）。
  8. 深浅两套主题下新按钮与新说明行的配色。

### C17 · 多模态 / 图片附件（诚实降级）（2026-09-23 实现，F5 八条待跑）
- **原文**：**现状**「附件只吃文本，包成 `<file>` 文本块」；**补法**「取决于模型与 runtime 是否支持图片内容块；支持则协议加 image 附件类型 + 气泡渲染」。
- **本次探查把「取决于」那一问回答死了：今天图片到不了模型。三层墙，逐条核过源码**：
  1. **协议层有图片块，但它带的是「已落盘的引用」而不是字节**：`session/prompt` 收的 `ContentBlock[]` 里确实有 `{type:'image', attachment: ImageAttachmentRef}`（`dsh-llm/lib/types/types.d.ts:48-89`），而提交字节那套 `EncodedImageAttachment` → `admitEncodedImages` 只被 **ACP 适配器**（`dsh-acp/lib/index.js:122`）与**命令执行器**（`dsh-commands/lib/index.js:337`）消费；我们这条 `dsh-sdk-jsonrpc-server` 的 `prompt()`（`lib/index.js:109-118`）只做 `createUserMessage({content: params.contentBlocks})`，**从不调 `admitEncodedImages`** ⇒ 没有任何办法把字节提交进去，也就造不出合法的 `ImageAttachmentRef`。
  2. **运行时没挂附件仓库**：`dsh-attachment-local` 既不在 `dist-runtime/node_modules` 也不在 `dist-runtime/cordis.yml`（只挂了 `llm-deepseek`）⇒ `ctx.attachments` 是 undefined。连带后果：**`read_image` 工具在我们运行时里根本不存在** —— 它由 `tool-fs` 仅当 `attachments` 被挂载时才注册（`dsh-tool-fs/lib/index.js:1191`）。agent 连「试着读一下这张图」的工具都没有。
  3. **模型是硬墙**：默认 `deepseek-v4-flash` 没声明 `inputModalities` ⇒ 按 `['text']` 处理，一遇图片即 `UNSUPPORTED_CONTENT`；`DEFAULT_MODELS` 两项都没声明（`dsh-llm-deepseek/lib/index.js:786-794`），而上游文档写死了「**DeepSeek 自家 chat-completions 路由是纯文本，且无法配置成别的**」（`docs/user/guide/providers.md:132`）。
- **用户已拍板：走「诚实降级」**（不再讨论）。即**不假装支持多模态**，而是把「图片今天进不去」做成一件用户看得懂的事，并顺手修掉今天真实存在的缺陷。
- **今天的实际行为（这才是要修的）**：
  - 贴一张**截图**（通常 >10KB）⇒ `_readFileAttachment` 因 `MAX_FILE_BYTES = 10*1024` 判 `readError: '文件过大（>10KB），未读取'` ⇒ `_sendUser` **整条拒发**，提示「以下文件无法读取或过大」。**用户完全读不出「其实是因为模型看不见图」**。
  - 贴一张**小图标**（<10KB）⇒ `fs.readFileSync(p,'utf8')` 把 PNG 读成乱码，包进 `<file>` 块**喂给模型**；同一个缺陷也把 PDF/ZIP 这类小二进制当文本读进去。反面对照：`src/fileSnapshot.ts` 早就有 `BIN_EXT` 与 NUL 嗅探 —— **审阅那条路有二进制意识，附件这条路没有**。
  - 🐞 **第三个真 bug（本次自检揪出）**：粘贴处理读的是 **`e.dataTransfer`**（`dropHasFiles(e)`），而粘贴事件把文件放在 **`e.clipboardData`** 上 ⇒ **整条粘贴贴图的路从来没通过**，而且是**静默失败**（不报错、什么也不发生）。
- **要达成的结果**：图片被认出来、有一条 agent 够得着的落点、气泡里有一枚**说明它是图片**的 chip、提示词里有一句**明说模型看不见图、只能用命令/工具碰它**；不支持的东西给**真实原因**而不是「读取失败或过大」。**字节永不发给模型 —— 因为它到不了。**
- **关键事实（都已核过源码，决定了设计）**：
  - **F1 降级不改 `dshRuntime.ts` 一个字节**：今天所有内容最后都被拼成一个 `{type:'text'}` 块，说明文字就是那段拼好的文本里的一段。与 C16 同一型 —— 改动全在扩展侧。
  - **F2 整份 `attachments` 会原样落进 `sessions*.json`**（`userMsg.attachments = attachments`），而正文**没有任何上限** ⇒ **base64 绝不能进 `Attachment`**，否则一次贴图就把会话存储写成几十 MB。图片附件只存**路径 + 元数据**。
  - **F3 选区附件（1.1）有现成范式**：落临时文件 → 提示词里只放引用 → 清扫。但**不照抄 `@"path"`** —— DSH 的 `@` 语法只管**会话**引用（规范形 `@[label](dsh-session:…)`），`@"D:\x.png"` 没有任何「这是图片」的语义，只会把 agent 引向文本工具去读二进制。
  - **F4 落点必须在工作区里**（`.hello-chat/images/`，不复制用户的文件）：DSH agent 共享这块盘、用命令读得到 —— 而「agent 能用命令碰它」是这次降级**唯一**的实际价值；放 globalStorage 等于把唯一的价值扔掉（1.1 选区临时目录踩过同一个坑）。该目录被 `fileSnapshot` 的 `IGNORED_DIRS` 整棵忽略。
  - **F5 缩略图这条路的账算不过来**：`asWebviewUri` 对工作区里的文件**过得了 CSP、过不了 `localResourceRoots`**（只放行 `media/`），放宽之后**拾取来的图片在工作区外，永远覆盖不到** ⇒ 得改成「一律复制进 `.hello-chat/images`」；且 `_post` 发出去的**常常就是落盘的那个对象实例** ⇒ 就地盖 URI 就是往 `sessions.json` 里写会过期的 URI。**本次不做**。
  - **F6 上游认的图片恰是四种**（`image/png|jpeg|webp|gif`），识别本身用 **sharp**（重原生依赖）⇒ 白名单**复刻那四种**、嗅探自己写、**不做尺寸解析**。**不许复用 `fileSnapshot.BIN_EXT`**：那回答的是另一个问题（「审阅时别按 utf8 预览」），集合里含 ico/bmp/pdf/zip，借过来会放行一批上游根本不认的类型 —— 那是新的谎言，而且它们过不了本模块的嗅探，等于自相矛盾。
  - **F7 拒发语义保持不变，只把原因分开**：图片过大 / 不是可用图片 / 二进制非文本，文案在 chip 上显示。
  - **F8 webview 的 DOM 影子**没有 `File`/`Uint8Array`/`ArrayBuffer`/`btoa`/`readAsDataURL`，且现有的 89 条**没有任何一条**碰 paste/drop ⇒ 影子只补两处，**不可能扰动既有 89 条**。用 `readAsDataURL` 而不是 `readAsArrayBuffer` ⇒ 白送 base64，省掉 `btoa`/分块 `fromCharCode` 一整类问题。
- **D1 · 新纯模块** [src/imageAttach.ts](../src/imageAttach.ts)（**不 import vscode** —— C10b/C15/C16 的教训）：`sniffImageMediaType` / `safeImageFileName` / `imageBytesAllowed` / `imagesWithinCount` / `imageNote` / `noteForAttachment` / `describeImageAttachment` / 三条拒绝文案。（⚠️ 这四个此后各归其位：`imageNote`/`noteForAttachment` 被 **C17b** 退役、`describeImageAttachment` 被 **C20** 删掉（死后无消费者 —— 导出与 chip 各自实现，它成了一段**没人读却看着权威**的旧文案），`imagePromptText` + `IMAGE_ROUTE_TAGS` 是它们的继任者。）
  - **魔数优先于扩展名**：`.png` 里可能装着文本，`shot.txt` 里可能是张真 PNG。**认不出来 = 不是图片**，绝不放行到「那就按文本读吧」那条路上去（今天最阴的缺陷就是从那儿来的）。扩展名**只用来给落盘文件取名**、以及决定拒绝时的说法（`.svg`/`.ico`/`.bmp` 确实是图片、只是送不进去，说「不是可用的图片（只支持 …）」比说「二进制文件」准确得多）。
  - **`imageBytesAllowed` 单独成函数**：上限的语义是「最多这么多」，**恰好等于要放行**。这条判据在扩展宿主之外钉住 —— 一个 `>` 写成 `>=` 的笔误，现场表现是「某些截图莫名其妙被拒」，而那种事**没有现场**（用户只会换一张图试试）。
  - **`safeImageFileName` 把输入当不可信**：剥目录（两种分隔符）→ 去控制字符与 Windows 非法字符 → 去尾部点与空格 → **扩展名由嗅探结果决定**（`image/jpeg` ⇒ `.jpg`）→ 80 字符上限 → Windows 保留名（`CON`/`COM1`…）加前缀 → 与已存在名字撞了就 `-2`/`-3`。踩过一个坑：判「有没有扩展名」必须用 `dot >= 0` 而不是 `> 0` —— 粘贴来的 Blob 名字有时就是 `.png`，落成 `.png.png` 既难看又像隐藏文件（兜底名 `image`）。
  - **说明文字里绝不出现 `@"`**（见 F3），且**三句必须都在**：「看不到它的内容」（不说这句，模型会对着一个 `.png` 路径一本正经地描述画面）+「**不要试图用工具把它「看」出来**」（真机加上的，见下面「F5 实录」的发现 B）+「不要凭文件名猜测」（否则「看不到」会被理解成「那就按文件名想象一个」）。**同时**必须留一句「只有用户明确要求对这个文件做某件事时，才用命令去动它」—— 收得太紧会把「把这个文件挪到 X」这种正当请求也一起拒掉，那是另一个方向的错。**路径那一行还要给两读法**：盘符形态之外附 WSL 里可执行的那个（`D:\a\b` ⇒ `/mnt/d/a/b`），换算**委派**给 `dshHooks.toWslPath`（`imageAttach.ts` 里一个 `/mnt/` 字面量都没有，有结构守卫钉着），且**只在两读法真的不同时才写**（POSIX 路径原样返回，macOS/Linux 上凭空多一行是噪音，探针有反控）。长度有上限，超了就截路径。
- **D2 · 协议**（[src/protocol.ts](../src/protocol.ts)）：`FileRef` += `kind?`/`mediaType?`/`bytes?`/`dataBase64?`，`truncated?` 从 `Attachment` **上移**到 `FileRef`（webview 才转得动它）；`Attachment` += `kind?`/`mediaType?`/`bytes?`/`note?`。注释写死那条不变量：**图片附件永不带 `content`；`dataBase64` 是 webview→扩展的单向字段，在 `_resolveAttachments` 里被消费掉，绝不进 `Attachment`**。
- **D3 · 接线**（[src/chatViewProvider.ts](../src/chatViewProvider.ts)）：
  - `_readFileAttachment` 重排成五步优先级：**魔数图片 → 扩展名像图片 → 二进制（`binaryExt`/NUL）→ 10KB 闸 → 按文本读**。图片分支**必须先于那道 10KB 闸**（截图几百 KB，排在后面就是永远「文件过大」）。
  - **拾取的文件（有 `path`）不复制**、原地引用；**只有粘贴/拖拽来的（无 `path`）才落盘**。理由同 C12/C16 的「不写用户任何文件」：不复制是更保守的选择，代价只是原文件被移走后路径失效（那时 agent 本来也读不到）。
  - `_resolveImageRef`：`Buffer.from(base64)` → **拿解出来的字节重新嗅探一次**（webview 不是可信输入）→ 在**解码后的长度**上再查一次上限 → 建目录 → **先清扫** → 补 `.gitignore` → 写盘。写失败 ⇒ `readError`，不静默丢。
  - `_runLive` 与 `_buildPrompt`（两个模式）**各插一份、都走同一个 `noteForAttachment`**，两个模式不许说两套话；分支必须排在通用 `<file>` 那行**之前**（图片没有 `content`，掉进那行只会拼出一个空块，而模型会以为「这个文件是空的」而不是「这个文件我看不见」）。
  - 张数超限**在 `_sendUser` 里兜底复查一次**（webview 侧有一份镜像，两边都被改过才可能漏）。
- **D4 · webview**（[media/chat.js](../media/chat.js) / [.css](../media/chat.css)）：常量镜像挨着 `MAX_FILE_BYTES` 写（探针有一条**对拍两边的字面量**）；`addFilesFromList` 按图片分岔走 `readAsDataURL`、剥掉 `data:` 前缀；`send()` 转发 `kind/mediaType/bytes/dataBase64`（**图片绝不设 `content`**），并**补上今天漏掉的 `truncated`**；两处 chip 加图片分支（`图片 · shot.png · 1.2MB · <末标>`，全部 `textContent`）；⚠️ **那个末标改过两版**：2026-09-23 先由「模型看不到」改成「模型需自行读取」（老那句把「今天这份配置没开图片输入」说成了**模型的属性**），**同日又被 C20 定稿成两档** —— 今天真机上可见的是「**图片输入未接通**」，「模型需自行读取」成了通路打开那一档的说法（判定与措辞见 **C20**）；CSS `.chip-tag`/`.chip-dim` 只用 `dsh-live.css` 里**真有**的 `--dsw-alias-*`。
- **D5 · 落点的整洁**：`.hello-chat/images/.gitignore`（内容 `*`）—— **只写在我们完全拥有的子目录里，不写 `.hello-chat/` 顶层**（那里有 C12 的 `profile.json`，是用户可能想提交的配置）。清扫复用 1.1 的 `_sweepStaleFiles(dir, maxAgeMs)`，TTL **7 天**，并在 `activate()` 里补扫一次（否则「只贴过一张图就再没贴过」的用户会一直留着垃圾）。
- **已知局限**：**模型看不见图片内容**（这是本次的**前提**而不是缺陷，说明文字会明说）；拾取的文件原地引用 ⇒ 原文件被移走/改名后路径失效；4 张 / 单张 3.5MB 是**扩展自己定的**上限（与 DSH 附件仓库的取值同形，但**不是**它的部署默认值 —— 那个值由部署配置解析，`dsh-attachment/lib` 只声明接口）；落盘副本 **7 天后被清扫**（转写里仍留着名字与大小，chip 不会消失）；`read_image` 在我们运行时里不存在 ⇒ 「让 agent 自己看图」这条**今天连试都试不了**。
- **本次不做**（写死，防后人重推）：**气泡里的缩略图**（三条理由见 F5，任一条都够；而且**它是不诚实的** —— 气泡里出现一张图，读起来就是「模型看见过它」，要缩略图另开 C17b）；**不解析图片尺寸**（没有任何消费者，而自己写 header 解析器就是再写一个解码器，上游用的是 sharp、我们零依赖）；**不把 `bmp`/`ico` 放进白名单**（多认就是新的谎言，见 F6）；**不加设置项**（图片是用户主动贴的，不像 `autoAttachSelection` 每次发送都会触发）；**不在 purge/软删除时删图片文件**（C15 的分叉意味着两条会话可能共用同一个路径，按 mtime 清扫是唯一安全的回收方式）；**不碰 `dshRuntime.ts` 的 `ContentBlock`**、不碰派生配置、不碰运行时挂载表（字节到不了模型这件事在扩展侧解决不了，见 F1）；不给图片做「信任/自动附加」之类的联动、不动 C16 的白名单语义。
- **自检**：[scripts/probe-image-attach.mjs](../scripts/probe-image-attach.mjs)（新，**47/47**，七组）—— A 识别（四种魔数、JPEG 字节配 `.png` 名仍判 jpeg、文本字节配 `.png` 名判 undefined、`.svg`/`.ico`/`.bmp` 一律拒、`.PNG` 大小写折叠）、B 上限（**恰好等于要放行**、张数、两边镜像字面量对拍）、C 文件名（`../../evil.png`、`a\b.png`、`CON.png`、300 字符名、重名 `-2`、扩展名以嗅探为准）、D 说明文字（路径/字节/MIME/那句「看不到」都在、**不含 `@"`**、有长度上限）、E **落盘反证**（`mkdtempSync` 里起真 `SessionStore`，写一条带图片附件的会话再读回 JSON：有 `kind`/`mediaType`/`bytes`/`note`，**没有 `dataBase64`、没有 `base64,`**）、F 源码结构守卫、G 与既有功能对账。
  - [scripts/probe-webview-render.mjs](../scripts/probe-webview-render.mjs) **97/97**（原 89 + 新增 8）：粘贴一张图 ⇒ **恰好一条** `user-message` 帧、带 `kind/mediaType/dataBase64` 且**不带 `content`**；超限与超张数 ⇒ chip 上出现 `readError`、`send()` **什么都不发**；快照里带一条图片附件 ⇒ 气泡里画出那枚文字 chip；`truncated: true` 的待发项 ⇒ 帧里也带 `truncated: true`。
  - ⚠️ **探针影子的两处扩充**：`El.dispatch(type, props)`（把 props 并进事件对象，才带得动 `clipboardData.files`；现有单参调用与 `click()` 不受影响）、`FileReader.readAsDataURL(f)`（**真回调** —— 今天那个 `readAsText` **从不回调**，所以 paste/drag 这条路从来没被跑过）。真实异步下「先读文件再发送」的次序在影子里被压成同步，**真正兜住张数上限的是扩展侧那道复查**。
  - **变异测试：C17 这 16 条全被抓红**（① 图片分支挪到 10KB 闸之后、② 图片走 `readFileSync(…,'utf8')`、③ 准入改成采信扩展名、④ 上限语义写成 `<=` 的反面 / ④b 上限缩回 10KB、⑤ 把 `dataBase64` 抄进 `Attachment`、⑥ `_runLive` 的图片分支挪到 `<file>` 之后、⑦ 去掉 `send()` 里的 `truncated` 转发、⑧ 图片也用 `readAsText` 读、⑨ 落盘文件名不剥目录、⑩ 说明文字里抹掉「看不到」那句、⑪ 粘贴判据退回 `dropHasFiles`、**⑫ 抹掉「不要试图用工具把它看出来」整段、⑬ 只删「只有用户明确要求…才用命令」那句、⑭ 抹掉 WSL 第二读法、⑮ 自己写一份换算（不再委派 `toWslPath`）**），其中 13 条打在 `probe-image-attach`、3 条打在 `probe-webview-render`（**那个探针的累计数因此从 32 变 35**）。每条**先自证插进去了**。
    - ⚠️ **两条踩坑记录**：**(a) `.ts` 变异必须 `npm run compile`** —— 探针读的是 `out/`，不编译 = 变异根本没进产物，于是**原样全绿**（第一轮 12 条里漏网 5 条，4 条是这个原因）。驱动里已改成**按文件扩展名自动判定**，不再每条手写。**(b)** 「图片分支先于 10KB 闸」这条的锚点**必须是那条返回图片的分支**（`if (mediaType) {`），不能锚在嗅探那一行：把闸插在「嗅探之后、判分支之前」这种写法锚在 sniff 上会看走眼。而锚点一挪，「这段里得有魔数嗅探」那句断言就得跟着改 —— 嗅探那一行在锚点**上面**，`slice` 进不来（实测自己把自己绊倒一次：**假红**，且恰好只在还原后的复跑里露头）。**(c)** 「`imageAttach` 里不许有 `/mnt/` 字面量」那条结构守卫**第一版忘了剥注释** —— 而 `/mnt/d/…` 正是这条约定要解释的东西，于是它把自己旁边那段解释判成了红。守卫改成先剥注释再找，并加了两条自证（剥完必须变短、且 `export function sniffImageMediaType` 还在 —— 免得哪天剥过头，守卫变成永真）。
- **F5 实录（2026-09-23，用户真机，一次「贴图 + 问『这是什么东西』」）**：
  - **第 2 条 ✅ / 第 3 条 ✅（半）**：贴的是一张 **1155 字节**的 PNG（正是「小图标 <10KB」那一档）。说明文字逐字到了模型（`图片附件：image.png（image/png，1.1 KB，共 1155 字节）` + 那句「你看不到」），**模型没有描述画面** —— 它开口就是 `I can't see images`，然后去开工具。**这是整个 C17 要买的那一件事，真机正面证明。** 转写里 agent 自己那句 `ls -la` 还顺带给出了第 3 条的另一半证据：`.hello-chat/images/` 下**同时**躺着 `image.png`（1155 字节）与 `.gitignore`（**2 字节** = `*`）。还差 `git status` 那半没看。
  - **白捡一条**：落盘副本**存在**这件事本身证明它是**粘贴/拖拽**进来的（拾取的文件是原地引用、不复制）⇒ **今天修掉的 `pasteHasFiles` 那条路（此前从来没通过）在真机上端到端跑通了**，变异 ⑪ 有了真机背书。
  - **发现 A（已处理）**：我们发出去的路径 agent 的 shell **用不了** —— `ls -la "d:/…/.hello-chat/images/image.png"` 报 `No such file or directory`，直到 `pwd` 打出 `/mnt/d/…` 才对上，白烧一轮。这正是 C13 那次真事故的同一面墙。**已按 C13 的口径补了第二读法**：路径那一行现在写成 `文件路径：D:\…（bash 在 WSL 里时读作 /mnt/d/…）`，换算**委派**给 [dshHooks.ts](../src/dshHooks.ts) 的 `toWslPath`（`imageAttach.ts` 里**一个 `/mnt/` 字面量都没有**，有结构守卫钉着）。⚠️ 这不是 C13「不做路径归一化」的反悔 —— 归一化是*改写*，两读法是*并列*（C13 给批准条做的就是并列）。**只在两读法真的不同时才写**：POSIX 路径换算后原样返回，在 macOS/Linux 上凭空多一行 `/mnt/…` 只是噪音（探针有反控）。
  - **发现 B（已处理）**：原话里那句「请用命令或工具处理这个文件（复制、**转换**、查看元数据…）」**读起来是一份行动许可** —— agent 为了回答一句「这是什么东西」，在 WSL 里下了 `get-pip.py`、装了 pip/Pillow/numpy/opencv/onnxruntime/rapidocr 一整套 OCR 栈，还试了 `sudo`，白烧十几轮。**全程没有一次审批，而这不算漏判**：bash 只按 `matchesAnyPattern` 判，十条默认正则全是**破坏性命令**的模式，`pip install`/`curl`/`sudo` 一个都不匹配；「工作区外」那条规则只覆盖 `write`/`edit`（见 [chatViewProvider.ts](../src/chatViewProvider.ts) 的 `_askNeedsApproval`）。⇒ **说明文字已收敛**：新增「不要试图用工具把它『看』出来：读二进制、OCR、转格式、装识别工具都不会让你看见画面，只会白烧时间与 token」，并补一句「只有用户明确要求对这个文件做某件事时，才用命令去动它」兜住正当请求；两条新变异（⑫ 抹掉前者、⑬ 删掉后者）都被抓住。**这一条改变了说明文字 ⇒ 第 1、2 条的 F5 证据是针对*旧文字*的**：机制已被证明可用，新句子仍需真机再看一眼。
- **只能真机 F5 盖住（八条）**：
  1. 贴一张**截图**（>10KB）⇒ 不再报「文件过大（>10KB）」，chip 上写的是**图片**与它的真实大小（末一个标**由 C20 定稿**：今天这台机器是**「图片输入未接通」**那一档，见 D4 与 C20），且提示词里那句「你看不到这些图的画面内容」确实到了模型（**C17b 之后改看盘上这条会话的 `request/header.header.system`** —— 气泡里已经没有那段字了）。
  2. ✅ 贴一张**小图标**（<10KB）⇒ 不再被当文本读进提示词（2026-09-23 真机通过，见上；**但说明文字此后改过两次：先加「不要试图用工具把它『看』出来」（当日已真机复验），再于 C17b 换了投递通道 —— 后面的验收改看 `request/header.header.system` 而不是气泡**）。
  3. 落盘副本在 `<工作区>/.hello-chat/images/` 里**真的存在** ✅（真机 `ls` 已见），`git status` 里**看不见**它（`.gitignore` 生效）—— 后半句待看。
  4. **拾取**一张工作区外的图片 ⇒ 提示词里给的是**那个原路径**，`.hello-chat/images/` 里**没有**多出副本。
  5. 超 3.5MB 的图 ⇒ 拒发，理由说的是**图片过大**（不是「读取失败或过大」）；第 5 张图 ⇒ 拒发，理由说的是**张数**。
  6. 附一个 **PDF/ZIP** ⇒ 拒发，理由说的是**二进制文件**，不是被当文本读进去。
  7. 只带图片、不带文字的**第一条**消息 ⇒ 会话标题取文件名（现状行为，顺带确认没被改坏）。
  8. `sessionExport` 导出的 Markdown 里那条图片附件写着**图片**且**没有** base64；`sessions*.json` 里搜 `base64` **一处都没有**。
  9. 贴一张图 + 只问一句「这是什么」⇒ agent **不再**去装工具/OCR，直接说看不到（旧文字下它会装一整套 OCR 栈，见发现 B）；**反控**：明确说「把这个文件挪到 X」时它**照旧**用命令 —— 收敛过头的症状是正当请求被拒，那同样是错。
  10. WSL 下它拿**第二个读法**就能直接 `ls` 到那张图（发现 A 的验收）：不再出现 `No such file or directory` 之后靠 `pwd` 自己纠偏的那一轮。
- **什么条件下 C17 重新开张**（三条缺一不可）：① 上游宣告视觉模型 rollout 完成（`inputModalities` 带上 `image`）**且** ② 运行时挂上附件仓库（`ctx.attachments` 有值、`read_image` 被注册）**且** ③ 我们的 wire 有提交图片字节的方法（或改走 ACP / 命令执行器那条有 `admitEncodedImages` 的路）。**在这三条同时成立之前，「加个 image 附件类型」只会造出一批送不到的字节。** ⚠️ **但 ② 单独成立就会改变一件事**（C20）：`read_image` 一出现，agent 就真能自己把画面读进上下文 —— 那条路**不需要 ③**（③ 管的是「把用户的字节随消息发出去」，与「agent 自己去读」是两回事）。所以「说明那段话」必须跟着 ② 走，不能等三条凑齐。

- **C17b 反转（2026-09-23，当日实现）· 那段说明搬出用户消息、搬进系统提示词**
  - **用户原话**：「提交问题时我不希望聊天气泡里有『图片附件：image-2.png（image/png，344 KB…）文件路径：…』这些」。
    这不是挑剔：那段字是**说给模型听的**，却被 DSH 自己的转写面（所见即所发）原样印在用户自己的话下面 —— 每贴一张图读一遍机器告示。
  - **先证明这不是渲染问题**（否则会走错路）：`SessionPromptParams` 只有 `contentBlocks`、且「sent verbatim as the user message」，**wire 上没有隐藏通道**；
    实时转写由 DSH 自己的 bundle 渲染；我们自己的渲染器本来就只画 `msg.text`。⇒ 它出现在气泡里，**唯一的原因是它真的在消息正文里**。
  - **推翻的两条既有结论**（写在这里，免得后人照着老段落改）：
    1. **F3 的后半被推翻，前半不变**：「不许用 `@"path"`」照旧（`@` 只管会话引用，发了等于把 agent 引向文本工具）；
       但 F3 当时推出的「所以说明就留在用户消息里」不再成立 —— 换成「说明不进消息、走系统提示词」。
    2. **D1 那条「说明文字…」与 D3 的两处 `parts.push(noteForAttachment(a))` 全部作废**：`imageNote`/`noteForAttachment` 已删除，
       `Attachment.note` 字段退役（`sessions*.json` 里每条图片附件少存约 600 字符；**旧会话遗留的 `note` 是无人读的死数据，不迁移**）。
       `_runLive` 与 `_buildPrompt` 的图片分支现在**只 `continue`** —— ⚠️ 那个 `continue` 是承重的：掉了它会掉进 `<file>` 分支拼出空块，
       模型会以为「这个文件是空的」。
  - **新机制**：自挂插件（[src/imagePromptPlugin.ts](../src/imagePromptPlugin.ts)，体例同 C11/C12）注册一个提示词**变量** + 一个**小节**
    （正文恰是 `{{hello_image_list}}`，`order: 150`）；扩展把渲染好的文字写进状态文件（`{dsh会话id: 文字}`，纯模块渲染在
    [src/imageAttach.ts](../src/imageAttach.ts) 的 `imagePromptText`），插件**每次 assembly 现读**；没有记录的会话返回空串，
    `renderPrompt` 把空小节整个丢掉 ⇒ **没有图片的会话里这份东西一个字节都不存在**。
  - **两个承重细节（都是码完复核才钉死的，各自会开一扇很难查的门）**：
    1. **绕变量这一道**：`interpolate` 对**每个** section 都跑，遇到没注册的 `{{名字}}` 直接 **throw**；而正文里带的是用户数据（文件名/路径）——
       一张叫 `{{草稿}}.png` 的图会让这个会话**每一轮**都失败，而表是整份重写的 ⇒ 只要那张图还在历史里就永久坏掉、**用户没有出路**。
       而代入后的值**不会被再扫一遍**，所以从变量送进去既逐字保真又永不抛。注册顺序**先变量后小节**，小节失败要撤掉变量（反过来会留下一个每轮都抛的悬空引用）。
    2. **键不能只认 `s.dsh?.id`**：`_ensureDshSession` 只有「补丁可用 + 首次」那一支把 id 落盘，no-patch（开发者路径 / `hello.dsh.command`）与
       cwd 不符两支**绝不写盘** ⇒ 照档位表那样过滤会让那两条路上**一个键都写不出来**、说明整段静默消失。改为 `_dshSessions`（权威内存表）优先、`s.dsh?.id` 兜底。
  - **其他设计点**：值取「共享同一 dsh id 的所有 UI 会话的**并集**」（分叉共享源 id），活跃那条排**最后**（12 张上限丢的是最旧的，本轮刚贴的不能被挤掉）；
    表是 store 的**纯函数**，只在 `_runLive`（每轮、在 `runtime.prompt(` 与起进程之前）与 `_purgeOne` 两处整份重建 —— 没有增量维护、没有引用计数；
    **派生配置从此永远写**（这块无条件挂，「四样都不需要就不派生」那条早退再也不会触发 —— 代价记在这里，换来的是不需要 C11 那套热路径重连逻辑）；
    挂不上必须**告警**（`_imagePromptMounted`/`_overlayConfigPath`），因为它正是 C19 那场事故的入口（模型不知道自己看不见图片）。
  - **★ 实现当天就在真机上抓到一个真 bug（那条告警自己的位置）**：右下角弹了「派生配置里没有挂上图片说明插件」——
    可**盘上明明是挂上的**（`dsh-config/cordis.yml` 里有 `- id: hello-chat-image-prompt`，状态表里两条会话都写着真路径）。
    根因是初版把这条判决写在 `_writeImagePromptState()` 里，而它在 `_refreshDerivedConfig` 里跑在**挂块之前**
    （表要先落地，插件一加载就读它）—— 那一刻 `_overlayConfigPath`/`_imagePromptMounted` 还是**上一轮的旧值**，
    首次连接时它们是空的 ⇒ **「刚挂上」被误判成「没挂上」**。误报本身只是噪音，真正的害处是
    `_imagePromptWarn` **只弹一条**：假警报把额度烧掉之后，**真的**失效再也不出声 —— 那是这个功能最坏的失效形状
    （它唯一的职责就是在那场事故的入口喊一声）。
    修法：把判决抽成 `_checkImagePromptDelivery()`，**只在旗标定下来之后问** —— `_refreshDerivedConfig` 的
    **每一个出口**（末尾一次 + 「底本配置找不到」那条**早退支**单独一次：那条路上派生配置根本没被用上，正是要说的情形），
    外加 `_runLive` 每轮一次；挂上时立刻返回、不扫会话（正常路径零开销）。
    **教训记在这里**：「判决」读的是状态，就必须**晚于那个状态定下来**；写在顺手的地方（写表那里）看着最自然，恰恰是错的。
    新增结构守卫 **E5** + 三条变异（判决搬回写表里 / 去掉每轮那次 / 去掉早退那次）**全被抓红**；探针 28 → **29 条**。
  - **自检**：[scripts/probe-image-prompt.mjs](../scripts/probe-image-prompt.mjs) **29/29**（五段：插件模块 / 文案 / 派生块 / 真运行时端到端 / 结构守卫），
    六条变异**全被抓红**（去掉 `inject`、未知会话也返回文案、表写在 `runtime.prompt(` 之后、空串改成一句「本轮没有图片」、抹掉约束句、去掉 `ctx.effect`）。
    端到端那一段是本次最强的判据：**同一份日志**里 `request/header.header.system` **含**那些字，而同一条 `user/message` **一个字节都不含**它 ——
    一句话分别证明「仍然到得了模型」与「气泡干净」。原 `probe-image-attach.mjs` 的说明那组判据**整个搬走**（47 → **46 条**，A/B/C/G 一字未动）。
  - **已知局限（如实记）**：模型看到的**消息历史**里再没有图片痕迹（清单每轮重新生成 —— 这也正是它扛得住压缩的原因）；
    **贴图那一轮的前缀缓存会失效一次**（系统提示词在 token 流最前面）；一个会话附 >12 张图时更早那些**路径对模型不可见**（省略行只能点出目录让它自己 `ls`）；
    多窗口下状态文件整份重写（同既有存储的局限：A 窗口可能把 B 窗口刚写的键挤掉，后果是那一轮少一段说明、下次发送即自愈）；
    此后 react-live 的转写里**看不出**消息带过图片（这正是要的），代价是「事后从消息正文核对当时发了什么」这条审计路没了 —— 判据改为 `request/header.header.system`。
  - **F5（真机，待跑六条）**：① 贴图发一句 ⇒ 气泡里只有自己的话、chip 照旧；② 同一会话下一轮问「我刚才那张图在哪儿」⇒ 说得出路径；
    ③ 开一轮没有图片的对话 ⇒ 盘上 `request/header.header.system` **一个字节都不含**我们的文案；④ 关掉审批等所有可选功能后重连 ⇒ 其余行为与从前一致；
    ⑤ 新开会话 ⇒ 没有上一个会话的图片清单；⑥ `sessions*.json` 里不再有 `note`、也没有 base64，导出 Markdown 照旧写着「图片」。
  - **chip 上那句话改过一版（2026-09-23，用户拍板）**：原来是「模型看不到」，改成 **「模型需自行读取」**。
    理由不是好不好听：**「模型看不到」描述的是模型的属性，而它实际在说「今天这份配置没开图片输入」** ——
    通路一开（运行时挂上 `dsh-attachment` + 模型 catalog 声明 `inputModalities: image`），模型通过 `read` 真能看见画面，这句话当场变成假话。
    新说法描述的是**取用方式**（字节不随消息走、要看画面得自己 `read`），**两个世界都为真**。
    改动落在三处（`media/chat.js` 的 chip 文本与 tooltip、`src/imageAttach.ts` 的导出摘要行），两个探针各加了一条**反向对照**
    （`!line.includes('模型看不到')`）—— 免得下一次有人顺手改回去。⚠️ **系统提示词里那段约束一个字没动**（它说的是「你看不到**这些图**的画面内容」，
    指的是**本轮没送出去的字节**，本来就只在这个世界里成立），chip 与提示词因此**不是同一句话**，别再拿其中一个去对另一个取证。
    （计数不变：`probe-image-attach` **46**、`probe-webview-render` **97/97**。）
    - ⚠️ **同日后半天被 C20 接上**：那句「两个世界都为真」的话**没有东西可以让它跟着动**，而用户要的是三处一起跟着开关走 ⇒ C20 补上判定（`read_image` 在不在 tool 表里）并把末标定稿成**两档** —— 今天真机上是「**图片输入未接通**」，「模型需自行读取」成了通路打开那一档。上面这段的理由**一个字不作废**（它解释了为什么「关」那一档不许说「模型看不到」，只把归因说成「这次部署没开通」），只是那句现在由 `IMAGE_ROUTE_TAGS` 按档位出。反向对照随之变成**两档各一条**。

### C19 · bash 越界动作护栏（装包 / 下载 / 提权）
- **由来**：**2026-09-23 C17 的真机现场**（那次「贴一张图问『这是什么东西』」）。agent 为了让它「变得可读」，在 WSL 里下了 `get-pip.py`、装了 pip/Pillow/numpy/opencv/onnxruntime/rapidocr 一整套 OCR 栈、还试了一次 `sudo`（`sudo -n true` 报「需要交互式认证」），**全程没有一次审批**。
- **这不是漏判，是缺口**：`_askNeedsApproval`（[chatViewProvider.ts](../src/chatViewProvider.ts)）里 bash 只走 `matchesAnyPattern(this._approvalPatterns(), ask.command)`，而十条默认正则全是**破坏性命令**的模式（`rm`/`mkfs`/`dd`/`git push --force` 那一类）；`pip install` / `curl -o` / `sudo` 一个都不匹配。C4 的「工作区外」那条规则只覆盖 `write`/`edit` —— 因为 bash **压根没有目标路径可解析**。C4 的已知局限里写着「bash 命令写进那个目录不在内」，**真机露出来的是它的更大一半**：不是「写进某个目录」，而是**在区外装东西、下东西、提权**。
- **性质**：与 C4 同源（用户机器被静默改动），论性质接近 P0；但**补法还没定**，先按 P1 挂着。
- **三条路线（未拍板）**：
  1. **扩默认正则**：往十条里加装包（`pip|npm|yarn|pnpm|apt|choco|winget install`…）、下载（`curl|wget` 带 `-o`/`-O`）、提权（`sudo|runas`）三类。**最便宜、零新机制**，而且 C16 的白名单给了「这条我准了别再问」的出口，所以「问」的代价比 C16 之前低得多。**代价**：正则白名单式护栏天生不全（`python -m pip`、`env sudo`、自己下的 `install.sh` 都绕得过去），而且**会误伤自己的开发流**（本仓库天天跑 `npm run compile` / `npm test` —— 规则必须落在 `npm install`/`npm ci` 上，不能落在 `npm` 上）。
  2. **区外写护栏的镜像**：给 bash 也判一次「它会不会写区外」——但**静态判不出来**（一个 `bash -c` 里可以有任意多步）。要走这条就得改成运行时观测（比如 hook 里看子进程的实际写）或者**目录级沙箱**，而沙箱那条 C4 早就 spike 否决过（bash 侧 fail-closed，见 C4 正文）。
  3. **fail-closed 白名单**：只有认得的命令放行，其余全问。**最安全也最烦**，且会因为「认不得」把日常命令全变成弹窗。
- **验收（等补法定下来再细化）**：装包 / 下载 / 提权三类各有一条**正控**（弹条、可拒、拒了真不执行）；同时有三条**反控**（`npm run compile`、`git status`、`ls` 这类日常命令**不许**弹 —— 误伤的代价是把一个能用的工具变成不能用的）。
- **与 C16 的关系**：C16 的白名单只覆盖 `command`（bash）与 `dir`（write/edit）两档，**bash 这一档正好是 C19 要拦的那一类命令** ⇒ 两条会接在同一个点上，做 C19 时一并看。

### C20 · 图片通路的单一判定：chip / 导出 / 系统提示词那段一起跟着它走
- **由来（2026-09-23，C17b 当天的下一句）**：C17b 把 chip 那句从「模型看不到」改成「模型需自行读取」，理由是**它得在两个世界都为真**。用户随即要的是「三处一起跟着开关走」。**这两条要求在字面上互斥**：一句在两个世界都为真的话，**没有东西可以让它跟着动**；而要让三处跟着动，chip 就必须作一个**状态断言** —— 那就得有一个**事实**在它背后撑住，否则 C17 那条 chip 的教训（把「今天这份配置没开图片输入」说成模型的属性）立刻重演，只是换了个方向。**本项补的就是那个事实。**
  ⚠️ 现状里已经有一处这样的越界：chip 的 tooltip 写着「（当前模型路由没开图片输入）」—— 那**是一个状态断言，而且是写死的常量**。本项正是把它从常量变成判定。
- **判定（唯一真相）**：**`read_image` 在不在这一轮的 tool 表里**。
  - **源码坐标**：`read_image` 注册在 `ctx.inject(['attachments'], …)` **里面**（`dist-runtime/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js:1191` 的注释 + :1204 的调用）—— **附件仓库不在，这个工具根本不注册**。所以「工具在」⟺「运行时挂上了附件仓库」，也就是 C17 那三层墙里**唯一一层在我们手里**的那层。
  - **今天的实测**（从真运行时一轮的 `request/header.header.tools` 读出来的）：`bash, edit, read, subagent, todo_write, write` —— **没有 `read_image`** ⇒ 判定为**关**。这条断言可复现：任何一条我们运行时产出的会话日志都读得出同一个结果。
  - **读法与 C12 的工具白名单是同一处**（`request/header.header.tools`，那边正反双控都做过），而且**它比「直接问附件仓库」更好**：profile 用 `tools.deny` 把 `read_image` 禁掉时，判定会正确地变成「关」—— 那正是模型真读不到的情形。插件那边其实能**同步**判得更近（`ctx.get('attachments') !== undefined`，`read_image` 自己就是这么查的）；**明确不选**，两个理由：真相会变成两份（会漂），且**看不见 deny 表**（会撒谎）。
  - **API 形状（实现期修正）**：`request/header.header.tools` 是 `ToolSchema[]`，**元素到底是字符串还是 `{name}`** 在文档里没写死，实测两种形状都可能出现 ⇒ 纯模块的 `toolNamesInHeader` **两种都认、认不出来的元素丢掉**（不是编一个名字），整表读不出来就返回空数组（fail-closed）。判据在 `probe-image-attach` 的 D6b 上钉着（含 `{ name: 'read_image' }` 那一例 —— 只认字符串会让判定**恒为「关」**，而「恒关」正是最安静的失效形状）。
- **三处一起派生（一个判定，三个消费者）**：
  `IMAGE_ROUTE_TAGS`（`Record<'blind'|'readable', {tag, title}>`）是**两句话的唯一定义处**；`imageRouteFrom(readable)` / `imageRouteFromHeader(header)` 把值收敛成两档；`imageRouteTag(route)` 是取标签的唯一出口；`imagePromptText(images, route)` 的两个变体从它派生。webview 的 chip 走**同一张对照表的镜像字面量**（沿用 `MAX_FILE_BYTES` 那套「镜像 + 探针逐字对拍」的老办法），导出那一行**直接 import** `imageRouteTag`。三处在两个状态下的**内容分工**：
  - **chip 末标 / 导出行**（短标签）：两处**共用同一张对照表**，一个字的差别都不许有（结构守卫：那几个字在 `src/` 只许出现在 `IMAGE_ROUTE_TAGS` 一处、在 `media/chat.js` 只许出现一次）。
  - **系统提示词那段**（写给模型看的那段）：**关 = C17 那版一字不动**（你看不到画面 / **不要试图用工具把它「看」出来** / 不要凭文件名猜 / 用户点名才动它），只把**归因**从「当前模型不支持图片输入」改成「**这次部署**没有开通图片输入」（判定来自「运行时没挂附件仓库」，那是部署的事实）；**开 = 换成「指路」** —— 这些图可以用 `read_image` 读（用上面给的路径）；如果你的路由不支持图片输入，read_image 会明确告诉你，那就照实说你读不了。⚠️ **「不要试图用工具把它看出来」那句在「开」的那版里必须撤掉**：它在那一半世界里禁掉的正是**唯一正确的那个动作** —— 留着一句错的禁令，比少一句更坏。反过来，「关」的那版**一个字都不提 `read_image`**（点一个不存在的工具名是反向的同一句谎）。
- **措辞（2026-09-23 用户拍板 = 候选 1）**：关 =「**图片输入未接通**」／开 =「**模型需自行读取**」。
  - 关的那句说的是**这份配置的事实**（附件仓库没挂 ⇒ 工具不存在），不往模型身上赖；开的那句落在它**真正成立**的那半边。**今天真机上可见的是「关」那一档**（`read_image` 不在 tool 表里）。
  - ⚠️ **两档都不许出现「模型看不到」**（探针 D6 有两档各一条反控）：那句是把**部署**的事实说成**模型**的属性，而模型完全可能是多模态的 —— C17 那条 chip 的老毛病就是它。tooltip 里也照这条改过（原来写着「（当前模型路由没开图片输入）」，是一个**写死的状态断言**）。
  - 落选的候选（留档，防后人重推）：2「当前模型不支持图片输入」= 把部署说成模型；3「模型看不到」= 用户嫌太白的那版；4 不区分 = 那本项只剩「判定落盘」半边，今天零风险但不满足用户要的「一起跟着走」。
- **判定怎么到得了三处**：`request/header` **本来就在扩展的实时流里**（[runInspector.ts](../src/runInspector.ts) 的 `default` 分支点名列出了它 —— 一直被无视）。加一个 `case 'request/header'`，读 `d.header.tools`。
  - ⚠️ **C10b 的教训照抄**：这条事件**在会话中途不重发**（只在 initial / change / resume 时写一条，见 `dsh-agent-loop`），所以值必须**记在会话上并落盘**（`StoredSession` 上一个 `imageRead?: boolean`），不能只放内存 —— 否则重连、切回来、重载窗口那一刻读数就没了（C10b 就是这样丢了整个分母）。**缺值一律按「关」**（fail-closed：没有证据 = 今天的行为）。
  - **翻转是自动的，不需要重启**：世界一变（挂上附件仓库 / profile 改了 deny 表）⇒ 那一轮的 header 必然变 ⇒ `headerEquals` 为假 ⇒ 盘上多一条 `reason:'change'` ⇒ 扩展当场看见，三处一起翻。
- **已知局限（如实记）**：
  - **一拍的滞后**：渲染（chip 与写表）都发生在请求**之前**，而 header 是那一轮才来的 ⇒ **首轮按「关」**，此后翻过来。三处**同时**翻（同一个值），所以不会出现「chip 说开、提示词说关」这种自相矛盾 —— 但「贴第一张图那一轮三处都还是关的那版」要如实说，这与 C17b 那条「贴图那一轮前缀缓存失效一次」是同一类代价。
  - 判定证的是「**工具在不在**」，**不证「模型声明了 `image`」**。那半由运行时自己在调用那一刻判（`assertImageCapableRoute`，`dsh-tool-fs/lib/index.js:896`），拒绝文案干净、模型看得见、还带「换一个支持图片的模型」的建议。**我们不复制它的逻辑**（抄一份 = 造第二份会漂的真相）；「开」那版的文案因此写成**指路 + 让它自己撞门**，而不是断言「你看得见」。
  - **技术原因写在这里**：`inputModalities` **不在 wire 上**。header 里只有 `config` 的 provider/model 与 `adapterDefaults` 的两个标记（`dsh-agent-loop/lib/index.js:725-730`），模态一个字都没有 —— 想要它就得让插件回写一个文件给扩展读，那是**新开一条回流通道**，本项不做。
  - 上游若给 `read_image` 改名、或改注册条件，判定会**静默变成「一直关」**：失效方向是安全的（退回今天的行为），但要有**结构守卫**钉住那个字面量与源码坐标（照 C13「`imageAttach.ts` 里一个 `/mnt/` 字面量都不许有」那条的办法：先剥注释再找，并自证剥完没剥过头）。
  - 落盘的 flag 可能过时：另一个窗口跑的那一轮、人手改过存储、上游在两次请求之间换了挂载表 —— 都会让读数停在旧值上。fail-closed 只保证**没有证据时不撒谎**，不保证读数永远新鲜。
  - **翻档的补发在轮尾**（实现期决定）：判定是在流里读到的（那一刻正在生成回复），当场重画快照会把正在写的气泡拆掉 ⇒ 记一个旗标，`_afterTurn` 里补发一次（那时没有流在跑），翻完就清（常态路径一个字节都不多发）。所以「贴第一张图那一轮」看到的是「关」那版，**轮尾**它才翻过来。
- **落地（2026-09-23，未提交）**：
  - [src/imageAttach.ts](../src/imageAttach.ts)：`ImageRoute` / `IMAGE_ROUTE_TAGS` / `imageRouteFrom` / `imageRouteFromHeader` / `toolNamesInHeader` / `READ_IMAGE_TOOL` / `imageRouteTag`；`imagePromptText(images, route)` 两个变体；**删掉 `describeImageAttachment`**（C17b 之后它一个消费者都没有 —— 导出与 chip 各自实现，于是它成了一段**没人读却看着权威**的旧文案，上一轮改措辞时没人跟着改它）。
  - [src/dshRuntime.ts](../src/dshRuntime.ts)：`DshEventData.header?: unknown`（只读 `tools`，形状**故意不收窄** —— 认不出来由纯模块 fail-closed）。
  - [src/chatViewProvider.ts](../src/chatViewProvider.ts)：`case 'request/header'`（判定 + 记在会话上）、`_imageRoute` / `_imageRouteOfDshId`（同一个 dsh id 取**或** —— 一个运行时进程服务多条 UI 会话，分叉就共享源 id）、`_imagePromptTable` 传档位、`_postSnapshot` 带 `imageRead`、`_afterTurn` 补发、导出调用点传档位、`_forkSession` 继承 `imageRead`。
  - [src/sessionStore.ts](../src/sessionStore.ts) `imageRead?: boolean`（C10b 式理由写在那儿）；[src/protocol.ts](../src/protocol.ts) `snapshot.imageRead?`；[src/sessionExport.ts](../src/sessionExport.ts) `sessionToMarkdown(s, imageRead?)` 透传到 `attachmentLine`。
  - [media/chat.js](../media/chat.js)：`IMAGE_ROUTE_TAGS` 镜像 + 模块级 `imageRoute`（缺省 `'blind'`）+ `appendImageBadges` 从表取 + **snapshot 处理里在 `renderSnapshot` 之前落定档位**。
- **本次不做**（写死，防后人重推）：**不做「开」时的字节回传**（wire 依然一个字节都不发；开的是「agent 自己 `read_image`」这条，不是「消息带图」—— C17 的 F1 一个字不改）；**不加用户开关 / 设置项 / 配置条第四个钮** —— 一个**能撒谎**的开关比没有开关更坏（用户在「关」的世界里把它打开，系统提示词就会指一条走不通的路，而 C17 那场事故正是一个模型被邀请去「把图弄可读」；要加也只能加**只许往下按**的那一半）；不把 `inputModalities` 抄一份到扩展；不因判定为「开」就动 C17 的三条拒绝文案；不解析图片尺寸。
  - （可选后续，一行：`hello.chat.imageRead: false` / profile 里的同名键 =「就算通路开着也按看不见说」。它**只能往下按**，与 C12「只能加严」同一条性质。今天没有任何用户会用到它。）
- **判据 / 探针（已落地，实际计数）**：
  - `probe-image-attach` **49/49**（原 47 + 新增；D 组原来是打已删函数的那 1 条）：**D6** 两档字面量 + 缺值/`false`/`undefined` 一律「关」+ **两档都不许出现「模型看不到」**；**D6b** `imageRouteFromHeader` 的正反（含 `{name}` 形态、逐字精确、垃圾输入全「关」）；**D6c** 结构守卫（那几个字在 `chatViewProvider` / `sessionExport` / `imagePromptPlugin` 里**都不许出现**、导出必须真的走 `imageRouteTag`）；**E3b** 导出行跟着通路走（缺值按「关」、显式入参赢过会话字段）；B4 追加**镜像逐字对拍**（两档的 tag 与 title 都要在 `media/chat.js` 里逐字相同）。
  - `probe-image-prompt` **32/32**（原 29 + B3b/B3c/E6）：B3 是「关」那档的四句（归因已改成「这次部署」）；**B3b** 是「开」那档（点名 `read_image`、**不许**含「看不到」与「不要试图用工具」、共同尾巴还在、交代了撞门怎么办）；**B3c** 两档同向（关的那档不许提 `read_image`、不许把部署说成模型、共用同一抬头、认不出的档位落到「关」）；**E6** 接线守卫（判定只有一个入口、值记在会话上、快照带它、提示词表与导出两处都跟随、同一 dsh id 取或、翻档在轮尾补发且旗标会清、**流里不许重画快照**）。
  - `probe-webview-render` **99/99**（原 97 + 2）：新增「chip 跟着 `snapshot.imageRead` 翻档」（`true` → 开、`false` → 关、**字段缺失 → 关**）与「结构守卫」（末标只从镜像表读、那几个字在 `media/chat.js` 里**只出现一次**、档位必须在 `renderSnapshot` **之前**落定）。
  - **变异测试 12 条全被抓红**（驱动在系统临时目录，不随仓库走）：① 判定认错工具名 ② 工具表只认字符串形态 ③「开」那档塞回「你看不到」 ④ chip 末标硬编 ⑤ 档位拖到 `renderSnapshot` 之后 ⑥ 判定不记在会话上 ⑦ 提示词那处不跟随 ⑧ 快照不带 `imageRead` ⑨ 流里直接重画快照 ⑩ 翻档旗标不清 ⑪ 导出自己硬编 ⑫ 会话上不落 `imageRead` 字段。每条**先自证变异真的插进去了**（CRLF 文件上多行 `find` 会静默空转），`.ts` 的变异先 `npm run compile`。
  - **没做的那条端到端双控（如实记）**：原计划「把状态表按『开』手写一遍 ⇒ 真运行时的 `header.system` 必须是 readable 版」。实际未做 —— 「开」那档的文案由 B3b 直接打纯函数钉住，而**投递通道**（状态表 → 插件 → 系统提示词）与档位无关、已由 D1–D4 端到端证过。⇒ 「真运行时在『开』那一档下 system 长什么样」**今天只有单元级证据**，没有端到端证据。要补的话很便宜（改一行状态表内容再跑一轮），但别把「已证」读成比上面这句更强。
- **F5（真机，四条 —— 2026-09-23 全过）**：
  1. **正控（✓ 2026-09-23）**：今天这台机器贴图发一句 ⇒ chip 末标是「关」那版，**且**盘上 `request/header.header.tools` 里没有 `read_image`（一条日志同时证两边）。
  2. **一起动（✓ 2026-09-23）**：把那条会话的存储改成 `imageRead: true`（测试现状，可逆）⇒ 重载窗口 ⇒ chip 与导出行当场变「开」那版，系统提示词那一处**也在同一轮**就带「开」档（状态表在发请求之前写）；发一轮之后**轮尾 chip 自动翻回「关」** —— 那是运行时回的 header 把判定纠正了（设计如此，不是 bug）。
  3. **反控（✓ 2026-09-23）**：没有任何 header 的新会话 ⇒ 三处都是「关」那版，**不许**出现「开」那版的任何字。
  4. **不漂（✓ 2026-09-23）**：关掉窗口再打开那条会话 ⇒ chip 不漂（证明落盘的 flag 生效，而不是只在内存里活着）。
- **F5 的结果与一处缺口（如实记）**：四条都在真机上跑过并符合预期（用户 2026-09-23 确认；②的扩展侧另有状态表旁证 —— 同一张表里该 dsh id 是「开」档、另一条会话 `082e2796` 同时是「关」档，说明档位是逐会话算的）。第 0 步的留痕也在盘上：`c19e7bd6` 那份日志里 17:56:56 那条 `request/header` 的 `header.system` **已经是 C20 新措辞**（新抬头 + 「这次部署没有开通图片输入」），而它前面四条还是旧归因「当前模型不支持图片输入」—— 换代在同一条日志里看得见。⚠️ **唯一的缺口**：「开」档那条 `header.system` 的端到端留痕**没取到** —— 18:02 那一轮确实带「开」档提示词跑过（轮尾 chip 自动翻回「关」说明 header 到了扩展手里），但那份会话日志是**进程退出才 flush**，收尾时那个运行时进程（18:00:30 起）还活着，日志停在 17:56:57 ⇒ **「开」档在真运行时的留痕仍是空白**，它的证据只有单元级（B3b）与状态表级。补它很便宜（再关一次窗口让日志落盘即可），但用户 2026-09-23 选择收尾，故如实留白。
- **测试残留（无害，自愈）**：存储里 `c19e7bd6` 的 `imageRead` 仍是手改的 `true`（编辑器缓冲在 18:02:31 把它回写了一次，覆盖了扩展自己写的 `false`）。症状只是**那条会话在它下一次 live 之前三处显示「开」那版**，header 一回来就被纠正。⚠️ 真正的雷是那个还开着的编辑器标签页 —— 以后再保存一次就会把 `true` 复活；**关掉它（不保存）**即可。

---

## 交叉说明

- **最小可用商业化 = C1 + C2 + C3**（敢用、装得上、花得起）。C3 的用量部分（C3a）已完成，剩 C3b 的费用/拦截。
- C1/C4/C12 同源（审批策略），做 C1 时一并设计，别拆散。**C12 的落地形态（2026-09-18）**：审批那一半确实"零新机制"（profile 只是一层 `||`/并集，读口从"读设置"变成"读设置 → `compileProfile`"），但**工具白名单那一半不是同一回事** —— 它跟 C1 没有共用机制，靠的是自挂插件调 `tools.restrict`（见 C12 正文）。「同源」说的是**审批策略这一轴**，别据此以为整张 C12 都挂在 C1 上。
- ~~C3 与 C10 共用「用量可得性」前置验证，建议合并做一次 spike。~~ 该前置已达（C3a 已把窗口与占用透出），C10 只剩压缩动作本身。
- **新发现的缺口（2026-09-23 真机）已立为 C19**：**bash 的越界动作今天完全没有护栏。** 起因是 C17 真机那次 —— agent 为了「看一眼」一张图，在 WSL 里下了 `get-pip.py`、装了 pip/Pillow/numpy/opencv/onnxruntime/rapidocr、还试了 `sudo`，**一次审批都没弹**。这不是漏判：`_askNeedsApproval` 里 bash 只按 `matchesAnyPattern` 判，十条默认正则全是**破坏性命令**的模式（`pip install`/`curl`/`sudo` 一个不匹配），而 C4 的「工作区外」那条规则只覆盖 `write`/`edit`。C4 的已知局限里写着「bash 命令写进那个目录不在内」，但当时想的是「写进某目录」，**真机露出来的是「在区外装东西、下东西、提权」** —— 同一句话的更大一半。详见 **C19**。C17 只把说明文字收紧了（不再邀请 agent 去用工具），**护栏本身没动。**

- **C20 与 C17b 是同一件事的两半（2026-09-23）**：C17b 把 chip 那句换成「两个世界都为真」的说法，代价是**那句话不再能跟着世界变**；C20 补上那个「世界」的判定（`read_image` 在不在 tool 表里），让三处再一起动。**顺序不能倒**：先有事实，才允许有一句随事实变的话 —— 反过来就是 C17 那条 chip 的老毛病（把配置的事实说成模型的能力）。C20 也顺带更正了 C17「重新开张」那三条的一个读法：**② 单独成立就够了**，不必等 ③（见 C17 正文那一行）。

- ~~C11、C14 受 DSH wire 能力限制，属"要等上游"~~ **C11 更正（2026-09-18）**：wire 下不去 ≠ 做不到 —— `cordis.yml` 里挂一个我们自己的插件就能在请求构建期覆盖（见 C11 正文的四条源码坐标）。**别再把「wire 没这个方法」直接读成「这件事做不了」**，先看看 `agent/*` 的瀑布与插件加载器。**C14 也一并更正（2026-09-21）**：这句话说 C14「仍是真受限」是错的 —— wire 里确实没有 file 事件，但 `tool/result.meta.diffs` 一直带着真 hunk（扩展此前没读），而「事前」那半靠 `tool/call` 的入参就够（帧先于 dispatch）。**两次更正说的是同一件事：先去看它到底给了什么，再判「拿不到」。**
