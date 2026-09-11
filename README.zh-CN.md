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
| `hello.dsh.runtimeDir` | `""` | **便携运行时（推荐）**：含 `runtime.json` 的目录。**优先于** `nodePath`/`loader`/`entry`/`config`/`runCwd`；目录不可用会明确报错，不会静默回退。 |
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

另一组键在 `hello.chat` 下，`scope: window`（随工作区）：护栏与审阅。

| 键 | 默认 | 作用 |
|---|---|---|
| `hello.chat.approval.enabled` | `true` | **事前审批**。命中策略的 bash 命令、以及越出工作区的 `write`/`edit`，在**执行前**弹确认条并暂停整轮。实现是一条 `PreToolUse` hook（派生配置落在扩展存储目录，**不改动你的 cordis.yml**）。**关掉它会连带关掉「工作区外改动」的可见性**（hook 是唯一的传感器）。改这个开关需重连才生效。 |
| `hello.chat.approval.patterns` | 见 package.json | bash 侧策略：命中任意一条（不区分大小写的正则）即弹条。默认是 `rm`/`rmdir`/`mkfs`/`dd of=`/`diskpart`/`format X:`/`git push --force`/`git reset --hard`/关机类/fork bomb。改动即时生效。 |
| `hello.chat.approval.outsideWorkspace` | `true` | **工作区外写确认**。关掉只是**不再问** —— 只要 `enabled` 还开着，区外改动仍会照旧出现在本轮审阅里。平台临时目录（`%TEMP%` / `/tmp`）两边都豁免。改动即时生效。 |
| `hello.chat.approval.timeoutSec` | `540` | 等确认的秒数；超时按**拒绝**处理。 |
| `hello.chat.reviewChanges` | `true` | 每轮结束后对比文件改动并显示审阅条（增/改/删 + 行级 diff + 保留/还原）。工作区**外**的改动也会一并列出（标出所在目录）。 |

**已知局限（不是 bug）**：护栏只看 `write`/`edit` 工具的目标路径，**不解析 bash 命令串里的路径**。所以 agent 用 `cp`/`mv`/`>` 写到工作区外时，既不弹确认条、**也不会出现在审阅里**。另外扩展不可达时 fs 侧一律放行（护栏降级，可见性同时停摆）。

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
| `src/sessionStore.ts` | 会话标题/续聊落盘（globalStorage） |
| `src/extension.ts` | 插件入口：命令 + 视图注册 |
| `media/chat.{html,js,css}` | 侧栏前端（模式胶囊 + harness 状态点；DSH 令牌 + VS Code 双兜底） |
| `media/dsh-live/` | **gitignore** —— DSH 单文件前端产物（见上） |
| `scripts/capture-dsh-frames.mjs` | DSH 运行时抓帧工具（`DSH_CAP_*`） |
| `scripts/update-dsh.mjs` | 运行时依赖治理：把 DSH 检出锁到 tag、查漂移、跑升级仪式 + 冒烟（见 `docs/runtime-dependency.md`） |
| `docs/runtime-dependency.md` | 治理决策依据：把 DSH 检出当「版本化运行时依赖」、升级仪式、「何时切官方 npm」观察清单 |

扩展注册的命令：`AlohaDSH: 开始新对话`、`AlohaDSH: 配置 DSH 运行路径`（另有玩具命令
`AlohaDSH: 打个招呼` / `AlohaDSH: 读取当前文件第一行`）。

## 开发与安全提示

- 构建 / 测试：`npm install` → `npm run compile` → 按 **F5**。
- 永不提交：`logs/`（真实会话帧）、`.claude/`（本地授权）、`media/dsh-live/`（上游产物派生）、
  `probe-*.html` / `probe-server.mjs`（本地探针）、`*.vsix`。
- 扩展只把 `DEEPSEEK_API_KEY` 注入子进程 env；它绝不能出现在日志、转写、设置或本仓库里。
