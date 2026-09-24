# Changelog

一节一个版本，最新在上。行为与判据的完整记录在 [docs/backlog.md](docs/backlog.md)，
用法与设置见 [docs/manual.zh-CN.md](docs/manual.zh-CN.md)。

## 0.0.1

首个版本。

- **Harness（主推）**：侧栏面板用 JSON-RPC 驱动本地 DeepSeek-Harness（DSH）的
  `jsonrpc-agent` 子进程 —— 真实工具调用、增量与转写回流；`media/dsh-live` 产物齐全时
  用 DSH 自带的 React 对话组件渲染，缺失时自动退回 VS Code 观感。
- 配置向导 + 常驻配置条：`hello.dsh.*` 一律从用户设置读取（`scope: machine`，仓库不含
  任何机器路径）；API Key 存进 VS Code SecretStorage，不回写任何文件。
- 会话历史与续聊、运行检查器、上下文窗口指示与压缩可见、项目级 agent profile、
  审批白名单记忆、图片附件、模型与推理档位、余额读数、远端模型列表。
- 选区自动附带、每轮文件改动审阅（事前 diff 预览 + 事后对照、分支对照视图）。
- **内嵌聊天**未完成，本版**未开放入口**（按钮已隐藏，代码保留）。
