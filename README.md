# hello-vscode-ext

一个 VS Code 侧栏聊天扩展（学习 / 自用）。在 Activity Bar 的 **Hello Chat** 面板里提供三种用法：

| 模式 | 后端 | 说明 |
|---|---|---|
| 内嵌聊天 | — | 自带流式对话界面（消息、工具卡、附件、历史），无需外部运行时 |
| Harness | 模拟 | 内置演示工具流，本地纯演示，不调用外部服务 |
| Harness | DSH 直播 | 连接本地 DeepSeek-Harness（DSH）JSON-RPC runtime 子进程，渲染**真 DSH 前端组件**（react-live） |

> 说明：本项目把 DSH 前端**编译产物**加载进 webview 以获得真实 DSH 组件观感（见下「DSH 直播画面」）。
> 为不把上游产物连带公开，`media/dsh-live/` 已被 gitignore —— clone 后需自行从 DSH 仓库重建。

## 怎么跑（基础）

1. 在 VS Code 里打开本文件夹
2. `npm install`
3. 按 `F5`（运行和调试 → Run Extension），弹出扩展开发窗口
4. 侧栏 Activity Bar 点 **Hello Chat** → 底部输入框发消息

## DSH 直播配置（可选）

DSH 直播后端会以子进程方式启动本地 DSH jsonrpc-agent。机器专属路径**不进仓库**，
请在自己的用户设置（`settings.json`，scope=machine）里填：

```jsonc
// VS Code 用户设置（settings.json），别提交到仓库
"hello.dsh.nodePath": "D:\\DSH\\tools\\node-v24.19.0-win-x64\\node.exe",
"hello.dsh.entry":    "D:\\DSH\\deepseek-harness\\packages\\examples\\jsonrpc-demo\\src\\bin.ts",
"hello.dsh.config":   "D:\\DSH\\deepseek-harness\\examples\\jsonrpc-agent\\cordis.yml",
"hello.dsh.runCwd":   "D:\\DSH\\deepseek-harness",
"hello.dsh.tsconfig": "D:\\DSH\\deepseek-harness\\tsconfig.json",
```

- `hello.dsh.command` 非空时整段覆盖上面的启动命令（+ `hello.dsh.args`）。
- API Key：扩展内 **API** 按钮 → 存进 VS Code SecretStorage（不回写任何文件）。
  也可用 `hello.dsh.credentialsFile` 指向一个含 `DEEPSEEK_API_KEY:` 的 YAML 作为回退。
- `hello.dsh.model` / `hello.dsh.provider` 控制 initialize 上报的模型与 provider 路由。

各配置项缺省为空是**有意为之**：仓库里不带任何机器路径；运行到 DSH 直播且未配置时，
会提示「DSH 未配置，请设置 hello.dsh.nodePath 与 hello.dsh.entry」。

## DSH 直播画面（react-live）

DSH 前端（`ui-conversation` / `ui-tool` 组件 + 主题令牌）以单文件产物形式从 **DSH 仓库**打包，
放到 `media/dsh-live/`（含 `dsh-live.js`、`dsh-live.css`、`assets/`）：

- 产物齐全：侧栏整体走 DSH 主题令牌（深浅随 VS Code 主题）；选择 Harness + DSH 直播后，
  webview 注入该 React 组件渲染真实转录。
- 产物缺失：侧栏回落纯 VS Code 观感（`chat.css` 双兜底变量），模拟模式照常可用，无报错。

该目录按本仓库构建脚本（`scripts/` 里有抓帧工具，需 DSH 环境与 `DSH_CAP_*` 环境变量）
或用你本地 DSH 打包流程重建后，开发环境即恢复 react-live。仓库本身不包含它。

## 结构

| 路径 | 作用 |
|---|---|
| `src/chatViewProvider.ts` | 聊天 webview 主逻辑：spawn DSH runtime、握手、消息/工具流转发、主题链接注入 |
| `src/dshRuntime.ts` | DSH JSON-RPC 子进程生命周期（spawn/握手/心跳/重连/事件分发） |
| `src/sessionStore.ts` | 会话标题/续聊落盘（globalStorage） |
| `src/extension.ts` | 插件入口（注册命令、激活 webview） |
| `media/chat.{html,js,css}` | 内嵌聊天 / Harness 界面前端（两行顶部 chrome + 胶囊 tab，DSH 令牌双兜底） |
| `media/dsh-live/` | **（gitignore，不提交）** DSH 前端单文件产物 |
| `scripts/capture-dsh-frames.mjs` | 抓 DSH runtime 入站 JSON-RPC 帧到 `logs/`（`DSH_CAP_*` 配路径） |

## 提示

- 不提交 `logs/`（含真实会话帧）、`.claude/`（本地授权）、`media/dsh-live/`（上游产物）、`*.vsix`。
- 扩展只把 API Key 注入子进程 env，任何日志 / 转写都不应出现其值。
