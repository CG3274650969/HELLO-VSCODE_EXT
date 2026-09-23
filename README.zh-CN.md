<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/logo-dark.svg">
  <img src="media/logo-light.svg" alt="AlohaDSH" width="220">
</picture>

# AlohaDSH —— VS Code 侧栏的 DeepSeek-Harness（DSH）聊天面板

[English](README.md) · **简体中文**

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC?logo=visualstudiocode&logoColor=white" alt="需要 VS Code 1.90 或更新">
  <img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?logo=nodedotjs&logoColor=white" alt="DSH 运行时要求 Node ^22.19 或 >= 24">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="零运行时依赖">
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white" alt="TypeScript 编写">
  <img src="https://img.shields.io/badge/License-MIT-3DA639" alt="MIT 许可">
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek%20Harness-JSON--RPC-4D6BFE" alt="对 DeepSeek Harness 讲 JSON-RPC"></a>
  <a href="https://github.com/CG3274650969/HELLO-VSCODE_EXT"><img src="https://img.shields.io/badge/GitHub-HELLO--VSCODE__EXT-181717?logo=github&logoColor=white" alt="源码在 GitHub"></a>
  <a href="https://github.com/CG3274650969/HELLO-VSCODE_EXT/issues"><img src="https://img.shields.io/badge/Issues-welcome-2F81F7?logo=github&logoColor=white" alt="提 issue"></a>
  <img src="https://img.shields.io/badge/tested%20on-Windows%2011-0078D6?logo=windows11&logoColor=white" alt="在 Windows 11 上端到端验过">
</p>

</div>

一个 VS Code 侧栏聊天扩展。主推模式 **Harness** 通过 JSON-RPC 连接你本地的
[DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）运行时 ——
真实工具调用、真实转写；当 `media/dsh-live` 产物齐全时，用 DSH 自带的 React 对话组件渲染。

| 模式 | 说明 |
|---|---|
| **Harness**（默认） | 恒为 **DSH 直播**：扩展以子进程拉起本地 DSH `jsonrpc-agent` 端到端驱动。模型与消息经 JSON-RPC 下发，工具调用 / 增量 / 转写回流。未配置时底部配置条常驻、引导点内建 **配置 DSH** 向导（路径配好前禁发）。 |
| **内嵌聊天** | 自带流式界面、回复是内置假文本的沙盒 —— **未完成**，仅用于打磨流式/渲染管线。见手册[内嵌聊天](docs/manual.zh-CN.md#内嵌聊天embedded-chat)。 |

> 仓库不带任何机器路径：`hello.dsh.*` 一律从你的用户设置读取（`scope: machine`），绝不进仓库。

---

## 文档（手册）

这一页只回答两件事：它是什么，以及五分钟怎么跑起来。其余全部正文 —— 从零安装 0–5、
设置速查（含会话历史）、运行可靠性（中断与续跑）、运行检查器、真 DSH 组件画面
（react-live）、项目结构、开发与安全提示 —— 都在
**[docs/manual.zh-CN.md](docs/manual.zh-CN.md)**。

> 差距提示：**上下文窗口与压缩**（C10）、**项目级 agent profile**（C12）、
> **Windows：agent 拿到哪个 bash**（C13）这三节目前只写在英文手册
> [docs/manual.md](docs/manual.md) 里，中文尚未翻译。

## 状态

**开发者预览。** 「Harness」是受支持的路径，在 Windows 上端到端跑过；
「内嵌聊天」是未完成的沙盒，只用于打磨流式/渲染管线。哪些做完、哪些有意没做，
见 [docs/backlog.md](docs/backlog.md)。

## 运行（三步）

前提是你已经有一份 DSH 检出（还没有？见[手册第 0–2 节](docs/manual.zh-CN.md#完整路径从零到跑通-harness)）：

```sh
git clone https://github.com/CG3274650969/HELLO-VSCODE_EXT.git
cd HELLO-VSCODE_EXT
npm install
```

1. 在 VS Code 打开本文件夹 → 按 **F5**（运行和调试 → Run Extension）。
2. 扩展开发窗口 Activity Bar 点 **AlohaDSH**，面板默认落在 **Harness** 页签。
3. 用底部 **配置 DSH** 向导指向你的 DSH 运行时；点 **API** 按钮把 Key 存进
   VS Code SecretStorage（不回写任何文件）。

每一步的长版说明都在手册里，从
[第 4 节 配置扩展](docs/manual.zh-CN.md#4-配置扩展优先用向导)开始。

## 开发

`npm run compile`（tsc）是构建。另有自检与一族探针（[scripts/](scripts/)），
F5 之前必须全绿。见[手册：开发与安全提示](docs/manual.zh-CN.md#开发与安全提示)。

## License

MIT

Third-party dependencies and their licenses are disclosed in THIRD_PARTY_NOTICES.md.
