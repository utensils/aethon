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

1. **Tauri shell** (`src-tauri/src/lib.rs`) — owns the OS boundary. Two Tauri
   commands: `send_message` (forwards a chat string to the agent's stdin) and
   `dispatch_a2ui_event` (forwards a structured event). On the first
   `send_message` it spawns `bun run agent/main.ts` and starts a reader
   thread that emits each stdout line as a Tauri `agent-response` event.
2. **Agent bridge** (`agent/main.ts`) — JSON-lines over stdio. Reads
   `{type:"chat", content}` or `{type:"a2ui_event", event}`, replies with
   `{type:"response"|"a2ui"|"error", ...}`. Provider config comes from env
   vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …); pi-ai picks one up.
3. **React frontend** (`src/`) — see below. Listens for `agent-response`
   events, parses each line, and routes it into the chat history or canvas.

### Frontend model — three things to know

**1. Layout-as-payload.** The default UI is *not* hardcoded React. It's
`src/skills/default-layout/layout.a2ui.json`, loaded as the boot payload and
fed to the same `A2UIRenderer` that handles agent output. A skill is the
extension primitive; the default layout *is* a skill (`defaultLayoutSkill`).
Don't add static chrome in `App.tsx` — extend the layout JSON or register a
new skill.

**2. Single state store, JSON Pointer addressed.** All app state lives in one
object on `App` (`messages`, `draft`, `waiting`, `status`, `connection`,
`canvas`, `terminal.open`, …). Components read it via `$ref` JSON Pointers
(e.g. `{"value": {"$ref": "/draft"}}`). The renderer applies an *optimistic*
write back to that path for `change`/`submit` events on inputs whose `value`
is a `$ref` — see `applyOptimisticUpdate` in `A2UIRenderer.tsx`. JSON Pointer
helpers: `src/utils/jsonPointer.ts` and `src/utils/dataBinding.ts`.

**3. Two registries.** `A2UIRenderer.tsx` has a hardcoded `PRIMITIVE_REGISTRY`
(`text`, `card`, `button`, `container`, `code`, `text-input`) — these can't
be overridden. Everything else (`layout`, `sidebar`, `chat-history`,
`chat-input`, `status-bar`, `terminal`, `main-canvas`) comes from the
`SkillRegistry`, exposed via React context (`useSkillRegistry`). To add a
new component type, register it on a skill, not in the primitives table.

### Runtime API

`App.tsx` attaches a small API to `window.aethon` so skills (and the dev
console) can swap chrome at runtime:

- `window.aethon.setLayout(payload)` — replace the active layout
- `window.aethon.resetLayout()` — restore the default-layout boot payload
- `window.aethon.registerSkill(skill)` — register a skill; if it has a
  `layout`, also activate it
- `window.aethon.listSkills()` — names of currently registered skills

### Agent runtime contract

The Tauri shell sets these env vars when spawning the bridge (`agent/main.ts`):

| Env var | Purpose |
|---------|---------|
| `AETHON_DOCS_DIR` | Bundled docs dir (`docs/aethon-agent/` in dev, `<resource_dir>/docs/aethon-agent/` in release). The system prompt points the model at these for the authoritative API/component reference. |
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

**Quick highlights as of writing:** M1–M5 essentially complete. Tool
execution surfaces as A2UI cards, multi-tab persistent sessions, light
theme, system tray + native menu, slash command picker, real
`~/.aethon/config.toml`, layout-slot contract (`canvas` + `composer`
required, `slotMap` for non-canonical layouts), generic
`extension_lifecycle` feedback channel, registerable slash commands /
keybindings / menu items / event routes, mutation-feedback channel
(every mutation returns `Promise<MutationResult>`). Not yet: Nix flake
overlay for distribution, first public release.

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
ESLint is configured for **0 errors**; some warnings in `App.tsx` /
`ChatInput` are tracked anti-patterns to address in a follow-up (set-state
in effect, ref access during render).

## Local-only files (gitignored)

`run-phase*.sh` and `aethon-phase*.png` are ad-hoc test-harness artifacts —
phase scripts spawn the dev server and Playwright-MCP grabs screenshots.
Don't commit them and don't rely on them being present.
