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

> ⚠️ **补记（2026-09-18，C11）**：上面这段只说对了"**wire** 下发不了"，**别读成"做不到"**。
> provider 本来就按请求解析档位（`dsh-llm-deepseek` 的 `resolveThinking(options, defaults)`），
> 而 `dsh-agent-loop` 每步都跑 `dispatch.waterfall("agent/request", …)` 且**它的返回值就是这次
> 请求的 config** ⇒ 在派生 `cordis.yml` 里挂一个我们自己的插件就能按会话覆盖，**热生效、不重启**。
> 详见 [backlog.md](backlog.md) 的 C11（含四条源码坐标与两条实测证据）。**wire 依然是死的，这条路不是。**

## 对扩展功能设计的含义

- **2.1 diff 审阅 + Keep/Revert**：扩展侧做（live 轮开始 git 快照 → 收尾 diff）。
  没有「官方 file 事件」可等。
- **审批（2.x）**：扩展侧自造（破坏性工具命令预审 / 确认条）。运行时当前不给任何
  wire 级审批入口；除非先在 DSH 配置层启用审批策略再另行评估。
- **3.1 Shield 的 reasoningEffort 菜单**：~~不是高优先 —— 这条 wire 下发不了，
  改配置重启才有意义。~~ **已实现（C11，2026-09-18）**：wire 仍下发不了，但改走
  「派生配置里挂我们自己的插件，按会话覆盖 `agent/request` 的返回值」⇒ 会话级菜单 +
  热生效（不重启）。见上面第 4 条的补记。
- **工具白名单 / 工具开关（C12）**：**wire 里根本没有这一轴**，连"工具"这个概念都不出现
  （方法全量清单里一个都没有）。而且这次拦路的不是 wire，是**配置面**：运行时的工具集
  不是一份配置清单（每个工具都是一个 `ctx.tools.register(…)` 的插件），`dsh-tools` 的
  `ToolRuntime.Config` 只有 `{mode, maxParallelSubCalls}` —— **allow / deny / enabled 一个键都没有**。
  ⇒ **能走通的还是同一句话：运行期有 API。** `ToolRuntime.restrict({allow, deny})`
  要求 **agent 作用域的 ctx**（拒绝上下文全局的限制），所以要在 `agent/created` 里对
  `agent.ctx` 调一次。**这是 C11 那条更正的第二次应验，而且比上次更远一层：**
  上次是"wire 少了东西、插件口还在"，这次是"**连配置面都没有这个东西**，插件口依然在"。
  ⇒ 判据升级：**先看配置面缺不缺，再看 wire 缺不缺，最后都回到 `agent/*` 的瀑布与插件加载器。**
  副产品：被禁的工具**真的从模型视野里消失**，而这件事有盘上证据 ——
  `request/header` 的 `header.tools` 来自加了限制之后的视图（见下面那条）。

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

**`request/header` 的 `reason` 有三个取值（2026-09-18，C11 的 F5 实测补）**：`initial`（进程/会话的第一次请求）、
`resume`（重连后接着跑）、**`change`（同一条连接内 config 变了 —— 就是"热切"的痕迹）**。
前两个是 C10b 就用来判「有没有重连」的；`change` 此前**从没被记下来过**，而它恰恰是判「改档位要不要重启」最直接的那个字。
实测：同一会话第一轮 `reason=initial / reasoningEffort=max`（底本默认），13 秒后第二轮 `reason=change / reasoningEffort=low`
—— **没重启就变了档**。（出处见 [backlog.md](backlog.md) 的 C11 ③。）

**`request/header` 的 `header` 里还带 `tools`（2026-09-18，C12 补）**：就是这次请求**实际发给模型的工具表**
（一串 `{name, description, parameters}`），`dsh-agent-loop` 的 `canonicalHeader` 写的是 `...tools.length > 0 ? { tools } : {}`，
到真正出网那次调用时又原样传下去（`tools: header.tools`）。它来自 `dsh-tools` 的 `wireSchemas(scope)`，
而后者读的是 `this.view(scope).visible` —— **加了限制之后的视图**。
⇒ 「某个工具到底在不在模型视野里」**不必问模型、也不必真发一次请求**：请求一构建，答案就落盘了。
C12 的工具白名单判据就是它（正反双控：带 profile 那轮没有 `bash`、不带 profile 那轮必须在）。
⚠️ 元素形态是**对象**（`.name`）不是字符串 —— 断言前先归一化，认不出来要**响亮报错**，
否则"没有 bash"会因为把表读成了空数组而假绿。

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

### 补记（2026-09-19，C13 实测，上面那句仍然全对）

「没有换 shell 的配置项」到今天仍然成立 —— 但**它不等于做不到**：

1. **PATH 是活的**。从 `_dshEnv()` 一路到那一次 spawn，**没有一处覆盖 PATH**：
   `dsh-subprocess` 的 `childEnv` / `scrubbedParentEnv` 只擦敏感键与 `DSH_*`，
   `dsh-bash-local` 的 `ENV_OVERRIDES` 不含 PATH。⇒ **扩展侧在子进程 PATH 前面插一个目录，
   就能换掉 agent 的 bash**（C13 的 `hello.dsh.bashPath` 就是这么干的，DSH 一行不改）。
2. **谁赢由 libuv 决定，不是 `PATHEXT`**：`spawn('bash', …, {env})` 按**传入 env 的 PATH** 搜索
   （不是调用进程的），且 libuv **完全不看 `PATHEXT`**（硬编码 `.exe`）。
   ⚠️ 所以**不许照抄** `dsh-subprocess-local` 的 `executableCandidates` —— 那个认 PATHEXT，
   抄来会算出**错的赢家**。
3. **`PATH=''` ⇒ ENOENT 且不回退 cwd**；空项跳过；相对项按**子进程 cwd** 解析；
   `Path`/`PATH` 并存时大写 `PATH` 胜；**完全没有 PATH 键时回退宿主真实环境**
   ⇒ 想改 PATH 就必须**删了再补**，不能只删。
4. **shim 起不来时的话是 UTF-16LE 打在 stdout 上**（stderr 空、退出码 4294967295），
   解出来是「不存在具有所提供名称的分发。错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND」
   —— 上面那句「一路报错」的真身就是这个：按 utf8 读是**乱码**，所以看着像一串 bash 报错。
   认它要按**奇位 NUL 占比 ≥ 0.4** 判 UTF-16LE（实测夹具 0.690），再认 `WSL_E_[A-Z_]+`
   这个语言无关令牌。判定与文案在 `src/shellDiag.ts`，判据在 `scripts/probe-shell-diag.mjs`。
5. **路径语义另有一坑**（同次实测）：DSH 的 fs 工具把 `/mnt/d/x` 当 **Windows 相对路径**解析，
   落到 `<cwd 所在盘>\mnt\d\x`。C13 只**显示**两种读法（批准条上的说明），
   **不做归一化** —— 改它等于改 agent 的文件落点。

## 相关

- 抓帧：`node scripts/capture-dsh-frames.mjs`（`DSH_CAP_NODE/ENTRY/CONFIG/RUNCWD/TSCONFIG/
  TOOLCWD/CRED/PROMPT/INIT_EXTRA`；key 走 `DSH_CAP_CRED` 的 YAML 或 `DEEPSEEK_API_KEY` env）
- 对拍：`node scripts/frame-vocab.mjs <帧目录> --baseline <基线帧>`
- DSH 检出对拍源：`core/session/src/known-event-types.ts`、`sdk/server/src/server.ts`、
  `shell/bash-local/src/index.ts`
- 运行时依赖治理见 `docs/runtime-dependency.md`
