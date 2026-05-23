# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Aethon is a Tauri 2 + React + TypeScript desktop app. See `SPEC.md` for the
design vision and milestone checklist; `RELEASING.md` for the release flow.

The Tauri shell is intentionally thin — the Rust side handles OS boundaries
and the React frontend renders A2UI payloads emitted by a TS agent
subprocess. Business logic belongs in the agent, not the shell.

## Stack

- **Backend**: Rust + Tauri 2 (crate `aethon`, lib `aethon_lib`)
- **Frontend**: React 19, TypeScript, Vite, bun
- **Agent**: `@mariozechner/pi-coding-agent` run as a `bun` subprocess
- **Dev env**: Nix flake (flake-parts + numtide/devshell + treefmt-nix +
  rust-overlay). Rust pinned to **1.92.0** in `flake.nix`; bumping past 1.95
  currently breaks `icu_provider` / `regex-automata` / `objc2` transitive
  deps. `rust-toolchain.toml` is for non-Nix builds; the Nix pin wins inside
  the devshell.

## Common commands

Run inside `nix develop` (direnv auto-activates via `.envrc`). Devshell
helpers (defined in `flake.nix`):

| Command     | What it does                                                    |
| ----------- | --------------------------------------------------------------- |
| `dev`       | `scripts/dev.sh` → `cargo tauri dev` with port auto-increment   |
| `build-app` | `cargo tauri build` — release bundle                            |
| `check`     | CI gate: clippy + tsc + ESLint + cargo test + vitest            |
| `lint`      | ESLint (no auto-fix)                                            |
| `test`      | `cargo test --lib` + `bunx vitest run`                          |
| `coverage`  | TS coverage report (vitest v8) → `coverage/`                    |
| `fmt`       | treefmt (rustfmt + nixfmt + prettier + taplo)                   |

ESLint is configured for **0 errors and 0 warnings**.

Single tests:
- TS file: `bunx vitest run agent/terminal-stream.test.ts`
- TS by name: `bunx vitest run -t "test name pattern"`
- Rust: `cargo test --lib -p aethon -- helpers::test_name`

`scripts/dev.sh` flags:
- `dev --new` — sandbox launch under `${TMPDIR}/aethon-dev/new-<pid>/`
  (empty `~/.aethon`, removed on exit). Resolver is `helpers::aethon_dir`,
  honored by config / sessions / pastes / logs / window state / extensions / skills.
- `dev --clean` — wipe `${TMPDIR}/aethon-dev/` and exit.

Vite defaults to port 1420 but `scripts/dev.sh` auto-increments and writes
the chosen Vite + debug ports to `~/.aethon/dev-info.json`; `strictPort: true`
stays on. The `aethon-debug` skill reads `dev-info.json` to follow the port.

## Architecture

Three layers:

1. **Tauri shell** (`src-tauri/src/`). `lib.rs` is the thin entry (agent
   supervisor, IPC, `run()` builder). IPC commands are grouped under
   `commands/` (`config`, `session`, `extensions`, `git`, `window`, `fs`).
   Shell-tab PTY logic under `shell/` (`lifecycle`, `scrollback`, `sharemode`).
   Window geometry in `window_state.rs`. Pure helpers in `helpers.rs`.
   Debug-only TCP eval server in `debug.rs` (gated by `cfg(debug_assertions)`).

   Core agent commands: `send_message` (forwards chat to agent stdin),
   `dispatch_a2ui_event` (forwards a structured event). First call spawns
   `bun run agent/main.ts` and starts a reader thread emitting `agent-response`
   Tauri events per stdout line. Shell-tab commands (`shell_open/input/
   resize/close`) sit behind a `ShellRegistry` (per-tab `portable-pty` +
   reader; emits `shell-output` / `shell-exit`).

   The PTY reader preserves UTF-8 boundaries across reads via a carry buffer
   + `Utf8Error::error_len()` split — **do not replace with per-chunk
   `from_utf8_lossy`**; multi-byte sequences will corrupt.

2. **Agent bridge** (`agent/`). JSON-lines over stdio. `main.ts` is a thin
   entry; the readline loop and dispatcher live in `dispatcher.ts`. State is
   the `AethonAgentState` class in `state.ts`. The bridge attaches
   `globalThis.aethon` (built in `aethon-api.ts`) so pi tools and extensions
   can mutate UI, register components/themes/keybindings, push notifications,
   and introspect.

   Each module has a colocated `*.test.ts`. Provider config comes from env
   (`ANTHROPIC_API_KEY` etc.); pi-ai picks one up.

3. **React frontend** (`src/`). `App.tsx` is a thin shell composed of
   `useX()` hooks (`src/hooks/`). Event routing lives in `src/eventRoutes/`
   (one file per prefix family). The `window.aethon` runtime API is
   built in `src/runtime/windowApi.ts`.

### Frontend model — three things to know

**1. Layout-as-payload.** The default UI is *not* hardcoded React —
it's `src/skills/default-layout/workstation.a2ui.json`, fed to the same
`A2UIRenderer` that handles agent output. Don't add static chrome in
`App.tsx`; extend the layout JSON or register a skill. Layouts must
match the slot contract in `src/skills/default-layout/slots.ts`
(canonical slots: `header`, `sidebar`, `canvas`, `composer`, `terminal`,
`status`); non-canonical layouts declare a `slotMap`.

**2. Single state store, JSON Pointer addressed.** All app state lives in
one object on `App`. Components read it via `$ref` JSON Pointers
(`{"value": {"$ref": "/draft"}}`). The renderer applies an *optimistic*
write back to that path for `change`/`submit` events on `$ref` inputs —
see `applyOptimisticUpdate` in `A2UIRenderer.tsx`. Pointer helpers in
`src/utils/jsonPointer.ts` + `src/utils/dataBinding.ts`.

**3. Two registries.**
- Primitive React components (`src/components/primitives/`) are wired
  in `src/components/builtins.tsx` into a hardcoded 19-entry
  `PRIMITIVE_REGISTRY`. **Can't be overridden by skills.**
- Everything else (chrome composites like `sidebar`, `chat-input`,
  `command-palette`, `terminal-panel`, `tab-strip`, `shell-canvas`, etc.)
  comes from `SkillRegistry`. Mount via `<RegistryComponent type="…" />`
  so a skill can swap them with `aethon.registerComponent`. New types
  go on a skill, not in the primitives table.

### Event routing

`A2UIRenderer` accepts `onEvent`. Returning `true` marks an event handled
and suppresses the default `dispatch_a2ui_event` forward to Rust.
`App.tsx` delegates to `dispatchEvent` in `src/eventRoutes/index.ts`,
with three precedence layers:
1. Reserved shell-consent prefixes (`shell-write` / `shell-close` /
   `session-delete`) MUST resolve before extension matchers.
2. Extension-registered routes (returning `false` forwards to the bridge).
3. Built-in routes keyed by `id:<componentId>` or `type:<componentType>`.

**Always key chrome composites by `type:`, not `id:`** — that's how
`registerComponent("<type>", custom)` and renamed instances stay routable.
New handlers go in `eventRoutes/<name>.ts` + a happy-path test, then
register in `BUILTIN_ROUTE_TABLE`.

### Runtime API

`window.aethon` exposes: `setLayout`, `resetLayout`,
`registerLayout({id, name, payload})` (id pattern `/^[A-Za-z][\w-]*$/`;
`workstation` is reserved), `activateLayout`, `registerSkill`,
`listSkills`, `openProject`. Mirrored agent-side on `globalThis.aethon`
(see `agent/aethon-api.ts`).

Per-surface subnamespaces, each backed by a `*_query` bridge message:
- `aethon.shells.{list, read, write}` — opt-in shell sharing.
- `aethon.tasks.start({projectPath, prompt, newWorktree?, branch?, baseBranch?})`
  — task launcher parity.
- `aethon.dashboard.{getRepoOverview, refresh, listIssues, getIssue}` —
  cached gh repo data + issues.

Pre-frontend-ready callers of `*_query` block until the handshake
completes — queries need real `data`, not the side-effect-mutation
shortcut. Do **not** add a fast-path letting the bridge invoke Tauri
commands directly; security floors live with the data source.

### Tab kinds + terminal panel

`Tab.kind` is `"agent" | "shell"`. The top tab strip carries only agent
tabs (shells are filtered). The bottom panel (toggle `` Cmd+` ``) hosts
two sub-tab kinds: the always-present read-only `agent-bash` stream
(buffered tool stdout) and zero or more interactive `portable-pty` shells
(TUI-capable, 256-color, mouse). State paths: `/terminalPanel/activeSubId`
(defaults `"agent-bash"`), `/terminal/open`. Shells live in `/tabs` with
`kind === "shell"`; the renderer routes them to the right surface via
`/agentTabActive` / `/shellTabActive` derived flags in
`workstation.a2ui.json`.

`Cmd+T` is focus-aware: focus inside the bottom panel = new shell sub-tab;
elsewhere = new agent tab. `Cmd+Shift+T` always spawns a new shell sub-tab.

Per-tab `ShareMode` is the security boundary, enforced Rust-side in
`shell/sharemode.rs`. The bridge surface (`aethon.shells.*`) rounds through
the mutation-ack channel. **Do not add an agent-driven `setShareMode`** —
discoverable tab ids + a setter would defeat the opt-in floor that `list()`
enforces. Writes pop an Allow/Deny notification in `read-write` mode;
`read-write-trusted` bypasses the prompt.

### Hot reload doesn't kill in-flight prompts

The Rust file-watcher (`commands/extensions.rs::run_debounce_worker`)
writes `{"type":"reload_request"}` to the child's stdin instead of
SIGKILL. The bridge drains active `tab.promptInFlight`, emits a
`{"type":"_reload_done"}` sentinel, and exits. The supervisor's reader
peeks for the sentinel, emits `agent-reloaded`, and respawns on the next
IPC call. Extension drops never abort the user's LLM turn. The hard-kill
fallback remains for wedged stdin.

`touch agent/main.ts` is the simplest manual restart.

### File-system safety (commands/fs.rs)

Two layers gate every path: lexical (`helpers::resolve_inside_root`)
catches `..` traversal without hitting disk; canonicalize-after-existing
catches symlinks redirecting outside the project root. Read/write caps
at 10 MB. Deletes go to the OS trash via the `trash` crate — never
`unlink`.

### Window geometry

`src-tauri/src/window_state.rs` persists position/size/maximized to
`~/.aethon/window-state.json` in **logical** units (physical pixels are
not portable across HiDPI). Restore runs in `setup()` before the window
becomes visible (`tauri.conf.json` sets `visible: false`). Save is
250 ms debounced on Moved/Resized; flushed synchronously on
CloseRequested. Monitor matching is three-tier (exact → intersects →
nearest by saved center) with titlebar-reachability clamp. Fullscreen
is transient and skipped. v0 (physical) files migrate to v1.

### Projects + worktrees

Pi sessions are scoped to a cwd. `src/projects.ts` persists the project
list at `~/.aethon/projects.json` (max 16, MRU, schemaVersion 2; v1→v2
migrates on read). **Existing tabs keep the cwd they were created with**
— switching the active project only affects new tabs. Worktrees attach
via `src/worktrees.ts`, with Rust commands in `commands/git.rs`. Active
worktree is mirrored to `/activeWorktreeId` so the file tree and new
tabs follow the sidebar selection.

### Dashboard caches (M9)

- `src/ghRepoOverviewCache.ts` — 5-min live TTL, 30-min negative.
- `src/ghIssuesCache.ts` — 90-s live, 60-s negative; cap clamped to 100.

Use `gh issue list -q length` for the open-issue count, **not**
`open_issues_count` (that counts PRs + issues). Percent-encode branch
names with slashes before hitting `repos/<r>/branches/{x}`.

## Agent runtime env

Tauri sets these when spawning `agent/main.ts`:

| Env var               | Purpose                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `AETHON_DOCS_DIR`     | Bundled docs (`docs/aethon-agent/`) — system prompt points the model here.                              |
| `AETHON_USER_DIR`     | `~/.aethon/` — extensions, skills, sessions, state file.                                                 |
| `AETHON_STATE_FILE`   | `~/.aethon/state.json` snapshot, debounced 200 ms.                                                       |
| `AETHON_SESSIONS_DIR` | `~/.aethon/sessions/<tabId>/` — pi `SessionManager.continueRecent` per tab.                              |
| `AETHON_RELEASE_MODE` | `"1"`/`"0"`. System prompt branches on this to avoid pointing at source paths in release.                |
| `AETHON_PROJECT_ROOT` | Source tree path in dev only.                                                                            |

`agent/system-prompt.ts` composes DEFAULT → optional `~/.aethon/system-prompt.md`
override → optional `~/.aethon/system-prompt-append.md` → runtime snapshot
from `getRuntimeSnapshot()`. Snapshot rebuilds on every
`resourceLoader.reload()`; extensions load **before** the default tab so
its session prompt sees them.

## Logging

Levels via `AETHON_LOG` (preferred) or `RUST_LOG` / `LOG_LEVEL`. Defaults
`info` in dev, `warn` in release. The Rust subscriber uses
`tracing-subscriber::EnvFilter` so target scopes work
(`AETHON_LOG=aethon::agent_watch=debug,aethon::config=warn`).

Two sinks: stderr (live) and `~/.aethon/logs/` (daily-rotating, 7-day
retention). Two file series share that directory:
- `aethon.YYYY-MM-DD` — Rust (`tracing`)
- `bridge.YYYY-MM-DD.log` — bun (`agent/logger.ts`)

## Driving the app from Claude

`.claude/skills/aethon-debug/` is slash-commandable. In debug builds the
Rust shell starts a TCP eval server on `127.0.0.1:19433` (override with
`AETHON_DEBUG_PORT`); `scripts/debug-eval.sh` ships JS to it, which
wraps in an async IIFE and evals inside the webview. Use proactively
after touching UI or agent code.

Dev-only webview globals:
- `window.__AETHON_STATE__()`, `window.__AETHON_SET_STATE__(next)`
- `window.__AETHON_INVOKE__` (Tauri `invoke`)
- `window.__AETHON_REGISTRY__` (`SkillRegistry`)
- `window.aethon` (public runtime API)

The dev build must already be running — never launch a release build
(debug server gated by `cfg(debug_assertions)`).

## Conventions

- **Conventional Commits** for all messages: `feat(scope):`, `fix(scope):`.
- **TypeScript strict + `verbatimModuleSyntax` + `erasableSyntaxOnly`.**
  Use `import type { ... }` for type-only imports.
- **No global state in the Rust shell** beyond Tauri's `Manager`
  (currently just the `AgentProcess` mutex).
- **No emojis in code or commits** unless asked.
- A few `react-hooks/*` per-line disables exist for set-state-in-effect
  resync paths + intentionally-empty memo deps. Audit on touch; don't
  broaden.

## Adding a Tauri plugin

1. `cargo add tauri-plugin-X --manifest-path src-tauri/Cargo.toml`
2. Register in `src-tauri/src/lib.rs` via `.plugin(tauri_plugin_X::init())`
3. Add permissions to `src-tauri/capabilities/default.json`

## Nix / Linux build notes

`flake.nix` carries platform-specific workarounds — read it before
changing the toolchain or build inputs.

- Linux needs `webkit2gtk_4_1` + GTK closure on `PKG_CONFIG_PATH` (set
  manually because numtide/devshell skips pkg-config setup hooks).
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` dodges a Mesa/Wayland crash.
- macOS uses Apple's `/usr/bin/cc` (Nix CC wrapper has SDK mismatches
  against current nixpkgs unstable), and pulls libiconv via
  `LIBRARY_PATH` + `NIX_LDFLAGS`.
