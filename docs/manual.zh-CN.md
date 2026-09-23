# AlohaDSH 手册

**AlohaDSH** 的完整正文。速览页是 [README.zh-CN.md](../README.zh-CN.md)（简体中文） · [README.md](../README.md)（English）。

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
闭包必须可搬迁）、拷入便携 node 与 [`runtime/cordis.default.yml`](../runtime/cordis.default.yml)、
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
| `hello.dsh.bashPath` | `""` | **仅 Windows，通常留空。** 某个 `bash.exe`（或任意 bash）的绝对路径：它的**所在目录会被前置到运行时子进程的 `PATH`**，于是 agent 的 `bash` 工具命中**这一把**，而不是机器 PATH 上第一个。留空 ⇒ 子进程环境**逐字节原样透传**。指到一个不存在的文件会**如实报出**（绝不静默忽略），并可在告警里一键清除。详见英文手册 [manual.md](manual.md#windows-which-bash-the-agent-gets) 的 *Windows: which bash the agent gets*。 |
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
  或 **JSON**（无损 —— 含附件正文/元数据、用量、DSH 会话身份；**图片附件只存路径与元数据，不存字节**，
  理由见 `src/imageAttach.ts` 的注释：整份附件是原样落盘的）。
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
| `hello.chat.approval.enabled` | `true` | **事前审批**。命中策略的 bash 命令、以及越出工作区的 `write`/`edit`，在**执行前**弹确认条并暂停整轮。实现是一条 `PreToolUse` hook（派生配置落在扩展存储目录，**不改动你的 cordis.yml**）。**关掉它会连带关掉「工作区外改动」的可见性**（hook 是唯一的传感器）。改这个开关需重连才生效。若不想整条正则地放开，可在拦停条上点**永久信任**（见下）：bash 条给「永久信任此命令」、`write`/`edit` 条给「永久信任此目录」，落进扩展存储的 `approval-trust.json`。**匹配是逐字精确的**（bash 的键是 `(命令原文, 当时的工作区)` 二元组，一个字符都不归一化），所以模型换个写法仍会再问一次 —— 这是有意的。撤销走命令面板的 `AlohaDSH: 查看/清除审批白名单（「永久信任」的命令与目录）`，或直接编辑/删掉那个 JSON 文件（**它是唯一真相**，删掉即退回「每次都问」）。 |
| `hello.chat.approval.patterns` | 见 package.json | bash 侧策略：命中任意一条（不区分大小写的正则）即弹条。默认是 `rm`/`rmdir`/`mkfs`/`dd of=`/`diskpart`/`format X:`/`git push --force`/`git reset --hard`/关机类/fork bomb。改动即时生效。 |
| `hello.chat.approval.outsideWorkspace` | `true` | **工作区外写确认**。关掉只是**不再问** —— 只要 `enabled` 还开着，区外改动仍会照旧出现在本轮审阅里。平台临时目录（`%TEMP%` / `/tmp`）两边都豁免。改动即时生效。 |
| `hello.chat.approval.timeoutSec` | `540` | 等确认的秒数；超时按**拒绝**处理。 |
| `hello.chat.reviewChanges` | `true` | 每轮结束后对比文件改动并显示审阅条（增/改/删 + 行级 diff + 保留/还原）。工作区**外**的改动也会一并列出（标出所在目录）。 |
| `hello.chat.retention.days` | `0` | 回收站留存天数。`0`（默认）= 关闭，按钮不出现。设了天数后回收站页多一个「清理 N 个过期会话」，把删除时间早于 N 天的条目**连 DSH 日志一起彻底删除**（不可撤销）。只清回收站，且**不会自动跑**。 |
| `hello.chat.compaction.thresholdRatio` | `0.8` | **DSH 的**上下文压缩阈值，按窗口占比算。越过这条线，DSH 会把一段较早的事件汇总成一个检查点 —— **有损且不可逆**。`retainRatio` 由它自动派生成 `0.2 ×` 这个值（DSH 的约束：插件加载时对不上就拒绝加载），所以**永远不要自己设**。默认 `0.8` 配 1M 窗口就是 800K token，也就是说**正常用法下它基本不会触发 —— 想真的看到压缩发生，就把它调低。** 改完要重连才生效（插件在加载时读配置）。 |

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
| `src/compactionNotice.ts` | 把 DSH 的 `compaction/summary` / `compaction/end` 载荷变成转写里的一条注记 —— 信息不全时**降级成「细节缺失」**而不是干脆不吭声、成功只报一次，且**绝不把摘要正文抄进转写**（纯函数，不引 `vscode`） |
| `src/contextWindow.ts` | 占用指示的两条判据：**分母从哪来**（先看本次运行的 `request/context`，没有就用**记在会话上的那个**）与是否越过警戒线。之所以从 `chatViewProvider` 里分出来，是因为一次真机 F5 漏掉了一个 bug 整整一轮 —— 这里的要害是**续聊时 `request/context` 一条都不会再发**（DSH 拿从日志折出来的 `previousContext` 比对），分母不记在会话上，整条指示就**安静地不存在**（纯函数，不引 `vscode`） |
| `src/agentProfile.ts` | C12 项目级 profile：读并校验 `.hello-chat/profile.json`（**从不抛错** —— 一个坏字段就是一条提示，其余照旧生效），再把 profile 与设置编译成**实际生效的那份策略**。**「只能收紧」这条性质只活在 `compileProfile` 一处**（纯函数，不引 `vscode`） |
| `src/toolPolicyPlugin.ts` | C12 的工具白名单：那个小 cordis 插件（生成到 globalStorage、挂进派生配置），在每个 `agent/created` 上调 `tools.restrict({deny})`。与 C11 的推理档位不同，它**没有状态文件** —— 策略在 agent 创建时读一次，所以只有重连才会变（纯函数，不引 `vscode`） |
| `src/shellDiag.ts` | C13 的 shell 诊断：运行时子进程**实际会拿到哪个 bash**（`resolveOnPath` 复刻 libuv 的真实搜索顺序 —— **不认 `PATHEXT`**）、那个 bash 能不能用（**三值**：可用 / 坏 / *不可判*，后者是超时或启动器空手而死，也就是冷启动的样子）、WSL 启动器那句报错的 **UTF-16LE 解码**、状态行那一段与警告文案，以及 `prependPathDir`（「钉住某个 bash」的那根杠杆 —— 空输入返回**同一个对象**，且**绝不**在丢掉 `PATH` 后不补回来）。`readPosixTarget` 只给显示用的 POSIX 路径两读法（纯函数，不引 `vscode`） |
| `src/changeForecast.ts` | C14 的事前预览：把一次 `tool/call` 的入参变成「这次调用要动哪个文件、动完大概长什么样」。`write` 拿进来的 `content` 与**此刻盘上的文件**对 diff（走 C4 自己的 `snapshotSingleFile`，二进制/超大/预算三道闸与审阅完全同源，不另开一个读文件的）；`edit` 只 diff 那段替换文本，并**拒绝模拟 DSH 会挑哪一处命中**（那是猜）。它还会把**已经能看出必然失败**的几种情况说出来（0 命中、`replace_all` 关着却 >1 命中、新旧文本相同、文件不在），且**先归一化行尾再数命中** —— 本仓库自己就是 CRLF/LF 混排，不归一化的话，一次本可成功的 edit 会被报成「找不到这段文字」。`resolveTargetPath` 是从 `chatViewProvider._fsTargetAbs` 搬出来的**那一处**（原处改成一行委派）：卡上的路径与审批条上的路径必须出自同一个函数，否则同一轮会读出两种说法。`actualForecast` 读 `tool/result.meta.diffs` —— 真 hunk 一直在那儿、扩展此前一个字没读 —— 其中 `{hunks: 0}`（新文件**或**内容没变，两者不可分）与「这条结果里压根没有 diffs」是分开的两件事（纯函数，不引 `vscode`） |
| `src/branchCompare.ts` | C15 对照浮层的全部判据（纯函数，不引 `vscode` —— 同 C10b 的理由：判据得能在扩展宿主之外加载）。分叉点靠**消息 id** 找（id 里嵌着产生它的会话 uuid ⇒ **共同前缀就是分叉点**，跨代也成立），**绝不按正文相似度猜**；串话判据**双证据、顺序写死**（先看本次运行的映射、再看盘上身份 —— 只看盘会漏报「补丁不可用 / `hello.dsh.command` 覆盖」那两条绝不写盘的路）；`frozenTail` 深拷贝尾段并归一化，**绝不改原对象** |
| `src/approvalTrust.ts` | C16 审批白名单的全部判据与读盘写盘（纯函数，不引 `vscode`）。bash 的键是 **`(命令原文, 当时的工作区)` 逐字二元组** —— 没有 trim、不折叠空白、不归大小写、不做前缀包含：逐字是唯一能一眼审计的规则，代价（多问一次）是安全的方向。`dir` 档只覆盖 `write`/`edit`，包含判定复用 `changeForecast.isInsideDir`（`path.relative`，**绝不用 `startsWith`** —— 那会让 `D:\proj2` 被 `D:\proj` 骗过）。**提不提供这个按钮是扩展说了算**（webview 只画它拿到的）：命令被 32KB 截断线切到的、盘根、以及包含或等于用户主目录的目录，一律不给（一条规则同时挡住 `C:\` 与 `C:\Users`）。条目**不带 `id` 字段**，撤销按 `identityOf` 现算，图的是文件能手读手改。坏文件**逐条丢弃**、退化成「每次都问」，**永远不会变成「全放行」**（缺 `command` 的条目必须丢 —— 那是「什么都没写却什么都匹配」的后门）。 |
| `src/imageAttach.ts` | C17 图片附件的**诚实降级**那一半：认得出图片、给它一个 agent 用命令真够得着的落点、并且**明说模型看不见它**（纯函数，不引 `vscode` —— 同 C10b 的理由）。**它不把图片发给模型，也做不到**：`session/prompt` 里确实有 `{type:'image'}` 块，但那带的是**已落盘的引用**，而提交字节那条路（`EncodedImageAttachment` → `admitEncodedImages`）只被 ACP 适配器与命令执行器消费，我们这条 jsonrpc 服务端的 `prompt()` 从不调它；便携运行时没挂附件仓库 ⇒ `ctx.attachments` 是 undefined、`read_image` 根本没注册；默认模型也没声明 `inputModalities`。判据是**魔数优先于扩展名**（`.png` 里可能是文本、`shot.txt` 里可能是张真 PNG），且**认不出来 = 不是图片**、绝不回退到「那就按文本读吧」—— 那个回退正是今天最阴的缺陷（小图标被按 `'utf8'` 读成乱码喂进提示词）。准入集合是**上游那四种**（`png`/`jpeg`/`webp`/`gif`），**刻意不复用** `fileSnapshot.BIN_EXT`（那回答的是另一个问题，集合里含 ico/bmp/pdf/zip）；扩展名只用来给落盘文件取名、以及决定拒绝时的说法。`imageBytesAllowed` 单独成函数，「至多 N」—— 也就「恰好 N 要放行」—— 因此在扩展宿主之外被钉住：一个 `>` 写成 `>=`，现场表现只有「某些截图莫名其妙被拒」，那是**没有现场**的失败。`safeImageFileName` 把输入当敌意：剥目录、去控制字符、去尾点尾空格、80 字符上限、Windows 保留名加前缀、扩展名取自嗅探结果（不采信原名）、重名 `-2`。落盘只落 `<工作区>/.hello-chat/images/`（**在工作区里，因为「agent 能用命令碰到它」是这次降级唯一的价值**），`MAX_IMAGES_PER_MESSAGE` 是往用户工作区写多少的安全阀、不是模型要求。说明文字里**绝不出现 `@"`**（DSH 的 `@` 只管会话引用，只会把 agent 引向文本工具），且**三句**必须都在：「你看不到画面」+「**不要试图用工具把它「看」出来**」+「不要凭文件名猜」—— 见过大量图文对话的模型，否则会对一个 `.png` 路径描述得头头是道。**中间那句是 2026-09-23 真机加上的**：原话里「请用命令或工具处理这个文件（复制、**转换**、查看元数据、交给用户）」读起来是一份行动许可，于是只被问了一句「这是什么东西」，agent 就在 WSL 里下了 `get-pip.py`、装了 pip/Pillow/numpy/opencv/onnxruntime/rapidocr 一整套 OCR 栈、还试了 `sudo`，**全程一次审批都没弹**（bash 只按破坏性命令的正则判，`pip install` 不匹配）。「让它变得可读」是一条走不通的路，现在明说了。**反过来那一句也留着**：用户点名要动这个文件时照旧可以用命令 —— 收得太紧会把「把这个文件挪到 X」也拒掉，那是另一个方向的错。同一次真机还带出路径那一行：agent 拿我们给的 `D:\…` 去 `ls` 是「找不到文件」，直到 `pwd` 打出 `/mnt/d/…` 才纠回来 ⇒ 现在**给两读法**（`（bash 在 WSL 里时读作 /mnt/d/…）`），换算**委派**给 `dshHooks.toWslPath`（本模块里一个 `/mnt/` 字面量都没有，有结构守卫钉着）；**只在两读法真不同时才写** —— POSIX 路径上凭空多一行 `/mnt/…` 只是噪音 |
| `src/dshPaths.ts` | DSH 会话日志的路径算法（**逐字复刻持久化插件**）+ 受控删除（纯函数，不引 `vscode`） |
| `src/extension.ts` | 插件入口：命令 + 视图注册 |
| `media/chat.{html,js,css}` | 侧栏前端（模式胶囊 + harness 状态点；DSH 令牌 + VS Code 双兜底） |
| `media/dsh-live/` | **gitignore** —— DSH 单文件前端产物（见上） |
| `scripts/capture-dsh-frames.mjs` | DSH 运行时抓帧工具（`DSH_CAP_*`） |
| `scripts/dsh-session-log.mjs` | 探针共用的助手：定位 harness 会话仓库 / 它下面的 DSH 会话日志，并解一个 `session.jsonl.zstd`（**按魔数切帧 + span 重试** —— 单个 `zstdDecompressSync` 只能拿到第一帧）。每个探针各抄一份迟早会漂，而漂掉的那份就是有一天会**安静地说「通过」**的那份 |
| `scripts/probe-session-tools.mjs` | 检索/导出/软删除自检，外加落盘加固（原子写、`.bak` 滚动、备份回退、`toolInput` 熔断）（先 `npm run compile`；不需要 VS Code、不需要 key） |
| `scripts/probe-purge.mjs` | 路径复刻对账/受控删除/留存边界自检（同上；**路径对账需 Node ≥ 22.15**，太老时会让你改用 `dist-runtime/node/node.exe`） |
| `scripts/probe-turn-state.mjs` | 「继续」判据 + 在线状态跟踪自检（同上；不需 VS Code、不需 key） |
| `scripts/probe-branch-compare.mjs` | C15 分支对照的判据自检，七组、全部用内存里造出来的会话（不建夹具、不碰盘、不连 DSH）：分叉点（真 fork 的拷贝 / 源分叉后还在长 / 无关会话 / 同一条 / 一侧为空 / **跨代**，每组先自证造出来的 id 逐字相等，否则这条测试什么都没测）；`drifted`（反控：id 不同但正文完全相同 ⇒ 根本不算共同前缀）；冻结的**只读正面证明**（原对象改前后 `JSON.stringify` 对拍 + 尾段是副本）+ `aAfter` 与实际下发的尾段同源；串话六态含 **live 优先的反控**与「同 id 不同 cwd 不该警示」；文案（三句 unknown 两两不同、无关会话不出警示色）；默认对侧的三级回退；结构守卫（`freezeTranscript` 在 provider 里恰好一处且 `_openSession` 必须委派、`_comparePane` 必须走 `frozenTail`、`compare-set` 只在 `_postCompare` 里构造、`sessionStore`/`ChatMessage`/`StoredSession` 里不许出现 `compare`、`side` 只有 `a\|b`、分支后缀字面量全仓唯一）（同上；不需 VS Code、不需 key） |
| `scripts/probe-approval-shell.mjs` | C1 审批 hook 的 shell 形态判据自检：至少一种形态跑得通、两种互斥、首猜猜错能被另一种救回来；外加形态先验与「不可判的失败」（超时/空手退出）必须重试且只重试一次这组纯函数判据（同上；不需 VS Code、不需 key） |
| `scripts/probe-approval-roundtrip.mjs` | C1/C4 **决策回路**自检 —— 真 `ApprovalServer` + 真生成的 hook 脚本 + 真 HTTP + 真子进程，全在扩展宿主之外：允许就一个字不打印、拒绝落在 `permissionDecision` 上带我们的理由、条只在策略要问时才出现、同一个 id 第二次回话被拒、超时与 `cancelAll` 都收在拒绝、两个兜底旋钮分别钉住（bash 在服务端够不着时回退内置危险清单，`write`/`edit` 回退**允许**）、错令牌/无令牌被拒。它**从不执行任何东西** —— hook 只负责问。第一次跑就抓到一条真的：服务端的固定理由对写文件也说「该命令」，于是 hook 带的那句按工具区分的说法在可达路径上是死的。C16 那半（现在 24/24）把白名单压在**真文件 + 真 hook 子进程**上：用 `addTrust`/`writeTrustFile` 种一条，再跑同一条命令，断言进程一个字不打印、退出 0、**只问一次**，而服务端 `observed` 里仍是**两条** —— 这就是「白名单静音的那个写动作是**放行**而不是**隐身**」的机器证据（它照样进 C4 的轮前快照）。反控才是重点：表非空不等于全放行、同一条命令换个 `cwd` 照问（cwd 真是键的一半）、多一个空格照问。四组结构钉住接线：`_askNeedsApproval` 的第一句就是白名单检查、判据只此一处（`matchTrust`/`offerTrust`/`isInsideDir`，没有自己再写一份 `includes`/`startsWith`）、每条失败路径都返回 `false` 且 `_isTrusted` 里没有一处 `return true`，以及 `_createTrust`（函数体里从不出现 `allow`）在回话**之前**调用 —— 记性永远变不成一种允许。这半还抓到生成 hook 里一个真 bug：bash 分支从来没转发 `cwd`（只有 `write`/`edit` 转了），于是每一条 bash 白名单都会挂在**空工作区**上 —— 同一条 `rm` 会在从未授权过的工作区里被安静放行，而范围行还会写着「本次没有工作区」（同上；不需 VS Code、不需 key） |
| `scripts/probe-approval-trust.mjs` | C16 白名单自检，七组、全部在内存里跑：**逐字匹配**及其一串反控（只差空白/只差大小写/只差末尾一个字符/只是前缀包含，一律**不**算命中）与「同一条命令换个 `cwd`」；`dir` 档含兄弟目录陷阱（`D:\out2` 不被 `D:\out` 覆盖）与 Windows 大小写折叠；**拦停条能给什么**（截断命令不给、盘根与主目录不给、`read` 不给 —— 每条都配一条「合法情形照样给」的反控）；`addTrust`（同键幂等去重、满 200 条**拒绝**而不是淘汰最旧、webview 伪造的 `kind` 拒收、写→读往返形状不变）；**坏文件退化**（文件不存在不算坏、乱码算、解析到空表算，缺 `command` 的后门被丢）；**文件 IO**（tmp+rename 不留 `.tmp` 残渣、父目录不存在**抛错**而不是假装成功）；以及文案与两个硬禁目录（同上；不需 VS Code、不需 key） |
| `scripts/probe-image-attach.mjs` | C17 的判据自检，七组：**识别**（四种魔数；JPEG 字节配 `.png` 名仍判 jpeg；文本字节配 `.png` 名判「不是图片」；`.svg`/`.ico`/`.bmp` 一律拒；`.PNG` 大小写折叠）；**上限**（`<=` 语义 —— 恰好等于上限必须放行，外加一条「`media/chat.js` 里那几份镜像字面量还跟扩展侧一致吗」的对拍）；**文件名**（`../../evil.png`、`a\b.png`、`CON.png`、300 字符名、重名 `-2`、扩展名以嗅探为准）；**说明文字**（路径/字节/MIME/那句「模型看不到」都在、**不含 `@"`**、有长度上限、还有「别用工具把它『看』出来」那句及其反控 —— 收得太紧会把「把这个文件挪到 X」也拒掉，那是另一个方向的错 —— 以及盘符路径的 **WSL 第二读法**，反控是 POSIX 路径上不许多出 `/mnt/…`、且名字里本来就带 `mnt` 段的路径也得换算对）；**落盘反证**（临时目录里起**真** `SessionStore`，写一条带图片附件的会话再读回 JSON：有 `kind`/`mediaType`/`bytes`/`note`，**没有 `dataBase64`、没有 `base64,`** —— 整份 `attachments` 是会原样落进 `sessions*.json` 的，而正文没有上限，一次贴图就可能写进几十 MB）；**源码结构守卫**（图片分支先于那道 10KB 闸；锚点必须落在 `if (mediaType) {` 而不是嗅探那一行 —— 把闸插在两者**之间**的写法会从嗅探锚点底下溜过去，而锚点一挪，「这段里还有魔数嗅探吗」那句断言就得跟着改切片范围，嗅探那一行在锚点上面）；**与既有功能对账**（`sessionExport` 不发 base64、`sessionSearch` 还能按文件名搜到只带图片的那条消息）。provider 在扩展宿主之外加载不了，所以顺序与出口这两类是**结构守卫**而非行为判据 —— 下面第 ③ 条变异只能这样被抓住 |
| `scripts/probe-run-inspector.mjs` | C9 运行检查器自检：帧过滤（灌 5000 条 `assistant/chunk` 记录必须逐字节不变）、调用/结果配对（含 DSH 补平帧的三态判据与守恒律）、终态优先级表、环与各项上限，以及把 `logs/dsh-frames/` 最新一份抓帧与一条独立推导的直算式 oracle 对拍（同上；不需 VS Code、不需 key） |
| `scripts/probe-compaction-notice.mjs` | C10 压缩注记自检：插件的 `compaction/summary`/`compaction/end` 载荷变成转写里的一条注记，**从不静默**（只有不相干的类型才 `undefined`）、每次成功压缩**恰好报一次**、且**绝不**把摘要正文回显进转写。后半把一份存下来的 DSH 会话日志里真的 `compaction/*` 帧与我们落盘的注记对拍 —— **逐字、同序**，完成计数与会话的 `compacted` 字段守恒（同上；不需 VS Code、不需 key） |
| `scripts/probe-compaction-override.mjs` | C10 阈值覆盖自检：只锚定改写 `compaction-basic` 的那两处比值（**恰好两行不同**、CRLF 保留、幂等、兄弟节点 `modelPolicies[].thresholdRatio` 一个字不动、9 条拒绝用例）、`retainRatio < thresholdRatio` 在整段区间上恒成立，以及**默认值产出的文件逐字节不变** —— C1「零回归」是靠这条成为结构性的，而不是靠运气（同上；不需 VS Code、不需 key） |
| `scripts/probe-context-window.mjs` | C10 占用分母自检：本次运行的值优先，**缺了就回退到记在会话上的那个**（这就是那个被整整一轮 F5 漏掉的 bug 的回归用例 —— 续聊时整条指示根本不出现）、垃圾值算「不知道」而不是算一个窗口、警戒线是 `阈值 × 0.85`（含那次真机 0.02 阈值的算术）、阈值坏掉回退默认值，且分母与「最后一次读数」都过得了一遍存储往返（同上；不需 VS Code、不需 key） |
| `scripts/probe-webview-render.mjs` | `media/chat.js` 渲染自检，在 Node 里跑一个最小 DOM 影子（F5 之前唯一能碰那段代码的路子）：占用条的 `near`/`stale`/`compacted` 三态与 `.near` class、转写折叠（首段折叠 + 正确条数 + 展开全回来 + 换会话复位）、同一套折叠再在**最长的一条真会话**上跑一遍（99 条消息 / 56 张工具卡），外加 C9 运行条/面板的小回归样本，以及 C11 推理档位菜单（默认「跟随配置」、✓ 只在当前行、每次点击下发的值 —— 且基础配置 `thinking: disabled` 时三行置灰**且一个点击处理器都不挂**，置灰的行连误发都发不出去）、C12 profile 菜单（「不用 profile」永远在第一个当退路、✓ 只在当前行、每次点击恰好一条 `set-profile` 且退出那条发 `null`、profile 钉住模型时每一行模型都置灰**且没有处理器且**「自定义模型」那一项整条藏起来 —— 反控是没钉住的菜单照样点得动；以及「profile.json 已改动 · 点这里重新应用」那行**能发得出去**，正因为它指的就是当前这一项；忙时把触发钮禁用并把菜单收起，那些行根本够不着），以及对**三个下拉钮**的结构守卫（每收窄一轮加一条）：它们分两类、每类只在一处定义 —— 模型钮留着 `link-button lc-model`，推理与 profile 两颗是**方形图标钮**、带 `tool-icon`（所以它们就是附件钮那个 26×26 的方块）且**不许**再带 `link-button`；`.lc-model` 不许长回 `border:`/`background:`/`height:`（那是被收窄掉的药丸）；两颗方块钮必须各持一枚**不同的内联 `<svg>`**、用 `stroke="currentColor"` 画（写死颜色会在两套主题里错一套）；`.on` 状态点必须还是 `position: absolute`，回到流里就会吃掉收窄刚换来的 13px。图标钮一个字都没有，它的 `aria-label`（**轴 + 当前值**）就是唯一的可访问名，这条也断言了（影子现在真的存属性，不再把 `setAttribute` 吞掉）。它已经抓过两个「影子撒谎比没有影子更糟」型的真 bug。C13 段再加十条：顶行 bash 读数三态、以及载荷里没有它时**不显示**（旧扩展 / 诊断还在跑 / 健康的非 WSL bash 三者看起来一模一样 —— 有意的）；更尖的那条是**重发**的 `backend-status` 不许在 chat 模式下把它点亮（所以那道闸在渲染函数里而不在 `applyMode` 里），而切回 harness（一个字节都不发）必须从缓存里把它恢复；审批条的多行路径注记与它的收尾（另一 id 的迟到帧不许关掉当前这条）；以及两条扁平影子表达不了的结构守卫：`#harness-shell` 必须是 `#harness-status` 的**兄弟**（后者整体重写自己的 `textContent`，做成子节点会在下次重连时被悄悄抹掉 —— C10b 那个形状）、CSS 必须留着 `flex: 0 0 auto`（否则变宽的 `#harness-status` 会把读数挤没），且两个新块里都不许有 `display:`（那会废掉 `[hidden]`）。C14 段再加八条，管工具卡上那行「≈ 预计 / 实际改动」：它必须以**兄弟**身份待在卡上、在头部之下与参数块之上（一长串 JSON 参数否则会把读数顶出视野），**绝不进头部**；diff 只在点击后出现（每行的 `+`/`-` 前缀与 `.diff-line` class）；`tool-result` 帧把那一行**就地**换掉（断言节点身份 —— 重建会丢位置与展开态）；没有 diff 的收尾帧把按钮与 diff 一起收起来，否则上一条的 diff 会留在那儿冒充这次的结果；失败/未知各有自己的 class 与说法，而另一 id 的迟到帧不许碰这张卡；未知 id 什么都不做；从没拿到预计的卡不长这一行。C13 的 `_fsTargetAbs` 守卫也在同一轮改了形：现在断言它**委派**给 `changeForecast.resolveTargetPath`、且函数体里不再有 POSIX 字面量。这些守卫做过变异测试 —— 做成子节点、去掉 `flex: 0 0 auto`、去掉 `pre-wrap`、去掉模式闸、去掉缓存、把 `_fsTargetAbs` 的提前返回重写而不是委派、在决策路径上第二次调 `readPosixTarget`、把预计行塞进头部、按子串匹配工具名（`todo_write`）、去掉 POSIX 提前返回、去掉行尾归一化、把 `diffs: []` 读成「读不出来」、去掉两处「未知」收尾之一。C15 段再加十三条：开关恰好发一次快照请求、再点关掉；**三个空态分开说**（还没到 / 还没选 / 选了但被删了 —— 合成一句「没有数据」在最初几毫秒里就是撒谎）；两侧各画自己的尾段 + 分叉点那一行 + 判据那两行（其中只有串话那行带警示色，反控是两条无关会话**一点警示色都没有**）；**折叠是按栏各算的**（反控：展开对照栏不许把直播转写也展开 —— 两个状态不共用一个变量）；选择器的行数与置灰行**一条消息都不发**、而第三行只发一次选择；快照落地时选择器收起（回执）；**面板关掉之后到的快照被丢弃**；对照栏**不污染直播面的 `byId`**（同 id 的 `tool-result` 帧既不许改卡的 class 也不许改它的文字 —— 这正是共用一张注册表会打开的那扇门）；直播消息面的子节点数经得起一次对照渲染；冻结的观感（`unknown` class、没有 `running`、被打断的消息上没有闪的光标）；三个同层浮层互斥；Esc 按顺序一层层剥；以及 CSS 与 `chat.html` 的结构守卫（`#compare-panel` 必须是 **body 直系**、不能待在 `#messages` 区域里 —— 那里 react-live 会藏起来，C14 的教训 —— 而 `#compare-btn` 在头部动作簇里；`.cmp-transcript` 必须保持 `display:flex; flex-direction:column`，不许从单列阅读版式抄来 `max-width`/`margin:0 auto`，因为 `.msg` 那套对齐是 flex item 的性质）。同一轮还补掉了影子自身的一个可测性漏洞：`document.addEventListener` 以前是空操作，于是全局 Esc 那条链从来没被跑过。C16 轮另外记下两条**有意惰性**的变异：把 `answerApproval` 上一句 `allow &&` 拿掉、以及把 `renderApproval` 弱化成只在 `trust` 存在时才赋值那两个元素 —— 单看每条都**什么都不改**（没有调用方在拒绝时带 kind，另一条被收起时的复位盖住了），只有合起来才红，所以这一对被写进了代码注释，而不是当成死代码。C16 段再加十一条，管审批条上那个信任钮：标签与范围行**逐字**来自载荷（反控：载荷压根没有 `trust` 时两者都藏起来**且被清干净** —— 那是旧扩展的形状）；点一下恰好一条 `approval-answer`、`allow:true` **且** `trust:'command'`；再点一下什么都不发（条先收起）；`dir` 档原样透传；**Esc 仍然是拒绝且完全不带 `trust` 键**（拒绝绝不能被读成一次安静的信任）；「允许执行」同样不带 `trust`（没有静默升级 —— 两个钮只差一个字段）；`approval-resolved` 上的复位不给下一条留任何可继承的东西；以及点那个（已隐藏的）按钮仍然不发 `trust`（kind 是**被复位**，不是仅仅看不见）—— 外加两条扁平影子表达不了的结构守卫：`#approval-trust` 在 `.approval-actions` **里面**而 `#approval-scope` 在它**外面**（范围行够长要换行时，否则会被排成一个按钮）、`.approval-scope` 用的是 `--dsw-alias-state-warn-primary`（真存在的那个主题变量 —— `dsh-live.css` 里没有 `state-warning-` 那一族，旁边那个 `.approval-note` 其实一直在悄悄退到 VS Code 兜底色），且它自己不写 `display:`，那会废掉 `[hidden]`。C17 段再加八条，管图片附件：贴一张图恰好一条 `user-message` 帧，带 `kind`/`mediaType`/`dataBase64` 且**不带 `content`**（字节永远到不了提示词正文）；超限或超张数时 chip 上出现 `readError`、而 `send()` **什么都不发**；带图片附件的快照画出那枚文字 chip；标了 `truncated` 的待发项确实把 `truncated: true` 带进帧里。影子为这条路只长了两样东西 —— `El.dispatch(type, props)` 把 props 并进事件对象（这样才挂得上假的 `clipboardData.files`；老的单参调用与 `click()` 一字未变，而之前那 89 条**没有一条**碰过粘贴或拖拽）与一个**真的会回调**的 `FileReader.readAsDataURL`（此前的 `readAsText` 从不回调 —— 这正是粘贴与拖拽那条路一次都没被跑过的原因）。影子把真实的异步顺序压成了同步读，所以真正兜住张数上限的是扩展侧那道复查，不是这里。变异：去掉 `truncated` 转发、用 `readAsText` 读图、把粘贴判据改回 `dropHasFiles` —— 后者读 `e.dataTransfer`，而粘贴事件把文件放在 `e.clipboardData` 上，**整条「粘贴一张图」的路从来没成功过**，而且是静默失败（不报错、什么都不发生）。那是这一轮抓到的真 bug。 —— **与 C13、C14、C15、C17 的合起来共 35 条，全部被抓红**，每条都先自证真的插进去了。这道自证这一轮值回票价：改 `.ts` 的变异会让 `probe-branch-compare` **整份全绿**（它载的是编译产物 `out/`），于是「变异没被抓到」与「变异压根没插进去」长得一模一样 —— 那些变异现在会重新编译，并且编译回来（同上；不需 VS Code、不需 key） |
| `scripts/probe-derived-config-boot.mjs` | 按扩展拉起运行时的方式启动便携运行时 —— 基础配置走**位置参数**、派生配置只走 `DSH_CORDIS_CONFIG` —— 一正控（合法覆盖能加载）一反控（违反插件加载期 `retainRatio < thresholdRatio` 的派生文件**必须**启动失败）。反控才是重点：它证明这个环境变量真的赢，而 C1 与 C10 都吊在这一根线上（同上；不需 VS Code、不需 key） |
| `scripts/probe-effort-plugin.mjs` | C11 会话级推理档位自检，三段：纯规则（`normalizeEffort` 从不猜、`thinkingDisabledInConfig` 只读 `llm-deepseek` 块、路径里带单引号时派生块怎么写引号、**没请求档位时派生文件里不许多出东西**、挂不上的块要警告而不是抛 —— 且 C1 自己那句 throw 原样还在）；**插件自己的决策表**，当普通模块加载、喂一个假 `ctx`（命中 / 未命中返回**上游返回的那个对象本身** / 载荷里没有 `agent` / 状态文件缺失或损坏 / 非法值 / `thinking` 关着时只放 `off` / 上游抛错必须往外传而不是被吞），其中「状态文件在**每一次**请求上都重读」这条**就是**热切的声明本身；以及真端到端启动：派生配置挂上真插件，落盘的 `request/header` 必须读到 `reasoningEffort: "low"` —— 反控是没设过的会话拿到的是**基础配置自己的默认值**、不是我们的值。外加上一次真机 F5 带出的结构守卫：`_actives[this._mode] =` 全仓**只许出现一次**（在 `_setActive` 里），且那个方法必须重播配置条 —— 否则换会话时档位菜单会安静地留着上一个会话的值。跑在**假 API key** 上：请求 401，但 `request/header` 是构建时就写的，所以断言成立、一分钱不花（同上；不需 VS Code、不需 key） |
| `scripts/probe-agent-profile.mjs` | C12 项目级 profile 自检，四段：**解析**（文件缺失 / 不是 JSON / 根是数组 / 字段类型错 / 未知字段 / 名字过长 / 未知工具名 —— 每一条都变成一条提示、没有一条抛错，且文件里好的那一半照样生效）；**「只能收紧」那张表**（设置关 + profile `false` ⇒ 还是关；设置关 + `true` ⇒ 开；设置开 + `false` ⇒ **还是开**，且从文件文本经解析到编译走一遍端到端，省得 `false` 从解析器底下溜过去；`patterns` 是并集、删不掉默认项也清不成空；`outsideWorkspace` 同一套正反控）—— 整个功能就压在这一段上；**插件的决策表**，当普通模块加载、喂假 `ctx`（给了 deny ⇒ `restrict` 拿到的恰好是那个过滤器；deny 为空 / 缺失 / 不是数组 ⇒ **根本不调 `restrict`**，这才让「没挂 profile」与「压根没有 C12」逐字节等价；非字符串条目被过滤；缺 `agent`/`ctx`/`tools` 不抛；`restrict` 抛错不许冒泡，那会把整个会话带下去）；以及真端到端启动：派生配置挂上真插件，落盘的 `request/header.header.tools` 里必须**没有 `bash`** 且**仍有 `read`** —— 反控是没挂 profile 的那次**有 `bash`**，否则「没有 bash」也可能只是这一轮根本没组装工具。跑在**假 API key** 上（请求 401；header 是构建时写的）（同上；不需 VS Code、不需 key） |
| `scripts/probe-shell-diag.mjs` | C13 shell 诊断自检，八组：**解析**（假 `PATH` + 假 `isFile`，含反控 —— libuv **不认 `PATHEXT`**，照抄那份认它的上游助手会算出错的赢家，所以断言是「机器上没有 `PATHEXT` 也能找到 `bash.exe`」；外加 `PATH=''` 不回退 cwd，以及 `PATH` 键缺失时回退宿主真实环境，那正是 `prependPathDir` 不能踩的地雷）；**分类**（只看形态，反控是 Cygwin / 裸 `bash.exe` 落进 `other`）；**三值表** + 那条让「冷启动绝不狼来了」可机器验证的配对断言（`shellWarnFor` 在可用**与**不可判上都必须 `undefined`，坏的必须非空），对着从真启动器抓下来的 **116 字节 UTF-16LE 夹具**（奇数位 NUL 占比 0.690）来量；**解码**与三份反向样本；`prependPathDir` 的同一性/幂等；POSIX 路径的两读法（反控是 UNC：拿到注记的集合必须等于拿不到快照的集合）；一条**不漂移**检查：`classifyShell` 与 `usabilityOf` 对同三份真 `uname` 输出说同一件事；以及一组真机用例，它的正控随本机有什么 bash 自适应，**没有 bash 时大声跳过**而不是安静通过（任何机器专有路径都不进仓库）。「没有 WSL 的机器拿到的是指引而不是一屏报错」这条验收钉了三处：上面那份夹具走一遍纯函数（空 PATH 与只有 shim 的 PATH 必须给出**两句不同的**头条 —— 是不等断言，不是两次字符串匹配）、判据是录制探针的纯函数、以及那个自适应的正控（同上；不需 VS Code、不需 key） |
| `scripts/probe-change-forecast.mjs` | C14 事前预览自检，八组，文件系统的每一次交互都是注入的（`readText` / `exists`），所以不建夹具、也不在乎本仓库 CRLF/LF 混排：**解析**（wire 把 `arguments` 当 JSON **字符串**发；畸形 / 非对象 / 空都降级成 `undefined` 而不抛）；**工具闸**，带那条要紧的反控 —— `todo_write` 在真会话里是存在的，按子串匹配会给一张不碰任何文件的卡挂上假预计；**路径解析**（相对路径对着 base 解析、绝对路径原样、POSIX 形状 `/mnt/d/x` **拒绝**才是重点、UNC 作为合法的绝对路径放过去、没有 base ⇒ 不给答案）；**类型与 diff**（新文件 ⇒ 没有 diff 并说明原因；已存在的文件 ⇒ 与盘上对 diff，明确不是与轮初快照对；三种「预览不了」各自说出来而不是假装一个空 diff；`edit` 只 diff 那段；过长 ⇒ 截断）；**命中检查**（0 / 1 / 2 且 `replace_all` 关着 / 2 且开着），含 **CRLF 反控**（LF 的 `old_string` 对着 CRLF 文件必须仍算命中）外加两件不用读盘就知道的失败；**文案**；**实际那一半**（一个 hunk、多个 hunk 合并并标注 —— DSH 是**每个 hunk 一条** —— `diffs: []` 是一个判词而不是「读不出来」、meta 畸形 ⇒ `undefined` 且绝不抛、DSH 自己的 `path` 赢过预测的那个）；以及结构守卫：`_fsTargetAbs` 必须委派且自己不带 POSIX 字面量、那个字面量只许活在**两个文件**里（`changeForecast.ts` 拒绝它、`shellDiag.ts` 翻译它 —— 同形状、反职责，两个都得留着）、三处 `_forecastAfter` 调用点都在（结果 + 两处「未知」收尾，缺一个就会让预计永远留在卡上）、表在轮初清掉，且 `ChatMessage` 与会话存储都不许学会 `forecast` 这个词（它是活的提示，不是转写）（同上；不需 VS Code、不需 key） |
| `scripts/probe-c8-runtime.mjs` | C8 的运行时前提 spike：第二条 prompt 排队、杀后 resume 补平、优雅 vs 硬杀。**需 API key**、会花掉真实模型轮 |
| `scripts/update-dsh.mjs` | 运行时依赖治理：把 DSH 检出锁到 tag、查漂移、跑升级仪式 + 冒烟（见 `docs/runtime-dependency.md`） |
| `docs/runtime-dependency.md` | 治理决策依据：把 DSH 检出当「版本化运行时依赖」、升级仪式、「何时切官方 npm」观察清单 |

扩展注册的命令：`AlohaDSH: 开始新对话`、`AlohaDSH: 配置 DSH 运行路径`、
`AlohaDSH: 查看/清除审批白名单（「永久信任」的命令与目录）`（另有玩具命令
`AlohaDSH: 打个招呼` / `AlohaDSH: 读取当前文件第一行`）。

## 开发与安全提示

- 构建 / 测试：`npm install` → `npm run compile` → 按 **F5**。
- 永不提交：`logs/`（真实会话帧）、`.claude/`（本地授权）、`media/dsh-live/`（上游产物派生）、
  `probe-*.html` / `probe-server.mjs`（本地探针）、`*.vsix`。
- 扩展只把 `DEEPSEEK_API_KEY` 注入子进程 env；它绝不能出现在日志、转写、设置或本仓库里。
