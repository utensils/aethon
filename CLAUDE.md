# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Aethon is a Tauri 2 + React + TypeScript desktop app. See `SPEC.md` for the
design vision and `README.md` for the public-facing description.

The Tauri shell is intentionally thin — agent logic lives elsewhere. The Rust
side handles OS boundaries; the React frontend renders A2UI components emitted
by the agent.

## Stack

- **Backend**: Rust + Tauri 2, crate name `aethon`, lib name `aethon_lib`
- **Frontend**: React 19, TypeScript, Vite, bun
- **Agent**: TypeScript via `@mariozechner/pi-coding-agent`, run as a `bun`
  subprocess spawned from the Rust shell
- **Dev env**: Nix flake (flake-parts + numtide/devshell + treefmt-nix +
  rust-overlay), Rust toolchain pinned at **1.92.0**
- **Targets**: macOS (aarch64), Linux (x86_64 / aarch64), Windows (later)

## Common Commands

Run inside `nix develop` (or via direnv — `.envrc` is `use flake`). The
devshell exposes these helpers (defined in `flake.nix`):

| Command     | What it does                                                   |
| ----------- | -------------------------------------------------------------- |
| `dev`       | `scripts/dev.sh` → `cargo tauri dev` with port auto-increment  |
| `build-app` | `cargo tauri build` — release bundle                           |
| `check`     | Full CI gate: clippy + tsc + ESLint + cargo test + vitest      |
| `lint`      | ESLint frontend + agent (no auto-fix)                          |
| `test`      | Run Rust + TS tests (cargo test --lib + vitest run)            |
| `coverage`  | TS coverage report under `coverage/` (vitest v8)               |
| `fmt`       | `treefmt` (rustfmt + nixfmt)                                   |

`bun tauri dev` and `bun tauri build` also work (they go through the JS-side
`@tauri-apps/cli` wrapper). One-time after pulling: `bun install`.

## Architecture

### Layer responsibilities

1. **Tauri shell** (`src-tauri/src/lib.rs`, helpers in `helpers.rs`,
   debug-only commands + TCP eval server in `debug.rs` gated by
   `#[cfg(debug_assertions)]`, PTY shell-tab module in `shell.rs`) —
   owns the OS boundary. Core agent commands: `send_message` (forwards
   a chat string to the agent's stdin) and `dispatch_a2ui_event`
   (forwards a structured event). On the first `send_message` it spawns
   `bun run agent/main.ts` and starts a reader thread that emits each
   stdout line as a Tauri `agent-response` event. Shell-tab commands
   (`shell_open`, `shell_input`, `shell_resize`, `shell_close`) live in
   `shell.rs` behind a `ShellRegistry` (per-tab `portable-pty` PTY +
   reader thread; emits `shell-output` / `shell-exit` events). UTF-8
   chunk boundaries are preserved across reader-thread reads via a
   carry buffer + `Utf8Error::error_len()` truncation/invalid split —
   don't replace this with per-chunk `from_utf8_lossy`, multi-byte
   sequences will corrupt.
2. **Agent bridge** (`agent/main.ts` + helpers) — JSON-lines over stdio.
   Reads `{type:"chat", content}` or `{type:"a2ui_event", event}`, replies
   with `{type:"response"|"a2ui"|"error", ...}`. Provider config comes from
   env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …); pi-ai picks one up.
   Helpers (each with a colocated `*.test.ts`):
   - `agent/project-extensions.ts` — discovers project-local extensions
     (walks up from the active cwd looking for `.aethon/extensions/`).
   - `agent/session-history.ts` — reads pi session transcripts under
     `$AETHON_SESSIONS_DIR/<tabId>/` so the frontend can rehydrate visible
     history on restart.
   - `agent/terminal-stream.ts` — buffers `bash`-tool output as an A2UI
     terminal stream (the `BashTerminalStreamState` snapshot type).
3. **React frontend** (`src/`) — see below. Listens for `agent-response`
   events, parses each line, and routes it into the chat history or canvas.

### Frontend model — three things to know

**1. Layout-as-payload.** The default UI is *not* hardcoded React. It's
`src/skills/default-layout/workstation.a2ui.json`, loaded as the boot payload
and fed to the same `A2UIRenderer` that handles agent output. A skill is the
extension primitive; the default-layout skill registers `workstation` (the
boot default) plus three sibling variations (`command-deck`, `editorial`,
`live-layout`) — switching is a sidebar/palette click that calls
`window.aethon.activateLayout(id)`. Don't add static chrome in `App.tsx` —
extend the layout JSON or register a new skill. Layouts must conform to
the slot contract in `src/skills/default-layout/slots.json` + `slots.ts`
(canonical area names: `header`, `sidebar`, `canvas`, `composer`,
`terminal`, `status`; non-canonical layouts declare a `slotMap`).

**2. Single state store, JSON Pointer addressed.** All app state lives in one
object on `App` (`messages`, `draft`, `waiting`, `status`, `connection`,
`canvas`, `terminal.open`, …). Components read it via `$ref` JSON Pointers
(e.g. `{"value": {"$ref": "/draft"}}`). The renderer applies an *optimistic*
write back to that path for `change`/`submit` events on inputs whose `value`
is a `$ref` — see `applyOptimisticUpdate` in `A2UIRenderer.tsx`. JSON Pointer
helpers: `src/utils/jsonPointer.ts` and `src/utils/dataBinding.ts`.

**3. Two registries.** `A2UIRenderer.tsx` has a hardcoded `PRIMITIVE_REGISTRY`
of 19 input/layout primitives (`text`, `heading`, `paragraph`, `code`, `card`,
`button`, `container`, `divider`, `image`, `icon`, `text-input`,
`date-picker`, `select`, `checkbox`, `slider`, `form`, `form-field`, `list`,
`table`) — these can't be overridden. Everything else (`layout`, `sidebar`,
`chat-history`, `chat-input`, `status-bar`, `terminal-panel`, `main-canvas`,
`shell-canvas`, `tool-card`, `command-palette`, `notification-stack`,
`settings-panel`, `search-panel`, `share-mode-badge`, …) comes from the
`SkillRegistry`, exposed via React context (`useSkillRegistry`). App-root
overlays mount through `<RegistryComponent type="…" />` (also exported
from `A2UIRenderer.tsx`) so a skill can swap any of them with
`aethon.registerComponent`. To add a new component type, register it on a
skill, not in the primitives table.

### Runtime API

`App.tsx` attaches a small API to `window.aethon` so skills (and the dev
console) can swap chrome at runtime:

- `window.aethon.setLayout(payload)` — replace the active layout
- `window.aethon.resetLayout()` — restore the default-layout boot payload
- `window.aethon.registerLayout({ id, name, payload })` — register a layout
  variation that appears in the sidebar's `layouts` section + palette.
  Also exposed agent-side as `aethon.registerLayout` (bridge in
  `agent/main.ts`). Reserved ids: `workstation`, `command-deck`,
  `editorial`, `live-layout`. Id pattern: `/^[A-Za-z][\w-]*$/`.
- `window.aethon.activateLayout(id)` — switch to a registered layout
- `window.aethon.registerSkill(skill)` — register a skill; if it has a
  `layout`, also activate it
- `window.aethon.listSkills()` — names of currently registered skills
- `window.aethon.openProject(path)` — register/activate a project

### Keyboard shortcuts (current set)

| Combo | Action |
|---|---|
| `Cmd+T` | New tab — **focus-aware**: agent tab when outside the bottom terminal panel, shell sub-tab when focus is inside the panel. `[shortcuts] new_tab_kind = "shell"` flips this to "always shell". |
| `Cmd+Shift+T` | New shell sub-tab (always — auto-opens the bottom panel) |
| `Cmd+W` | Close active tab. Shell tabs prompt before killing a running job (disable via `[shell] prompt_before_close = false`). |
| `Cmd+Opt+T` | Reopen most-recently-closed tab |
| `Cmd+]` / `Cmd+[` | Next / previous *agent* tab (top strip; shells are filtered). When focus is inside the bottom panel, cycles between sub-tabs (agent-bash + each shell) instead. |
| `Cmd+Shift+]` / `Cmd+Shift+[` | Move active agent tab right / left. When focus is inside the bottom panel, reorders shell sub-tabs instead. |
| `Cmd+1`..`Cmd+8` | Jump to agent tab N. When focus is inside the bottom panel, jumps between sub-tabs instead (1 = agent-bash). |
| `Cmd+9` | Jump to last agent tab (or last shell sub-tab when focus is in panel). |
| `Cmd+P` / `Cmd+Shift+P` | Command palette (switcher / commands) |
| `Cmd+\`` | Toggle bottom terminal panel (Agent bash sub-tab + each user shell as a sub-tab) |
| `Cmd+B` | Toggle sidebar |
| `Cmd+K` | Clear chat |
| `Cmd+.` | Stop current prompt |
| `Cmd+=` / `Cmd+-` | Zoom in / out |
| `Cmd+0` | Toggle focus between composer and terminal panel |
| `Cmd+Shift+0` | Reset zoom |
| `Cmd+L` | Focus active tab's primary input (composer for agent tabs, terminal for shell tabs) |
| `Cmd+,` | Open Settings panel |
| `Cmd+Shift+F` | Cross-session search overlay |
| `Cmd+Shift+S` | Export active chat as Markdown to `~/Downloads/` (agent tabs only) |
| `Cmd+Ctrl+F` (mac) / `F11` | Toggle fullscreen |
| `F12` | Toggle WebKit DevTools (debug builds) |
| `Esc` | Close palette / settings / search overlay (when open) |

`metaKey || ctrlKey` for cross-platform — Linux/Windows users get the
same set under Ctrl. Native menu accelerators in `src-tauri/src/lib.rs`
mirror these. Extension `aethon.registerKeybinding` priority is
unchanged: extensions run first and may override built-ins.

### Terminal panel mental model

The **bottom terminal panel** (toggle `Cmd+\``) is a tabbed surface
hosting two kinds of sub-tabs:

1. **Agent bash** (always present, sub-tab id `"agent-bash"`,
   read-only). A live stream of the bash tool's stdout for the active
   agent tab. Same content also appears in chat as a tool card; the
   panel pins it visible while you scroll chat.
2. **Shell sub-tabs** (zero or more). Full interactive PTYs backed by
   `portable-pty`. TUI-capable (vim, htop, fzf), 256-color, mouse
   reporting. Status line under the xterm shows
   `cwd · command · share-mode badge · cols×rows`.

The top tab strip carries **only agent tabs** (chat sessions). Shell
sub-tabs render in the bottom panel; the `TabStrip` composite filters
out `kind === "shell"` automatically.

`Cmd+T` is **focus-aware**: focus inside the bottom panel → new shell
sub-tab; focus elsewhere → new agent tab. `Cmd+Shift+T` always spawns
a new shell sub-tab and auto-opens the panel. This matches the
mental model "new tab of whatever surface I'm using".

State paths: `/terminalPanel/activeSubId` tracks which sub-tab is
visible (defaults to `"agent-bash"`). `/terminal/open` toggles the
whole panel. Shells live in `/tabs` next to agents but with
`kind === "shell"` — the rendering layer routes them to the correct
surface.

### Tab kinds — agent vs shell

`Tab.kind` is `"agent" | "shell"`. Agent tabs carry chat-history fields
(`messages`, `draft`, `waiting`, `queueCount`); shell tabs carry a
`shell: ShellMeta` payload (`cwd`, `command`, `args`, `shareMode`,
`shellState`, `exitCode?`). Share-mode UI helpers live in
`src/utils/shareMode.ts` (`cycleShareMode`, `shareModeLabel`,
`shareModeTooltip`); the security boundary is enforced Rust-side in
`shell.rs` (`ShareState` + `Scrollback`). The bridge surface is `aethon.shells.{list, read, write}` — round-trips
through the mutation-ack channel as `shell_query` ops with
`MutationResult.data` populated. **Do not add an agent-driven
`setShareMode`** — discoverable tab ids in `/tabs` plus a setter would
defeat the opt-in boundary `list()` enforces (only the user's badge
click may flip a mode). Reads are forward-paging from the caller's
cursor; cold-start callers omit the cursor to get the latest
`max_bytes`. Writes pop an Allow/Deny notification in `read-write` mode
(reusing the existing notification primitive — `pushNotification` with
`durationMs: null` + `actions`); `read-write-trusted` writes go through
without prompting. Pre-frontend-ready callers awaiting
`shells.list/read/write` block until the handshake completes (queries
need real `data`, not the side-effect-mutation shortcut). Don't add a
fast-path that lets the bridge invoke Tauri commands directly — the
read clamp + privacy floor have to live where the PTY does. Most code paths special-case via
`tab.kind === "shell"` checks (see `closeTab`, `newShellTab`,
`/agentTabActive` + `/shellTabActive` derived flags). The shell-canvas
composite (`ShellCanvas` in `components.tsx`) replaces the agent
`main-canvas` + `chat-input` cells when a shell tab is active —
controlled by the `/agentTabActive` / `/shellTabActive` `$ref` visibility
flags in `workstation.a2ui.json`. Keybindings: `Cmd+T` = new shell tab,
`Cmd+Shift+T` = new agent tab (Terminal.app convention; configurable via
`[shortcuts] new_tab_kind` once that setting lands).

### Command palette

`Cmd+P` opens the switcher (tabs / sessions / projects / layouts /
themes / models first); `Cmd+Shift+P` opens it in commands mode (slash
commands / keybindings first). The palette is a registered builtin
component (`command-palette` type) in `defaultLayoutSkill` so a skill
can override it via `aethon.registerComponent`. Pure ranking + section
selectors live in `src/skills/default-layout/palette-items.ts` so vitest
can exercise them without React. Query prefixes: `>` forces commands,
`@` forces tabs, `?` forces keybindings. Arrow nav uses a document-level
capture-phase keydown handler keyed off a `navRef` so focus theft and
content swaps don't strand the selection — see the comments in
`command-palette.tsx` before refactoring.

### Projects

Pi sessions are scoped to a working directory. `src/projects.ts` persists
the project list at `~/.aethon/projects.json` (max 16, MRU-ordered) and
the active project's path is passed as `cwd` on `tab_open`. **Existing
tabs keep the cwd they were created with** — switching the active project
only affects new tabs. When updating tab/session code, treat the per-tab
cwd as immutable.

### Agent runtime contract

The Tauri shell sets these env vars when spawning the bridge (`agent/main.ts`):

| Env var | Purpose |
|---------|---------|
| `AETHON_DOCS_DIR` | Bundled docs dir (`docs/aethon-agent/` in dev, `<resource_dir>/docs/aethon-agent/` in release). Contains `README.md`, `api.md`, `components.md`, `extensions.md`. The system prompt points the model at these for the authoritative API/component reference. |
| `AETHON_USER_DIR` | `~/.aethon/` — user extensions, skills, sessions, state file. |
| `AETHON_STATE_FILE` | `~/.aethon/state.json` — JSON snapshot of loaded extensions, themes, custom components, layout summary, and tab list. Rewritten (debounced 200 ms) on every registration. |
| `AETHON_SESSIONS_DIR` | `~/.aethon/sessions/<tabId>/` per tab. Each tab uses `SessionManager.continueRecent` so pi context survives bun restarts. |
| `AETHON_RELEASE_MODE` | `"1"` in release, `"0"` in dev. The system prompt branches on this to (a) avoid telling the model to read source files that aren't there, (b) point at `~/.aethon/extensions/` for new extensions instead. |
| `AETHON_PROJECT_ROOT` | Source tree path (dev only). Lets the model reference `agent/main.ts` etc. by absolute path during dev work. |

The bridge's `agent/system-prompt.ts` composes a layered prompt:
DEFAULT (static API + primitives reference, mentioning the docs/state-file
paths) → optional user override at `~/.aethon/system-prompt.md` →
optional user append at `~/.aethon/system-prompt-append.md` → **runtime
snapshot** built from `getRuntimeSnapshot()` (extensions, themes,
components, layout summary, tabs). The snapshot is rebuilt every time
`resourceLoader.reload()` runs, so the bootstrap order is important —
extensions load **before** the default tab is created so its session
prompt sees them.

### globalThis.aethon (bridge side, in agent/main.ts)

Mutation: `registerComponent`, `setState`, `setLayout`, `patchLayout`,
`registerSidebarSection`, `registerTheme`, `onEvent`. Introspection:
`listExtensions`, `listComponents`, `listThemes`, `getLayout`,
`getRuntimeSnapshot` — these let the agent answer "what's loaded?"
without scraping the filesystem. The same data is also written to
`$AETHON_STATE_FILE` so a `cat` works without an introspection round-trip.

### Event flow gotcha

`A2UIRenderer` accepts an `onEvent` prop. Returning `true` from it marks the
event as handled and *suppresses* the default Tauri `dispatch_a2ui_event`
forward. `App.tsx` uses this to short-circuit `chat-input` submits (calls
`send_message` directly) and the sidebar's `toggle-terminal` item (mutates
`/terminal/open` locally). New components that should drive native APIs go
through this path.

## Conventions

- **Conventional Commits** for all messages: `feat(scope):`, `fix(scope):`, etc.
- **Two-space indent** for Nix; standard for everything else.
- **TypeScript strict mode** + `verbatimModuleSyntax` + `erasableSyntaxOnly`.
  Use `import type { ... }` for type-only imports.
- **Vite port defaults to 1420 but auto-increments via `scripts/dev.sh`**
  when busy. The wrapper finds free Vite + debug ports, writes them to
  `~/.aethon/dev-info.json`, exports `VITE_PORT` + `AETHON_DEBUG_PORT`,
  and overrides Tauri's `devUrl` via `$TAURI_CONFIG`. `strictPort: true`
  stays on so Vite fails loudly if the wrapper hands it a busy port. The
  aethon-debug skill reads `dev-info.json` to follow the chosen port.
- **No global state in the Rust shell** beyond what Tauri's `Manager` exposes
  (currently just the `AgentProcess` mutex). Business logic belongs in the
  agent, not the shell.
- **No emojis in code or commits** unless the user explicitly asks.

## Editing Tauri Config

`src-tauri/tauri.conf.json` controls window, bundle, and security policy.
Adding a Tauri plugin requires three steps:

1. `cargo add tauri-plugin-X --manifest-path src-tauri/Cargo.toml`
2. Register in `src-tauri/src/lib.rs` via `.plugin(tauri_plugin_X::init())`
3. Add the plugin's permissions to `src-tauri/capabilities/default.json`

## Nix / Linux build notes

`flake.nix` carries platform-specific workarounds — read it before changing
the toolchain or build inputs:

- Rust is pinned at **1.92.0** because 1.95+ currently fails to compile
  `icu_provider 2.2.0`, `regex-automata 0.4.14`, and `objc2` (transitive
  Tauri 2.10 deps). The pin has a comment; bump only when upstream catches up.
- Linux build needs `webkit2gtk_4_1` + GTK closure on `PKG_CONFIG_PATH`. The
  flake sets these manually because numtide/devshell skips nixpkgs'
  pkg-config setup hook. `WEBKIT_DISABLE_DMABUF_RENDERER=1` is set to dodge
  a Mesa/Wayland crash in WebKitGTK's DMA-BUF renderer.
- macOS uses Apple's `/usr/bin/cc` (not Nix's CC wrapper) due to SDK
  mismatches with current nixpkgs unstable, and pulls libiconv via
  `LIBRARY_PATH` + `NIX_LDFLAGS`.

## Reference Projects

- `~/Projects/utensils/Claudette` — sibling Tauri 2 + TS project with much
  deeper integration (xterm, voice, mDNS). Good source of patterns for IPC,
  window management, and the Nix Linux build closure.
- `~/Projects/utensils/claudex` — sibling Rust-only project. Good source of
  patterns for the flake skeleton (flake-parts + devshell + treefmt + crane).

## Hot reload

Vite hot-reloads the frontend automatically. The agent subprocess (`bun run
agent/main.ts`) is held alive across reloads in Tauri state, so editing the
agent on its own would not pick up changes — to fix this, in debug builds
the Rust shell uses `notify` to watch `agent/` recursively and kills the
child whenever a file changes. The next Tauri command (e.g. `start_agent`,
`send_message`) lazily respawns it with the new code, and the frontend
receives an `agent-reloaded` event so it can show "agent reloaded" in the
status bar. Production builds skip the watcher entirely.

If you find yourself wanting to manually restart the agent during dev, the
simplest path is `touch agent/main.ts`.

## Driving the app from Claude (`aethon-debug` skill)

`.claude/skills/aethon-debug/` ships a slash-commandable skill for inspecting
and driving the running dev app. In debug builds the Rust shell starts a TCP
eval server on `127.0.0.1:19433` (override with `AETHON_DEBUG_PORT`); the
script `scripts/debug-eval.sh` ships JS to that server, which wraps it in
an async IIFE, evals it inside the webview, and returns the stringified
result. Patterned on Claudette's `claudette-debug` skill — see its `SKILL.md`
for the full action list.

Webview globals exposed in dev only:

- `window.__AETHON_STATE__()` — snapshot of the layout state object
- `window.__AETHON_INVOKE__` — Tauri `invoke` (used by the eval wrapper)
- `window.__AETHON_REGISTRY__` — `SkillRegistry` instance
- `window.__AETHON_SET_STATE__(next)` — replace state (advanced)
- `window.aethon` — public runtime API (`setLayout`, `registerSkill`, etc.)

Use this proactively after touching any UI / agent code: connect, send a
chat, screenshot, verify. The dev build must already be running — never
launch a release build (the debug server is gated by `cfg(debug_assertions)`).

## Status — what is and isn't wired up

The authoritative checklist is in `SPEC.md` ("Status Checklist" section,
keyed against milestones M1–M5). Update both that checklist and any
relevant notes here when capabilities land.

**Quick highlights as of writing:** M1–M5 complete + M6 P1 shipped
(interactive PTY-backed user shell tabs via `portable-pty`, `Tab.kind`
discriminator, `Cmd+T` = shell / `Cmd+Shift+T` = agent, theme-agnostic
xterm) + M6 P2 shipped (per-tab `ShareMode` 4-value enum with
privacy-floor guardrail, `aethon.shells.{list, read, write}` bridge
API with per-write Allow/Deny user confirmation in `read-write` mode,
clickable share-mode badge in the shell status line, `[shell]
default_share_mode` config seeded inside `shell_open` so the floor
pins at byte 0). Pi-tool registration of `listShells`/`readShell`/
`writeShell` is the next phase — the API is already reachable via
`globalThis.aethon.shells.*` from extensions today.
Tool execution surfaces as A2UI cards, multi-tab persistent
sessions, light theme, system tray + native menu, slash command picker,
real `~/.aethon/config.toml`, layout-slot contract (`canvas` +
`composer` required, `slotMap` for non-canonical layouts), generic
`extension_lifecycle` feedback channel, registerable slash commands /
keybindings / menu items / event routes / layouts (4-layout catalogue
via `aethon.registerLayout`), mutation-feedback channel (every mutation
returns `Promise<MutationResult>`), command palette (Cmd+P switcher /
Cmd+Shift+P commands), v0.2.0 GitHub release with macOS .dmg + Linux
.deb/AppImage + Windows NSIS bundles via Nix overlay.

## Test coverage + linting

| Tool | Scope | Devshell command |
|---|---|---|
| `cargo clippy -D warnings` | Rust shell + helpers | `check` |
| `cargo test --lib` | Rust unit tests under `src-tauri/src/helpers.rs` | `test` |
| `bunx tsc -b --noEmit` | TypeScript types (frontend + agent) | `check` |
| `bunx eslint .` | TS + React lint, type-aware via tsconfig | `lint` |
| `bunx vitest run` | TS unit tests (`src/**/*.test.ts`) | `test` |
| `bunx vitest run --coverage` | TS coverage report (v8) | `coverage` |

The `check` devshell command runs all of the above as a single CI gate.
ESLint is configured for **0 errors and 0 warnings**. A handful of `react-hooks`
disables (set-state-in-effect for state-resync paths, exhaustive-deps for
intentionally-empty memo deps) are scoped per-line with author rationale —
audit them on touch, don't broaden them.

## Local-only files (gitignored)

`run-phase*.sh` and `aethon-phase*.png` are ad-hoc test-harness artifacts —
phase scripts spawn the dev server and Playwright-MCP grabs screenshots.
Don't commit them and don't rely on them being present.
