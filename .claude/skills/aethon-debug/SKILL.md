---
name: aethon-debug
description: Drive and debug the running Aethon Tauri app by executing JavaScript inside its webview. Inspect the layout state object, switch models, send chat messages, capture screenshots, and verify UI changes end-to-end. Dev builds only.
when_to_use: Use when the user asks to inspect Aethon's UI state, debug the webview, send a chat message programmatically, switch models, take a screenshot, or verify A2UI rendering. Also use proactively after touching `src/`, `agent/`, or `src-tauri/` to confirm the app actually behaves as intended.
argument-hint: "[action] [args...]"
allowed-tools: Bash Read Grep Glob
---

# Aethon Debug

Execute JavaScript inside the running Aethon Tauri webview via a TCP debug server on `127.0.0.1`. Dev-build only (`#[cfg(debug_assertions)]`).

The server listens on **19433** by default (Claudette uses 19432; Aethon picks the next port to avoid collision). Override with `AETHON_DEBUG_PORT` if running multiple instances.

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
```

## Prerequisites

- App running via `bun tauri dev` (or the devshell `dev` helper) — debug TCP server starts automatically
- `python3` in PATH (used by `debug-eval.sh`)

**Do NOT launch a release build.** The TCP server is gated behind `#[cfg(debug_assertions)]` and is absent from `cargo tauri build` artifacts. If the dev build is not running, ask the user to start it — never fall back to a release binary.

## Available globals (dev only)

| Global | Type | Description |
|---|---|---|
| `window.__AETHON_STATE__()` | `() => Record<string, unknown>` | Snapshot of the layout state object |
| `window.__AETHON_SET_STATE__(next)` | `(state) => void` | Replace state (advanced; bypasses the agent) |
| `window.__AETHON_REGISTRY__` | `SkillRegistry` | Skill registry — `.list()`, `.resolve(type)` |
| `window.__AETHON_INVOKE__` | Tauri `invoke` | Call any Tauri command |
| `window.aethon` | object | Public runtime API: `setLayout`, `resetLayout`, `getLayout`, `registerSkill`, `listSkills` |

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

### `skills` — list registered skills

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
return window.aethon.listSkills();
JS
```

### `reset-layout` — restore the default-layout skill's payload

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'window.aethon.resetLayout(); return "reset"'
```

## Architecture

```
Terminal ──TCP:19433──▶ debug server ──webview.eval()──▶ webview JS context
                                                              │
Terminal ◀──TCP─────── debug server ◀──debug_eval_result── webview (callback)
```

- **TCP server**: `src-tauri/src/debug.rs` — wraps JS in async IIFE, evals in webview, 10s timeout
- **Port**: `19433` by default; `$AETHON_DEBUG_PORT` overrides
- **Input cap**: 1 MB per eval request

The wrapped JS calls `window.__AETHON_INVOKE__('debug_eval_result', { requestId, data })` to send the result back. Rust forwards that into a oneshot channel, the TCP server reads from the channel, and writes the result back over the socket.
