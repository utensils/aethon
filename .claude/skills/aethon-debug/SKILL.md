---
name: aethon-debug
description: Drive and debug the running Aethon Tauri app by executing JavaScript inside its webview. Inspect the layout state object, switch models, send chat messages, capture screenshots, and verify UI changes end-to-end. Dev builds only.
when_to_use: Use when the user asks to inspect Aethon's UI state, debug the webview, send a chat message programmatically, switch models, take a screenshot, or verify A2UI rendering. Also use proactively after touching `src/`, `agent/`, or `src-tauri/` to confirm the app actually behaves as intended.
argument-hint: "[action] [args...]"
allowed-tools: Bash Read Grep Glob
---

# Aethon Debug

Execute JavaScript inside the running Aethon Tauri webview via a TCP debug server on `127.0.0.1`. Dev-build only (`#[cfg(debug_assertions)]`).

The server listens on **19433** by default (Claudette uses 19432; Aethon picks the next port to avoid collision). When 19433 is busy the dev wrapper (`scripts/dev.sh`) auto-increments to the next free port and writes the chosen port to `~/.aethon/dev-info.json`. The skill scripts read that file automatically — no need to set `AETHON_DEBUG_PORT` manually unless you're running multiple dev instances or pinning a specific port.

## Quick start

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return 1 + 1'
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return window.__AETHON_STATE__().model'
${CLAUDE_SKILL_DIR}/scripts/debug-screenshot.sh
```

Or via the slash-command form, which reads from `${CLAUDE_SKILL_DIR}/scripts/`:

```
/aethon-debug status                # one-shot snapshot of state
/aethon-debug models                # list available models
/aethon-debug send "what is 2+2?"   # send a chat message
/aethon-debug set-model <id>        # switch model by id
/aethon-debug screenshot            # capture for visual review
/aethon-debug eval 'return ...'     # arbitrary JS
/aethon-debug logs                  # tail recent on-disk logs
/aethon-debug logs --grep ext-loader      # filter today's logs
/aethon-debug logs --follow               # live tail (Ctrl+C to stop)
/aethon-debug logs --source bridge --since 2026-05-01
```

## Prerequisites

- App running via `bun tauri dev` (or the devshell `dev` helper) — debug TCP server starts automatically
- `python3` in PATH (used by `debug-eval.sh`)

## Release builds are off-limits — full stop

Every action in this skill assumes the **dev** process. Release builds (anything from `cargo tauri build` — including the bundle at `src-tauri/target/release/bundle/macos/Aethon.app`) are different binaries with different code:

- **No debug TCP server.** It's gated behind `#[cfg(debug_assertions)]`, so `debug-eval.sh` will hang on a release build.
- **No `window.__AETHON_STATE__` / `__AETHON_INVOKE__` globals.** They're only attached when `cfg!(debug_assertions)`.
- **Stale code.** The release bundle is whatever the last `cargo tauri build` produced — could be hours, days, or weeks behind current source. Any "bug" you reproduce against a release is the release's bug, not current main.

If the dev build isn't running, **ask the user to start it** (`bun tauri dev` or the `dev` devshell helper). Never fall back to a release binary, and never run `cargo tauri build` to "get something running" — that produces a release.

### Never activate Aethon by app name

`osascript -e 'tell application "aethon" to activate'`, `open -a Aethon`, and similar LaunchServices gestures resolve by name and routinely match an installed/built release `.app` instead of the running dev process — both share the bundle id `com.utensils.aethon`. This has produced silently wrong screenshots in the past: the user was testing dev, but the captured window was an ancient release.

Detection: if `~/.aethon/dev-info.json` exists, a dev process *should* be running with that PID. The debug TCP server is PID-bound, so `debug-eval.sh` is guaranteed to talk to it (or fail loudly if the PID is stale). After a `debug-eval.sh` call, sanity-check `window.location.href` — dev returns `http://localhost:<vitePort>/` (1420 by default), release returns a `tauri://` or `tauri:///` scheme.

To raise/focus the dev window without LaunchServices ambiguity, do it from inside the webview:

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'window.focus(); return "focused"'
```

For screenshots, use `debug-screenshot.sh` (it does not activate by app name) and crop after the fact, or ask the user to bring the dev window forward themselves.

## Available globals (dev only)

| Global | Type | Description |
|---|---|---|
| `window.__AETHON_STATE__()` | `() => Record<string, unknown>` | Snapshot of the layout state object |
| `window.__AETHON_SET_STATE__(next)` | `(state) => void` | Replace state (advanced; bypasses the agent) |
| `window.__AETHON_EXTENSION_REGISTRY__` | `ExtensionRegistry` | Extension registry — `.list()`, `.resolve(type)` |
| `window.__AETHON_INVOKE__` | Tauri `invoke` | Call any Tauri command |
| `window.aethon` | object | Public runtime API: `setLayout`, `resetLayout`, `getLayout`, `registerExtension`, `listExtensions` |

## Tauri commands

Reachable via `await window.__AETHON_INVOKE__('<name>', args)`:

| Command | Args | Purpose |
|---|---|---|
| `start_agent` | none | Spawn the pi agent subprocess if not running |
| `send_message` | `{ message: string }` | Send a chat message to the agent |
| `agent_command` | `{ payload: string }` | Forward arbitrary JSON to the agent's stdin (e.g. `{"type":"set_model","id":"..."}`) |
| `dispatch_a2ui_event` | `{ event: string }` | Forward a structured A2UI event to the agent |
| `debug_eval_js` | `{ js: string }` | Same as the TCP server but from in-webview |

## Actions

### `status` — one-shot snapshot

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__AETHON_STATE__();
const messages = (s.messages || []);
const last = messages[messages.length - 1];
return {
  model: s.model,
  status: s.status,
  connection: s.connection,
  waiting: s.waiting,
  messageCount: messages.length,
  lastMessage: last ? { role: last.role, preview: (last.text || '').slice(0, 120) } : null,
  draft: s.draft,
  terminalOpen: s.terminal?.open,
  modelsAvailable: (s.sidebar?.models || []).length,
};
JS
```

### `models` — list all models in the picker

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
return (window.__AETHON_STATE__().sidebar?.models || [])
  .map(m => `${m.id}\t${m.label}`)
  .join('\n');
JS
```

### `send "<message>"` — send a chat message

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
await window.__AETHON_INVOKE__('send_message', { message: `MESSAGE_TEXT_HERE` });
return 'sent';
JS
```

Substitute `MESSAGE_TEXT_HERE` with the actual text. Escape backticks as `\``.

### `set-model <id>` — switch active model

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
await window.__AETHON_INVOKE__('agent_command', {
  payload: JSON.stringify({ type: 'set_model', id: 'MODEL_ID_HERE' })
});
return 'requested';
JS
```

The agent emits a `model_changed` event back to the frontend, which updates `state.model` — re-run `/aethon-debug status` to confirm.

### `wait` — block until the agent is idle

Polling helper for UAT. **Run with `run_in_background: true`** if you intend to do other work while waiting.

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-wait.sh
```

Returns `{waiting:false, status, messageCount, lastRole, durationSeconds}` when `state.waiting` flips false. Default timeout 300s, override with `--timeout N`.

### `screenshot` — capture screen

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-screenshot.sh
```

Returns the path to a PNG. Use the Read tool to view it. Saves to `${TMPDIR:-/tmp}/aethon-debug/` by default.

### `layout` — dump the active layout's component tree

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
return window.aethon.getLayout();
JS
```

### `state [path]` — read state by JSON Pointer path

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return window.__AETHON_STATE__()'
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return window.__AETHON_STATE__().messages'
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return window.__AETHON_STATE__().terminal'
```

### `logs` — tail / grep on-disk logs

Both the Rust shell (`tracing` crate) and the bun bridge (`agent/logger.ts`)
write daily-rotating log files to `~/.aethon/logs/`. This action wraps
`tail` + `grep` over the right files for the requested day and source.

```bash
# Last 50 lines from today, both Rust and bridge
${CLAUDE_SKILL_DIR}/scripts/debug-logs.sh

# Filter by scope (matches the scope column in each line)
${CLAUDE_SKILL_DIR}/scripts/debug-logs.sh --grep ext-loader

# Live tail
${CLAUDE_SKILL_DIR}/scripts/debug-logs.sh --follow

# Pick a source: rust | bridge | all (default)
${CLAUDE_SKILL_DIR}/scripts/debug-logs.sh --source bridge

# Look at a specific day (YYYY-MM-DD) — useful after a rotation
${CLAUDE_SKILL_DIR}/scripts/debug-logs.sh --since 2026-05-01

# More lines than the default 50
${CLAUDE_SKILL_DIR}/scripts/debug-logs.sh --lines 500
```

Files older than 7 days are pruned at app startup. Each line is
`ISO_TS LEVEL scope: message` so `grep '^.* ERROR'` works for
quick triage.

### `eval <js>` — arbitrary JS

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'USER_JS_HERE'
```

Multi-line via heredoc:

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__AETHON_STATE__();
return Object.keys(s).sort();
JS
```

JS must use `return` to send a value back. Async/await is supported (the wrapper evals the body inside an async IIFE).

### `extensions` — list registered extensions

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
return window.aethon.listExtensions();
JS
```

### `reset-layout` — restore the default-layout extension's payload

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'window.aethon.resetLayout(); return "reset"'
```

## UI-automation primitives

These scripts wrap real user gestures (open a shell tab, send keystrokes, query the devshell cache, …) so a human OR an automated UAT agent can drive Aethon without hand-coding `__TAURI_INTERNALS__.invoke(...)` plumbing each time. They prefer dedicated `cfg(debug_assertions)` Tauri commands over production paths whose share-mode/consent gates would skew the test, so what you observe matches what a user would observe.

### `debug-invoke.sh <command> [<args-json>]` — generic Tauri-command runner

The lowest-level building block. Calls any registered Tauri command and prints the JSON result (or `ERROR: ...`).

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-invoke.sh shell_list_shareable
${CLAUDE_SKILL_DIR}/scripts/debug-invoke.sh devshell_status '{"args":{"root":"'"$(pwd)"'"}}'
${CLAUDE_SKILL_DIR}/scripts/debug-invoke.sh debug_shell_snapshot '{"tabId":"uat-1","tailBytes":4096}'
```

### Shell-tab driving (PTY user-equivalent)

```bash
TAB=$(${CLAUDE_SKILL_DIR}/scripts/debug-shell-spawn.sh)              # open in active project
TAB=$(${CLAUDE_SKILL_DIR}/scripts/debug-shell-spawn.sh /path/repo)   # explicit cwd
${CLAUDE_SKILL_DIR}/scripts/debug-shell-write.sh "$TAB" 'env | sort | head'
${CLAUDE_SKILL_DIR}/scripts/debug-shell-read.sh   "$TAB"             # JSON snapshot (cwd, command, share, tail)
${CLAUDE_SKILL_DIR}/scripts/debug-shell-read.sh   "$TAB" 8192 raw    # just the tail bytes
${CLAUDE_SKILL_DIR}/scripts/debug-shell-close.sh  "$TAB"
```

`debug-shell-write` + `debug-shell-read` ride dev-only Tauri commands (`debug_shell_write_raw`, `debug_shell_snapshot`) that bypass the share-mode gating. The PTY itself still spawns through the real `shell_open` path — including the Nix devshell env intercept — so this is a faithful UAT, not a Rust-only shortcut.

### Devshell cache

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-devshell.sh status   # active project's cache state
${CLAUDE_SKILL_DIR}/scripts/debug-devshell.sh env      # resolved env map
${CLAUDE_SKILL_DIR}/scripts/debug-devshell.sh refresh  # invalidate + re-resolve
${CLAUDE_SKILL_DIR}/scripts/debug-devshell.sh status /Users/.../some-project   # explicit root
```

When no root is passed, the script reads the active project from `window.__AETHON_STATE__()` so it Just Works after a project switch.

### Agent chat (drive the agent like a user typing)

```bash
TAB=$(${CLAUDE_SKILL_DIR}/scripts/debug-agent-new-tab.sh /path/to/project)
${CLAUDE_SKILL_DIR}/scripts/debug-chat-send.sh "$TAB" 'run env | grep PATH via your bash tool'
${CLAUDE_SKILL_DIR}/scripts/debug-chat-wait.sh "$TAB" 90    # block until the response lands
```

`debug-agent-new-tab.sh` pushes a tab record into central state AND sends `tab_open` to the agent, which spawns a per-tab pi session bound to the cwd you passed. From there `debug-chat-send.sh` rides the same `send_message` IPC the composer uses, and `debug-chat-wait.sh` polls until `waiting` flips false and a new message lands. The agent's bash tool runs through the customTools-shadowed `BashSpawnHook`, so anything it executes inherits the project's Nix devshell env exactly as a real user would see — this is how to confirm end-to-end devshell wrapping when "ask the agent to verify" is the right shape of test.

Caveats: live agent confirmation needs a valid API key for the active model (`~/.pi/agent/auth.json`). If the turn errors immediately with a 0.3s duration in the logs, that's an auth problem, not a feature problem.

## When the skill needs more — extend it

If a UAT step needs data or a gesture the existing scripts can't surface:

1. Add a `cfg(debug_assertions)` Tauri command to `src-tauri/src/debug.rs` (mirror an existing production command but skip the gate that's blocking the test).
2. Register it in `lib.rs` under the existing `#[cfg(debug_assertions)]` block.
3. Add a thin wrapper script in `.claude/skills/aethon-debug/scripts/` and document it in the table above.

This is the documented expectation — see the user-feedback memory `feedback_aethon_maintain_debug_skill.md`. Don't work around a gap; close it.

## Architecture

```
Terminal ──TCP:19433──▶ debug server ──webview.eval()──▶ webview JS context
                                                              │
Terminal ◀──TCP─────── debug server ◀──debug_eval_result── webview (callback)
```

- **TCP server**: `src-tauri/src/debug.rs` — wraps JS in async IIFE, evals in webview, 10s timeout
- **Port discovery**: `$AETHON_DEBUG_PORT` → `~/.aethon/dev-info.json` (`debugPort`) → `19433` default. Wrapper-chosen ports flow through `dev-info.json` so the skill follows the auto-increment.
- **Input cap**: 1 MB per eval request

The wrapped JS calls `window.__AETHON_INVOKE__('debug_eval_result', { requestId, data })` to send the result back. Rust forwards that into a oneshot channel, the TCP server reads from the channel, and writes the result back over the socket.
