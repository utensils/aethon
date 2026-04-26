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

| Command     | What it does                                          |
| ----------- | ----------------------------------------------------- |
| `dev`       | `cargo tauri dev` — launches the app with hot reload  |
| `build-app` | `cargo tauri build` — release bundle                  |
| `check`     | `cargo clippy -- -D warnings` + `bunx tsc -b --noEmit`|
| `fmt`       | `treefmt` (rustfmt + nixfmt)                          |

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
- **Frontend port is fixed at 1420** (Vite `strictPort: true`) — Tauri's
  `devUrl` points there.
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

## Status — what is and isn't wired up

**Done:** Tauri shell + React frontend; agent subprocess bridge with
JSON-lines protocol; A2UI renderer with primitives, data binding (JSON
Pointer `$ref`), and event dispatch; skill registry with the default-layout
skill providing sidebar/canvas/terminal/status-bar/chat-input; runtime
`window.aethon` API for layout/skill swapping.

**Not yet:** Streaming agent responses (currently sent as one chunk when the
prompt resolves); compiled `aethon-agent` binary via `bun build --compile`
(agent is run from source via `bun run agent/main.ts`); extension/hot-reload
loading from `~/.aethon/`; multiple canvases/tabs; cross-platform release
bundles; mobile (`tauri::mobile_entry_point` is wired but untested). See
`SPEC.md` milestones M1–M4 for the broader roadmap.

## Local-only files (gitignored)

`run-phase*.sh` and `aethon-phase*.png` are ad-hoc test-harness artifacts —
phase scripts spawn the dev server and Playwright-MCP grabs screenshots.
Don't commit them and don't rely on them being present.
