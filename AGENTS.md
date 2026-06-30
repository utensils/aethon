# AGENTS.md

This file provides guidance to OpenAI Codex when working with code in this repository.

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
  rust-overlay), Rust toolchain pinned at **1.92.0** in `flake.nix` (via
  rust-overlay); `rust-toolchain.toml` says `channel = "stable"` for non-Nix
  builds — the Nix pin takes precedence inside the devshell
- **Targets**: macOS (aarch64), Linux (x86_64 / aarch64), Windows (later)

## Common Commands

Run commands inside the Nix devshell (or via direnv — `.envrc` is `use flake`).
Before running native app commands, explicitly check whether the shell is
already in that environment:

```bash
printenv IN_NIX_SHELL DIRENV_DIR
command -v dev check build-app
```

If `IN_NIX_SHELL` / `DIRENV_DIR` are empty or the devshell helper commands are
missing, do not run `bun tauri dev`, `cargo tauri dev`, `cargo test`, or
`build-app` directly from the plain shell. Use `nix develop -c ...` instead:

```bash
nix develop -c dev
nix develop -c check
nix develop -c build-app
nix develop -c cargo test --lib -p aethon -- helpers::test_name
```

This is mandatory for native macOS UAT. Plain shells often inherit incompatible
flags or miss SDK/libiconv/toolchain paths, causing noisy linker failures that
are not app regressions.

The devshell exposes these helpers (defined in `flake.nix`):

| Command                | What it does                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `dev`                  | `scripts/dev.sh` → `cargo tauri dev` with port auto-increment                                                                       |
| `docs`                 | `vitepress dev` from `website/` bound to `0.0.0.0` (LAN-reachable; :5173)                                                           |
| `build-app`            | `cargo tauri build` — release bundle                                                                                                |
| `understand-dashboard` | `scripts/understand-dashboard.sh` → Vite dashboard for `.understand-anything/knowledge-graph.json` (open the printed `?token=` URL) |
| `check`                | Full CI gate: clippy + tsc + ESLint + cargo test + vitest                                                                           |
| `lint`                 | ESLint frontend + agent (no auto-fix)                                                                                               |
| `test`                 | Run Rust + TS tests (cargo test --lib + vitest run)                                                                                 |
| `coverage`             | TS coverage report under `coverage/` (vitest v8)                                                                                    |
| `fmt`                  | `treefmt` (rustfmt + nixfmt + prettier for JSON/MD/YAML/CSS + taplo for TOML)                                                       |
| `clean`                | `scripts/dev.sh --clean` — wipe the `${TMPDIR}/aethon-dev/` sandbox                                                                 |

`bun tauri dev` and `bun tauri build` also work (they go through the JS-side
`@tauri-apps/cli` wrapper). One-time after pulling: `bun install`.

To run a single test file: `bunx vitest run agent/terminal-stream.test.ts`.
To run tests matching a name: `bunx vitest run -t "test name pattern"`.
To run a single Rust test: `cargo test --lib -p aethon -- helpers::test_name`.

## Testing Discipline

Treat bug fixes as TDD by default. Before changing implementation, write or
tighten a regression test that fails for the reported behavior and proves the
actual user-visible contract. Run that focused test and confirm it is red, then
make the smallest fix that turns it green. Do not count a component-only test as
coverage for an app workflow when the bug crosses component, route table, hook,
bridge, or persisted-state boundaries; add the test at the layer where the
contract actually broke, and keep lower-level tests only as supporting coverage.

For UI/session/project/worktree bugs, regression tests must exercise the full
state transition the user relies on: event dispatch, route handling, active
project/worktree alignment, tab creation/selection, landing visibility, and any
session-history restore flags. A test that only verifies a button emits an event
is not enough if the app also needs to route that event and mutate state. When a
fix changes a routed event or state mirror, include dispatcher/hook tests that
would fail if the event fell through, the wrong cwd was selected, or stale UI
state kept rendering over the restored surface.

Every regression fix should end with the focused red-green test, the nearby test
slice, and the relevant broader gate (`bunx vitest run`, `bun run typecheck`,
`bun run lint`, `bun run build`, or `check` depending on blast radius). If a
gate exits 0 with existing warnings, report those warnings clearly; do not treat
new warnings as acceptable without addressing or justifying them.

## UI UAT Discipline

For Aethon UI and interaction changes, verify the running dev app with the
right tool for the job: use the `aethon-debug` skill for webview state,
programmatic event dispatch, screenshots, and fast end-to-end probes; use the
`computer-use` skill when visual/manual UI behavior matters, such as clicking,
typing, focus, menus, or layout as the user sees it. Prefer the narrower debug
probe first when diagnosing state, then confirm user-facing behavior with
Computer Use when the fix depends on rendered interaction. Never UAT against
`/Applications/Aethon.app` or any release bundle unless the user explicitly asks
for release testing; use the running dev app only.

## Architecture

### Layer responsibilities

1. **Tauri shell** (`src-tauri/src/lib.rs` is a thin entry — `run()`
   builder + plugin/state registration; the agent supervisor lives in
   `src-tauri/src/agent_process/` (`AgentProcesses` managed state, plus
   `spawn`/`readers`/`sidecar`); concern-grouped IPC commands live under
   `src-tauri/src/commands/`: `boot.rs`, `config.rs`, `devshell.rs`,
   `extensions/`, `fs/`, `git/`, `host.rs`, `mcp.rs`,
   `native_windows.rs`, `scheduler/`, `server.rs`, `session.rs`,
   `setup.rs`, `startup/`, `subagents.rs`, `updater.rs`, `voice.rs`,
   `window.rs`; shell-tab PTY logic under `src-tauri/src/shell/`
   (`lifecycle/`, `scrollback.rs`, `sharemode.rs`); native window
   geometry persistence in `window_state/` (`schema`, `restore`, `save`,
   `monitor_matching`, `migration`, `persistence`); pure helpers in
   `helpers/` (`paths`, `names`, `config`); HTTP + mDNS discovery in
   `server/` (`http.rs`, `mdns.rs` — see "Networked discovery" below);
   debug-only TCP eval server in `debug.rs` gated by
   `#[cfg(debug_assertions)]`)
   — owns the OS boundary. Core agent commands: `send_message`
   (forwards a chat string to the agent's stdin) and
   `dispatch_a2ui_event` (forwards a structured event). On the first
   `send_message` it spawns `bun run agent/main.ts` and starts a reader
   thread that emits each stdout line as a Tauri `agent-response`
   event. Shell-tab commands (`shell_open`, `shell_input`,
   `shell_resize`, `shell_close`) sit behind a `ShellRegistry` (per-tab
   `portable-pty` PTY + reader thread; emits `shell-output` /
   `shell-exit` events). UTF-8 chunk boundaries are preserved across
   reader-thread reads via a carry buffer + `Utf8Error::error_len()`
   truncation/invalid split — don't replace this with per-chunk
   `from_utf8_lossy`, multi-byte sequences will corrupt.
2. **Agent bridge** (`agent/main.ts` is a thin entry-point — env wiring
   - boot order; the readline loop and 28-case dispatcher live in
     `agent/dispatcher.ts`) — JSON-lines over stdio. Reads
     `{type:"chat", content}` or `{type:"a2ui_event", event}`, replies
     with `{type:"response"|"a2ui"|"error", ...}`. Provider config comes
     from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …); pi-ai
     picks one up. Modules (each with a colocated `*.test.ts`):
   * `state.ts` — the `AethonAgentState` data class (registries, tabs,
     pending mutations, layout, themes).
   * `aethon-api.ts` — `buildAethonApi` factory exposed on `globalThis`.
   * `dispatcher.ts` — readline loop + per-message-type dispatch.
   * `tab-lifecycle/` — `ensureTab`, pi session subscribers, ready
     handshakes, tab-scoped event emitters, terminal streams, and
     extension slash-command discovery (`index.ts` is the public barrel).
   * `extension-loader/` — discovers + loads loose user extensions,
     project-local extensions, npm-distributed extension packages, pi
     extension metadata, persisted tabs, and theme directories
     (`index.ts` is the public barrel).
   * `project-extensions.ts` — walks up from the active cwd looking
     for `.aethon/extensions/`.
   * `system-prompt.ts` — composes the layered system prompt from
     `system-prompt/prompt-template.ts`, `system-prompt/types.ts`, user
     overrides, and the runtime snapshot.
   * `runtime-snapshot.ts` — `getRuntimeSnapshot` + `$AETHON_STATE_FILE`
     persistence.
   * `layout-manager.ts` — `setLayout` / `patchLayout` /
     `registerLayout` + summarize helpers.
   * `state-mutation.ts` — extension `setState` (size guard + per-tab
     mirror).
   * `mutation-ack.ts` — Promise/timeout handshake for mutation acks.
   * `event-routes.ts` — extension `onEvent` route table.
   * `keybindings.ts` — extension keybinding registration.
   * `notifications.ts` — agent-pushed toasts.
   * `session-history/` — reads local chat JSONL and pi transcripts under
     `$AETHON_SESSIONS_DIR/<tabId>/`, parses/restores messages and tool
     cards, dedupes local pending content, and exposes metadata helpers
     (`index.ts` is the public barrel).
   * `terminal-stream.ts` — buffers `bash`-tool output as an A2UI
     terminal stream (the `BashTerminalStreamState` snapshot type).
   * `canvas.ts` — helpers for building and patching A2UI canvas
     payloads.
   * `agent-errors.ts` — extracts structured error info from pi agent
     end-of-run errors (wraps `AgentEndError` classification).
   * `shell-tools.ts` — pi tool implementations for
     `listShells`/`readShell`/`writeShell` (bridge-side counterpart to
     the Rust `shell_query` Tauri command).
3. **React frontend** (`src/`) — `App.tsx` is a thin shell of `useX()`
   hooks (`src/hooks/`); event-routing logic lives in `src/eventRoutes/`
   (one file per prefix family, with sidebar subroutes under
   `src/eventRoutes/sidebar/`); root overlay orchestration lives behind
   `useUiOverlays` with per-surface modules in `src/hooks/uiOverlays/`;
   `src/runtime/windowApi.ts` builds the `window.aethon` runtime API.
   Listens for `agent-response` events, parses each line, and routes it
   into the chat history or canvas.

### Agent process model + workspace concurrency

The supervisor (`src-tauri/src/agent_process/`) runs one **global bridge**
(`GLOBAL_AGENT_KEY`) plus one **worker bridge per non-default tab**
(`tab:<id>`). Tab-scoped message types with a non-default `tabId` route to
that tab's worker (`route_payload_key`); everything else — including
`set_project`, `report`, and the default tab — goes to the global bridge.
Workers spawn lazily on first write, respawn when their cwd changes, and
idle-retire after `[agent] idle_retire_minutes` (15 min default), reconciled
against the frontend's live tab set.

**The global bridge is the sole owner of the frontend extension surface.**
Workers also load project extensions for their own cwd (tools + event
handlers must work in-process), but their registry-replacing messages are
origin-stamped (`agent/origin-gate.ts`) with `originTabId`; the frontend
rejects hydrates whose origin tab isn't in the active workspace bucket. This
stops a background workspace's worker respawn from clobbering the active
workspace's components/themes/keybindings.

### Frontend model — three things to know

**1. Layout-as-payload.** The default UI is _not_ hardcoded React. It's
`src/extensions/default-layout/workstation.a2ui.json`, loaded as the boot payload
and fed to the same `A2UIRenderer` that handles agent output. An extension is
the runtime contribution primitive; the default-layout extension currently registers only
`workstation` while we focus polish on a single surface (the earlier
`command-deck` / `editorial` / `live-layout` variations were dropped from
the catalogue — the variation chrome components stay registered so their
`.a2ui.json` payloads can be re-added when we want sibling layouts back).
Switching layouts (when more exist) is a sidebar/palette click that calls
`window.aethon.activateLayout(id)`. Don't add static chrome in `App.tsx` —
extend the layout JSON or register a new extension. Layouts must conform to
the slot contract in `src/extensions/default-layout/slots.json` + `slots.ts`
(canonical area names: `header`, `sidebar`, `canvas`, `composer`,
`terminal`, `status`; non-canonical layouts declare a `slotMap`).

**2. Single state store, JSON Pointer addressed.** All app state lives in one
object on `App` (`messages`, `draft`, `waiting`, `status`, `connection`,
`canvas`, `terminal.open`, …). Components read it via `$ref` JSON Pointers
(e.g. `{"value": {"$ref": "/draft"}}`). The renderer applies an _optimistic_
write back to that path for `change`/`submit` events on inputs whose `value`
is a `$ref` — see `applyOptimisticUpdate` in `A2UIRenderer.tsx`. JSON Pointer
helpers: `src/utils/jsonPointer.ts` and `src/utils/dataBinding.ts`.

**3. Two registries.** Primitive React components live in
`src/components/primitives/` (`text.tsx`, `controls.tsx`, `form.tsx`,
`layout.tsx`, `media.tsx`); the registry that wires them is built in
`src/components/builtins.tsx` and consumed by `A2UIRenderer.tsx` as a
hardcoded `PRIMITIVE_REGISTRY` of 19 input/layout primitives (`text`,
`heading`, `paragraph`, `code`, `card`, `button`, `container`,
`divider`, `image`, `icon`, `text-input`, `date-picker`, `select`,
`checkbox`, `slider`, `form`, `form-field`, `list`, `table`) — these
can't be overridden. Default-layout extension components are split per
family under `src/extensions/default-layout/` (`chat.tsx`, `terminal.tsx`,
`command-palette.tsx`, `settings-panel.tsx`, `search-panel.tsx`,
`notifications.tsx`, `share-mode-badge.tsx`, `variation-components.tsx`,
`markdown-adapter.tsx`, plus `shell/`, `sidebar/`, and `editor/`
sub-directories); `components.tsx` itself is the registration
aggregator only. Everything else (`layout`, `sidebar`,
`chat-history`, `chat-input`, `status-bar`, `terminal-panel`, `main-canvas`,
`shell-canvas`, `tool-card`, `command-palette`, `notification-stack`,
`settings-panel`, `search-panel`, `share-mode-badge`, …) comes from the
`ExtensionRegistry`, exposed via React context (`useExtensionRegistry`). App-root
overlays mount through `<RegistryComponent type="…" />` (also exported
from `A2UIRenderer.tsx`) so an extension can swap any of them with
`aethon.registerComponent`. To add a new component type, register it on an
extension, not in the primitives table.

### Runtime API

`App.tsx` attaches a small API to `window.aethon` so extensions (and the dev
console) can swap chrome at runtime:

- `window.aethon.setLayout(payload)` — replace the active layout
- `window.aethon.resetLayout()` — restore the default-layout boot payload
- `window.aethon.registerLayout({ id, name, payload })` — register a layout
  variation that appears in the sidebar's `layouts` section + palette.
  Also exposed agent-side as `aethon.registerLayout` (bridge in
  `agent/main.ts`). Reserved id: `workstation`
  (`command-deck` / `editorial` / `live-layout` were trimmed from the
  built-in catalogue and may be reintroduced later — keep the names
  free). Id pattern: `/^[A-Za-z][\w-]*$/`.
- `window.aethon.activateLayout(id)` — switch to a registered layout
- `window.aethon.registerExtension(extension)` — register an extension; if it has a
  `layout`, also activate it
- `window.aethon.listExtensions()` — names of currently registered extensions
- `window.aethon.openProject(path)` — register/activate a project

### Keyboard shortcuts (current set)

| Combo                         | Action                                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cmd+T`                       | New tab — **focus-aware**: agent tab when outside the bottom terminal panel, shell sub-tab when focus is inside the panel. (The old `[shortcuts] new_tab_kind` key is deprecated / a no-op; `Cmd+T` is strictly focus-aware.) |
| `Cmd+Shift+T`                 | New shell sub-tab (always — auto-opens the bottom panel)                                                                                                                                                                      |
| `Cmd+W`                       | Close active tab. Shell tabs prompt before killing a running job (disable via `[shell] prompt_before_close = false`).                                                                                                         |
| `Cmd+Opt+T`                   | Reopen most-recently-closed tab                                                                                                                                                                                               |
| `Cmd+Shift+]` / `Cmd+Shift+[` | Next / previous _agent_ tab (top strip; shells are filtered). When focus is inside the bottom panel, cycles between sub-tabs (agent-bash + each shell) instead. Matches the iTerm / Terminal.app convention.                  |
| `Cmd+Opt+]` / `Cmd+Opt+[`     | Move active agent tab right / left. When focus is inside the bottom panel, reorders shell sub-tabs instead.                                                                                                                   |
| `Cmd+1`..`Cmd+8`              | Jump to agent tab N. When focus is inside the bottom panel, jumps between sub-tabs instead (1 = agent-bash).                                                                                                                  |
| `Cmd+9`                       | Jump to last agent tab (or last shell sub-tab when focus is in panel).                                                                                                                                                        |
| `Cmd+P` / `Cmd+Shift+P`       | Command palette (switcher / commands)                                                                                                                                                                                         |
| `Ctrl+\``                     | Toggle bottom terminal panel (Agent bash sub-tab + each user shell as a sub-tab)                                                                                                                                              |
| `Cmd+B`                       | Toggle sidebar                                                                                                                                                                                                                |
| `Cmd+K`                       | Clear chat                                                                                                                                                                                                                    |
| `Cmd+.`                       | Stop current prompt                                                                                                                                                                                                           |
| `Shift+Tab`                   | Toggle Plan mode for the active agent session                                                                                                                                                                                 |
| `Cmd+Shift+M`                 | Toggle voice input (push-to-talk dictation into the composer). Hold-to-record key + toggle combo configurable via `[voice]` in `config.toml`.                                                                                 |
| `Cmd+=` / `Cmd+-`             | Zoom in / out                                                                                                                                                                                                                 |
| `Cmd+0`                       | Toggle focus between composer and terminal panel                                                                                                                                                                              |
| `Cmd+Shift+0`                 | Reset zoom                                                                                                                                                                                                                    |
| `Cmd+L`                       | Focus active tab's primary input (composer for agent tabs, terminal for shell tabs)                                                                                                                                           |
| `Cmd+,`                       | Open Settings panel                                                                                                                                                                                                           |
| `Cmd+Shift+F`                 | Cross-session search overlay                                                                                                                                                                                                  |
| `Cmd+Shift+L`                 | Open Scheduled Tasks                                                                                                                                                                                                          |
| `Cmd+Shift+S`                 | Export active chat as Markdown to `~/Downloads/` (agent tabs only)                                                                                                                                                            |
| `Cmd+Ctrl+F` (mac) / `F11`    | Toggle fullscreen                                                                                                                                                                                                             |
| `F12`                         | Toggle WebKit DevTools (debug builds)                                                                                                                                                                                         |
| `Esc`                         | Close palette / settings / search overlay (when open)                                                                                                                                                                         |

`metaKey || ctrlKey` for cross-platform — Linux/Windows users get the
same set under Ctrl. Native menu accelerators in `src-tauri/src/lib.rs`
mirror these. Extension `aethon.registerKeybinding` priority is
unchanged: extensions run first and may override built-ins.

### Terminal panel mental model

The **bottom terminal panel** (toggle `Ctrl+\``) is a tabbed surface
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
`shareModeTooltip`); the security boundary is enforced Rust-side in the
`src-tauri/src/shell/` module (`sharemode.rs`, backed by `scrollback.rs`).
The bridge surface is `aethon.shells.{list, read, write}` — round-trips
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
composite (`ShellCanvas` in `default-layout/shell/canvas.tsx`) replaces the agent
`main-canvas` + `chat-input` cells when a shell tab is active —
controlled by the `/agentTabActive` / `/shellTabActive` `$ref` visibility
flags in `workstation.a2ui.json`. Keybindings: `Cmd+T` = new agent tab (focus-aware — new shell sub-tab when
focus is inside the bottom panel), `Cmd+Shift+T` = new shell sub-tab (always).

### Slash commands (client-side)

`src/slashCommands.ts` registers frontend-only slash commands that run
without an LLM round-trip (e.g. `/clear`, `/theme`, `/extensions`). They
receive a `SlashCommandContext` with `appendSystem`, `notify`, `clearChat`,
`setTheme`, etc. Pi's server-side / native slash commands are also plumbed
through: the bridge advertises them via `extension_slash_commands` events
and the renderer dispatches them back through the
`native_slash_command` → `native_slash_result` round-trip in
`agent/dispatcher.ts`. They appear in the composer autocomplete next to the
client-side ones. When adding a purely UI action, prefer the client-side
registry; only go through the bridge when the agent needs to observe or
act on the command.

### Extension frontend loading

Extensions can ship React components by setting `aethon.frontendEntry` in
their `package.json` to a relative JS file path. The bridge reads that file
and sends its contents as a string in `extension_frontend_modules` events.
`src/extensions/extensionFrontendLoader.ts` receives these events, wraps each
body in `new Function("React", "extension", code)`, and calls the result with
`React` + a `{ registerComponent(type, fn) }` API object. Components
registered this way land in the `ExtensionRegistry` and are resolved alongside
built-in extension components. A delta payload replaces the full previous set —
re-evaluated modules hot-swap their components; removed modules unregister
theirs. The trust model is identical to bridge-side extension code (user
installed it, no sandbox).

`ExtensionRegistry` also has a `.registerTemplate(type, payload)` path for
declarative A2UI subtree templates — used when an extension provides a
component as an A2UI JSON fragment rather than a React function. The
renderer prefers React components when both exist for the same type.

### Command palette

`Cmd+P` opens the switcher (tabs / sessions / projects / layouts /
themes / models first); `Cmd+Shift+P` opens it in commands mode (slash
commands / keybindings first). The palette is a registered builtin
component (`command-palette` type) in `defaultLayoutExtension` so an extension
can override it via `aethon.registerComponent`. Pure ranking + section
selectors live in `src/extensions/default-layout/palette-items.ts` so vitest
can exercise them without React. Query prefixes: `>` forces commands,
`@` forces tabs, `?` forces keybindings. Arrow nav uses a document-level
capture-phase keydown handler keyed off a `navRef` so focus theft and
content swaps don't strand the selection — see the comments in
`command-palette.tsx` before refactoring.

### Projects + workspaces

**A project has one or more workspaces; a workspace is the main checkout
(`isMain: true`) or a git worktree.** Each workspace runs independently —
its own tabs, agent sessions, git state, and devshell. Workspaces attach
via `src/workspaces.ts` (Rust commands in `commands/git/`); the active
workspace is mirrored to `/activeWorkspaceId` so the file tree and new tabs
follow the sidebar selection.

Aethon is built for concurrent work: users can have multiple projects,
workspaces, tabs, shells, and agents active at the same time. Treat workspace
switching as a restore operation, not a reset. Switching host/project/workspace
or returning to a running tab must not drop, invent, or briefly blank live UI
state such as in-flight status, activity labels, queue counts, attention dots,
tab identity, cwd, model/auth/session association, or terminal state. When a
tab is still running, the chat and footer should immediately reconstruct a
truthful activity affordance from tab-scoped sources (`agentRunningTabs`,
`agentActivityByTab`, per-tab `waiting`, pending queue state, and immutable tab
cwd) even before the next bridge event arrives. Do not rely only on global
`waiting`/`status` for routed workspace UI; those are active-surface summaries
and can lag a workspace bucket switch.

Pi sessions are scoped to a working directory, but Aethon's application
state is SQLite-backed. `src/projects.ts` still reads/writes the logical
`projects.json` state key for compatibility, but `read_state` / `write_state`
persist that key in `~/.aethon/state/aethon.sqlite3`; generated per-project
data lives under `~/.aethon/projects/<projectId>/`. Older project schemas —
including v4's `activeWorktreeId` / `worktreesByProject` spellings — migrate
on read. The active project's path is passed as `cwd` on `tab_open`.
**Existing tabs keep the cwd they were created with** — switching the active
project only affects new tabs. When updating tab/session code, treat the
per-tab cwd as immutable.

The sidebar tree is **host → project → workspace**
(`src/extensions/default-layout/sidebar/`). Tabs bucket per workspace
(`src/projectOps/tabBuckets.ts`, key separator `"::workspace::"`; pre-rename
`"::worktree::"` snapshot keys migrate on load). Git-status polling is
tiered (`src/hooks/statusPollScheduler.ts`): hot = active workspace
(20 s + `git-state-changed` events), warm = last 4 activated workspace roots
(60 s), cold = other projects (5 min).

Tests for project/workspace/session fixes must cover the full concurrent state
transition: switch away from a workspace with a running tab, switch back, and
assert the restored chat/status/sidebar surface is correct without waiting for
a new agent event to repair it.

### Monaco editor + file tree

The editor surface (sidebar file tree + Monaco buffers + media/text
viewers) is implemented as a default-layout sub-extension under
`src/extensions/default-layout/editor/`. Monaco glue lives in `src/monaco/`
(`editor-buffers.ts` manages models per file, `setup.ts` configures
workers + languages, `theme.ts` syncs to the active Aethon theme).
File-system operations go through `src-tauri/src/commands/fs/`
(`io`, `listing`, `open`, `security`, `trash`, `watch`) — a
thin set of read/write/list/move/delete commands scoped to the active
project's `cwd`. Two security layers gate every path: a lexical check
(`helpers::resolve_inside_root`) catches `..` traversal without
hitting disk, then a canonicalize-after-existing check catches
symlinks that redirect outside the project root. Reads/writes are
capped at 10 MB to keep the Tauri IPC bridge responsive. Deletes go
to the OS trash via the `trash` crate, never `unlink`.

### Window state persistence

`src-tauri/src/window_state/` saves window position, size, and
`maximized` flag through the SQLite-backed `window-state.json` state key
(keyed by window label). Everything is stored in **logical** units — physical pixels
aren't portable across monitors with different scale factors, so a
window saved on Retina (2×) would render at the wrong size when
restored to a 1× monitor.

Restore runs in `setup()` _before_ the window becomes visible
(`tauri.conf.json` sets `visible: false`), so there's no race or
settle-debounce. Save is 250 ms-debounced on `Moved`/`Resized` and
flushed synchronously on `CloseRequested`. Monitor matching is a
three-tier fallback: exact-dimension → intersects → nearest by saved
center, then the window is translated to preserve its
offset-within-saved-monitor and clamped so the titlebar stays
reachable. Fullscreen state is treated as transient and skipped on
save. v0 (physical-unit) state files are migrated to v1 on first
load. Spaces / virtual desktops aren't tracked — Tauri 2 doesn't
expose a stable identifier.

### Networked discovery (server/)

`src-tauri/src/server/` is a Claudette-style scaffold daemon wired in
`setup()` and torn down on exit. Two `mdns_sd::ServiceDaemon`s run side
by side: one **advertises** `_aethon._tcp.local.` with the bound HTTP
port in TXT, the other **browses** and emits Tauri events
`host-discovered` / `host-removed`. An axum server binds `0.0.0.0:0`
(OS picks the port) and exposes `GET /health` + `GET /status`. **No
auth, no TLS** — this is explicit scaffolding for an upcoming pairing
PR; do not lean on it for trusted IPC. `commands/server.rs` exposes
`server_start` / `server_stop`; `commands/host.rs` surfaces discovered
peers to the frontend. The boot-time HTTP listener and mDNS **advertiser**
are gated on `[server] enabled` (default true) via `server_enabled()` in
`server/mod.rs`; `boot()` reads it during Tauri `setup()` and skips local
listening/advertisement when it's `false`. The mDNS **browser** is NOT
gated — it always runs, so peer discovery stays read-only and useful even
with the local server off. An explicit `server_start` IPC always starts the
listener and advertises regardless of the flag.

### Voice-to-text input

Composer dictation is Rust-side. The `src-tauri/src/voice/` module
(`mod.rs`) runs a local Whisper model (`candle-transformers`) as one
provider; `voice/audio.rs` is the `cpal` recorder (level metering + WAV
capture). Other providers are native OS recognizers behind the top-level
`src-tauri/src/platform_speech/` module's (`mod`, `macos`,
`windows_speech`) `PlatformSpeechEngine` trait — macOS
`SFSpeechRecognizer`/`SpeechAnalyzer` (small Swift static lib built in
`build.rs`), Windows SAPI 5.4 via COM (`windows` crate), Linux a stub. All
consume the same `CapturedAudio` PCM buffer, so the module holds a
`&dyn PlatformSpeechEngine` with no per-OS branching. A third mode,
**LFM2-Audio**, is an end-to-end ASR+TTS conversational voice path (a
llama.cpp GGUF runner) supporting hands-free conversation and speak-aloud
replies, not just one-shot dictation. `commands/voice.rs` exposes the IPC:
provider list/select/enable, model `prepare`/`remove` (Whisper weights
download on demand), and `start_recording` / `stop_and_transcribe` /
`cancel_recording`. Toggle is `Cmd+Shift+M`; `[voice]` config carries
`toggle_hotkey` + optional hold-to-record `hold_hotkey`, plus the
conversational keys `speak_agent_replies`, `speak_max_chars`, and
`conversation_continuous`.

### Auth profiles (multi-account login)

Per-tab login identities so different agent tabs can authenticate as
different accounts. State lives in `agent/auth-profiles/` (store + manager):
each profile is `oauth | api_key`, scoped to a provider, with a per-tab
active profile and a per-provider default. Profile ids are sanitized
(`isSafeProfileId` / `sanitizeProfileId`) before touching disk; credentials
sit under `authProfilesDir()` in `~/.aethon/`. Login streams an
`AuthProfileLoginEvent` (`started → auth → progress → prompt → complete`)
so the OAuth challenge surfaces in the UI. Frontend mirror is
`src/auth-profiles/`; the active profile selects which model registry a tab
sees (`modelRegistryForModelId`). Driven by `/login [list | use <account> |
default <account>]`.

### Command PATH resolution (env.rs)

Release builds launched from Finder/Dock inherit a minimal PATH missing
Homebrew, Nix profiles, and cargo bins. `env.rs` centralizes lookup so every
Rust IPC command (git, gh, bun, nix, …) resolves tools the same way,
augmenting PATH with `COMMON_TOOL_DIRS`. Resolve external binaries through
this helper, not bare `Command::new("git")`.

### Agent runtime contract

The Tauri shell sets these env vars when spawning the bridge (`agent/main.ts`):

| Env var                             | Purpose                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AETHON_DOCS_DIR`                   | Bundled docs dir (`docs/aethon-agent/` in dev, `<resource_dir>/docs/aethon-agent/` in release). Contains `README.md`, `api.md`, `components.md`, `extensions.md`. The system prompt points the model at these for the authoritative API/component reference. |
| `AETHON_USER_DIR`                   | `~/.aethon/` — user extensions, config, logs, and the SQLite-backed app state directory.                                                                                                                                                                     |
| `AETHON_DB_FILE`                    | `~/.aethon/state/aethon.sqlite3` — canonical Aethon app state, projects, sessions, search index, and small managed state slices.                                                                                                                             |
| `AETHON_PROJECTS_DIR`               | `~/.aethon/projects/` — stable per-project generated data directories keyed by project id.                                                                                                                                                                   |
| `AETHON_STATE_FILE`                 | `~/.aethon/state.json` — compatibility/debug JSON snapshot of loaded extensions, themes, custom components, layout summary, and tab list. Rewritten (debounced 200 ms) on every registration.                                                                |
| `AETHON_SESSIONS_DIR`               | Legacy Aethon session-import location. New Aethon session state is SQLite-backed; pi still writes sidecar transcripts to pi's default session location for later pi pickup and analytics.                                                                    |
| `AETHON_RELEASE_MODE`               | `"1"` in release, `"0"` in dev. The system prompt branches on this to (a) avoid telling the model to read source files that aren't there, (b) point at `~/.aethon/extensions/` for new extensions instead.                                                   |
| `AETHON_PROJECT_ROOT`               | Source tree path (dev only). Lets the model reference `agent/main.ts` etc. by absolute path during dev work.                                                                                                                                                 |
| `AETHON_PROVIDER_TIMEOUT_SECONDS`   | Optional Aethon-owned provider/SDK request timeout override from `[agent] provider_timeout_seconds`; omitted leaves pi's provider retry settings unchanged.                                                                                                  |
| `AETHON_BASH_TIMEOUT_FLOOR_SECONDS` | Floor applied to model-supplied bash tool timeouts from `[agent] bash_timeout_floor_seconds`.                                                                                                                                                                |
| `AETHON_SUBAGENT_TIMEOUT_SECONDS`   | Default inline subagent wall-clock ceiling from `[agent] subagent_timeout_seconds`; individual subagent frontmatter may override it with `timeout: <seconds>`.                                                                                               |

Timeouts must be named config fields or constants, never inline numeric
literals. Keep the Settings UI, `helpers::parse_config_toml`, bridge env
wiring, and agent runtime constants in sync when changing timeout policy.
Subagent definitions use seconds in frontmatter (`timeout: 900`), while the
provider override is converted to milliseconds only at the bridge boundary.

The bridge's `agent/system-prompt.ts` composes a layered prompt using the
static template in `agent/system-prompt/prompt-template.ts` and the
`RuntimeSnapshot` contract in `agent/system-prompt/types.ts`: DEFAULT
(static API + primitives reference, mentioning the docs/state-file paths)
→ optional user override at `~/.aethon/system-prompt.md` → optional user
append at `~/.aethon/system-prompt-append.md` → **runtime snapshot** built
from `getRuntimeSnapshot()` (extensions, themes, components, layout
summary, tabs). The snapshot is rebuilt every time
`resourceLoader.reload()` runs, so the bootstrap order is important —
extensions load **before** the default tab is created so its session prompt
sees them.

### globalThis.aethon (bridge side, built in agent/aethon-api.ts)

Mutation: `registerComponent`, `setState`, `setLayout`,
`patchLayout(path, value)`, `registerSidebarSection`, `registerTheme`,
`registerLayout`, `registerHighlightGrammar`, `onEvent`, `onUnload`,
`notify`, `dismissNotification`. Subnamespaces:
`shells.{list, read, write, create}`, `tasks.{start, …}`, `dashboard.*`,
`windows.*` (`openCanvas` / `openTerminal` / `list` / `get` / `focus` /
`close` / `emitCanvas` …), `sessions.*`, and
`canvas.{emit, append, clear, patch}`. Introspection: `listExtensions`,
`listComponents`, `listThemes`, `getLayout`, `getRuntimeSnapshot`,
`getFrontendState`, `getLayoutSlots` — these let the agent answer "what's
loaded?" without scraping the filesystem. The same data is also written to
`$AETHON_STATE_FILE` so a `cat` works without an introspection round-trip.
Note: `activateLayout` / `resetLayout` / `openProject` are **frontend-only**
(`window.aethon`), not on `globalThis.aethon`.

### Event flow gotcha

`A2UIRenderer` accepts an `onEvent` prop. Returning `true` from it marks the
event as handled and _suppresses_ the default Tauri `dispatch_a2ui_event`
forward. `App.tsx` delegates to `dispatchEvent` in `src/eventRoutes/` — a
per-prefix route table with three precedence layers enforced in
`eventRoutes/index.ts`: (1) shell-consent reserved prefixes
(`shell-write` / `shell-close` / `session-delete`) MUST resolve before
extension matchers; (2) extension-registered routes (returning `false`
forwards to the bridge); (3) built-in routes keyed by `id:<componentId>`
or `type:<componentType>`. New built-in handlers go in
`eventRoutes/<name>.ts` + a happy-path test, then registered under the
matching key(s) in `BUILTIN_ROUTE_TABLE`.

**Always key chrome-composite handlers by `type:<componentType>`, not
`id:`** — that's how `aethon.registerComponent("<type>", custom)` and
custom-layout payloads with renamed instances stay routable. Use
`id:<…>` only for genuine instance-specific dispatch (none today). The
12 chrome composites (sidebar, command-palette, settings-panel,
search-panel, notification-stack, chat-input, empty-state,
terminal-panel, tab-strip, model-picker, appearance-menu,
share-mode-badge, shell-canvas) all dispatch by type.

### Hot-reload doesn't kill in-flight prompts

The Rust file-watcher (`commands/extensions/reload.rs::run_debounce_worker`,
wired from `commands/extensions/watcher.rs`) no longer SIGKILLs the bun
child when an extension file changes.
Instead it writes `{"type":"reload_request"}` to the child's stdin.
The bridge sets `state.reloadPending`, drains active
`tab.promptInFlight`, writes a `{"type":"_reload_done"}` sentinel to
stdout, and `process.exit(0)`s. The supervisor's stdout reader peeks
for that sentinel, sets the reload-in-progress flag, emits
`agent-reloaded`, and the next IPC call respawns. So an extension
drop never aborts a user's LLM turn. The fallback hard-kill path
remains for the case where stdin is wedged.

Frontend UI state must survive both Vite hot reloads and bridge reloads as a
core product invariant. Open tabs, active workspace selection, stashed
workspace buckets, chat history, editor tabs, terminal-panel state, and
in-flight activity indicators should not disappear, demote to project overview,
or reset because React remounted or the bridge respawned. When touching reload,
session restore, project/workspace switching, or snapshot persistence, add
coverage for the full transition and verify against the running dev app.

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
- **Disclosure affordances always use the shared `Chevron`**
  (`src/extensions/default-layout/sidebar/chevron.tsx`). Every
  expand/collapse control — sidebar sections, host/project/workspace rows,
  file tree, Source Control headers, and anything new — renders
  `<Chevron expanded={…} />` (wrapped in a `…-chevron`/`…-caret` span for
  sizing). Never hand-roll a `▸`/`▾`/`>` text caret or one-off rotating
  glyph; they drift in size and weight.

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
- macOS pins both `CC=/usr/bin/cc` _and_
  `CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc`. The first steers
  `cc-rs` build scripts to Apple's toolchain; the second overrides what
  rustc invokes at the link step so it links against the active Xcode SDK.
  Without the linker pin, rustc resolves bare `cc` through PATH and lands on
  nix-darwin's wrapped GCC pointing at Nix's bundled `apple-sdk-14.4`, whose
  `libSystem.tbd` is missing dozens of POSIX symbols (`_write`, `_waitpid`,
  `__NSGetEnviron`, …), and ld errors out with "Undefined symbols for
  architecture arm64". **Do not** re-add `pkgs.libiconv` to
  `darwinBuildInputs` or point `LIBRARY_PATH` / `NIX_LDFLAGS` at it — that
  bakes a `/nix/store` install_name into the bundle that dyld rejects on any
  non-builder Mac (Team ID mismatch with our notarized signature).
- `build-app` runs `scripts/verify-bundle.sh` after `cargo tauri build` as a
  fail-loud safety net: it greps `otool -L` on the bundled binary for
  `/nix/store` and aborts before the bundle can ship.

## Reference Projects

- `~/Projects/utensils/Claudette` — sibling Tauri 2 + TS project with much
  deeper integration (xterm, voice, mDNS). Good source of patterns for IPC,
  window management, and the Nix Linux build closure.
- `~/Projects/utensils/claudex` — sibling Rust-only project. Good source of
  patterns for the flake skeleton (flake-parts + devshell + treefmt + crane).

## Hot reload

Vite hot-reloads the frontend automatically. The agent subprocess (`bun run
agent/main.ts`) is held alive across frontend reloads in Tauri state. In debug
builds the Rust shell also watches `agent/` recursively; agent edits request a
graceful bridge reload via `reload_request`, the bridge drains active prompts,
emits `_reload_done`, exits, and the supervisor emits `agent-reloaded` before
the next IPC call respawns it. Production builds skip the watcher entirely.

If you find yourself wanting to manually restart the agent during dev, the
simplest path is `touch agent/main.ts`.

## Logging

Both the Rust shell and the bridge (TS) use leveled, scoped loggers and
write to two sinks:

| Sink              | What goes there                       | When to use                                                          |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------- |
| stderr            | Live stream as the app runs           | Watching `bun tauri dev` output, seeing what's happening right now   |
| `~/.aethon/logs/` | Daily-rotating files, 7-day retention | Post-hoc investigation, release-build crashes, comparing across runs |

Two file series share that directory:

- `aethon.YYYY-MM-DD` — Rust shell (`tracing` crate), covers agent
  supervisor, file watcher, debug TCP server, Tauri commands.
- `bridge.YYYY-MM-DD.log` — bun bridge (`agent/logger.ts`), covers
  extension loaders, theme/extension discovery, system-prompt assembly,
  per-tab session setup.

Files older than 7 days are pruned at app startup; rotation is per-day.
Each line is `ISO_TS LEVEL scope: message` so `grep ext-loader …` works.

Levels follow `AETHON_LOG` (preferred) or `RUST_LOG` / `LOG_LEVEL` env
vars. Defaults are `info` in dev and `warn` in release. Examples:

```bash
AETHON_LOG=debug bun tauri dev          # everything
AETHON_LOG=warn bun tauri dev           # quiet — warnings + errors only
AETHON_LOG=aethon::agent_watch=debug bun tauri dev  # one scope verbose
```

The Rust subscriber uses `tracing-subscriber::EnvFilter` so target-scoped
filters work (`aethon::agent_watch=debug,aethon::config=warn`).

## Driving the app from Codex (`aethon-debug` skill)

`.claude/skills/aethon-debug/` (mirrored under `.agents/skills/aethon-debug/`)
ships a slash-commandable skill for inspecting and driving the running dev
app. In debug builds the Rust shell starts a TCP
eval server on `127.0.0.1:19433` (override with `AETHON_DEBUG_PORT`); the
script `scripts/debug-eval.sh` ships JS to that server, which wraps it in
an async IIFE, evals it inside the webview, and returns the stringified
result. Patterned on Claudette's `claudette-debug` skill — see its `SKILL.md`
for the full action list.

Webview globals exposed in dev only:

- `window.__AETHON_STATE__()` — snapshot of the layout state object
- `window.__AETHON_INVOKE__` — Tauri `invoke` (used by the eval wrapper)
- `window.__AETHON_EXTENSION_REGISTRY__` — `ExtensionRegistry` instance
- `window.__AETHON_SET_STATE__(next)` — replace state (advanced)
- `window.aethon` — public runtime API (`setLayout`, `registerExtension`, etc.)

Use this proactively after touching any UI / agent code: connect, send a
chat, screenshot, verify. The dev build must already be running — never
launch a release build (the debug server is gated by `cfg(debug_assertions)`).

## Status — what is and isn't wired up

The authoritative sources are `SPEC.md` (design vision + status checklist)
and `CHANGELOG.md` (what actually shipped per version). Update those when
capabilities land; treat this section as a snapshot, not the source of truth.

**Quick highlights (version 0.10.2):** projects with multiple workspaces
(main checkout + git worktrees, each with its own tabs / sessions / git
state / devshell), MCP server setup + config flows, multi-model subagents
with parallel background delegation, scheduled tasks / loops, native A2UI
canvas windows (`windows.*` open/focus/close), multi-account auth profiles,
voice input across Whisper / native-OS recognizers / LFM2-Audio (ASR+TTS
conversational mode), plan mode, Nix devshell auto-wrap for shells + the
agent bash tool, window-state persistence with multi-monitor restore, and a
channel-aware auto-updater with boot probation + rollback. Earlier
foundations still in place: interactive PTY shell tabs (`portable-pty`,
`Tab.kind` discriminator) with per-tab `ShareMode` + privacy-floor
guardrail, `aethon.shells.{list, read, write}` bridge API, Monaco editor +
file tree + media viewers, tool execution as A2UI cards, command palette,
slash-command picker, themes, system tray + native menu, and real
`~/.aethon/config.toml`.

Releases are macOS **Apple Silicon (aarch64) only**, cut via release-please
(app + dmg + updater manifest). There are no Linux or Windows release
artifacts today, even though the dev toolchain still builds on Linux.

## State persistence

`src/persist.ts` is the disk I/O layer for frontend state. It wraps Tauri
`read_state` / `write_state` commands with a graceful no-op fallback when
running outside Tauri (unit tests, plain browser). One-time migration: on
first read it checks `localStorage` for the same key so users upgrading from
the pre-Tauri build keep their history. All tab/canvas state serialisation
goes through here; don't invoke Tauri storage commands directly from
components.

## Releases

See `RELEASING.md` for the full release workflow: keypair generation,
wiring the public key into `tauri.conf.json`, CI secrets, and the
release-please flow. Summary: releases are driven by **release-please** on
merge to `main` (not a `v*.*.*` tag push). Merging the "chore: release" PR
triggers `.github/workflows/release-please.yml`, which builds the signed
macOS **aarch64** app + dmg and uploads `latest.json` to feed the in-app
updater. No Linux or Windows release artifacts are produced.

## Test coverage + linting

| Tool                         | Scope                                                                                                                               | Devshell command |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `cargo clippy -D warnings`   | Rust shell + helpers                                                                                                                | `check`          |
| `cargo test --lib`           | Rust unit tests under `src-tauri/src/helpers/`                                                                                      | `test`           |
| `bunx tsc -b --noEmit`       | TypeScript types (frontend + agent)                                                                                                 | `check`          |
| `bunx eslint .`              | TS + React lint, type-aware via tsconfig                                                                                            | `lint`           |
| `bunx vitest run`            | TS unit tests (`src/**/*.test.ts` + `agent/**/*.test.ts`)                                                                           | `test`           |
| `bunx vitest run --coverage` | TS coverage report (v8)                                                                                                             | `coverage`       |
| `bun run test:e2e`           | Playwright E2E (`e2e/aethon.spec.ts`); webview is mocked, tests run serial against a shared Vite dev server                         | —                |
| `bun run version:check`      | Fail if `package.json` / `Cargo.toml` / `tauri.conf.json` drift (auto-runs before `bun run build`); fix with `bun run version:sync` | —                |

The `check` devshell command runs all of the above as a single CI gate.
ESLint is configured for **0 errors and 0 warnings**. A handful of `react-hooks`
disables (set-state-in-effect for state-resync paths, exhaustive-deps for
intentionally-empty memo deps) are scoped per-line with author rationale —
audit them on touch, don't broaden them.

## Local-only files (gitignored)

`run-phase*.sh` and `aethon-phase*.png` are ad-hoc test-harness artifacts —
phase scripts spawn the dev server and Playwright-MCP grabs screenshots.
Don't commit them and don't rely on them being present.
