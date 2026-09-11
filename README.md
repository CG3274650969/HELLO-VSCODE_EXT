# AlohaDSH — a DeepSeek-Harness (DSH) side panel for VS Code

<img src="media/logo.png" alt="AlohaDSH" width="128">

**English** · [简体中文](README.zh-CN.md)

A VS Code side-bar chat extension whose headline mode, **Harness**, talks to your local
[DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) runtime over JSON-RPC —
real tool calls, real transcripts, rendered with DSH's own React conversation UI when the
`media/dsh-live` bundle is present.

| Mode | What you get |
|---|---|
| **Harness** (default) | Always **live DSH** — the extension spawns a local DSH `jsonrpc-agent` subprocess and drives it end to end. Model and messages go over JSON-RPC; tool calls, deltas and transcripts stream back. When unconfigured, the bottom config bar stays visible and guides you to the built-in **配置 DSH** wizard (sending is disabled until paths are set). |
| **内嵌聊天** (Embedded chat) | A self-contained streaming-chat sandbox that replies with built-in canned text — **work in progress**, kept only to exercise the streaming/render pipeline. See [below](#内嵌聊天-embedded-chat). |

> No committed machine paths: all `hello.dsh.*` settings are read from your user settings
> (`scope: machine`), never from the repo.

---

## Quick start (you already have a DSH checkout)

1. Open this folder in VS Code → `npm install` → press **F5** (Run Extension).
2. In the Extension Development Host, click **AlohaDSH** in the Activity Bar. The panel opens on
   the **Harness** tab by default.
3. If DSH paths are configured, the top status dot turns green **在线 · \<model\>** and you can just
   type. If not, the message area shows a guide and the send button is disabled — click **配置 DSH**
   in the bottom bar and walk the wizard (pick `node.exe`, pick the entry script; the rest is derived).
4. Need an API key? Click **API** in the bottom bar → stored in VS Code SecretStorage (never written
   to a file), or point `hello.dsh.credentialsFile` at a YAML containing `DEEPSEEK_API_KEY:`.

---

## Full setup: from a clean machine to a live Harness

### 0. Prerequisites

- **VS Code** (any recent version).
- **Node.js** matching DSH's `engines`: `^22.19.0 || >=24.0.0` (a 24.x LTS works; see the bundled
  example below). Only needed to *build* things — the [portable runtime](#portable-runtime-recommended)
  ships its own node and needs none on your PATH.
- **pnpm** ≥ 11 — DSH declares `packageManager: pnpm@11.7.0`. (This extension itself is plain npm.)

### 1. Get Node.js (bundled example)

DSH is a large ESM workspace; it is convenient to keep a dedicated Node beside your checkouts, e.g.
extract Node 24 into `D:\DSH\tools\` so you get:

```
D:\DSH\tools\node-v24.19.0-win-x64\node.exe
```

That exact file is what `hello.dsh.nodePath` points at in the worked example below.

### 2. Clone & build DeepSeek Harness

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

Optional sanity check — launch DSH's own web UI and open http://127.0.0.1:3080:

```bash
pnpm dsh web
```

If anything here fails, follow the upstream `README.md` in that checkout; the extension expects a
**built, working** DSH workspace.

### 3. Understand the runtime the extension launches

The extension runs (as a child process):

```
<node.exe> --import tsx/esm <entry script> <deploy config>
```

- **Entry script** — `packages/examples/jsonrpc-demo/src/bin.ts` (the *jsonrpc-demo* example; its
  runner takes the config from `DSH_CORDIS_CONFIG` env, else `argv[2]`).
- **Deploy config** — `examples/jsonrpc-agent/cordis.yml`: wires `sdk-jsonrpc-server`,
  `llm-deepseek` (`thinking: enabled`), `dsh-bash-local`, `agent-spine` and JSONL session
  persistence. Its stdout is reserved for JSON-RPC.
- **Model** — *not* pinned in the config; the model is passed **per session over JSON-RPC**
  (`hello.dsh.model`, default `deepseek-v4-flash`).
- **API key** — the `llm-deepseek` plugin reads `DEEPSEEK_API_KEY` (its default env name) on every
  request. Other optional env vars used by the example: `DEEPSEEK_BASE_URL`, `DSH_CWD`, `DSH_MODEL`,
  `DSH_SYSTEM_PROMPT`, `DSH_MAX_TOKENS_AS_SUCCESS` … (see `examples/jsonrpc-agent/README.md`).

### 4. Configure the extension (wizard-first)

The recommended path needs **no hand-written settings**: open the panel, make sure you're on the
**Harness** tab, and click **配置 DSH** in the bottom bar (same path as the palette command
`AlohaDSH: 配置 DSH 运行路径`).

**First question — where should the runtime bytes come from?**

- **便携运行时目录（推荐）** — see [Portable runtime](#portable-runtime-recommended) below. Pick the
  folder; node, entry and config all come from its `runtime.json`. No tsx, no DSH checkout.
- **手工 node + 入口（developer path）** — pick your `node.exe`, then
  `…\deepseek-harness\packages\examples\jsonrpc-demo\src\bin.ts`; the wizard derives `runCwd`
  (the DSH repo root it finds), `tsconfig.json` and `examples/jsonrpc-agent/cordis.yml` for you.

Either way, finish with **保存并重启 live** — it writes the values into your **user** settings
(`hello.dsh.*`, `scope: machine` — never committed) and reconnects the live subprocess.

#### Portable runtime (recommended)

A *portable runtime* is a self-contained directory: a bundled `node`, a pre-built JSON-RPC entry,
a default `cordis.yml`, and a `runtime.json` manifest describing them. Point
`hello.dsh.runtimeDir` at it and the extension needs nothing else — **no tsx, no DSH checkout, no
`node` on your PATH**.

Windows has no downloadable DSH artifact today (`python/sdk-runtime/platforms.json` lists only
linux/macos, and the exe builder calls *"Windows is a documented non-goal"*), so you build one once
from a DSH checkout:

```bash
# --dsh <DSH checkout root>; --out defaults to dist-runtime/ (gitignored)
node scripts/build-runtime.mjs --dsh D:\DSH\deepseek-harness \
     --node D:\DSH\tools\node-v24.19.0-win-x64\node.exe
```

The script runs `pnpm deploy` against DSH's own SDK-runtime package, repairs the closure (restores
legacy hoists, materializes every symlink — the tree must be relocatable), copies the portable node
and [`runtime/cordis.default.yml`](runtime/cordis.default.yml) in, writes `runtime.json`, and
finishes with a bare smoke test. Then verify a runtime directory at any time, without VS Code:

```bash
node scripts/smoke-runtime.mjs --runtime dist-runtime   # sends one `initialize`, needs no API key
```

The bundled `cordis.yml` is **ours**, not upstream's minimal `runtime/cordis.yml` — the upstream one
omits `dsh-tool-fs` and would leave the agent without `read`/`write`/`edit`.

> ⚠️ **Known risk**: upstream positions the `packaged-bin.js` node carrier as dev-only and excludes
> it from distributions. This route is therefore not upstream-endorsed; our own build + smoke test is
> what backs it. Swapping the supplier later (an upstream Windows artifact, an internal package)
> only changes where the directory comes from.

Then set the API key once: click **API** in the bottom bar to store it in VS Code SecretStorage.
The key only ever goes into the child process env — never into settings, logs or the transcript.
(Alternative: export `DEEPSEEK_API_KEY` in the environment VS Code was started from, or set
`hello.dsh.credentialsFile` to a YAML with that key as a fallback.)

### 5. Verify & chat

On the Harness tab the top status dot shows the connection: gray 未连接 → blue 连接中 → green
**在线 · deepseek-v4-flash**. Type a message — the first send (or the panel opening, if paths are
already set) spawns the runtime, and you should see real tool-call cards and a streaming transcript.

---

## Settings reference

All keys live under `hello.dsh` and are `scope: machine` (read from user settings, not the repo).

| Setting | Default | Purpose |
|---|---|---|
| `hello.dsh.runtimeDir` | `""` | **Portable runtime (recommended).** A directory containing `runtime.json`. Takes precedence over `nodePath`/`loader`/`entry`/`config`/`runCwd`; an unusable directory is reported as an error rather than silently falling back. **Cross-restart session memory only works with a runtime produced by this repo's `build-runtime.mjs`** (it carries the resume patch); the developer path / `command` drive the user's own DSH, which has no patch — there a continued chat starts a fresh session and says so in a note. |
| `hello.dsh.nodePath` | `""` | *Developer path.* `node.exe` used to launch the runtime (must satisfy DSH `engines`). Ignored when `runtimeDir` is set. |
| `hello.dsh.loader` | `""` | Loader id passed to `node --import`. **Empty ⇒ inferred from the entry's extension**: `.ts`/`.tsx`/`.mts` ⇒ `tsx/esm`, anything else (a pre-built `.js`) ⇒ no loader at all. |
| `hello.dsh.entry` | `""` | *Developer path.* The jsonrpc-agent entry script. Ignored when `runtimeDir` is set. |
| `hello.dsh.config` | `""` | Runtime deploy config (`cordis.yml`) path. |
| `hello.dsh.runCwd` | `""` | Subprocess working directory so `tsx`/`@deepseek-ai/*` resolve. Falls back to the open workspace root. |
| `hello.dsh.tsconfig` | `""` | Sets `TSX_TSCONFIG_PATH` for tsx. |
| `hello.dsh.credentialsFile` | `""` | Fallback YAML containing `DEEPSEEK_API_KEY:` when the key is not in SecretStorage. |
| `hello.dsh.provider` | `"deepseek-official"` | Provider route reported at `initialize`. |
| `hello.dsh.model` | `"deepseek-v4-flash"` | Default model, sent per session; shown in the online status. |
| `hello.dsh.command` | `""` | If non-empty, **overrides the whole launch command** (ignores nodePath/loader/entry/config). |
| `hello.dsh.args` | `[]` | Extra arguments when `command` is used. |
| `hello.dsh.debug` | `false` | Stream child stderr / ignored JSON-RPC notifications to the Output panel (never secrets). |

A worked example (`settings.json`, **do not commit**) — portable runtime:

```jsonc
{
  "hello.dsh.runtimeDir": "D:\\hello-vscode-ext\\dist-runtime"
}
```

…or the developer path:

```jsonc
{
  "hello.dsh.nodePath": "D:\\DSH\\tools\\node-v24.19.0-win-x64\\node.exe",
  "hello.dsh.entry":    "D:\\DSH\\deepseek-harness\\packages\\examples\\jsonrpc-demo\\src\\bin.ts",
  "hello.dsh.config":   "D:\\DSH\\deepseek-harness\\examples\\jsonrpc-agent\\cordis.yml",
  "hello.dsh.runCwd":   "D:\\DSH\\deepseek-harness",
  "hello.dsh.tsconfig": "D:\\DSH\\deepseek-harness\\tsconfig.json"
}
```

Changing any path/model/key while the panel is open reconnects the live subprocess automatically
(the status dot follows). History lives in the extension's global storage; Harness sessions are kept
separate from Embedded-chat ones.

A second group lives under `hello.chat` (`scope: window`) — guardrails and review:

| Setting | Default | Purpose |
|---|---|---|
| `hello.chat.approval.enabled` | `true` | **Pre-execution approval.** Matching bash commands, and `write`/`edit` calls targeting paths **outside the workspace**, raise a confirm bar and pause the turn before running. Implemented as a `PreToolUse` hook (derived config in the extension's storage dir — **your `cordis.yml` is never modified**). **Turning it off also disables outside-workspace change visibility** (the hook is the only sensor). Requires a reconnect. |
| `hello.chat.approval.patterns` | see package.json | bash-side policy: any case-insensitive regex match raises the bar. Defaults cover `rm`/`rmdir`/`mkfs`/`dd of=`/`diskpart`/`format X:`/`git push --force`/`git reset --hard`/shutdown/fork bomb. Takes effect immediately. |
| `hello.chat.approval.outsideWorkspace` | `true` | **Outside-workspace write approval.** Turning it off only stops the *asking* — outside changes are still listed in the per-turn review while `enabled` is on. Temp dirs (`%TEMP%` / `/tmp`) are exempt from both. Takes effect immediately. |
| `hello.chat.approval.timeoutSec` | `540` | Seconds to wait before denying by timeout. |
| `hello.chat.reviewChanges` | `true` | Diff file changes after each turn and show a review bar (added/modified/deleted, inline diff, keep/revert). Changes **outside** the workspace are listed too, tagged with their directory. |

**Known limitation (not a bug):** the guardrail only inspects `write`/`edit` tool targets — paths
inside a bash command string are **not** parsed. So an agent writing outside the workspace via
`cp`/`mv`/`>` is neither gated **nor shown in the review**. Also, when the extension is unreachable
the fs side always allows (guardrail degrades, visibility stops with it).

---

## Real DSH components (react-live, optional)

When the harness transcript is rendered with DSH's own React components, the panel pulls in the
single-file bundle at `media/dsh-live/` (`dsh-live.js` + `dsh-live.css` + KaTeX `assets/`). That
folder is **gitignored** and is **not** built by this repo — it is produced by a *local, uncommitted
spike* inside the DSH checkout (`apps/web/dsh-webview/vite.config.mts`, run via
`pnpm --filter @deepseek-ai/dsh-web-frontend run build:dsh-webview`, `outDir` → this repo's
`media/dsh-live`).

- **Bundle present** → the whole panel takes DSH's theme tokens and the Harness transcript renders
  with the real conversation UI.
- **Bundle absent** (e.g. after a fresh clone) → the panel silently falls back to its own DOM
  transcript rendering; everything still works, it just looks like plain VS Code instead of DSH.

You do **not** need the bundle to use Harness.

---

## 内嵌聊天 (Embedded chat)

A small unfinished mode kept as a sandbox for the streaming/render pipeline (typewriter bubbles,
cursor, stop button, attachments, per-mode drafts/history). Its replies are **built-in canned text** —
no real model, no external calls — so treat it as a WIP, not a usable assistant. Harness is the
finished path.

---

## Project layout

| Path | Role |
|---|---|
| `src/chatViewProvider.ts` | Chat webview host: spawns the DSH runtime, handshake, message/tool streaming, mode & live-config logic |
| `src/dshRuntime.ts` | DSH JSON-RPC child-process lifecycle (spawn/handshake/heartbeat/events) |
| `src/sessionStore.ts` | Session titles & continuation persisted under global storage |
| `src/extension.ts` | Extension entry: commands + view registration |
| `media/chat.{html,js,css}` | Side-panel front end (mode pills + harness status dot; DSH theme tokens with VS Code fallbacks) |
| `media/dsh-live/` | **gitignored** — DSH single-file front-end bundle (see above) |
| `scripts/capture-dsh-frames.mjs` | Frame-capture tool for the DSH runtime (`DSH_CAP_*`) |
| `scripts/update-dsh.mjs` | Runtime-dependency governance: lock the DSH checkout to a tag, check drift, run the upgrade ritual + smoke (see `docs/runtime-dependency.md`) |
| `docs/runtime-dependency.md` | Governance decision for treating the DSH checkout as a versioned runtime dependency, the upgrade ritual, and the “when to switch to official npm” checklist |

Commands contributed by the extension: `AlohaDSH: 开始新对话`, `AlohaDSH: 配置 DSH 运行路径`
(plus the toy `AlohaDSH: 打个招呼` / `AlohaDSH: 读取当前文件第一行`).

## Development & security notes

- Build/test: `npm install` → `npm run compile` → **F5**.
- Never commit: `logs/` (real session frames), `.claude/` (local auth), `media/dsh-live/`
  (upstream-derived artifacts), `probe-*.html` / `probe-server.mjs` (local probes), `*.vsix`.
- The extension injects `DEEPSEEK_API_KEY` only into the child-process env; it must never appear in
  logs, transcripts, settings, or this repo.
