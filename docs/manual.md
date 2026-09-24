# AlohaDSH manual

Full documentation for **AlohaDSH**. The landing page is [README.md](../README.md) (English) · [README.zh-CN.md](../README.zh-CN.md) (简体中文).

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
and [`runtime/cordis.default.yml`](../runtime/cordis.default.yml) in, writes `runtime.json`, and
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
| `hello.dsh.bashPath` | `""` | **Windows only, usually leave it empty.** Absolute path to a `bash.exe` (or any bash) whose directory is **prepended to the runtime child's `PATH`**, so the agent's `bash` tool resolves to *that* one instead of whatever the machine's `PATH` finds first. Empty ⇒ the child's environment is passed through **byte for byte**. Pointing it at a file that doesn't exist is reported (never silently ignored) and can be cleared from the warning itself. See *Windows: which bash the agent gets* below. |
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

### Windows: which bash the agent gets

The agent's `bash` tool is hard-wired to `bash -c <command>` and **upstream has no setting for the
shell** — it is resolved on `PATH`, first hit wins. On Windows the first hit is often
`C:\Windows\System32\bash.exe`, the **WSL launcher**: if no distro is installed (or WSL is still
cold-starting), every shell command comes back as a wall of `bash` errors — and because that launcher
writes them as **UTF-16LE on stdout**, what you see is mojibake rather than anything readable.

The panel therefore reports which bash the runtime child would actually get, as one segment in the
top status line:

| Segment | Meaning |
|---|---|
| *(nothing)* | A usable bash that isn't the WSL launcher — nothing to say. |
| `bash=WSL` (amber) | Working, but it's the WSL launcher: the agent's commands run **inside WSL**, so `D:\…` paths and the Windows toolchain aren't there. |
| `bash=?` (amber) | The probe couldn't reach a verdict (a timeout, or a launcher that died without saying anything). **Never** treated as broken — that's what a cold start looks like. |
| `bash=坏` (red) | No usable bash. This is the one case that also raises a warning, once per activation, with two ways out. |

Two ways out of a broken or wrong shell, both under your control:

1. **Install a real bash** — [Git for Windows](https://git-scm.com/download/win) supplies one at
   `C:\Program Files\Git\bin\bash.exe`. The warning offers the two `wsl --install` / `wsl --list`
   commands as *text*; the extension never runs them for you.
2. **Pin one you already have** — the warning's **钉住这个 bash** button writes
   `hello.dsh.bashPath` for you (machine-scoped, so it can't end up committed in a repo). It only
   offers a bash it just **probed successfully** in this session. Set it by hand to switch from a
   WSL bash to Git Bash, or back. Clearing the setting restores the previous behaviour exactly.

**Paths are shown, never rewritten.** When a tool call targets a POSIX-shaped path, the approval bar
adds a note spelling out both readings — e.g. model wrote `/mnt/d/x` while the tool will resolve it
the Windows way, landing on `D:\mnt\d\x` — and says that such a call gets **no pre-turn snapshot**,
so the change won't appear in that turn's review. There is deliberately **no** “use `D:\x` instead”
button: silently rewriting the agent's file paths is a behaviour change, not a display one.

Diagnosis runs once per activation and is shared with the approval self-check, so the two together
cost `max`, not `sum` — a cold WSL start doesn't get paid for twice.

### Session history

The **历史** panel lists past sessions for the current mode, and now does more than match titles:

- **Full-text search** over message bodies plus each tool card's **name and arguments** (so you can
  find a session by the command you ran, e.g. `rm test.py`). Tool *output* and the grey status notes
  are deliberately not searched — they are noise for this purpose. Matches show a context snippet
  with the hit highlighted.
- **Export** a single session (⬇ per row, trash included) as **Markdown** (readable transcript;
  tool input/output clipped at 4000 chars) or **JSON** (lossless — attachment content/metadata,
  usage and the DSH session identity included; **image attachments keep only a path and metadata,
  never bytes** — the whole attachment array is persisted verbatim, see `src/imageAttach.ts`).
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

**Branching and comparing (分支与对照).** Branching a session (**在新对话中分支**) copies the transcript
into a new session and switches you to it — the original stays in **历史**. The **对照** button in the
header opens a read-only overlay that puts two sessions side by side: the messages they share are
folded away, and what you see is what each side has done **since the fork point**, with that point
spelled out in the line above. Nothing is sent, nothing runs in parallel — it is a snapshot, taken
when you open it, change a side, or hit 刷新.

There is one thing the overlay exists to tell you that no other screen does: **a fork shares its
source's DSH memory.** Continue the conversation in either side and the model sees both — the
overlay says so in a warning-coloured line. That verdict is not guessed: it is read from the live
session mapping first and from the stored identity second (the disk record alone would miss exactly
the case this warning is for). Two unrelated sessions, or two sessions whose identity can't be
determined, say so plainly and get no warning colour — a warning that fires when nothing is wrong
is a warning nobody reads. A branch title carries a 「（分支）」 suffix to make the default pairing
obvious; either side can be repointed through the **选择会话** button in its own pane head, which
lists every session in the current mode with the two sides already picked out and greyed.

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

In Harness mode the **readout row** above the composer carries the run readout:
`本轮 4 工具 · 11.2s`. **运行记录 ›** at the end of the row opens the full timeline of the turn —
every step's duration, every tool call's name and duration, which one failed, and this turn's error
text. Once earlier turns are still on record the row says **最新一轮** ("latest turn") and each
overlay row says **第 N 轮** ("turn N") — the readout itself is word-for-word the same in both places.

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

### The readout row: one row, not a card; occupancy is a ring, not a line of text

The **readout row** above the composer says one thing: what this turn did, with **运行记录 ›** at the
far end. It has **no border and no background** — that is deliberate. The **usage** readout (this
turn's and cumulative tokens, plus the context occupancy) is **not** on this row: it is a **small ring
in the config bar**, sitting **between the model picker and the reasoning-level knob** — see the next
section.

- **The strips around the composer come in two kinds.** The ones that need **you to act** (approval,
  review, 「继续」) are **cards**: a border, a background, a surface. The ones that are merely there
  **to be read** (usage, runs) are a **row**: one line of dim text that gets out of the way. The
  number of cards now matches "does this need you to do something" one-for-one — four identical soft
  cards side by side made a readout weigh as much as an action, so nothing stood out.
- **Only "nearing the compaction threshold" changes colour.** Of everything around the composer,
  **only that one ring** turns warn-coloured. Because nothing else shouts, this one is audible when
  it does.
- **运行记录 › is dimmed by default** — visible, but clearly lighter than the run readout — and goes
  to full when you hover the row or Tab to it; Enter opens the overlay. It is **always there** (its
  width is reserved, so the text to its left does not reflow as the pointer moves in and out). On
  touch devices there is no hover, so it stays at full.
- **No word was lost**: the run readout has its own tooltip (hover for the full readout) and is
  ellipsised when the panel is narrow; the ring carries every number in its own tooltip.

### The context-usage ring: how much is left, at a glance

The small ring in the config bar, **between the model button and the reasoning-level button**, draws
**how much of the context window this conversation is using**: it grows clockwise from 12 o'clock, and
a full circle is a full window. It is the **same square button** as the two knobs beside it (same size,
same rounding, same highlight under the pointer). Hover it and the whole readout is there — this turn's
and cumulative tokens, the cache hit rate, the occupancy in absolute terms and as a percentage, how many
times the session has been compacted, and how each of those numbers is arrived at. **Click it and those
same numbers are laid out line by line** — see below.

- **The ring expresses a ratio, so the ratio lives on the ring.** On a 1M window the percentage sits
  at 0.x% for a long time, and a figure that always reads "0%" is the same as no figure at all; a
  ring's length tells 1% from 30% at a glance. The exact numbers are in the tooltip.
- **It turns warn-coloured as you near the compaction threshold** (the line set by
  `hello.chat.compaction.thresholdRatio` — see the next section). **Only the ring changes colour**;
  nothing else around the composer does, which is why it is audible when it does. (Its two neighbours
  light up under the pointer too, but that is feedback about where your cursor is — a *state* colour is
  still this one thing only.)
- **When the sample is the last one a previous run left behind, the ring is drawn dimmer** and the
  tooltip says so (「上次」). Stale and live have to be distinguishable at a glance — otherwise you
  are holding a number of unknown age.
- **With no usage data at all the ring is still there** (a brand-new conversation is exactly this):
  the arc is empty (0), and the tooltip and popover read 「本轮尚无用量」 plus a line saying the numbers
  start after the first request. It **does not print digits** — reading nothing can also mean "we
  cannot assemble this session's figures", which is *unknown*; `↑0 ↓0` would turn that into a lie.
  So **the ring reads 0 while the words say "none yet"**. For the same reason, **a payload carrying no
  context section leaves the ring but draws no arc** — because 「已压缩 N 次」 is the one reminder that
  never scrolls away with the transcript. The price is that **an arc-less ring may mean "0% used" or
  "unknown"**: hover it, or open the popover, and the two are told apart at once — that section's row
  is simply **not there** (a screen reader hears 「暂无数据」).
- **Clicking it opens a read-only popover**: the same readout **laid out line by line** (one
  label/value pair per row, with the values sharing one left edge), and a rule separating it from the
  notes on how the numbers are arrived at (how each is computed, and why "nearing the threshold" is
  not "about to compact"). There is nothing selectable inside — it just spreads the numbers out, and
  no click in it triggers anything. Click again, click elsewhere, or press Esc to close it.
  **Tab to it and press Enter or Space and it opens the same way** — that is how keyboard and
  screen-reader users reach all of it (the native tooltip only appears under a hovering pointer).
- **One deliberate difference from the two knobs beside it: it is never disabled while a run is in
  flight.** Changing the model, the reasoning level or the profile restarts something or rewrites
  configuration, so those grey out mid-run; **the readout should be readable at any time**, and a
  running turn is exactly when you most want to see it. For the same reason, sending a message does
  not close it (a popover belonging to one of the other three knobs would be closed).

---

## Context window & compaction

**DSH already compacts on its own — you just cannot see it.** The portable runtime composes
`@deepseek-ai/dsh-compaction-basic` (`runtime/cordis.default.yml`), and once prompt pressure crosses
its threshold it folds a span of older events into a summary checkpoint. That is DSH replacing its own
memory: **lossy, and not undoable from here.** Up to now the three session events it emits
(`compaction/start` / `summary` / `end`) were forwarded to the extension and **simply not read**, so the
moment your model's memory got folded, the UI said nothing at all. Now:

- **The transcript gets a note** ("上下文已压缩：前 N 条事件（约 X token）已折叠成摘要…") plus a count on
  the readout row (**已压缩 N 次** — the note scrolls away, the count does not). A failed compaction says so
  too, and says the memory was **not** touched. The summary body itself is deliberately **not** echoed
  into the transcript — that would be pouring a second-hand recollection into your record.
- **The ring is the occupancy**, with the whole readout in its tooltip: `上下文 24.0K / 1.0M`, plus
  `⚠ 接近压缩阈值` once you are near the line and `· 上次` when the number is the last sample from a
  previous run rather than live.
  ⚠️ **The two numbers are not the same number.** The ring's occupancy is the provider-reported prompt-side
  pressure; DSH decides to compact using its own `token-meter` heuristic. So the UI says "near" and never
  "X tokens until compaction" — the tooltip spells this out.
  ⚠️ When you are near the threshold **only that ring changes colour** — of everything around the
  composer, it is the only place that does (see "The context-usage ring" above).
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
| `src/shellDiag.ts` | C13's shell diagnosis: which `bash` the runtime child would actually get (`resolveOnPath` models libuv's real search — **not** `PATHEXT`), whether that one is usable (**three-valued**: usable / broken / *indeterminate*, the last one being a timeout or a launcher that died silently, i.e. what a cold start looks like), the UTF-16LE decode of the WSL launcher's failure text, the status-line segment and warning wording, and `prependPathDir` (the “pin a bash” lever — empty input returns the **same object**, and it never drops `PATH` without re-adding it). `readPosixTarget` gives the two readings of a POSIX-shaped path for display only (pure, no `vscode`) |
| `src/changeForecast.ts` | C14's before-the-fact preview: turns one `tool/call`'s arguments into “which file this call is about to touch, and roughly what it will look like afterwards”. `write` diffs the incoming `content` against **the file as it is on disk right now** (read through C4's own `snapshotSingleFile`, so the binary/oversize/budget gates are the same ones the review uses — not a second reader to drift from it); `edit` diffs only the replacement fragment and refuses to simulate *which* occurrence DSH will pick, which would be a guess. It also says out loud what it can already tell will fail (0 hits, >1 hit with `replace_all` off, identical old/new text, missing file), normalising line endings **before** counting hits — this repo is itself CRLF/LF mixed, so an unnormalised `indexOf` would report “can't find that text” for an edit that would have succeeded. `resolveTargetPath` is the one piece moved out of `chatViewProvider._fsTargetAbs` (which now delegates): the card's path and the approval bar's path must come out of the same function, or the same turn shows two different readings. `actualForecast` reads `tool/result.meta.diffs` — the real hunks DSH always sent and this extension never read — where `{hunks: 0}` (new file **or** unchanged content, indistinguishable) is kept distinct from “no diffs in this result at all” (pure, no `vscode`) |
| `src/branchCompare.ts` | C15's compare view: every verdict the side-by-side overlay shows, with no `vscode` import (same reason as C10b — a judgement that can only be loaded inside the extension host can only be checked by eye). The fork point is found by **comparing message ids**, because an id embeds the uuid of the session that produced it (`_nextMsgId()`), so a forked copy's ids still carry the *source's* uuid while everything after the fork carries the fork's: the common prefix **is** the fork point, and it survives generations. It deliberately never falls back to text similarity — two hand-copied near-identical sessions are reported as “no shared messages”, which is the honest answer. `drifted` counts same-id/different-content messages (the fork is normalised in place after the copy is taken, so this can legitimately happen) and is a hint, not a diff. `crossTalkOf` decides whether the two sessions share one DSH memory from **two pieces of evidence in a fixed order**: the live `_dshSessions` mapping first, the disk record second — disk-only would silently *not* warn in exactly the case this feature exists for, because when the C5 patch is unavailable (or `hello.dsh.command` overrides everything) `_ensureDshSession` returns early and never writes an identity, so both sides' disk records are empty while the two sessions really do share a memory. Same dsh id but a different cwd is `unknown`, not shared: DSH attributes session logs by cwd. `frozenTail` deep-copies the tail and applies C10/C15's freeze rule without ever touching the original (pure, no `vscode`) |
| `src/approvalTrust.ts` | C16's trusted-command memory: the whitelist behind the confirm bar's 「永久信任此命令／此目录」, as a pure module with no `vscode` import (the C10b rule again). What makes it a guard rail rather than a back door is that a bash key is the **byte-exact pair `(command, cwd)`** — no `trim`, no whitespace folding, no case folding, no prefix/`includes` matching — at the honest cost that a model that rewords the command gets asked again; the alternative (prefix matching) would quietly repeal the `\brm\b` pattern the settings already offer. A `dir` entry covers `write`/`edit` targets through the shared `isInsideDir` (`path.relative`, never `startsWith`, or `D:\proj2` would be covered by `D:\proj`), and the two kinds never overlap. **Whether the bar may offer trust at all is decided here, not in the webview**: bash always may (unless the command reached the server's 32 KB truncation line, where two different commands can arrive as the same string — so a truncated command can be neither offered nor matched), and a directory may unless it is a drive root or contains/equals the home directory, one rule covering both `C:\` and `C:\Users`, because handing over an entire disk with one click is not what that button is for. Entries carry **no id**: removal and de-duplication go through `identityOf`, which keeps the file hand-readable and hand-editable. Parsing is fail-closed per entry (field types, the `kind` whitelist, non-empty command/dir, an absolute non-forbidden dir) — an entry like `{"kind":"bash"}` with no command **must** be dropped, because an empty command is an “everything matches” back door, and a non-string `cwd` drops the entry rather than silently widening it to “no workspace”. `readTrustFile` reports `corrupt` for the warning only; every failure path degrades to “ask every time”, never to “allow everything” |
| `src/imageAttach.ts` | C17's image attachments — the honest-degradation half: recognising an image, giving it a landing place the agent can actually reach with a command, and saying out loud that the model cannot see it — since **C17b (2026-09-23) that last part is delivered through the system prompt, not the user message** (see the last paragraph of this cell). Pure, no `vscode` import (the C10b rule). **It does not get pictures to the model and cannot**: `session/prompt` does carry `{type:'image'}` blocks, but they hold a *stored reference*, and the byte-submitting path (`EncodedImageAttachment` → `admitEncodedImages`) is consumed only by the ACP adapter and the command executor — the vendored jsonrpc server's `prompt()` never calls it; the portable runtime mounts no attachment store, so `ctx.attachments` is undefined and `read_image` is never registered; and `deepseek-v4-flash` declares no `inputModalities`. The judgement is **magic bytes before extensions** (a `.png` can hold text, a `shot.txt` can hold a real PNG) and **"not recognised" means "not an image"**, never a fallback to reading it as text — that fallback is exactly today's nastiest defect, where a small icon was read as `'utf8'` mojibake straight into the prompt. The accepted set is **the upstream four** (`png`/`jpeg`/`webp`/`gif`, copied from `dsh-attachment`) and deliberately *not* `fileSnapshot.BIN_EXT`, which answers a different question and carries ico/bmp/pdf/zip; extensions only name the stored file and shape the refusal wording. `imageBytesAllowed` is its own function so that "at most N" — and therefore "exactly N passes" — is pinned outside the extension host, where a `>` typed as `>=` would surface only as “some screenshots mysteriously get rejected”, a failure with no scene. `safeImageFileName` treats its input as hostile: strip the directory, drop control characters, drop trailing dots/spaces, cap at 80 characters, prefix Windows reserved names, take the extension from the sniffed type rather than the name, de-duplicate with `-2`. Whatever is stored lands in `<workspace>/.hello-chat/images/` (`IMAGE_DIR_REL`) — inside the workspace on purpose, because an agent that can reach it with a command is the *only* real value this degradation buys — and `MAX_IMAGES_PER_MESSAGE` is a cap on how much gets written into the user's workspace, not a model requirement. The note never contains `@"` (DSH's `@` syntax is for session references only, and would point the agent at a text tool) and always carries **three** things — “you cannot see the picture”, “**do not try to make it visible with tools**”, and “do not guess from the file name” — because a model that has seen a great many image conversations will otherwise describe a `.png` path in confident detail. The middle sentence was added from a real machine run (2026-09-23): the original wording said “handle this file with a command or tool (copy, **convert**, inspect metadata, hand it to the user)”, which read as an invitation — asked only “what is this?”, the agent downloaded `get-pip.py` and installed pip/Pillow/numpy/opencv/onnxruntime/rapidocr into WSL, plus an attempt at `sudo`, with no approval raised (bash is judged only by the destructive-command patterns, so `pip install` matches nothing). Making the file *readable* is a road that goes nowhere and now says so. The one thing deliberately left open is the reverse error: a sentence permitting command use *when the user explicitly asks for something to be done to the file* keeps “move this file to X” working, since a note that is too tight is a different kind of wrong. The same run produced the path line: the agent's first `ls` on the `D:\…` form we emitted came back “No such file or directory”, and it only recovered after `pwd` revealed `/mnt/d/…` — so the note now gives **both readings** (`(bash in WSL reads it as /mnt/d/…)`), converting through `dshHooks.toWslPath`, which is the one implementation of that conversion in the repo: there is no `/mnt/` literal anywhere in this module, and a structural guard says so. The second reading only appears when it actually differs — on a POSIX path the conversion returns its input, and inventing an `/mnt/…` line there would be pure noise. **C17b moved the note out of the user message entirely**: DSH’s transcript is “what you see is what was sent”, so a paragraph addressed to the model was printed verbatim under the user’s own words in every bubble — and there is no rendering-layer fix, because `SessionPromptParams` carries only `contentBlocks` and no hidden channel. The text is still rendered here (`imagePromptText`, a pure function with its own probe); its destination is now `src/imagePromptPlugin.ts`. The message holds not one byte about pictures, so an image-only message in chat mode produces nothing at all. Two consequences are recorded honestly: the model’s message history now contains no trace of any picture (the list is regenerated in the system prompt every turn — which is also why it survives compaction), and the first turn after a paste invalidates the prompt cache once, because the system prompt sits at the front of the token stream and everything after it is re-read when it changes. **C20 gives this module one judgement — “is the picture route open?”** (`ImageRoute` = `blind | readable`): `IMAGE_ROUTE_TAGS` is the **single definition** of the chip's trailing label and of that phrase in the export line, `imageRouteFromHeader(header)` reads this turn's `request/header.header.tools` for `read_image` (it is registered inside `ctx.inject(['attachments'], …)`, so the tool being there ⟺ the runtime mounted an attachment store), and `imagePromptText(images, route)` falls out of it in two variants — the **blind** one is C17's with only its attribution changed, from “the current model doesn't support” to “**this** deployment didn't enable image input” (a fact about the deployment, not a property of the model), and the **readable** one switches to **pointing the way** (read it with `read_image`; if the route refuses, say so plainly) and **drops “do not try to make it visible with tools”**, because the one move that sentence forbids is the only correct one in that half of the world. An unrecognisable element of the tool table is **dropped rather than given a name**, and a table that cannot be read at all counts as blind (fail-closed) — it is a pure function, so the judgement and both wordings are pinned outside the extension host. **`describeImageAttachment` is deleted** in the same pass: after C17b it had no consumer left (the export and the chip each implement their own), which made it old wording that **nobody read while it still looked authoritative** — the last time the wording changed, it was the one thing nobody updated. |
| `src/imagePromptPlugin.ts` | C17b’s delivery half: the note reaches the model through the **system prompt** instead of the user message. The mechanism is one self-mounted cordis plugin (same shape as the C11 effort and C12 tool-policy plugins — generated into `<storageDir>/dsh-plugins/`, referenced by a `file:///` URL) that registers a prompt **variable** plus a **section** whose text is exactly `{{hello_image_list}}`; the extension renders the text into a state file (`{dshSessionId: text}`) and the plugin reads it fresh on **every assembly**, returning `‘’` for a session with no entry — and `renderPrompt` drops empty sections, so a conversation with no pictures carries not one byte of this. Two details are load-bearing. **The variable detour**: `interpolate` runs over *every* section and throws on an unknown `{{name}}`, while the text carries user data (file names, paths), so a picture named `{{草稿}}.png` would have made that session fail on *every* turn, permanently, with no way out — substituted values are not scanned again, so going in through a variable keeps the path byte-exact and never throws. **The registration order**: variable first, section second, and if the section fails to register the variable is disposed; the reverse would leave a section referencing a name that does not exist, which throws on every assembly. Keys are DSH session ids, read from `_dshSessions` (the in-memory map, set unconditionally) with `stored.dsh.id` as a fallback, because the no-patch and cwd-mismatch branches never write an id to disk. The value is the **union** over every UI session sharing that id (a fork shares its source’s id), with the active session ordered last so the picture just pasted is never squeezed out by the 12-image cap. The table is a pure function of the stores — rebuilt on every turn and after every purge, with no incremental maintenance and no refcounts. Failing to mount is reported rather than silent: with no derived config in use, the model is not told it cannot see the pictures — precisely the accident (an agent building an OCR stack) that C17 exists to prevent |
| `src/dshPaths.ts` | DSH session-log path algorithm (**copied verbatim from the persistence plugin**) + guarded removal (pure, no `vscode`) |
| `src/extension.ts` | Extension entry: commands + view registration |
| `media/chat.{html,js,css}` | Side-panel front end (mode pills + harness status dot; DSH theme tokens with VS Code fallbacks) |
| `media/dsh-live/` | **gitignored** — DSH single-file front-end bundle (see above) |
| `scripts/capture-dsh-frames.mjs` | Frame-capture tool for the DSH runtime (`DSH_CAP_*`) |
| `scripts/dsh-session-log.mjs` | Shared probe helper: locate the harness session store / the DSH session logs under it, and decode a `session.jsonl.zstd` (frame-splitting by magic + span-retry — a single `zstdDecompressSync` only gets the first frame). A copy in each probe would drift, and the drifted copy is the one that one day quietly says “pass” |
| `scripts/probe-session-tools.mjs` | Self-check for search/export/soft-delete plus the storage hardening (atomic write, `.bak` roll, backup fallback, `toolInput` fuse) (`npm run compile` first; no VS Code, no API key) |
| `scripts/probe-purge.mjs` | Self-check for path parity / guarded removal / retention boundaries (same; **path parity needs Node ≥ 22.15** and points you at `dist-runtime/node/node.exe` otherwise) |
| `scripts/probe-turn-state.mjs` | Self-check for the Continue-button verdict + online status tracking (same; no VS Code, no API key) |
| `scripts/probe-approval-shell.mjs` | Self-check for the C1 approval hook's shell-form verdict: at least one form runs, the two are mutually exclusive, and the second form rescues a wrong first guess — plus the pure-function rules for the platform prior and for inconclusive failures (timeout / silent non-zero exit), which are retried exactly once. C13 added two more: that **`opts.env` really does replace the search path** (the mechanism “pin a bash” rests on — if it silently didn't, changing the setting would do nothing and say nothing), and that the **self-check runs in that same env**, since the hook's Windows-vs-WSL form is derived from that very verdict (same; no VS Code, no API key) |
| `scripts/probe-approval-roundtrip.mjs` | Self-check for the C1/C4 **decision round-trip** — a real `ApprovalServer` + a real generated hook script + real HTTP + a real child process, all outside the extension host: allow prints nothing, deny lands on `permissionDecision` with our reason, the bar only appears when the policy asks, a second answer to the same id is refused, timeout and `cancelAll` both end in deny, and the two fail-safe dials are pinned separately (bash falls back to the built-in dangerous list when the server is unreachable, `write`/`edit` fall back to **allow**), plus a wrong/absent token being rejected. It never executes anything: the hook only asks. First run caught a real one — the server's hard-coded reason said “该命令” even for a file write, so the tool-specific wording the hook carried was dead on the reachable path. The C16 half (now 24/24) drives the whitelist through a **real file and a real hook child process**: it seeds a trust entry through `addTrust`/`writeTrustFile`, runs the same command again, and asserts the process prints nothing, exits 0, asks exactly **once** — while the server's `observed` list still holds **two** entries, which is the machine evidence that a whitelist-silenced write is 放行 but not 隐身 (it still reaches C4's pre-turn snapshot). The reverse controls are the point: a non-empty table is not a blanket allow, the same command in a *different* `cwd` still asks (cwd really is half the key), and one extra space still asks. Four structural pairs pin the wiring — `_askNeedsApproval`'s first statement is the trust check, the judgement exists in exactly one place (`matchTrust`/`offerTrust`/`isInsideDir`, no re-implemented `includes`/`startsWith`), every failure path returns `false` with no `return true` anywhere in `_isTrusted`, and `_createTrust` (whose body never contains the word `allow`) is called **before** the answer is sent — i.e. remembering can never become a way of allowing. This half caught a genuine bug in the generated hook: the bash branch had never forwarded `cwd` at all (only `write`/`edit` did), so every bash trust entry would have been keyed to an **empty** workspace — the same `rm` would have been silently allowed in a workspace it was never granted in, and the scope line would have read 「本次没有工作区」 (same; no VS Code, no API key) |
| `scripts/probe-approval-trust.mjs` | Self-check for the C16 whitelist, in seven groups, all in memory: **byte-exact bash matching** with its reverse controls (a command differing by whitespace, by case, by one trailing character, or matching only as a prefix must **not** be trusted) plus the same command under a different `cwd`; **`dir` matching** including the sibling-directory trap (`D:\out2` must not be covered by `D:\out`) and Windows case folding; **what the bar may offer** (a truncated command offers nothing, a drive root or the home directory offers nothing, `read` offers nothing — each with the reverse control that the legal cases still do); **`addTrust`** (idempotent de-duplication, refusing at the 200-entry cap instead of evicting the oldest, a forged `kind` from an untrusted webview refused, and a write→read round trip returning the same shape); **corrupt-file degradation** (a missing file is *not* corrupt, garbage is, and an entry set that parses down to nothing is, with the missing-command back door dropped); **file IO** (tmp+rename leaving no `.tmp` residue, a missing parent directory **throwing** rather than silently succeeding); and the display wording plus the two hard-forbidden directories (same; no VS Code, no API key) |
| `scripts/probe-run-inspector.mjs` | Self-check for the C9 run inspector: frame filtering (5000 `assistant/chunk` must change nothing), call/result pairing (including DSH repair frames' three-state verdict and a conservation law over them), the outcome precedence table, ring/dropped caps, and a replay of both the newest capture in `logs/dsh-frames/` **and** a real `session.jsonl.zstd` cross-checked against independently derived oracles (same; no VS Code, no API key). The session log is picked as the newest one that actually **carries repair frames** — those only appear when a turn is interrupted, so always taking the newest just meant a false red every few sessions |
| `scripts/probe-compaction-notice.mjs` | Self-check for the C10 compaction notice: the plugin's `compaction/summary` and `compaction/end` payloads turn into a transcript note, never silently (`undefined` only for unrelated types), exactly once per successful compaction, and **never** echoing the summary body into the transcript. The second half cross-checks the real `compaction/*` frames in a stored DSH session log against the notes we persisted — **word for word, same order**, with the done-count conserved against the session's `compacted` field (same; no VS Code, no API key) |
| `scripts/probe-compaction-override.mjs` | Self-check for the C10 threshold override: anchored rewriting of the two `compaction-basic` ratios only (exactly two lines differ, CRLF kept, idempotent, sibling `modelPolicies[].thresholdRatio` untouched, 9 rejection cases), `retainRatio < thresholdRatio` held across the whole range, and **the default value produces a byte-identical file** — which is what makes C1's zero-regression structural rather than luck (same; no VS Code, no API key) |
| `scripts/probe-context-window.mjs` | Self-check for the C10 occupancy denominator: live value wins, **a missing live value falls back to the one remembered on the session** (the regression case for a bug a whole F5 round missed — continue a session and the bar showed nothing at all), junk values count as “unknown” rather than as a window, the warn line is `threshold × 0.85` (including the `0.02`-threshold arithmetic of that real run), a corrupted threshold falls back to the default, and both the denominator and the last reading survive a store round-trip (same; no VS Code, no API key) |
| `scripts/probe-webview-render.mjs` | Self-check for `media/chat.js` rendering, run in Node behind a minimal DOM shim (the only way to exercise that code before F5): the usage readout's `near` / `stale` / `compacted` states and its `.near` class (on the ring in the config bar as of C22, not in the readout row), the transcript fold (head folded, correct count, expand restores everything, reset on session switch), the same fold replayed over the **longest real stored session** (99 messages / 56 tool cards), plus a small C9 runs-panel regression sample and the C11 effort menu (default 「跟随配置」, the ✓ on the current row only, the value posted by each pick — and that a `thinking: disabled` base config greys the three rows *and* attaches no click handler at all, so a greyed row cannot post even by accident), plus the C12 profile menu (「不用 profile」 always first as the way out, the ✓ on the current row only, exactly one `set-profile` per pick and `null` for the escape hatch, a pinned model greying every model row *and* leaving them with no handler *and* hiding the “custom model” entry — with the counter-control that an unpinned menu is still clickable — the “profile.json 已改动 · 点这里重新应用” row being able to **post**, precisely because it targets the current item, and busy disabling the trigger while collapsing the menu so those rows aren't reachable in the first place), and finally a **structural guard on the three dropdown triggers**, one clause per narrowing round — they come in two kinds, each defined in exactly one place: the model trigger keeps `link-button lc-model`, while the reasoning and profile triggers are square icon knobs carrying `tool-icon` (so they *are* the attach button's 26×26 square) and must **not** also carry `link-button`; `.lc-model` must not grow a `border:` / `background:` / `height:` back (the pill they were restyled away from); the two knobs must hold **two different inline `<svg>`s** painted with `stroke="currentColor"` (a hardcoded colour would be wrong in one of the two themes); and the `.on` status dot must stay `position: absolute`, because a dot back in the flow would eat the 13px the narrowing just bought. Since a knob has no text at all, its `aria-label` — axis **and** current value — is its only accessible name, and that is asserted too (the shim now really stores attributes instead of swallowing `setAttribute`). It has already caught two real bugs of the “a shadow that lies is worse than no shadow” kind. The C13 segment adds ten more: the top-line bash readout in all three states and its **absence** when the payload carries none (an old extension, a diagnosis still running and a healthy non-WSL bash all look the same — deliberately), the sharper case that a **re-sent** `backend-status` must not light it up in chat mode (which is why that gate lives in the render function, not in `applyMode`) while switching back to harness — which sends nothing — must restore it from the cache, the approval bar's multi-line path note and its teardown (a late frame for another id must not close the current one), and two **structural guards** the flat shadow cannot express: `#harness-shell` must be a **sibling** of `#harness-status` (which rewrites its own `textContent` wholesale, so a child would be silently wiped on the next reconnect — the C10b shape), and the CSS must keep `flex: 0 0 auto` (otherwise the wider `#harness-status` squeezes the readout away) with no `display:` in either new block (which would defeat `[hidden]`). The C14 segment adds eight more for the tool card's “≈ predicted / actual change” line: it must sit on the card as a **sibling right below the header and above the arguments blob** (a long JSON argument would otherwise push the readout out of sight) and never *inside* the header, the diff appears only when you click it (each row's `+`/`-` prefix and `.diff-line` class), the `tool-result` frame swaps that line **in place** (node identity is asserted, because a rebuild would lose the position and the expanded state), a closing frame with no diff collapses both button and diff — otherwise the previous diff is left sitting there looking like this call's result — failure/unknown get their own class and wording while a late frame for another id must not touch this card, an unknown id does nothing at all, and a card that never got a prediction grows no such line. C13's `_fsTargetAbs` guard was reshaped in the same round: it now asserts **delegation** to `changeForecast.resolveTargetPath` and that no POSIX literal remains in the body. These guards were mutation-tested — nesting it as a child, dropping `flex: 0 0 auto`, dropping `pre-wrap`, removing the mode gate, dropping the cache, re-implementing `_fsTargetAbs`'s early return instead of delegating, a second `readPosixTarget` call on the decision path, putting the forecast line inside the header, matching tool names by substring (`todo_write`), dropping the POSIX early return, dropping the line-ending normalisation, reading `diffs: []` as “unreadable”, and removing one of the two “unknown” teardowns. The C15 segment adds thirteen more for the compare overlay: the toggle posting exactly one snapshot request and closing again, the **three empty states said separately** (nothing arrived yet / nothing picked yet / picked but deleted — collapsing them into “no data” would be a lie for the first few milliseconds), both panes rendering their own tails with the fork-point line and the verdict's two lines where only the cross-talk line carries the warning colour (plus the counter-control that two unrelated sessions get **no** warning colour at all), **folding being per-pane** (with the reverse control that expanding the compare pane must not expand the live transcript — the two states share no variable), the picker's row count and its greyed rows firing **no** message while a third row posts exactly one pick, the picker collapsing when the snapshot lands (the receipt), **a snapshot arriving after the panel was closed being discarded**, the compare pane **not polluting the live `byId`** (a `tool-result` frame carrying the same id must change neither the card's class nor its text — this is the door a shared registry would leave open), the live message surface's child count surviving a compare render, the frozen visuals (`unknown` class, no `running`, no blinking caret on an interrupted message), the three same-layer overlays excluding each other, Esc peeling them off in order, and structural guards on CSS and `chat.html` (`#compare-panel` must be a **body-level sibling** and not inside the `#messages` region, which react-live hides — the C14 lesson — while `#compare-btn` lives in the header's action cluster, and `.cmp-transcript` must stay `display:flex; flex-direction:column` with no `max-width`/`margin:0 auto` copied from the single-column reading layout, since `.msg`'s alignment properties are flex-item properties). The same round closed a testability hole in the shim itself: `document.addEventListener` used to be a no-op, so the global Esc chain had never been exercised. Mutations: sink → `byId`, folding wired to `foldExpanded`, greyed rows keeping their handler, not discarding state on close, `.cmp-transcript` → `display:block`, dropping the freeze, **swapping the live/disk evidence order**, and writing the compare state onto `StoredSession`. The C16 round also recorded two mutations that are **deliberately inert**: stripping the `allow &&` gate off `answerApproval`'s trust, and weakening `renderApproval` to assign the two elements only when `trust` is present, each change *nothing* on its own (no caller passes a kind on a refusal, and the clear-time reset covers the other) — they only go red in compound form, which is exactly how the pair got written into the code comment instead of being mistaken for dead weight. The C16 segment adds eleven more for the trust button on the approval bar: the label and the scope line appearing **verbatim** from the payload (and, the reverse control, both staying hidden *and* cleared when a payload carries no `trust` at all — that is the old-extension shape), a click posting exactly one `approval-answer` with `allow:true` **and** `trust:'command'`, a second click posting nothing (the bar collapses first), the `dir` kind passing through unchanged, **Esc still meaning deny and carrying no `trust` key at all** (a refusal must never be readable as a quiet trust), 「允许执行」 likewise posting no `trust` (no silent upgrade — the two buttons differ by exactly one field), the reset on `approval-resolved` leaving nothing for the next ask to inherit, and a click on the hidden button still posting no `trust` (the kind is reset, not merely invisible) — plus two structural guards the flat shadow cannot express: `#approval-trust` sits **inside** `.approval-actions` while `#approval-scope` sits **outside** it (a scope line long enough to wrap would otherwise be laid out as a button), and `.approval-scope` uses `--dsw-alias-state-warn-primary` — the theme variable that actually exists, since `dsh-live.css` has no `state-warning-` family and the neighbouring `.approval-note` has been quietly falling back to a VS Code colour all along — with no `display:` of its own, which would defeat `[hidden]`. The C17 segment adds eight more for image attachments: pasting a picture posts **exactly one** `user-message` frame carrying `kind`/`mediaType`/`dataBase64` and **no `content`** (bytes never reach the prompt body), an over-limit or over-count paste puts the `readError` on the chip while `send()` posts **nothing at all**, a snapshot carrying an image attachment draws the text chip, and a pending item flagged `truncated` really does carry `truncated: true` into the frame. The shim grew exactly two things to make that reachable — `El.dispatch(type, props)` merging props into the event object (so a fake `clipboardData.files` can be attached; existing single-argument calls and `click()` are unaffected, and none of the 89 earlier checks touch paste or drop at all) and a **really-calling-back** `FileReader.readAsDataURL`, since the pre-existing `readAsText` never invoked its callback — which is exactly why the paste-and-drop paths had never once been run. The shadow flattens real async ordering into a synchronous read, so what actually enforces the count limit is the extension-side re-check, not this. Mutations: dropping the `truncated` forward, reading images with `readAsText`, and reverting the paste predicate to `dropHasFiles` — which reads `e.dataTransfer` where a paste event puts its files on `e.clipboardData`, so **the entire paste-an-image path had never worked**, and failed silently (no error, nothing happened). That is a real bug this round found. — **35 of 35 go red** combined with C13's, C14's, C15's and C17's, each mutation first proving it actually landed (C21 adds six more: putting `border`/`background` back on the row, dropping `.near`'s tint, turning the entry into `display:none`, counting only the left half for `hidden`, leaving one old id behind, and reading the wrong field name off the snapshot — all red too). That self-proof earned its keep this round: mutations to a `.ts` file leave `probe-branch-compare` **entirely green** because it loads the compiled `out/` artifact, so “the mutation wasn't caught” and “the mutation was never applied” look identical — those mutations now recompile, and recompile back. **C20 adds two**: the chip's trailing label follows `snapshot.imageRead` (`true` → 「模型需自行读取」, `false` → 「图片输入未接通」, and **a missing field is also blind** — the same fail-closed discipline as the extension side), and a structural guard (the label is read from that mirror table only, those words appear **exactly once** in `media/chat.js`, and the route must be settled **before** `renderSnapshot` — one step late and the screen gets painted with the previous variant). **C21 adds five more** for the merge into one row: runs-only still **shows the row** (C9's “the entry never waits for a first turn”), both halves **coexisting in one frame**, **both halves over the snapshot path** (this is the one that catches the two field names being merged into one), no old id left behind (a half-moved merge leaves dead code), and a **CSS guard** (`.status-row` carries no `border`/`background` and no longer carries any colour-changing state, `.status-open` uses `opacity: 0` rather than `display:none`/`visibility:hidden`, and a `:focus-within` reveal rule must exist — keyboard reachability is a criterion here, not a courtesy). **C22 adds eight more** for turning the occupancy into a ring in the config bar: the arc length is **proportional to the ratio** (plus a monotonicity counter-control), **both endpoints** (0% leaves the offset at a full turn with the arc hidden, a full window is a complete ring, over-window clamps to 0), **no context section still shows the ring but draws no arc** (which keeps the persistent “compacted N times” reminder alive), `aria-label` being a **short sentence**, and four structural guards — the ring sits **between the model and reasoning triggers**, carries `tabindex`/`role` and **no** button class, `.ctx-ring` has no `border`/`background`/`cursor` and is the **only** place the warning colour appears, `stroke-dasharray` equals the JS constant while that block **never** writes `stroke-dashoffset`, and a **token-existence** guard (all three tokens the ring uses are really defined for both themes in `dsh-live.css`). **C22b rewrites nine more** (the ring stops being a pure readout and becomes the config bar's third square button, opening a read-only popover): C22's “**no** button class” clause is turned inside out into “**must** carry `.tool-icon`/`.lc-knob`, and differ from the reasoning knob's class set by exactly one `.ctx-ring`” (compared as sets, not by eye), and new assertions cover — open on click and close on a second click (button and popover both carrying `.open`), **the popover's rows joined back up being character-identical to the tooltip's first line** (⚠️ not by splitting on ` · `, since one row's body genuinely contains that separator), the notes matching line for line and refreshing with every streaming frame (the old numbers must not linger), only one popover open at a time on that row, closing by outside click and by Esc (Esc peels off only this layer — the panel behind it must stay open), both “the ring is about to hide” early-return paths closing the popover first, and **the ring staying clickable while busy** (it does not grey out when the three knobs do, and an open popover is not swept away when a run starts); the CSS guards add the `:hover` member of the `.near` rule group (without it the pointer landing on the ring replaces the warning colour with the ordinary hover colour) and `.ctx-readout .lc-model-item` dropping the pointer cursor and the hover background (it is not clickable). Mutations: **C22's seven** (inverting the arc offset, painting the warning colour back onto the readout row, hiding the whole ring when there is no context, dropping `tabindex`, dropping `.stale`, moving the ring out of the config bar, and writing the non-existent `-warning-` token back into the CSS) and **C22b's eight** (hiding the ring without closing the popover, dropping the `:hover` member of the `.near` group, building the popover's rows from a second assembly, missing the ring out of the document-level outside-click test, not collapsing the other three menus, writing `width` back into the ring's own block, moving the ring's Esc clause behind the runs panel, and leaving `.tool-icon` off the ring) — **all red, and each one reddening exactly the check it should**. **C22c rewrites three more** (same-day hardware feedback, verbatim: 「排版改一下，太丑了，另外新建对话时也要有这个按钮，只不过是"0"即可」): ① **the empty state no longer hides the ring** (C22's “no usage data at all means no ring” is turned inside out) — with no readout at all the ring is present, the arc empty, and the tooltip's first line reads 「本轮尚无用量」, with an explicit assertion that no `↑`/`↓` may appear in it (a session whose figures we *cannot assemble* is **unknown**, and `↑0 ↓0` would report unknown as zero); ② that empty row is still derived from the same `rows` array (the popover's row must be character-identical to the tooltip's first line — anyone hardcoding a “none yet” line into the popover goes red); ③ the ghost-popover guard **changed entry point** (the ring is never hidden now, so both early-return paths are gone; the guard now walks **switching out of harness — which hides the whole config bar — closing the popover**); plus a group of **layout guards** — the width override's selector must carry `.lc-model-menu`, its `min-width` must satisfy the **greater-than-230px relationship** rather than any particular number (the C21b lesson), the readout row must be baseline-aligned, the label must be `em`-width and right-aligned, the value must own a column with `min-width: 0`, and a rule must separate the notes from the numbers. 13 mutations (hiding the ring in the empty state again, writing zeros into the empty state, writing the width override as a bare `.ctx-readout` — the source-order trap, reverting the readout row to centre alignment, dropping the label's fixed width, dropping the rule before the notes, not closing the popover when leaving harness, writing a static `hidden` back onto the ring, assembling the popover's rows a second way, leaving the ring out of the outside-click test, dropping `.near`'s `:hover` member, moving the ring's Esc clause behind the runs panel, and leaving `.tool-icon` off the ring) — **all red**. **123 checks** (same; no VS Code, no API key) |
| `scripts/probe-branch-compare.mjs` | Self-check for the C15 judgements, in seven groups, all of them built from in-memory sessions (no fixture files, no disk, no DSH): **the fork point** (a real fork's copy, a source that kept growing after the fork, two unrelated sessions, the same session twice, one side empty, and **across generations** — F forked from S, compared against S, must still find S's stretch), each group first proving its own fixture really has the property under test (`assert the ids are byte-identical` before testing a common prefix, otherwise the test measures nothing); **`drifted`**, with the counter-control that a same-length, same-text pair with *different* ids is not a common prefix at all; **the freeze being read-only**, proved positively — the original `StoredSession` is `JSON.stringify`-compared before and after, and the returned tail is mutated to show it does not read back — plus the equation that `aAfter` and the tail the provider actually sends come from the same source; **cross-talk's six states**, including the reverse control for the evidence order (disk says “separate”, live says “shared” — live must win, or a real shared memory goes unreported) and the same-id/different-cwd case that must not warn; **the wording** (the three `unknown` sentences are pairwise different, two unrelated sessions never get the warning colour, and the tooltip states the criterion); **the default counterpart** picker's three-tier fallback; and **structural guards**: `freezeTranscript` appears exactly once in the provider and `_openSession` delegates to it, `_comparePane` must go through `frozenTail`, `compare-set` is constructed only inside `_postCompare`, the session store / `ChatMessage` / `StoredSession` never learn the word `compare` (the panel state is memory-only), `side` is only ever `'a'\|'b'`, and the fork-title suffix literal exists exactly once repo-wide (same; no VS Code, no API key) |
| `scripts/probe-derived-config-boot.mjs` | Boots the portable runtime the way the extension spawns it — base config as the **positional** arg, derived config only via `DSH_CORDIS_CONFIG` — with one positive control (a valid override loads) and one negative control (a derived file violating the plugin's load-time `retainRatio < thresholdRatio` rule **must** fail to boot). The negative control is the point: it proves the env var wins, which is the single thread C1 and C10 both hang on (same; no VS Code, no API key) |
| `scripts/probe-effort-plugin.mjs` | Self-check for the C11 per-session reasoning effort, in three parts: the pure rules (`normalizeEffort` never guesses; `thinkingDisabledInConfig` only reads the `llm-deepseek` block; the generated derived block's quoting when a path contains a single quote; **nothing extra in the derived file when no effort is requested**; an un-mountable block warns instead of throwing — and C1's own throw is still intact); the **plugin's own decision table**, loaded as a plain module with a fake `ctx` (hit / miss returns *the very object upstream returned* / no `agent` in the payload / missing or corrupt state file / an illegal value / `thinking` disabled lets only `off` through / an upstream throw must propagate, not be swallowed) including the “state file is re-read on **every** request” case that *is* the hot-swap claim; and a real end-to-end boot where the derived config mounts the real plugin and the stored `request/header` must read `reasoningEffort: "low"` — with a negative control proving an unset session gets **the base config's own default**, not our value. plus a structural guard born from a real F5 bug: `_actives[this._mode] =` may appear **exactly once** (inside `_setActive`), and that method must replay the config bar — otherwise switching sessions leaves the effort menu showing the *previous* session's value, silently. Runs on a **fake API key**: the request 401s, but `request/header` is written at build time, so the assertions hold and nothing is spent (same; no VS Code, no API key) |
| `scripts/probe-agent-profile.mjs` | Self-check for the C12 project profiles, in four parts: **parsing** (missing file / not JSON / root is an array / wrong field types / unknown fields / over-long names / unknown tool names — every one of them becomes a message, none of them throws, and the good half of the file still applies); **the “only tighten” table** (settings off + profile `false` ⇒ still off; settings off + `true` ⇒ on; settings on + `false` ⇒ **still on**, with the end-to-end path from file text through parse to compile so `false` can't slip past the parser either; `patterns` as a union that can't delete a default and can't be emptied; `outsideWorkspace` with the same positive/negative controls) — this is the section the whole feature rests on; the **plugin's decision table**, loaded as a plain module with a fake `ctx` (deny given ⇒ `restrict` gets exactly that filter; deny empty/missing/not-an-array ⇒ **`restrict` is never called**, which is what makes an unmounted profile byte-identical to no C12 at all; non-string entries filtered; missing `agent`/`ctx`/`tools` doesn't throw; a throwing `restrict` must not bubble, since that would take the whole session down); and a real end-to-end boot where the derived config mounts the real plugin and the stored `request/header.header.tools` must have **no `bash`** and **still has `read`** — with the counter-control proving an unprofiled run *does* have `bash`, without which “no bash” could just mean the turn never assembled tools at all. Runs on a **fake API key** (the request 401s; the header is written at build time) (same; no VS Code, no API key) |
| `scripts/probe-shell-diag.mjs` | Self-check for the C13 shell diagnosis, in eight groups: **resolution** on a fake `PATH` and a fake `isFile` (including the counter-control that libuv **ignores `PATHEXT`** — copying the upstream helper that honours it would compute the wrong winner, so the assertion is that a `PATHEXT`-less machine still finds `bash.exe`; plus `PATH=''` not falling back to cwd, and a missing `PATH` key falling back to the host's real environment, which is the landmine `prependPathDir` must not step on); **classification** (shape-only, with the counter-control that Cygwin / a bare `bash.exe` land in `other`); the **three-valued table** with the pairing assertion that makes “a cold start never cries wolf” machine-checkable (`shellWarnFor` must be `undefined` on usable *and* indeterminate, and non-empty on broken), measured against the **116-byte UTF-16LE fixture** (odd-position NUL ratio 0.690) captured from the real launcher; the **decode** with three counter-samples; `prependPathDir`'s identity/idempotence; the two readings of POSIX paths (UNC as a counter-control: the set that gets a note must equal the set that gets no snapshot); a **no-drift** check that `classifyShell` and `usabilityOf` say the same thing about the same three real `uname` outputs; and a real-machine group whose positive control adapts to whatever bash this machine has and **skips loudly** rather than passing quietly when there is none (no machine-specific path is ever committed). The “a machine without WSL gets guidance, not a wall of errors” acceptance is pinned three ways: the fixture above driven through the pure functions (empty PATH and a shim-only PATH must yield **two different** headlines — an inequality, not two string matches), the verdicts being pure functions of a recorded probe, and that adaptive positive control (same; no VS Code, no API key) |
| `scripts/probe-change-forecast.mjs` | Self-check for the C14 preview, in eight groups, with every filesystem interaction injected (`readText` / `exists`) so it builds no fixtures and does not care that this repo is CRLF/LF mixed: **parsing** (the wire sends `arguments` as a JSON *string*; malformed / non-object / empty all degrade to `undefined` without throwing); the **tool gate**, with the counter-control that matters — `todo_write` exists in real sessions, so a substring match would put a fake prediction on a card that touches no file; **path resolution** (relative against the base, absolute as-is, the POSIX shape `/mnt/d/x` **refused** as the whole point, UNC passing through as the legal absolute path it is, no base ⇒ no answer); **kind and diff** (new file ⇒ no diff and a note saying so; existing file ⇒ a diff against the disk, explicitly not against the turn-start snapshot; the three “can't preview this” cases each speaking up rather than faking an empty diff; `edit` diffs the fragment only; over-long ⇒ truncated); the **hit check** (0 / 1 / 2 with `replace_all` off / 2 with it on) including the **CRLF counter-control** (LF `old_string` against a CRLF file must still count as a hit) plus the two failures knowable without reading anything; the **wording**; **the actual half** (one hunk, several hunks merged and marked as such — DSH emits one entry *per hunk* — `diffs: []` as a verdict rather than “unreadable”, malformed meta ⇒ `undefined` and never a throw, DSH's `path` winning over the predicted one); and structural guards: `_fsTargetAbs` must delegate and carry no POSIX literal of its own, that literal may live in **exactly two files** (`changeForecast.ts` refuses it, `shellDiag.ts` translates it — same shape, opposite job, both must stay), all three `_forecastAfter` call sites exist (the result plus the two “unknown” teardowns, since a missing one leaves a prediction on a card forever), the table is cleared at turn start, and neither `ChatMessage` nor the session store learns the word `forecast` (it's a live hint, not transcript) (same; no VS Code, no API key) |
| `scripts/probe-image-attach.mjs` | Self-check for the C17 judgements, in seven groups: **recognition** (all four magic numbers; JPEG bytes under a `.png` name still judged JPEG; text bytes under a `.png` name judged *not* an image; `.svg`/`.ico`/`.bmp` refused; `.PNG` case-folded); **limits** (the `<=` semantics, i.e. exactly-at-the-limit must pass, plus a check that the mirrored literals in `media/chat.js` still agree with the extension's); **file names** (`../../evil.png`, `a\b.png`, `CON.png`, a 300-character name, `-2` de-duplication, and the extension following the sniffed type); **display and extraction** (the chip/export one-liner, and `imagesInMessages` — pulling a session’s picture list out of its messages, the sole input to the C17b state table; the wording group that used to live here **moved wholesale** to `scripts/probe-image-prompt.mjs` when the note changed channel, because a judgement gets exactly one home); **a storage reverse-proof** — a real `SessionStore` in a temp directory, one session written with an image attachment and read back as JSON, asserting `kind`/`mediaType`/`bytes` are there and that **`note` is gone** (C17b retired the field) and that **`dataBase64` and `base64,` are not** (the whole `attachments` array is persisted verbatim, and the prompt body has no cap, so one paste could otherwise write tens of MB into the session store); **source structural guards** (the image branch precedes the 10 KB gate; the branch is anchored on `if (mediaType) {` rather than on the sniff line, because a gate inserted *between* them would slip past a sniff anchor — and the “this branch still judges by magic bytes” assertion has to widen its slice accordingly, since the sniff line sits above the anchor); and **reconciliation** with the features already there (`sessionExport` sends no base64, `sessionSearch` still finds an image-only message by file name). The provider itself cannot be loaded outside the extension host, so the order-and-outlet checks are *structural* rather than behavioural — mutation ③ below can only be caught that way. **C20 adds four**: the two variants' own labels plus the counter-control that **neither may say “the model cannot see it”**; `imageRouteFromHeader` from both sides (including the `{ name }` shape of a tool-table element — matching strings only would make the judgement **always blind**, the quietest possible failure — byte-exact, and any junk input blind); a structural guard that **those words may only leave through the lookup table** (they must not appear in `chatViewProvider` / `sessionExport` / `imagePromptPlugin`); and “the export line follows the route” (a missing value counts as blind, an explicit argument beats the session field). The mirror check widens from **constants** to **sentences** as well: both variants' label and tooltip must be byte-identical inside `media/chat.js`. **49 checks** |
| `scripts/probe-image-prompt.mjs` | Self-check for C17b, in five parts: **the plugin module** (the generated `image-prompt.mjs` is imported as a pure module and fed a fake ctx — registration order, the section body being exactly the variable reference, a finite `order`, a disposer handed back, `‘’` for an unknown session / a missing agent / a broken table, nothing registered when `ctx` is missing a limb, and the rollback when the section fails); **the wording** (path, human-readable size, MIME, file name — and deliberately **no raw byte count**, since this block re-enters the prompt every turn; the two WSL readings with their two counter-controls; all four constraint sentences; **no `@"`**; the cap by count and by characters; and `{{草稿}}.png` preserved verbatim); **the derived block** (the plugin is mounted with the right id, URL and state path, and a base config whose root is not a block sequence produces a warning rather than silence); **end-to-end** — a real runtime booted with a **fake key**, asserting that `request/header.header.system` carries the header, the path and the constraint sentence, with the counter-control that a second session (its own session root) whose id is not in the table does not, plus the strongest assertion in the file: the same log’s `user/message` events contain **not one byte** of it, which is what “the bubble is clean” means on disk; and **structural guards** (the old outlet is gone, the table is written before `runtime.prompt(` and before the process starts, the key comes from the in-memory map first, and the state table is never maintained incrementally). Six mutations were planted and all six were caught — including one that only the wording group and the end-to-end group can see. **C20 adds three**: the blind variant's four sentences with the attribution moved to “this deployment didn't enable image input”; the **readable** variant (it names `read_image`, must contain **neither** “cannot see” **nor** “do not try to use tools”, keeps both shared closing sentences, and says what to do when the route refuses); and the two variants agreeing in the right direction (the blind one must not mention `read_image` and must not state a deployment fact as a property of the model, both share one header, and an unrecognised route falls to blind). Plus a **wiring guard**: the judgement has exactly one entry point, the value is recorded on the session, the snapshot carries it, both the prompt table and the export follow it, the same dsh id takes the **OR**, a flip is re-posted at the end of the turn and the flag is then cleared, and **the stream must not re-render a snapshot** (a reply is being written at that moment). **32 checks** (29 + 3). ⚠️ The planned “end-to-end counter-control” — hand-writing the state table as readable and then looking at a real runtime's `header.system` — was **not done**: today the readable variant has unit-level evidence only, while the **delivery channel** half is proved by the original end-to-end group and is route-independent; do not read “proved” as stronger than that |
| `scripts/probe-c8-runtime.mjs` | Runtime spike for C8: queued second prompt, kill-then-resume turn repair, graceful vs hard kill. **Needs an API key** and spends real model turns |
| `scripts/update-dsh.mjs` | Runtime-dependency governance: lock the DSH checkout to a tag, check drift, run the upgrade ritual + smoke (see `docs/runtime-dependency.md`) |
| `docs/runtime-dependency.md` | Governance decision for treating the DSH checkout as a versioned runtime dependency, the upgrade ritual, and the “when to switch to official npm” checklist |

Commands contributed by the extension: `AlohaDSH: 开始新对话`, `AlohaDSH: 配置 DSH 运行路径`,
`AlohaDSH: 查看/清除审批白名单（「永久信任」的命令与目录）`
(plus the toy `AlohaDSH: 打个招呼` / `AlohaDSH: 读取当前文件第一行`).

## Development & security notes

- Build/test: `npm install` → `npm run compile` → **F5**.
- Never commit: `logs/` (real session frames), `.claude/` (local auth), `media/dsh-live/`
  (upstream-derived artifacts), `probe-*.html` / `probe-server.mjs` (local probes), `*.vsix`.
- The extension injects `DEEPSEEK_API_KEY` only into the child-process env; it must never appear in
  logs, transcripts, settings, or this repo.
