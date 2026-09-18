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

### Session history

The **历史** panel lists past sessions for the current mode, and now does more than match titles:

- **Full-text search** over message bodies plus each tool card's **name and arguments** (so you can
  find a session by the command you ran, e.g. `rm test.py`). Tool *output* and the grey status notes
  are deliberately not searched — they are noise for this purpose. Matches show a context snippet
  with the hit highlighted.
- **Export** a single session (⬇ per row, trash included) as **Markdown** (readable transcript;
  tool input/output clipped at 4000 chars) or **JSON** (lossless — attachments, usage and the DSH
  session identity included).
- **Delete is now a soft delete** (✕ moves it to the **回收站** tab, which can restore it). Removing
  something for good takes an explicit **彻底删除** or **清空回收站**, each behind a native modal
  confirm — restoring bumps the session back to the top of the list.
- **Deleting for good is now actually thorough**: those two actions also remove the session's DSH
  logs from disk (`<globalStorage>/dsh-sessions/…`), which used to be left behind in full. A fork
  shares its source's log, so a log still referenced by another session is kept — the confirm dialog
  says which case you are in.
- **Optional trash retention**: set `hello.chat.retention.days` and the trash tab gains a
  "purge N expired" button. It counts from the **deletion** time and only ever touches the trash —
  sessions you never deleted are reported but never removed — and it is **purely manual**.

Search scope and the trash are per-mode, like the lists themselves. Note that session storage is
shared per VS Code profile while each window keeps its own in-memory list: a session deleted in one
window can be written back by another window's next save, so use a single window.

A second group lives under `hello.chat` (`scope: window`) — guardrails and review:

| Setting | Default | Purpose |
|---|---|---|
| `hello.chat.approval.enabled` | `true` | **Pre-execution approval.** Matching bash commands, and `write`/`edit` calls targeting paths **outside the workspace**, raise a confirm bar and pause the turn before running. Implemented as a `PreToolUse` hook (derived config in the extension's storage dir — **your `cordis.yml` is never modified**). **Turning it off also disables outside-workspace change visibility** (the hook is the only sensor). Requires a reconnect. |
| `hello.chat.approval.patterns` | see package.json | bash-side policy: any case-insensitive regex match raises the bar. Defaults cover `rm`/`rmdir`/`mkfs`/`dd of=`/`diskpart`/`format X:`/`git push --force`/`git reset --hard`/shutdown/fork bomb. Takes effect immediately. |
| `hello.chat.approval.outsideWorkspace` | `true` | **Outside-workspace write approval.** Turning it off only stops the *asking* — outside changes are still listed in the per-turn review while `enabled` is on. Temp dirs (`%TEMP%` / `/tmp`) are exempt from both. Takes effect immediately. |
| `hello.chat.approval.timeoutSec` | `540` | Seconds to wait before denying by timeout. |
| `hello.chat.reviewChanges` | `true` | Diff file changes after each turn and show a review bar (added/modified/deleted, inline diff, keep/revert). Changes **outside** the workspace are listed too, tagged with their directory. |
| `hello.chat.retention.days` | `0` | Trash retention in days. `0` (default) = off, no button. Otherwise the trash tab gains a "purge N expired" button that permanently deletes items deleted more than N days ago, **DSH logs included** (irreversible). Trash only, and it never runs on its own. |
| `hello.chat.compaction.thresholdRatio` | `0.8` | **DSH's** context-compaction threshold, as a fraction of the window. Above the line DSH summarises a span of older events into a checkpoint — lossy and irreversible. `retainRatio` is derived automatically as `0.2 ×` this (a DSH constraint; the plugin refuses to load otherwise), so never set it yourself. At the default `0.8` with a 1M window that is 800K tokens, i.e. **it essentially never fires in normal use — lower it to make compaction actually happen.** Changes need a reconnect (the plugin reads its config at load time). |

**Known limitation (not a bug):** the guardrail only inspects `write`/`edit` tool targets — paths
inside a bash command string are **not** parsed. So an agent writing outside the workspace via
`cp`/`mv`/`>` is neither gated **nor shown in the review**. Also, when the extension is unreachable
the fs side always allows (guardrail degrades, visibility stops with it).

---

## Project agent profiles (`.hello-chat/profile.json`)

Model, approval policy and the tool whitelist all used to live in `cordis.yml` — a file you edit by
hand, outside your project. A **profile** moves that decision into the project itself, so it travels
with the repo and can be shared with everyone working on it.

```json
{
  "active": "严格",
  "profiles": {
    "严格": {
      "model": "deepseek-reasoner",
      "approval": { "enabled": true, "outsideWorkspace": true, "patterns": ["\\bdrop\\s+table\\b"] },
      "tools": { "deny": ["bash"] }
    },
    "省钱": { "model": "deepseek-chat" }
  }
}
```

Pick one from the **profile** menu in the config bar. Switching **always reconnects** the live
subprocess — the model is an `initialize` parameter, and the tool whitelist and approval switch are
read when the runtime starts. `active` is only a *suggestion* for whoever opens the repo; your own
choice is remembered per workspace and wins.

**A profile can only ever tighten, never loosen.** This is the property the whole feature is built
on, and it is enforced in one place (`compileProfile`):

| Field | What it does | Why it can't loosen anything |
|---|---|---|
| `model` | Overrides the model picker | Not a strictness axis. While a profile pins it, the model menu is greyed out and its title tells you to switch to 「不用 profile」 first — a silent no-op is never an option here |
| `approval.patterns` | **Unioned** with your settings' list | A union can only add; the ten defaults can't be deleted |
| `approval.enabled` / `outsideWorkspace` | **OR**ed with your settings | `false` is a *parse error*, not “turn it off” — writing it gets you a message, not a silent ignore |
| `tools.deny` | Those tools **disappear from the model's view** | There is no `tools.allow`; that direction can't express “only tighten” anyway |

The extension never writes your files — not `.vscode/settings.json`, not `cordis.yml`. The active
profile lives in the extension's own per-workspace storage, and the tool whitelist is applied by a
small plugin of ours mounted into a **derived** copy of the runtime config.

**Caveat worth knowing:** a write *inside* the workspace doesn't prompt (that's the C1 design), so
an agent can technically edit this file — and `.hello-chat` is excluded from the review snapshot, so
the edit wouldn't show up in the turn's diff either. Three things blunt that: the file has no
loosening direction to express; the runtime uses the copy captured when you activated the profile, so
editing the file changes nothing; and taking effect requires *you* to re-activate. The residue is
honest: if you re-activate without reading, you've signed off on whatever the file now says.

Parsing never throws. A bad field becomes one line in a warning and **the rest of the file still
applies** — check the menu: it shows the error count and the notification says which profile and
which field.

`.hello-chat/profile.json` is deliberately **not** in `.gitignore` — being shareable is the point.
It will show up in `git status`.

---

## Reliability: interrupt & continue

Stopping is a hard constraint of the wire, not a choice: there is **no cancel RPC**, so **stopping a
turn means killing the child process** (the next turn lazily respawns it). What this repo does is
make that visible, resumable and honest:

- **Stop is recorded, not lost.** An interrupted turn sets `lastTurn` on the session (persisted), its
  running tool cards turn into errors, and a grey note explains that the DSH-side memory is kept but
  the interrupted tool call's outcome is **unknown** (same wording the runtime gives the model when it
  repairs a dangling turn). A **Continue** bar then appears above the composer — click it and the last
  user message is **re-sent verbatim** onto the *same* DSH session, so the model picks up where it
  left off. The bar survives a window reload or a VS Code restart (the verdict is read off disk).
- **Errors really stop.** A turn that surfaces as an error now **kills the child process**. Before
  this, the UI said "error" while the process kept executing tools and its events were silently
  dropped — you couldn't see that work, but DSH remembered it.
- **Long turns are not mistaken for failures.** `session/prompt` returns an *ack*, not the turn's
  result, so a long tool-heavy turn legitimately takes a while to acknowledge. The ack timeout is now
  10 minutes, and if it ever does fire while the session is *known to be running*, the UI keeps
  waiting instead of declaring an error.
- **Stopping is gentler.** `kill()` now ends stdin first and force-kills only 2 s later, giving the
  runtime its own clean-exit path (`disposeAndExit(0)` → flush → fsync) — writes are batched at
  200 ms, and doing both in the same tick threw that batch away.
- **The transcript is written atomically, with a one-generation backup.** Since "delete for real"
  (C7) also removes a session's DSH log, the file under global storage can be the *only* copy left.
  It is now written tmp-file → fsync → rename (a half-written file is no longer possible), the
  previous generation is rolled to `<file>.bak` *before* the overwrite, and a load failure falls back
  to that backup instead of silently starting from zero. A genuinely corrupt file surfaces as a
  single warning; a first run with no file yet stays silent.

Trying to send while a turn is still running on the DSH side is refused with a hint to stop first
(the wire has no cancel, so that turn cannot be pre-empted). See `docs/wire-vocabulary.md` for the
full wire-method inventory this rests on.

---

## Run inspector: what this turn actually did

In Harness mode a run readout sits above the composer: `本轮 4 工具 · 11.2s`. Click **查看** for the
full timeline of the turn — every step's duration, every tool call's name and duration, which one
failed, and this turn's error text. Once earlier turns are still on record the bar says
**最新一轮** ("latest turn") and each overlay row says **第 N 轮** ("turn N") — the readout itself is
word-for-word the same in both places.

- **Timing costs nothing to collect.** Every event envelope already carries `time` (epoch ms);
  durations are a subtraction, so tool timings are exact rather than sampled.
- **Tools are grouped by step, and every step gets its own row.** DSH runs one model call per step
  (possibly with one tool), and a step's duration = model latency + tool latency, so the two are not
  redundant. A step that called no tool is **still a row** rather than a footnote — folding it away
  made the step numbers skip, and those steps are often the slowest ones.
- **Four states, kept apart.** 成功 / 失败 / 运行中, plus **未知 (unknown)**: a call whose result never
  arrived because you stopped the turn, the process was killed, or DSH itself repaired an interrupted
  turn. It may well have run, and reporting it as a failure sends you chasing a problem that does not
  exist — or worse, retrying a command that already took effect.
- **DSH's turn repair is not blamed on us.** Repair frames (`TOOL_NOT_STARTED` / "outcome is unknown")
  **say "unknown" in their body while carrying `isError: true`**, so the verdict has to be three-state
  rather than a boolean; and they match no call at all, which the overlay reports as
  「Harness 代写的，不是故障」 separately from a genuine pairing-key failure.
- **Memory only, last 20 turns.** Reloading the window clears it (which is also why it does not span
  sessions). Nothing is persisted, nothing enters the transcript, and **no bodies are kept** — tool
  inputs/outputs are dropped so this can never become a second path around the `toolInput` fuse.
  819 streaming-text frames are not recorded either: what you need here is a timeline, not a second
  copy of the transcript.

---

## Context window & compaction

**DSH already compacts on its own — you just cannot see it.** The portable runtime composes
`@deepseek-ai/dsh-compaction-basic` (`runtime/cordis.default.yml`), and once prompt pressure crosses
its threshold it folds a span of older events into a summary checkpoint. That is DSH replacing its own
memory: **lossy, and not undoable from here.** Up to now the three session events it emits
(`compaction/start` / `summary` / `end`) were forwarded to the extension and **simply not read**, so the
moment your model's memory got folded, the UI said nothing at all. Now:

- **The transcript gets a note** ("上下文已压缩：前 N 条事件（约 X token）已折叠成摘要…") plus a count on
  the usage bar (**已压缩 N 次** — the note scrolls away, the count does not). A failed compaction says so
  too, and says the memory was **not** touched. The summary body itself is deliberately **not** echoed
  into the transcript — that would be pouring a second-hand recollection into your record.
- **The usage bar carries the occupancy**, appended to the existing readout: `上下文 24.0K / 1.0M`, with
  `⚠ 接近压缩阈值` once you are near the line and `· 上次` when the number is the last sample from a
  previous run rather than live.
  ⚠️ **The two numbers are not the same number.** The bar's occupancy is the provider-reported prompt-side
  pressure; DSH decides to compact using its own `token-meter` heuristic. So the UI says "near" and never
  "X tokens until compaction" — the tooltip spells this out.
- **You can move the line**: `hello.chat.compaction.thresholdRatio` (default `0.8`, i.e. DSH's own value).
  It is written into a *derived* copy of your `cordis.yml` in the extension's storage dir — your file is
  never modified — and `retainRatio` is rescaled with it, because the plugin refuses to load if retention
  is not below the threshold. Requires a reconnect. At the default this line is ~800K tokens on a 1M
  window, so **in normal use it will never trigger**; lower it if you want to see compaction happen.
- **Folding the transcript is a different thing entirely.** Once a session grows past 60 messages the
  older ones collapse behind a 「更早的 N 条已折叠」 row. That is **purely a rendering change** — no
  message is lost, the snapshot payload is not one byte smaller, and DSH's context is untouched. It
  exists because the webview rebuilds the whole message DOM on every frame.

**Cannot be done from here** (checked, not assumed): compaction cannot be triggered on demand — the wire
has no compaction RPC, the `/compact` command is not composed, and its executor has no caller in the
JSON-RPC path. DSH's `session.jsonl.zstd` cannot be archived either: it is an append-only log with zstd
frame boundaries and offset repair, so editing it breaks continuation outright.

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
| `src/sessionStore.ts` | Session titles, soft delete/trash, retention rules & continuation persisted under global storage; atomic write with a one-generation `.bak` and a load report (`source`/`reason`) that tells "first run" apart from "corrupt" |
| `src/turnState.ts` | Turn-state verdicts: whether a session needs a “Continue”, and whether the DSH side is known to be running (pure, no `vscode`) |
| `src/runInspector.ts` | Run inspector: the per-turn frame timeline (tool sequence / turn·step·tool durations / this turn's error). **Memory only, last 20 turns**, every duration is a subtraction of the `time` the envelope already carries (pure, zero imports) |
| `src/sessionSearch.ts` | Full-text search over stored transcripts (pure, no `vscode`) |
| `src/sessionExport.ts` | Transcript → Markdown / JSON, and safe default file names (pure, no `vscode`) |
| `src/compactionNotice.ts` | Turns DSH's `compaction/summary` / `compaction/end` payloads into a transcript note — degrades to “details missing” rather than going silent, reports success exactly once, and never copies the summary body into the transcript (pure, no `vscode`) |
| `src/contextWindow.ts` | The occupancy readout's two verdicts: **where the denominator comes from** (look at the live `request/context` value, else the one remembered on the session) and whether the warn line has been crossed. Split out of `chatViewProvider` after a real F5 missed a bug for a whole round — the panic button here is that `request/context` is **never** re-sent when you continue a session (DSH compares against a log-derived `previousContext`), so without the remembered denominator the whole indicator silently doesn't exist (pure, no `vscode`) |
| `src/agentProfile.ts` | C12 project profiles: reads and validates `.hello-chat/profile.json` (never throws — one bad field is one message, the rest still applies) and compiles profile + settings into the policy actually in force. **The “only tighten” property lives in `compileProfile` and nowhere else** (pure, no `vscode`) |
| `src/toolPolicyPlugin.ts` | C12's tool whitelist: the small cordis plugin (generated into global storage, mounted into the derived config) that calls `tools.restrict({deny})` on each `agent/created`. No state file, unlike the C11 effort plugin — the policy is read once at agent creation, so it only changes on a reconnect (pure, no `vscode`) |
| `src/dshPaths.ts` | DSH session-log path algorithm (**copied verbatim from the persistence plugin**) + guarded removal (pure, no `vscode`) |
| `src/extension.ts` | Extension entry: commands + view registration |
| `media/chat.{html,js,css}` | Side-panel front end (mode pills + harness status dot; DSH theme tokens with VS Code fallbacks) |
| `media/dsh-live/` | **gitignored** — DSH single-file front-end bundle (see above) |
| `scripts/capture-dsh-frames.mjs` | Frame-capture tool for the DSH runtime (`DSH_CAP_*`) |
| `scripts/dsh-session-log.mjs` | Shared probe helper: locate the harness session store / the DSH session logs under it, and decode a `session.jsonl.zstd` (frame-splitting by magic + span-retry — a single `zstdDecompressSync` only gets the first frame). A copy in each probe would drift, and the drifted copy is the one that one day quietly says “pass” |
| `scripts/probe-session-tools.mjs` | Self-check for search/export/soft-delete plus the storage hardening (atomic write, `.bak` roll, backup fallback, `toolInput` fuse) (`npm run compile` first; no VS Code, no API key) |
| `scripts/probe-purge.mjs` | Self-check for path parity / guarded removal / retention boundaries (same; **path parity needs Node ≥ 22.15** and points you at `dist-runtime/node/node.exe` otherwise) |
| `scripts/probe-turn-state.mjs` | Self-check for the Continue-button verdict + online status tracking (same; no VS Code, no API key) |
| `scripts/probe-approval-shell.mjs` | Self-check for the C1 approval hook's shell-form verdict: at least one form runs, the two are mutually exclusive, and the second form rescues a wrong first guess — plus the pure-function rules for the platform prior and for inconclusive failures (timeout / silent non-zero exit), which are retried exactly once (same; no VS Code, no API key) |
| `scripts/probe-approval-roundtrip.mjs` | Self-check for the C1/C4 **decision round-trip** — a real `ApprovalServer` + a real generated hook script + real HTTP + a real child process, all outside the extension host: allow prints nothing, deny lands on `permissionDecision` with our reason, the bar only appears when the policy asks, a second answer to the same id is refused, timeout and `cancelAll` both end in deny, and the two fail-safe dials are pinned separately (bash falls back to the built-in dangerous list when the server is unreachable, `write`/`edit` fall back to **allow**), plus a wrong/absent token being rejected. It never executes anything: the hook only asks. First run caught a real one — the server's hard-coded reason said “该命令” even for a file write, so the tool-specific wording the hook carried was dead on the reachable path (same; no VS Code, no API key) |
| `scripts/probe-run-inspector.mjs` | Self-check for the C9 run inspector: frame filtering (5000 `assistant/chunk` must change nothing), call/result pairing (including DSH repair frames' three-state verdict and a conservation law over them), the outcome precedence table, ring/dropped caps, and a replay of both the newest capture in `logs/dsh-frames/` **and** a real `session.jsonl.zstd` cross-checked against independently derived oracles (same; no VS Code, no API key). The session log is picked as the newest one that actually **carries repair frames** — those only appear when a turn is interrupted, so always taking the newest just meant a false red every few sessions |
| `scripts/probe-compaction-notice.mjs` | Self-check for the C10 compaction notice: the plugin's `compaction/summary` and `compaction/end` payloads turn into a transcript note, never silently (`undefined` only for unrelated types), exactly once per successful compaction, and **never** echoing the summary body into the transcript. The second half cross-checks the real `compaction/*` frames in a stored DSH session log against the notes we persisted — **word for word, same order**, with the done-count conserved against the session's `compacted` field (same; no VS Code, no API key) |
| `scripts/probe-compaction-override.mjs` | Self-check for the C10 threshold override: anchored rewriting of the two `compaction-basic` ratios only (exactly two lines differ, CRLF kept, idempotent, sibling `modelPolicies[].thresholdRatio` untouched, 9 rejection cases), `retainRatio < thresholdRatio` held across the whole range, and **the default value produces a byte-identical file** — which is what makes C1's zero-regression structural rather than luck (same; no VS Code, no API key) |
| `scripts/probe-context-window.mjs` | Self-check for the C10 occupancy denominator: live value wins, **a missing live value falls back to the one remembered on the session** (the regression case for a bug a whole F5 round missed — continue a session and the bar showed nothing at all), junk values count as “unknown” rather than as a window, the warn line is `threshold × 0.85` (including the `0.02`-threshold arithmetic of that real run), a corrupted threshold falls back to the default, and both the denominator and the last reading survive a store round-trip (same; no VS Code, no API key) |
| `scripts/probe-webview-render.mjs` | Self-check for `media/chat.js` rendering, run in Node behind a minimal DOM shim (the only way to exercise that code before F5): the usage bar's `near` / `stale` / `compacted` states and its `.near` class, the transcript fold (head folded, correct count, expand restores everything, reset on session switch), the same fold replayed over the **longest real stored session** (99 messages / 56 tool cards), plus a small C9 runs-bar/panel regression sample and the C11 effort menu (default 「跟随配置」, the ✓ on the current row only, the value posted by each pick — and that a `thinking: disabled` base config greys the three rows *and* attaches no click handler at all, so a greyed row cannot post even by accident), plus the C12 profile menu (「不用 profile」 always first as the way out, the ✓ on the current row only, exactly one `set-profile` per pick and `null` for the escape hatch, a pinned model greying every model row *and* leaving them with no handler *and* hiding the “custom model” entry — with the counter-control that an unpinned menu is still clickable — the “profile.json 已改动 · 点这里重新应用” row being able to **post**, precisely because it targets the current item, and busy disabling the trigger while collapsing the menu so those rows aren't reachable in the first place). It has already caught two real bugs of the “a shadow that lies is worse than no shadow” kind (same; no VS Code, no API key) |
| `scripts/probe-derived-config-boot.mjs` | Boots the portable runtime the way the extension spawns it — base config as the **positional** arg, derived config only via `DSH_CORDIS_CONFIG` — with one positive control (a valid override loads) and one negative control (a derived file violating the plugin's load-time `retainRatio < thresholdRatio` rule **must** fail to boot). The negative control is the point: it proves the env var wins, which is the single thread C1 and C10 both hang on (same; no VS Code, no API key) |
| `scripts/probe-effort-plugin.mjs` | Self-check for the C11 per-session reasoning effort, in three parts: the pure rules (`normalizeEffort` never guesses; `thinkingDisabledInConfig` only reads the `llm-deepseek` block; the generated derived block's quoting when a path contains a single quote; **nothing extra in the derived file when no effort is requested**; an un-mountable block warns instead of throwing — and C1's own throw is still intact); the **plugin's own decision table**, loaded as a plain module with a fake `ctx` (hit / miss returns *the very object upstream returned* / no `agent` in the payload / missing or corrupt state file / an illegal value / `thinking` disabled lets only `off` through / an upstream throw must propagate, not be swallowed) including the “state file is re-read on **every** request” case that *is* the hot-swap claim; and a real end-to-end boot where the derived config mounts the real plugin and the stored `request/header` must read `reasoningEffort: "low"` — with a negative control proving an unset session gets **the base config's own default**, not our value. plus a structural guard born from a real F5 bug: `_actives[this._mode] =` may appear **exactly once** (inside `_setActive`), and that method must replay the config bar — otherwise switching sessions leaves the effort menu showing the *previous* session's value, silently. Runs on a **fake API key**: the request 401s, but `request/header` is written at build time, so the assertions hold and nothing is spent (same; no VS Code, no API key) |
| `scripts/probe-agent-profile.mjs` | Self-check for the C12 project profiles, in four parts: **parsing** (missing file / not JSON / root is an array / wrong field types / unknown fields / over-long names / unknown tool names — every one of them becomes a message, none of them throws, and the good half of the file still applies); **the “only tighten” table** (settings off + profile `false` ⇒ still off; settings off + `true` ⇒ on; settings on + `false` ⇒ **still on**, with the end-to-end path from file text through parse to compile so `false` can't slip past the parser either; `patterns` as a union that can't delete a default and can't be emptied; `outsideWorkspace` with the same positive/negative controls) — this is the section the whole feature rests on; the **plugin's decision table**, loaded as a plain module with a fake `ctx` (deny given ⇒ `restrict` gets exactly that filter; deny empty/missing/not-an-array ⇒ **`restrict` is never called**, which is what makes an unmounted profile byte-identical to no C12 at all; non-string entries filtered; missing `agent`/`ctx`/`tools` doesn't throw; a throwing `restrict` must not bubble, since that would take the whole session down); and a real end-to-end boot where the derived config mounts the real plugin and the stored `request/header.header.tools` must have **no `bash`** and **still has `read`** — with the counter-control proving an unprofiled run *does* have `bash`, without which “no bash” could just mean the turn never assembled tools at all. Runs on a **fake API key** (the request 401s; the header is written at build time) (same; no VS Code, no API key) |
| `scripts/probe-c8-runtime.mjs` | Runtime spike for C8: queued second prompt, kill-then-resume turn repair, graceful vs hard kill. **Needs an API key** and spends real model turns |
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
