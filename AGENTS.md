# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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

Run inside `nix develop` (or via direnv — `.envrc` is `use flake`). The
devshell exposes these helpers (defined in `flake.nix`):

| Command     | What it does                                                                  |
| ----------- | ----------------------------------------------------------------------------- |
| `dev`       | `scripts/dev.sh` → `cargo tauri dev` with port auto-increment                 |
| `build-app` | `cargo tauri build` — release bundle                                          |
| `check`     | Full CI gate: clippy + tsc + ESLint + cargo test + vitest                     |
| `lint`      | ESLint frontend + agent (no auto-fix)                                         |
| `test`      | Run Rust + TS tests (cargo test --lib + vitest run)                           |
| `coverage`  | TS coverage report under `coverage/` (vitest v8)                              |
| `fmt`       | `treefmt` (rustfmt + nixfmt + prettier for JSON/MD/YAML/CSS + taplo for TOML) |

`bun tauri dev` and `bun tauri build` also work (they go through the JS-side
`@tauri-apps/cli` wrapper). One-time after pulling: `bun install`.

To run a single test file: `bunx vitest run agent/terminal-stream.test.ts`.
To run tests matching a name: `bunx vitest run -t "test name pattern"`.
To run a single Rust test: `cargo test --lib -p aethon -- helpers::test_name`.

## Architecture

### Layer responsibilities

1. **Tauri shell** (`src-tauri/src/lib.rs` is now a thin entry — agent
   supervisor + child IPC + `run()` builder; concern-grouped IPC commands
   live under `src-tauri/src/commands/` (`config.rs`, `session.rs`,
   `extensions.rs`, `git.rs`, `window.rs`); shell-tab PTY logic lives
   under `src-tauri/src/shell/` (`lifecycle.rs`, `scrollback.rs`,
   `sharemode.rs`); pure helpers in `helpers.rs`; debug-only commands
   - TCP eval server in `debug.rs` gated by `#[cfg(debug_assertions)]`)
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
   - boot order; the readline loop and 14-case dispatcher live in
     `agent/dispatcher.ts`) — JSON-lines over stdio. Reads
     `{type:"chat", content}` or `{type:"a2ui_event", event}`, replies
     with `{type:"response"|"a2ui"|"error", ...}`. Provider config comes
     from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …); pi-ai
     picks one up. Modules (each with a colocated `*.test.ts`):
   * `state.ts` — the `AethonAgentState` data class (registries, tabs,
     pending mutations, layout, themes).
   * `aethon-api.ts` — `buildAethonApi` factory exposed on `globalThis`.
   * `dispatcher.ts` — readline loop + per-message-type dispatch.
   * `tab-lifecycle.ts` — `ensureTab` + the pi session subscriber +
     `emitReady`.
   * `extension-loader.ts` — discovers + loads extensions from four
     sources + theme directories.
   * `project-extensions.ts` — walks up from the active cwd looking
     for `.aethon/extensions/`.
   * `system-prompt.ts` — composes the layered system prompt.
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
   * `session-history.ts` — reads pi session transcripts under
     `$AETHON_SESSIONS_DIR/<tabId>/` so the frontend can rehydrate
     visible history on restart.
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
   (one file per prefix family); `src/runtime/windowApi.ts` builds the
   `window.aethon` runtime API. Listens for `agent-response` events,
   parses each line, and routes it into the chat history or canvas.

### Frontend model — three things to know

**1. Layout-as-payload.** The default UI is _not_ hardcoded React. It's
`src/skills/default-layout/workstation.a2ui.json`, loaded as the boot payload
and fed to the same `A2UIRenderer` that handles agent output. A skill is the
extension primitive; the default-layout skill currently registers only
`workstation` while we focus polish on a single surface (the earlier
`command-deck` / `editorial` / `live-layout` variations were dropped from
the catalogue — the variation chrome components stay registered so their
`.a2ui.json` payloads can be re-added when we want sibling layouts back).
Switching layouts (when more exist) is a sidebar/palette click that calls
`window.aethon.activateLayout(id)`. Don't add static chrome in `App.tsx` —
extend the layout JSON or register a new skill. Layouts must conform to
the slot contract in `src/skills/default-layout/slots.json` + `slots.ts`
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
can't be overridden. Default-layout skill components are split per
family under `src/skills/default-layout/` (`chat.tsx`, `terminal.tsx`,
`command-palette.tsx`, `settings-panel.tsx`, `search-panel.tsx`,
`notifications.tsx`, `share-mode-badge.tsx`, `variation-components.tsx`,
plus `shell/` and `sidebar/` sub-directories); `components.tsx` itself
is the registration aggregator only. Everything else (`layout`, `sidebar`,
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
  `agent/main.ts`). Reserved id: `workstation`
  (`command-deck` / `editorial` / `live-layout` were trimmed from the
  built-in catalogue and may be reintroduced later — keep the names
  free). Id pattern: `/^[A-Za-z][\w-]*$/`.
- `window.aethon.activateLayout(id)` — switch to a registered layout
- `window.aethon.registerSkill(skill)` — register a skill; if it has a
  `layout`, also activate it
- `window.aethon.listSkills()` — names of currently registered skills
- `window.aethon.openProject(path)` — register/activate a project

### Keyboard shortcuts (current set)

| Combo                         | Action                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cmd+T`                       | New tab — **focus-aware**: agent tab when outside the bottom terminal panel, shell sub-tab when focus is inside the panel. `[shortcuts] new_tab_kind = "shell"` flips this to "always shell". |
| `Cmd+Shift+T`                 | New shell sub-tab (always — auto-opens the bottom panel)                                                                                                                                      |
| `Cmd+W`                       | Close active tab. Shell tabs prompt before killing a running job (disable via `[shell] prompt_before_close = false`).                                                                         |
| `Cmd+Opt+T`                   | Reopen most-recently-closed tab                                                                                                                                                               |
| `Cmd+]` / `Cmd+[`             | Next / previous _agent_ tab (top strip; shells are filtered). When focus is inside the bottom panel, cycles between sub-tabs (agent-bash + each shell) instead.                               |
| `Cmd+Shift+]` / `Cmd+Shift+[` | Move active agent tab right / left. When focus is inside the bottom panel, reorders shell sub-tabs instead.                                                                                   |
| `Cmd+1`..`Cmd+8`              | Jump to agent tab N. When focus is inside the bottom panel, jumps between sub-tabs instead (1 = agent-bash).                                                                                  |
| `Cmd+9`                       | Jump to last agent tab (or last shell sub-tab when focus is in panel).                                                                                                                        |
| `Cmd+P` / `Cmd+Shift+P`       | Command palette (switcher / commands)                                                                                                                                                         |
| `Cmd+\``                      | Toggle bottom terminal panel (Agent bash sub-tab + each user shell as a sub-tab)                                                                                                              |
| `Cmd+B`                       | Toggle sidebar                                                                                                                                                                                |
| `Cmd+K`                       | Clear chat                                                                                                                                                                                    |
| `Cmd+.`                       | Stop current prompt                                                                                                                                                                           |
| `Cmd+=` / `Cmd+-`             | Zoom in / out                                                                                                                                                                                 |
| `Cmd+0`                       | Toggle focus between composer and terminal panel                                                                                                                                              |
| `Cmd+Shift+0`                 | Reset zoom                                                                                                                                                                                    |
| `Cmd+L`                       | Focus active tab's primary input (composer for agent tabs, terminal for shell tabs)                                                                                                           |
| `Cmd+,`                       | Open Settings panel                                                                                                                                                                           |
| `Cmd+Shift+F`                 | Cross-session search overlay                                                                                                                                                                  |
| `Cmd+Shift+S`                 | Export active chat as Markdown to `~/Downloads/` (agent tabs only)                                                                                                                            |
| `Cmd+Ctrl+F` (mac) / `F11`    | Toggle fullscreen                                                                                                                                                                             |
| `F12`                         | Toggle WebKit DevTools (debug builds)                                                                                                                                                         |
| `Esc`                         | Close palette / settings / search overlay (when open)                                                                                                                                         |

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
composite (`ShellCanvas` in `default-layout/shell/canvas.tsx`) replaces the agent
`main-canvas` + `chat-input` cells when a shell tab is active —
controlled by the `/agentTabActive` / `/shellTabActive` `$ref` visibility
flags in `workstation.a2ui.json`. Keybindings: `Cmd+T` = new agent tab (focus-aware — new shell sub-tab when
focus is inside the bottom panel), `Cmd+Shift+T` = new shell sub-tab (always).

### Slash commands (client-side)

`src/slashCommands.ts` registers frontend-only slash commands that run
without an LLM round-trip (e.g. `/clear`, `/theme`, `/extensions`). They
receive a `SlashCommandContext` with `appendSystem`, `notify`, `clearChat`,
`setTheme`, etc. These are distinct from pi's server-side slash commands
(extension/skill-registered, dispatched through the bridge) — pi's
`getCommands()`/handler API is not yet plumbed through. When adding a purely
UI action, prefer the client-side registry; only go through the bridge when
the agent needs to observe or act on the command.

### Extension frontend loading

Extensions can ship React components by setting `aethon.frontendEntry` in
their `package.json` to a relative JS file path. The bridge reads that file
and sends its contents as a string in `extension_frontend_modules` events.
`src/skills/extensionFrontendLoader.ts` receives these events, wraps each
body in `new Function("React", "skill", code)`, and calls the result with
`React` + a `{ registerComponent(type, fn) }` API object. Components
registered this way land in the `SkillRegistry` and are resolved alongside
built-in skill components. A delta payload replaces the full previous set —
re-evaluated modules hot-swap their components; removed modules unregister
theirs. The trust model is identical to bridge-side extension code (user
installed it, no sandbox).

`SkillRegistry` also has a `.registerTemplate(type, payload)` path for
declarative A2UI subtree templates — used when an extension provides a
component as an A2UI JSON fragment rather than a React function. The
renderer prefers React components when both exist for the same type.

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

| Env var               | Purpose                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AETHON_DOCS_DIR`     | Bundled docs dir (`docs/aethon-agent/` in dev, `<resource_dir>/docs/aethon-agent/` in release). Contains `README.md`, `api.md`, `components.md`, `extensions.md`. The system prompt points the model at these for the authoritative API/component reference. |
| `AETHON_USER_DIR`     | `~/.aethon/` — user extensions, skills, sessions, state file.                                                                                                                                                                                                |
| `AETHON_STATE_FILE`   | `~/.aethon/state.json` — JSON snapshot of loaded extensions, themes, custom components, layout summary, and tab list. Rewritten (debounced 200 ms) on every registration.                                                                                    |
| `AETHON_SESSIONS_DIR` | `~/.aethon/sessions/<tabId>/` per tab. Each tab uses `SessionManager.continueRecent` so pi context survives bun restarts.                                                                                                                                    |
| `AETHON_RELEASE_MODE` | `"1"` in release, `"0"` in dev. The system prompt branches on this to (a) avoid telling the model to read source files that aren't there, (b) point at `~/.aethon/extensions/` for new extensions instead.                                                   |
| `AETHON_PROJECT_ROOT` | Source tree path (dev only). Lets the model reference `agent/main.ts` etc. by absolute path during dev work.                                                                                                                                                 |

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
share-mode-badge, shell-canvas) all dispatch by type as of #N.

### Hot-reload doesn't kill in-flight prompts

The Rust file-watcher (`commands/extensions.rs::run_debounce_worker`)
no longer SIGKILLs the bun child when an extension file changes.
Instead it writes `{"type":"reload_request"}` to the child's stdin.
The bridge sets `state.reloadPending`, drains active
`tab.promptInFlight`, writes a `{"type":"_reload_done"}` sentinel to
stdout, and `process.exit(0)`s. The supervisor's stdout reader peeks
for that sentinel, sets the reload-in-progress flag, emits
`agent-reloaded`, and the next IPC call respawns. So an extension
drop never aborts a user's LLM turn. The fallback hard-kill path
remains for the case where stdin is wedged.

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
  extension loaders, theme/skill discovery, system-prompt assembly,
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

`.Codex/skills/aethon-debug/` ships a slash-commandable skill for inspecting
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

**Quick highlights as of writing:** M1–M6 complete. M6 shipped: interactive
PTY-backed user shell tabs (`portable-pty`, `Tab.kind` discriminator,
theme-agnostic xterm), per-tab `ShareMode` 4-value enum with privacy-floor
guardrail, `aethon.shells.{list, read, write}` bridge API with per-write
Allow/Deny user confirmation, pi-tool registration of
`listShells`/`readShell`/`writeShell` (in `agent/shell-tools.ts`), Settings
UI overlay, fullscreen, search overlay, drag-and-drop into composer, bridge
crash recovery, OS notifications.
Tool execution surfaces as A2UI cards, multi-tab persistent
sessions, light theme, system tray + native menu, slash command picker,
real `~/.aethon/config.toml`, layout-slot contract (`canvas` +
`composer` required, `slotMap` for non-canonical layouts), generic
`extension_lifecycle` feedback channel, registerable slash commands /
keybindings / menu items / event routes / layouts (workstation only in
the built-in catalogue today; extensions can register more via
`aethon.registerLayout`), mutation-feedback channel (every mutation
returns `Promise<MutationResult>`), command palette (Cmd+P switcher /
Cmd+Shift+P commands), v0.2.0 GitHub release with macOS .dmg + Linux
.deb/AppImage + Windows NSIS bundles via Nix overlay.

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
wiring the public key into `tauri.conf.json`, CI secrets, and how to cut a
tag. Summary: push a `v*.*.*` tag → GitHub Actions builds signed macOS DMGs,
Linux `.deb`/`.rpm`, and Windows NSIS, uploads `latest.json` for the
in-app updater.

## Test coverage + linting

| Tool                         | Scope                                                     | Devshell command |
| ---------------------------- | --------------------------------------------------------- | ---------------- |
| `cargo clippy -D warnings`   | Rust shell + helpers                                      | `check`          |
| `cargo test --lib`           | Rust unit tests under `src-tauri/src/helpers.rs`          | `test`           |
| `bunx tsc -b --noEmit`       | TypeScript types (frontend + agent)                       | `check`          |
| `bunx eslint .`              | TS + React lint, type-aware via tsconfig                  | `lint`           |
| `bunx vitest run`            | TS unit tests (`src/**/*.test.ts` + `agent/**/*.test.ts`) | `test`           |
| `bunx vitest run --coverage` | TS coverage report (v8)                                   | `coverage`       |

The `check` devshell command runs all of the above as a single CI gate.
ESLint is configured for **0 errors and 0 warnings**. A handful of `react-hooks`
disables (set-state-in-effect for state-resync paths, exhaustive-deps for
intentionally-empty memo deps) are scoped per-line with author rationale —
audit them on touch, don't broaden them.

## Local-only files (gitignored)

`run-phase*.sh` and `aethon-phase*.png` are ad-hoc test-harness artifacts —
phase scripts spawn the dev server and Playwright-MCP grabs screenshots.
Don't commit them and don't rely on them being present.
