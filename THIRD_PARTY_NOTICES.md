# Third-party notices

AlohaDSH is licensed under the MIT License — see [LICENSE](LICENSE).

This repository ships **no third-party code**. `package.json` declares
`"dependencies": {}`, so the extension bundle is only this project's own source:
the language model is not embedded, and no SDK or runtime library is vendored.

## Build-time dependencies

Installed by `npm install` and used only to compile and type-check. None of them
is redistributed in the extension package:

| Package | License |
|---|---|
| `typescript` | Apache-2.0 |
| `@types/node` | MIT |
| `@types/vscode` | MIT |

## DeepSeek Harness — not vendored

The extension drives a **DeepSeek Harness** (DSH) runtime that *you* provide:
either a checkout you build yourself
(<https://github.com/deepseek-ai/deepseek-harness>) or a portable runtime
directory produced by `scripts/build-runtime.mjs`. DSH is licensed under the MIT
License (© DeepSeek). It is not part of this repository — see
[docs/manual.md](docs/manual.md) for how to obtain and build it.

## Generated locally, never committed

`.gitignore` keeps the following out of the repository. They are produced on your
machine and may contain third-party material:

| Path | What it is |
|---|---|
| `media/dsh-live/` | A build of DSH's own React chat UI (© DeepSeek, MIT) |
| `dist-runtime/` | The portable runtime — DSH packages plus a copy of Node.js |
| `node_modules/`, `out/` | Build inputs and this project's compiled output |

`scripts/build-runtime.mjs` copies the Node.js binaries into the runtime
directory and, when the source tree ships one, copies Node's own `LICENSE` file
alongside them. Node.js is licensed under the MIT License
(© Node.js contributors).
