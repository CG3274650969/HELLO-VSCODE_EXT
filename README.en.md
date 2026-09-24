<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/logo-dark.svg">
  <img src="media/logo-light.svg" alt="AlohaDSH" width="220">
</picture>

# AlohaDSH — a DeepSeek-Harness (DSH) side panel for VS Code

**English** · [简体中文](README.md)

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC?logo=visualstudiocode&logoColor=white" alt="Requires VS Code 1.90 or newer">
  <img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?logo=nodedotjs&logoColor=white" alt="The DSH runtime requires Node ^22.19 or >= 24">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white" alt="Written in TypeScript">
  <img src="https://img.shields.io/badge/License-MIT-3DA639" alt="MIT license">
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek%20Harness-JSON--RPC-4D6BFE" alt="Speaks JSON-RPC to DeepSeek Harness"></a>
  <a href="https://github.com/CG3274650969/HELLO-VSCODE_EXT"><img src="https://img.shields.io/badge/GitHub-HELLO--VSCODE__EXT-181717?logo=github&logoColor=white" alt="Source on GitHub"></a>
  <a href="https://github.com/CG3274650969/HELLO-VSCODE_EXT/issues"><img src="https://img.shields.io/badge/Issues-welcome-2F81F7?logo=github&logoColor=white" alt="Open an issue"></a>
  <img src="https://img.shields.io/badge/tested%20on-Windows%2011-0078D6?logo=windows11&logoColor=white" alt="Verified end to end on Windows 11">
</p>

<p align="center">
  Project home: <a href="https://github.com/CG3274650969/HELLO-VSCODE_EXT">https://github.com/CG3274650969/HELLO-VSCODE_EXT</a>
</p>

</div>

A VS Code side-bar chat extension whose headline mode, **Harness**, talks to your local
[DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) runtime over JSON-RPC —
real tool calls, real transcripts, rendered with DSH's own React conversation UI when the
`media/dsh-live` bundle is present.

| Mode | What you get |
|---|---|
| **Harness** (default) | Always **live DSH** — the extension spawns a local DSH `jsonrpc-agent` subprocess and drives it end to end. Model and messages go over JSON-RPC; tool calls, deltas and transcripts stream back. When unconfigured, the bottom config bar stays visible and guides you to the built-in **配置 DSH** wizard (sending is disabled until paths are set). |
| **内嵌聊天** (Embedded chat) | A self-contained streaming-chat sandbox that replies with built-in canned text — **work in progress, not exposed in this release** (the entry button is hidden; the code is kept). See [Embedded chat](docs/manual.md#内嵌聊天-embedded-chat). |

> No committed machine paths: all `hello.dsh.*` settings are read from your user settings
> (`scope: machine`), never from the repo.

---

## Documentation

This page answers only two questions: what it is, and how to get it running in five
minutes. Everything else — clean-machine setup (0–5), the settings reference, the
Windows bash story, session history, reliability (interrupt & continue), the run
inspector, the context-window indicator, project agent profiles, the project layout, and
the development/security notes — lives in **[docs/manual.md](docs/manual.md)**.

## Status

**Developer preview.** *Harness* is the supported path and is exercised end to end on
Windows. *内嵌聊天* (Embedded chat) is a work in progress and **is not exposed in this
release** (the button is hidden; the code is kept to exercise the streaming/render
pipeline). What is done and what is deliberately not is tracked in
[docs/backlog.md](docs/backlog.md).

## Run

Assuming you already have a DSH checkout (no checkout yet? see [manual §0–2](docs/manual.md#full-setup-from-a-clean-machine-to-a-live-harness)):

```sh
git clone https://github.com/CG3274650969/HELLO-VSCODE_EXT.git
cd HELLO-VSCODE_EXT
npm install
```

1. Open this folder in VS Code and press **F5** (Run and Debug → Run Extension).
2. In the Extension Development Host window, click **AlohaDSH** in the Activity Bar. The
   panel opens on the **Harness** tab.
3. Point it at your DSH runtime with the bottom **配置 DSH** wizard, and put the API key
   behind the **API** button (VS Code SecretStorage — never written to any file).

The long form of every step is in the manual, starting at
[§4 Configure the extension](docs/manual.md#4-configure-the-extension-wizard-first).

## Discussion & contributing

Everyone is welcome to join in. This repo's **Issues** are open to anything: usage
questions, bug reports, feature wishes, or simply telling us what you built with it.
Pull requests are welcome too — the active line is the long-running `dev` branch.

- Project home: https://github.com/CG3274650969/HELLO-VSCODE_EXT
- Questions & ideas: https://github.com/CG3274650969/HELLO-VSCODE_EXT/issues

## Development

`npm run compile` (tsc) is the build. Beside it there is a self-check and a family of
probes under [scripts/](scripts/), all of which must be green before an F5 pass. See
[manual: Development & security notes](docs/manual.md#development--security-notes).

## License

MIT

Third-party dependencies and their licenses are disclosed in THIRD_PARTY_NOTICES.md.
