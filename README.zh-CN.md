# AlohaDSH —— VS Code 侧栏的 DeepSeek-Harness（DSH）聊天面板

<img src="media/logo.png" alt="AlohaDSH" width="128">

[English](README.md) · **简体中文**

一个 VS Code 侧栏聊天扩展。主推模式 **Harness** 通过 JSON-RPC 连接你本地的
[DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）运行时 ——
真实工具调用、真实转写；当 `media/dsh-live` 产物齐全时，用 DSH 自带的 React 对话组件渲染。

| 模式 | 说明 |
|---|---|
| **Harness**（默认） | 恒为 **DSH 直播**：扩展以子进程拉起本地 DSH `jsonrpc-agent` 端到端驱动。模型与消息经 JSON-RPC 下发，工具调用 / 增量 / 转写回流。未配置时底部配置条常驻、引导点内建 **配置 DSH** 向导（路径配好前禁发）。 |
| **内嵌聊天** | 自带流式界面、回复是内置假文本的沙盒 —— **未完成**，仅用于打磨流式/渲染管线。见下文[内嵌聊天](#内嵌聊天-embedded-chat)。 |

> 仓库不带任何机器路径：`hello.dsh.*` 一律从你的用户设置读取（`scope: machine`），绝不进仓库。

---

## 快速上手（你已有 DSH 检出）

1. 在 VS Code 打开本文件夹 → `npm install` → 按 **F5**（运行和调试 → Run Extension）。
2. 扩展开发窗口 Activity Bar 点 **AlohaDSH**。面板默认落在 **Harness** 页签。
3. 已配置：顶部状态点变绿 **在线 · \<模型\>**，直接输入即可。未配置：消息区显示引导、发送按钮
   灰 —— 点底部 **配置 DSH** 走向导（先选「便携运行时目录」或「手工 node + 入口」，见第 4 节）。
4. 需要 API Key：点底部 **API** 按钮 → 存入 VS Code SecretStorage（不回写任何文件）；
   或把 `hello.dsh.credentialsFile` 指向含 `DEEPSEEK_API_KEY:` 的 YAML 作回退。

---

## 完整路径：从零到跑通 Harness

### 0. 前置

- **VS Code**（任意较新版本）。
- **Node.js** 满足 DSH 的 `engines`：`^22.19.0 || >=24.0.0`（用 24.x LTS 即可；见下例的独立 Node）。
  只在**构建**时需要 —— [便携运行时](#便携运行时推荐)自带 node，PATH 上没有也行。
- **pnpm** ≥ 11 —— DSH 声明 `packageManager: pnpm@11.7.0`。（本扩展自身是普通 npm。）

### 1. 准备 Node.js（独立 Node 示例）

DSH 是较大的 ESM 工作区，建议在检出旁放一个专用 Node。例如把 Node 24 解压到 `D:\DSH\tools\`，得到：

```
D:\DSH\tools\node-v24.19.0-win-x64\node.exe
```

下面 `hello.dsh.nodePath` 示例指的就是它。

### 2. 克隆并构建 DeepSeek Harness

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

可选验收 —— 启动 DSH 自带 Web UI，打开 http://127.0.0.1:3080：

```bash
pnpm dsh web
```

若此步报错，以该检出内上游 `README.md` 为准；扩展要求一个**已构建可跑**的 DSH 工作区。

### 3. 认识扩展要拉起的运行时

扩展以子进程运行：

```
<node.exe> --import tsx/esm <入口脚本> <部署配置>
```

- **入口脚本** —— `packages/examples/jsonrpc-demo/src/bin.ts`（jsonrpc-demo 示例；其 runner 取
  `DSH_CORDIS_CONFIG` env、否则 `argv[2]` 作为配置路径）。
- **部署配置** —— `examples/jsonrpc-agent/cordis.yml`：编排 `sdk-jsonrpc-server`、
  `llm-deepseek`（`thinking: enabled`）、`dsh-bash-local`、`agent-spine` 与 JSONL 会话持久化；
  其 stdout 保留给 JSON-RPC。
- **模型** —— 不钉在配置里，**每个会话经 JSON-RPC 下发**（`hello.dsh.model`，默认 `deepseek-v4-flash`）。
- **API Key** —— `llm-deepseek` 插件每次请求读 `DEEPSEEK_API_KEY`（其默认 env 名）。示例还用到
  其它可选 env：`DEEPSEEK_BASE_URL`、`DSH_CWD`、`DSH_MODEL`、`DSH_SYSTEM_PROMPT`、
  `DSH_MAX_TOKENS_AS_SUCCESS`…（见 `examples/jsonrpc-agent/README.md`）。

### 4. 配置扩展（优先用向导）

推荐路径**无需手写任何设置**：打开面板、确认在 **Harness** 页签，点底部 **配置 DSH**（与
palette 命令 `AlohaDSH: 配置 DSH 运行路径` 同一条路）。**第一个岔路口是「字节从哪来」**：

- **便携运行时目录（推荐）** —— 见下方[便携运行时](#便携运行时推荐)。选目录即可：node、入口、
  配置全从它里面的 `runtime.json` 解析。不需要 tsx，不需要 DSH 检出。
- **手工 node + 入口（开发者路径）** —— 选你的 `node.exe`，再选
  `…\deepseek-harness\packages\examples\jsonrpc-demo\src\bin.ts`；向导按入口自动推导
  `runCwd`（它定位到的 DSH 仓库根）、`tsconfig.json` 与 `examples/jsonrpc-agent/cordis.yml`。

两条路都以 **保存并重启 live** 收尾 —— 把值写进你的**用户**设置（`hello.dsh.*`，
`scope: machine`，绝不提交）并重启 live 子进程。

#### 便携运行时（推荐）

*便携运行时*是一个自包含目录：包内自带 `node`、预构建的 JSON-RPC 入口、一份默认 `cordis.yml`，
以及描述它们的 `runtime.json` 清单。把 `hello.dsh.runtimeDir` 指向它，其余什么都不用配 ——
**不需要 tsx、不需要 DSH 检出、PATH 上没有 node 也行**。

Windows 今天没有可下载的 DSH 制品（`python/sdk-runtime/platforms.json` 只列 linux/macos，
单文件 exe 构建脚本原文写着 *"Windows is a documented non-goal"*），所以要从一份 DSH 检出构建一次：

```bash
# --dsh <DSH 检出根>；--out 默认 dist-runtime/（已 gitignore）
node scripts/build-runtime.mjs --dsh D:\DSH\deepseek-harness \
     --node D:\DSH\tools\node-v24.19.0-win-x64\node.exe
```

脚本会跑 DSH 自有的 SDK-runtime `pnpm deploy`、修复闭包（补 legacy hoist、把符号链接统统实体化 ——
闭包必须可搬迁）、拷入便携 node 与 [`runtime/cordis.default.yml`](runtime/cordis.default.yml)、
写出 `runtime.json`，最后跑一遍裸冒烟。之后任何时候都能脱离 VS Code 验证一个运行时目录：

```bash
node scripts/smoke-runtime.mjs --runtime dist-runtime   # 发一条 initialize，不需要 API key
```

包内那份 `cordis.yml` 是**我们的**，不是上游精简的 `runtime/cordis.yml` —— 后者没有 `dsh-tool-fs`，
直接用会让 agent **丢掉 `read`/`write`/`edit` 文件工具**。

> ⚠️ **已知风险**：上游把 `packaged-bin.js` 这个 node 载体定位为 dev-only、不进发行物。所以这条
> 路线**没有上游背书**，靠的是我们自己的构建 + 冒烟兜底。将来换供给方（上游 Windows 制品 / 内网包）
> 只需改「目录从哪来」。

随后设一次 API Key：点底部 **API** 存入 VS Code SecretStorage。Key 只进子进程 env ——
永不进设置 / 日志 / 转写。（备选：在 VS Code 的启动环境里 `export DEEPSEEK_API_KEY`，或把
`hello.dsh.credentialsFile` 指向含该 key 的 YAML 作回退。）

### 5. 验证并开聊

Harness 页签顶部状态点依次显示连接：灰 未连接 → 蓝 连接中 → 绿 **在线 · deepseek-v4-flash**。
发一句话 —— 首次发送（或已配置时打开面板）即拉起运行时，应能看到真实工具调用卡与流式转写。

---

## 设置速查

键都在 `hello.dsh` 下，`scope: machine`（读用户设置，不进仓库）。

| 键 | 默认 | 作用 |
|---|---|---|
| `hello.dsh.runtimeDir` | `""` | **便携运行时（推荐）**：含 `runtime.json` 的目录。**优先于** `nodePath`/`loader`/`entry`/`config`/`runCwd`；目录不可用会明确报错，不会静默回退。**会话记忆跨重启只在指向本仓库 `build-runtime.mjs` 产出的运行时下生效**（那份带 resume 补丁）；开发者路径/`command` 走用户自己的 DSH，没有补丁，续聊会开新会话并插一行说明。 |
| `hello.dsh.nodePath` | `""` | *开发者路径*。启动运行时用的 `node.exe`（须满足 DSH `engines`）。设了 `runtimeDir` 时不生效。 |
| `hello.dsh.loader` | `""` | 传给 `node --import` 的加载器标识。**留空 ⇒ 按入口扩展名自动判断**：`.ts`/`.tsx`/`.mts` ⇒ `tsx/esm`，其余（预构建的 `.js`）⇒ 不加任何加载器。 |
| `hello.dsh.entry` | `""` | *开发者路径*。jsonrpc-agent 入口脚本。设了 `runtimeDir` 时不生效。 |
| `hello.dsh.config` | `""` | 运行时部署配置（`cordis.yml`）路径。 |
| `hello.dsh.runCwd` | `""` | 子进程工作目录，保证 `tsx` / `@deepseek-ai/*` 能解析；留空回退打开的工作区根。 |
| `hello.dsh.tsconfig` | `""` | 给 tsx 设 `TSX_TSCONFIG_PATH`。 |
| `hello.dsh.credentialsFile` | `""` | 未在 SecretStorage 配 key 时的回退 YAML（含 `DEEPSEEK_API_KEY:`）。 |
| `hello.dsh.provider` | `"deepseek-official"` | `initialize` 时上报的 provider 路由名。 |
| `hello.dsh.model` | `"deepseek-v4-flash"` | 默认模型，按会话下发；在线状态里展示。 |
| `hello.dsh.command` | `""` | 非空时**整段覆盖启动命令**（忽略 nodePath/loader/entry/config）。 |
| `hello.dsh.args` | `[]` | `command` 非空时配合的参数列表。 |
| `hello.dsh.bashPath` | `""` | **仅 Windows，通常留空。** 某个 `bash.exe`（或任意 bash）的绝对路径：它的**所在目录会被前置到运行时子进程的 `PATH`**，于是 agent 的 `bash` 工具命中**这一把**，而不是机器 PATH 上第一个。留空 ⇒ 子进程环境**逐字节原样透传**。指到一个不存在的文件会**如实报出**（绝不静默忽略），并可在告警里一键清除。详见 [README.md](README.md) 的 *Windows: which bash the agent gets*。 |
| `hello.dsh.debug` | `false` | 把子进程 stderr / 被忽略的 JSON-RPC 通知打到输出面板（不含密钥）。 |

一份可用的 `settings.json` 示例（**别提交**）—— 便携运行时：

```jsonc
{
  "hello.dsh.runtimeDir": "D:\\hello-vscode-ext\\dist-runtime"
}
```

……或开发者路径：

```jsonc
{
  "hello.dsh.nodePath": "D:\\DSH\\tools\\node-v24.19.0-win-x64\\node.exe",
  "hello.dsh.entry":    "D:\\DSH\\deepseek-harness\\packages\\examples\\jsonrpc-demo\\src\\bin.ts",
  "hello.dsh.config":   "D:\\DSH\\deepseek-harness\\examples\\jsonrpc-agent\\cordis.yml",
  "hello.dsh.runCwd":   "D:\\DSH\\deepseek-harness",
  "hello.dsh.tsconfig": "D:\\DSH\\deepseek-harness\\tsconfig.json"
}
```

面板开着时改动任一路径 / 模型 / key，live 子进程会自动重启（状态点跟随）。历史存在扩展
globalStorage；Harness 会话与内嵌聊天分开存放。

### 会话历史

**历史**面板列出当前模式的历史会话，现在不只按标题匹配：

- **全文检索**：范围是消息正文 + 每张工具卡的**命令名与入参**（所以能按「我跑过什么命令」找会话，
  例如 `rm test.py`）。工具的**输出**与那些灰色状态说明（note）**有意不搜** —— 对找会话来说是噪音。
  命中会带一段上下文片段，命中词高亮。
- **导出**单条会话（每行 ⬇，回收站里也能导）：**Markdown**（给人看的转写；工具入参/输出截到 4000 字符）
  或 **JSON**（无损 —— 含附件正文、用量、DSH 会话身份）。
- **删除改成了软删除**（✕ 移进**回收站**标签页，可恢复）。真要删干净得点**彻底删除**或**清空回收站**，
  两者都有原生模态确认 —— 恢复会把该会话顶回列表最前。
- **删除即彻底**：上面的「彻底删除 / 清空回收站」现在会**连磁盘上的 DSH 会话日志一起删掉**
  （`<globalStorage>/dsh-sessions/…`）—— 以前那里什么都不删，删掉的对话其实还完整躺在盘上。
  分支与源**共享**同一份日志，所以还留着引用时日志会保留（确认框里会如实说明是哪一种）。
- **回收站留存清理**（可选，默认关）：把 `hello.chat.retention.days` 设成天数后，回收站页多出一个
  「清理 N 个过期会话」按钮。判据是**删除时间**，而且**只清回收站** —— 从没被删过的会话哪怕很久没动
  也不入选（确认框会告诉你有多少条属于这种情况）。**没有任何自动清理**，不点就一直留着。

检索范围与回收站都是 per-mode 的，跟列表本身一致。**多窗口注意**：会话存储按 profile 共享，
每个窗口各持一份内存列表，A 窗口删掉的条目可能被 B 窗口的下一次保存推回磁盘 —— 建议单窗口使用。

另一组键在 `hello.chat` 下，`scope: window`（随工作区）：护栏与审阅。

| 键 | 默认 | 作用 |
|---|---|---|
| `hello.chat.approval.enabled` | `true` | **事前审批**。命中策略的 bash 命令、以及越出工作区的 `write`/`edit`，在**执行前**弹确认条并暂停整轮。实现是一条 `PreToolUse` hook（派生配置落在扩展存储目录，**不改动你的 cordis.yml**）。**关掉它会连带关掉「工作区外改动」的可见性**（hook 是唯一的传感器）。改这个开关需重连才生效。 |
| `hello.chat.approval.patterns` | 见 package.json | bash 侧策略：命中任意一条（不区分大小写的正则）即弹条。默认是 `rm`/`rmdir`/`mkfs`/`dd of=`/`diskpart`/`format X:`/`git push --force`/`git reset --hard`/关机类/fork bomb。改动即时生效。 |
| `hello.chat.approval.outsideWorkspace` | `true` | **工作区外写确认**。关掉只是**不再问** —— 只要 `enabled` 还开着，区外改动仍会照旧出现在本轮审阅里。平台临时目录（`%TEMP%` / `/tmp`）两边都豁免。改动即时生效。 |
| `hello.chat.approval.timeoutSec` | `540` | 等确认的秒数；超时按**拒绝**处理。 |
| `hello.chat.reviewChanges` | `true` | 每轮结束后对比文件改动并显示审阅条（增/改/删 + 行级 diff + 保留/还原）。工作区**外**的改动也会一并列出（标出所在目录）。 |
| `hello.chat.retention.days` | `0` | 回收站留存天数。`0`（默认）= 关闭，按钮不出现。设了天数后回收站页多一个「清理 N 个过期会话」，把删除时间早于 N 天的条目**连 DSH 日志一起彻底删除**（不可撤销）。只清回收站，且**不会自动跑**。 |

**已知局限（不是 bug）**：护栏只看 `write`/`edit` 工具的目标路径，**不解析 bash 命令串里的路径**。所以 agent 用 `cp`/`mv`/`>` 写到工作区外时，既不弹确认条、**也不会出现在审阅里**。另外扩展不可达时 fs 侧一律放行（护栏降级，可见性同时停摆）。

**工具卡上的「预计 → 实际」**（C14）：`write` / `edit` 的卡片在**这条调用执行之前**就多一行
`≈ 预计改动 D:\proj\a.ts（修改 · +3 −1）`，点开是近似 diff —— `write` 拿入参里的 `content` 跟
**现在盘上**的内容比（不是跟轮前快照比），`edit` 只在替换片段上算、**不模拟 DSH 会挑中哪一处**
（那是猜）。事前就能说出口的失败会直接写在行上：现在盘上的内容里找不到这段 `old_string`、
命中多处而 `replace_all` 没开、新旧文本相同、盘上压根没这个文件。这条调用一跑完，那行就
**就地**翻成 `实际改动 …`，diff 换成运行时自己给的**真 hunk**（`tool/result.meta.diffs`，
`write`/`edit` 一直在发、扩展此前从没读过）；失败与中断时预测会被明确作废（改成「上面那行
只是预测，不是结果」/「改没改未知」），**绝不让一条预测永远挂在卡上**。

**它不是审批，也不覆盖 bash**：帧先于执行只领先**毫秒级**，可拦截的窗口仍然只有 C1 的 hook；
而 `bash` 的重定向 / `rm` / `tee` **一律不预判**（shell 语法，猜错比不说更坏），它们照旧只出现在
轮尾审阅里。所以**卡片上没有这行 ≠ 这一轮没动文件**。这行也**不落盘**（是直播提示）：重载窗口、
切换会话、回放历史会话都不会有它。

**分支与对照**（C15）：**在新对话中分支**会把转写拷进一条新会话并切过去（源会话仍在**历史**里，
标题带一个「（分支）」后缀，那就是默认配对的依据）。顶栏的**对照**钮打开一个**只读**浮层，把两条
会话并排摆出来：两侧**逐字相同的那一段被折起来**，你看到的是**分叉点之后**各自长成什么样，分叉点
在哪由上面那行写着。面板里不发消息、不并行跑 —— 它是打开时 / 换一侧时 / 点刷新时拍的一幅快照。

浮层存在的理由里，只有一条是别处看不到的：**分支与源共享同一份 DSH 记忆**。在任一边继续聊，模型
两边都看得见 —— 浮层会用**警示色**把那句话说出来。这个判据不是猜的：先看本次运行里的会话映射、
再看盘上记的身份（**只看盘会漏掉这条警告最该出现的那种情况**：补丁不可用时那条路从不写盘，两侧
盘上都没有身份，可它们确实是同一份记忆）。两条无关会话、或身份判不出来的会话，会如实说「分开的」
或「无从判断」，**不会染上警示色** —— 一条没事也亮的警告，很快就没人看了。两侧都能换，点某一栏
栏头的**选择会话**即可（列的是当前模式下的全部会话，已选的两条会置灰且点不动）。

---

## 运行可靠性：中断与续跑

停止是 wire 的硬约束而不是我们的选择：**没有 cancel RPC**，所以**停一轮 = 杀子进程**（下一轮再惰性
重启）。本仓能做的是让这件事**可见、可续、可解释**：

- **停止会留痕，而不是丢掉。** 被中断的一轮会把 `lastTurn` 落在会话上（随会话落盘），还挂着的工具卡
  落成 error，并插一行灰 note 说明：DSH 侧记忆保留，但被中断那次工具调用的**结果未知**（与运行时
  补平悬空 turn 时给模型的措辞一致）。随后 composer 上方出现**「继续」条** —— 点它会把上一条用户消息
  **逐字重发**到**同一个** DSH 会话，模型接着往下跑。重载窗口、甚至重启 VS Code 之后这条仍在
  （判据是从盘上读的）。
- **报错就是真停。** 界面报 error 的一轮现在会**杀掉子进程**。此前是界面说 error、进程却还在执行工具，
  而它的事件被静默丢弃 —— 你看不见那份工作，DSH 却记得。
- **长轮不再被误判为失败。** `session/prompt` 回的是**收执**、不是本轮结果，所以一个工具密集的长轮
  迟迟不给收执是正常的。收执超时已放宽到 10 分钟；而且万一真的超时、而会话**已知仍在运行**，
  界面会继续等下去，不再直接判 error。
- **停止更温和。** `kill()` 改成先关 stdin、2 秒后才强杀，给运行时留出它自己的干净退出路径
  （`disposeAndExit(0)` → flush → fsync）—— 写盘是 200 ms 攒批的，同一 tick 里做完这两件事等于把那批扔掉。
- **转写是原子写 + 留一代备份。** C7 的「彻底删除」会连会话的 DSH 日志一起删，于是 globalStorage
  下那份可能成了**唯一副本**。现在先写 tmp、fsync，再 rename 盖过去（不再可能出现半截文件）；覆盖
  **之前**把上一代滚成 `<file>.bak`；读不出来时回退到那份备份，而不是静默从零开始。真损坏会弹**一条**
  告警；首次运行（文件还没建）保持安静。

DSH 侧还在跑的时候想发新消息会被拦下并提示先停止（wire 没有 cancel，那一轮抢占不了）。
这些判断依据的 wire 方法全量清单见 `docs/wire-vocabulary.md`。

---

## 运行检查器：这一轮到底跑了什么

Harness 模式下输入框上方有一条**运行读数**：`本轮 4 工具 · 11.2s`。点「查看」开浮层，看到这一轮的
完整时间线 —— 每一步的耗时、每次工具调用的名字与耗时、哪次失败了、以及本轮的错误原文。
留着更早的轮次时，条上写的是「**最新一轮** …」，浮层里每行写「**第 N 轮** …」（同一轮的读数两处逐字一致）。

- **耗时不需要额外计时。** 每个事件信封本来就带 `time`（epoch ms），相减即得；所以工具耗时是精确的，
  没有采样误差。
- **工具按「步」分组，而每个步都占一行。** DSH 一步做一次模型调用（可能带一次工具），步耗时 =
  模型延迟 + 工具延迟，两者不冗余。一步没调工具也**单列成一行**（不折进脚注 —— 那会让步骤号跳号，
  而那往往正是最慢的一步）。
- **四种状态分得清。** 成功 / 失败 / 运行中，以及**「未知」**：被停止、进程被杀、或 DSH 自己补平中断轮时
  没收到结果的调用都算它（可能跑了，只是不知道结果 —— 谎报成失败会让人去排查一个不存在的问题，
  甚至重试一个已经生效过的命令）。
- **DSH 补平的中断轮不诬告我们。** 补平帧（`TOOL_NOT_STARTED` / 「outcome is unknown」）**正文说未知、
  帧上却带 `isError: true`**，所以判据是三态而不是布尔；它们也**配不上任何调用**，面板会照实说
  「Harness 代写的，不是故障」，与真正的配对键失效分开报。
- **只在内存里，留最近 20 轮。** 重载窗口即清空（这也是它不跨会话的原因），不落盘、不进转写、
  **不记正文**（工具入参/输出一概不留，避免成为绕过 `toolInput` 保险丝的另一条路）。819 条流式
  文本帧一条都不记 —— 需要的是时间线，不是第二份转写。

---


## 真 DSH 组件画面（react-live，可选）

当 harness 转写用 DSH 自带 React 组件渲染时，面板会加载 `media/dsh-live/` 的单文件产物
（`dsh-live.js` + `dsh-live.css` + KaTeX `assets/`）。该目录 **已 gitignore**、**不由本仓库构建**
——它产自 DSH 检出里的一个**本地未提交 spike**（`apps/web/dsh-webview/vite.config.mts`，经
`pnpm --filter @deepseek-ai/dsh-web-frontend run build:dsh-webview` 执行，`outDir` 指向本扩展的
`media/dsh-live`）。

- **产物齐全** → 侧栏整体走 DSH 主题令牌，harness 转写用真对话组件渲染。
- **产物缺失**（如刚 clone 完）→ 侧栏自动回落自带 DOM 转录渲染；一切照常可用，只是观感是纯
  VS Code 而非 DSH。

不装这个产物也能正常用 Harness。

---

## 内嵌聊天（Embedded chat）

一个未完成的小模式，当作流式 / 渲染管线的沙盒（打字机气泡、光标、停止、附件、按模式分存的
草稿与历史）。回复是**内置假文本** —— 不接真实模型、不调外部服务，属 WIP，别当真助手用。
Harness 才是完成态。

---

## 项目结构

| 路径 | 作用 |
|---|---|
| `src/chatViewProvider.ts` | 聊天 webview 宿主：拉起 DSH 运行时、握手、消息/工具流转发、模式与配置条逻辑 |
| `src/dshRuntime.ts` | DSH JSON-RPC 子进程生命周期（spawn/握手/心跳/事件分发） |
| `src/sessionStore.ts` | 会话标题、软删除/回收站、留存判据、续聊落盘（globalStorage）；原子写 + 留一代 `.bak`，加载结局（`source`/`reason`）能把「首次运行」与「真损坏」分开 |
| `src/turnState.ts` | 轮次状态判据：这条会话要不要显示「继续」、DSH 侧是否已知在跑（纯函数，不引 `vscode`） |
| `src/runInspector.ts` | 运行检查器：每轮的帧时间线（工具序列 / 轮·步·工具耗时 / 本轮错误）。**纯内存、只留最近 20 轮**，耗时全靠信封自带的 `time` 相减（纯函数，零 import） |
| `src/sessionSearch.ts` | 存下来的转写做全文检索（纯函数，不引 `vscode`） |
| `src/sessionExport.ts` | 转写 → Markdown / JSON，以及安全的默认文件名（纯函数，不引 `vscode`） |
| `src/branchCompare.ts` | C15 对照浮层的全部判据（纯函数，不引 `vscode` —— 同 C10b 的理由：判据得能在扩展宿主之外加载）。分叉点靠**消息 id** 找（id 里嵌着产生它的会话 uuid ⇒ **共同前缀就是分叉点**，跨代也成立），**绝不按正文相似度猜**；串话判据**双证据、顺序写死**（先看本次运行的映射、再看盘上身份 —— 只看盘会漏报「补丁不可用 / `hello.dsh.command` 覆盖」那两条绝不写盘的路）；`frozenTail` 深拷贝尾段并归一化，**绝不改原对象** |
| `src/dshPaths.ts` | DSH 会话日志的路径算法（**逐字复刻持久化插件**）+ 受控删除（纯函数，不引 `vscode`） |
| `src/extension.ts` | 插件入口：命令 + 视图注册 |
| `media/chat.{html,js,css}` | 侧栏前端（模式胶囊 + harness 状态点；DSH 令牌 + VS Code 双兜底） |
| `media/dsh-live/` | **gitignore** —— DSH 单文件前端产物（见上） |
| `scripts/capture-dsh-frames.mjs` | DSH 运行时抓帧工具（`DSH_CAP_*`） |
| `scripts/probe-session-tools.mjs` | 检索/导出/软删除自检，外加落盘加固（原子写、`.bak` 滚动、备份回退、`toolInput` 熔断）（先 `npm run compile`；不需要 VS Code、不需要 key） |
| `scripts/probe-purge.mjs` | 路径复刻对账/受控删除/留存边界自检（同上；**路径对账需 Node ≥ 22.15**，太老时会让你改用 `dist-runtime/node/node.exe`） |
| `scripts/probe-turn-state.mjs` | 「继续」判据 + 在线状态跟踪自检（同上；不需 VS Code、不需 key） |
| `scripts/probe-branch-compare.mjs` | C15 分支对照的判据自检，七组、全部用内存里造出来的会话（不建夹具、不碰盘、不连 DSH）：分叉点（真 fork 的拷贝 / 源分叉后还在长 / 无关会话 / 同一条 / 一侧为空 / **跨代**，每组先自证造出来的 id 逐字相等，否则这条测试什么都没测）；`drifted`（反控：id 不同但正文完全相同 ⇒ 根本不算共同前缀）；冻结的**只读正面证明**（原对象改前后 `JSON.stringify` 对拍 + 尾段是副本）+ `aAfter` 与实际下发的尾段同源；串话六态含 **live 优先的反控**与「同 id 不同 cwd 不该警示」；文案（三句 unknown 两两不同、无关会话不出警示色）；默认对侧的三级回退；结构守卫（`freezeTranscript` 在 provider 里恰好一处且 `_openSession` 必须委派、`_comparePane` 必须走 `frozenTail`、`compare-set` 只在 `_postCompare` 里构造、`sessionStore`/`ChatMessage`/`StoredSession` 里不许出现 `compare`、`side` 只有 `a\|b`、分支后缀字面量全仓唯一）（同上；不需 VS Code、不需 key） |
| `scripts/probe-approval-shell.mjs` | C1 审批 hook 的 shell 形态判据自检：至少一种形态跑得通、两种互斥、首猜猜错能被另一种救回来；外加形态先验与「不可判的失败」（超时/空手退出）必须重试且只重试一次这组纯函数判据（同上；不需 VS Code、不需 key） |
| `scripts/probe-run-inspector.mjs` | C9 运行检查器自检：帧过滤（灌 5000 条 `assistant/chunk` 记录必须逐字节不变）、调用/结果配对（含 DSH 补平帧的三态判据与守恒律）、终态优先级表、环与各项上限，以及把 `logs/dsh-frames/` 最新一份抓帧与一条独立推导的直算式 oracle 对拍（同上；不需 VS Code、不需 key） |
| `scripts/probe-c8-runtime.mjs` | C8 的运行时前提 spike：第二条 prompt 排队、杀后 resume 补平、优雅 vs 硬杀。**需 API key**、会花掉真实模型轮 |
| `scripts/update-dsh.mjs` | 运行时依赖治理：把 DSH 检出锁到 tag、查漂移、跑升级仪式 + 冒烟（见 `docs/runtime-dependency.md`） |
| `docs/runtime-dependency.md` | 治理决策依据：把 DSH 检出当「版本化运行时依赖」、升级仪式、「何时切官方 npm」观察清单 |

扩展注册的命令：`AlohaDSH: 开始新对话`、`AlohaDSH: 配置 DSH 运行路径`（另有玩具命令
`AlohaDSH: 打个招呼` / `AlohaDSH: 读取当前文件第一行`）。

## 开发与安全提示

- 构建 / 测试：`npm install` → `npm run compile` → 按 **F5**。
- 永不提交：`logs/`（真实会话帧）、`.claude/`（本地授权）、`media/dsh-live/`（上游产物派生）、
  `probe-*.html` / `probe-server.mjs`（本地探针）、`*.vsix`。
- 扩展只把 `DEEPSEEK_API_KEY` 注入子进程 env；它绝不能出现在日志、转写、设置或本仓库里。
