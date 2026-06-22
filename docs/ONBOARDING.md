# Aethon — Onboarding Guide

> Generated from the project knowledge graph (2674 nodes / 5903 edges / 10 layers / 14 tour
> steps). This guide is a high-level map for new contributors. Every file, layer, and concept
> below is grounded in the analyzed codebase at commit `7b01986`.

---

## 1. Project Overview

**Aethon** is a Tauri 2 + React 19 + TypeScript desktop shell that embeds the **pi coding
agent** and renders its output as live, interactive UI via the **A2UI protocol** — the agent
dynamically populates the interface rather than presenting a fixed IDE layout. The mental model
to internalize on day one is **layout-as-payload**: the UI you see is a data document the agent
can mutate at runtime, not hardcoded React chrome.

The system is organized into **three deliberate layers**:

1. A thin **Rust / Tauri shell** (`src-tauri/src/`) that owns OS boundaries — IPC, process
   supervision, PTY shells, window state, voice, devshell resolution, discovery, auto-update.
2. A **TypeScript agent bridge** (`agent/`) that runs the pi coding agent as a subprocess and
   speaks **JSON-lines over stdio**.
3. A **React frontend** (`src/`) driven by an `A2UIRenderer` that turns layout payloads into a
   live component tree.

**Languages:** TypeScript, Rust, JavaScript, Markdown, Shell, Nix, TOML, JSON, YAML, CSS, HTML,
Dockerfile, Swift, XML.

**Frameworks & tooling:** Tauri 2, React 19, Vite, Vitest, Playwright, Docker, GitHub Actions.
The dev/build environment is a reproducible **Nix flake** (Rust pinned to 1.92.0).

---

## 2. Architecture Layers

The graph assigns every file to exactly one of ten layers. The first five are the code layers
you will work in most; the remaining five are tests, docs, tooling, infra, and config.

### Rust/Tauri Shell — `src-tauri/src/` (107 files, 43 complex)
The thin Tauri 2 native backend that owns OS boundaries: IPC commands, the agent-process
supervisor, PTY shell tabs, window-state persistence, devshell resolution, voice capture, mDNS
discovery, and auto-update probation.
- `lib.rs` — thin entry point; `run()` builder registers plugins, managed state, IPC handlers, setup hooks.
- `commands/mod.rs` — barrel re-exporting the whole IPC surface (boot, config, devshell, fs, git, session, updater, voice, window).
- `agent_process/process.rs` — agent supervisor state machine: per-worker readiness/idle tracking, global-vs-tab payload routing, retirement.
- `agent_process/spawn.rs` — launches the bun bridge child with user/worker env + devshell-resolved env injection.
- `shell/sharemode.rs` — the per-tab `ShareMode` security boundary for shell sharing.
- `devshell/resolve.rs` — runs `nix print-dev-env` / `direnv exec env` to compute the wrapped environment.

### Agent Bridge — `agent/` (102 files, 35 complex)
The TypeScript pi-coding-agent subprocess that speaks JSON-lines over stdio: dispatcher, agent
state, system-prompt composition, auth profiles, subagents, devshell client, and the
`globalThis.aethon` API exposed to tools and extensions.
- `main.ts` — bridge entry: builds `AethonAgentState`, loads auth profiles/extensions/themes/subagents, restores the default tab session, starts the dispatcher.
- `dispatcher.ts` — JSON-lines reader loop routing each inbound stdin message to a handler.
- `state.ts` — the `AethonAgentState` class holding all bridge runtime state (third-most depended-upon file in the project).
- `aethon-api.ts` — assembles the full `globalThis.aethon` runtime API.
- `mutation-ack.ts` / `origin-gate.ts` — tracked mutation IDs + origin stamping so background workers can't clobber the active workspace.

### Frontend UI & A2UI Layout — `src/components/`, `src/extensions/` (133 files, 54 complex)
The React rendering surface: the `A2UIRenderer`, the primitive component registry, the
default-layout payload (`workstation.a2ui.json` + slots), Monaco editor, file icons, and styles.
- `components/A2UIRenderer.tsx` — the engine that turns layout payloads into React trees.
- `components/primitives/{layout,controls,form,media,text}.tsx` — the built-in primitives behind the 19-entry `PRIMITIVE_REGISTRY` (+ the renderer's inline `for-each` = 20 non-overridable types). `context-menu.tsx` here is a shared menu helper, not a registered primitive type.
- `extensions/default-layout/workstation.a2ui.json` — the default UI, as data.
- `extensions/default-layout/index.ts` — assembles the slot catalogue and registers all chrome components, panels, themes, keybindings.

### Frontend Runtime & State — `src/hooks/`, `src/eventRoutes/`, `src/app/` (220 files, 68 complex)
The wiring of the React shell: the single JSON-Pointer state store, bridge-message handlers,
event routing, OS-edge subscribers, overlays, and the `window.aethon` runtime API.
- `App.tsx` — root shell composing ~40 `useX()` hooks; bootstraps state, wires OS-edge listeners and native window sync.
- `eventRoutes/index.ts` — central A2UI event dispatcher (shell-consent → extension → built-in precedence).
- `hooks/useBridgeMessages.ts` + `hooks/bridgeMessageHandlers/index.ts` — the frontend half of the JSON-lines conversation with the agent.
- `config.ts` — reads the Rust-side TOML config and normalizes it into a typed `AethonConfig`.
- `runtime/windowApi.ts` — builds the public `window.aethon` runtime API.

### Shared Utilities & Types — `src/utils/`, `src/types/` (35 files, 7 complex)
Cross-cutting helpers and type definitions imported across the UI and runtime layers.
- `types/a2ui.ts` — the A2UI payload protocol types (the 2nd most depended-upon file, 100 inbound edges).
- `types/tab.ts` — the `Tab` type and pure bucketing/active-tab helpers (the single most depended-upon file, 144 inbound edges).
- `utils/jsonPointer.ts` — immutable JSON-Pointer toolkit (resolve/set/delete with structural sharing) for the single state store.
- `utils/dataBinding.ts` — turns a component's `{"$ref": "/path"}` props into concrete values.

### Tests (312 files, 74 complex)
Colocated Vitest unit specs across the frontend, agent bridge, and CLI, plus the Playwright e2e
suite. Every `*.test.*` / `*.spec.*` file that exercises the three code layers.

### Documentation — `website/`, `docs/`, `*.md` (46 files, 11 complex)
Project docs and the VitePress site: user guides, runtime/config references, the bundled agent
docs (`docs/aethon-agent/`), `SPEC`/`DESIGN`/`RELEASING`, and `AGENTS`/`CLAUDE` instructions.

### CLI, Scripts & Examples (36 files, 9 complex)
Developer-facing tooling outside the app: the `aethonctl` control CLI (`cli/`), build/dev/release
shell scripts (`scripts/`), example pi-extensions, the e2e harness, and Claude skill scripts.

### Infrastructure & CI/CD (27 files, 2 complex)
GitHub Actions workflows (`ci.yml` delegating to the reusable `_ci.yml`), AUR packaging
(PKGBUILD/.SRCINFO), the build Dockerfile, and `.dockerignore`.

### Configuration (25 files, 2 complex)
Build and project config: TypeScript project files, Vite/ESLint/Playwright configs, the Nix
`flake.nix`, `Cargo.toml`/`tauri.conf.json`, release-please config, capabilities, `index.html`.

---

## 3. Key Concepts

These are the load-bearing design decisions. Understanding them is the difference between fighting
the architecture and flowing with it.

### Layout-as-payload
The default UI is **not hardcoded React** — it is
`src/extensions/default-layout/workstation.a2ui.json`, a data document describing the entire app
chrome (header, sidebar, canvas, composer, terminal, status) plus the initial state store. It is
fed to the same `A2UIRenderer` that handles agent output. Because the layout is data, the agent
can mutate it at runtime — that is what makes Aethon "the agent decides what you see." **Do not
add static chrome to `App.tsx`;** extend the layout JSON or register an extension. Layouts must
satisfy the slot contract in `slots.ts` (canonical slots: header, sidebar, canvas, composer,
terminal, status).

### Single JSON-Pointer-addressed state store with optimistic writes
All app state lives in **one object** on `App`. Components read it via `$ref` JSON Pointers
(`{"value": {"$ref": "/draft"}}`). `utils/jsonPointer.ts` resolves/sets/deletes by pointer with
structural-sharing clones; `utils/dataBinding.ts` turns `$ref` props into concrete values. The
renderer applies an **optimistic** write back to that path for `change`/`submit` events on `$ref`
inputs (`applyOptimisticUpdate` in `A2UIRenderer.tsx`). This is "how data becomes pixels and how
user input flows back into state."

### Two component registries
- **Primitive React components** (`src/components/primitives/`) are wired into a hardcoded
  19-entry `PRIMITIVE_REGISTRY` in `A2UIRenderer.tsx`; with inline `for-each`, agents see 20
  non-overridable primitive types. **Extensions cannot override these.**
- **Everything else** (chrome composites like `sidebar`, `chat-input`, `command-palette`,
  `terminal-panel`, `tab-strip`, `shell-canvas`) comes from the `ExtensionRegistry`. Mount via
  `<RegistryComponent type="…" />` so an extension can swap them with `registerComponent`. **New
  chrome types go on an extension, not in the primitives table.** Always key chrome composites by
  `type:`, not `id:`, in event routing.

### Global + per-tab agent bridge model
One **global bridge** plus one **worker bridge per non-default tab** (`tab:<id>`). Tab-scoped
message types with a non-default `tabId` route to that tab's worker; everything else — including
`set_project`, `report`, and the default tab — goes to the global bridge. Workers spawn lazily on
first write, respawn when their cwd changes, and idle-retire after 15 min. **The global bridge is
the sole owner of the frontend extension surface;** worker registry-replacing messages are stamped
with `originTabId` and the frontend rejects hydrates whose origin tab isn't in the active
workspace (`origin-gate.ts` + `mutation-ack.ts`). This stops a background workspace's worker from
clobbering the active workspace's components/themes/keybindings.

### Nix devshell wrap for shells + agent bash
Project roots with `flake.nix`, `.envrc`, or `shell.nix` get their devshell env auto-applied to
**both** interactive PTY shell tabs and the agent's pi `bash` tool, from one source of truth
(`src-tauri/src/devshell/{detect,resolve,cache}.rs`). The PTY intercept lives in
`shell/lifecycle/open.rs`; the agent intercept is a `customTools` `bash`-named shadow warmed via
`agent/devshell/client.ts`. Cold cache → shell spawns unwrapped while the background resolver
runs; the next open gets wrapped.

### Per-tab ShareMode — the shell security boundary
`Tab.kind` is `"agent" | "shell"`. Each shell tab has a `ShareMode` enforced Rust-side in
`shell/sharemode.rs` — the opt-in floor before an agent can read or write a shell. The agent
surface (`aethon.shells.*`) rounds through the mutation-ack channel; `list()` only returns
opted-in shells. Writes pop an Allow/Deny notification in `read-write` mode;
`read-write-trusted` bypasses the prompt. **Do not add an agent-driven `setShareMode`** — that
would defeat the opt-in floor.

### Event routing precedence
`A2UIRenderer` accepts `onEvent`; returning `true` marks an event handled and suppresses the
default forward to Rust. `eventRoutes/index.ts` resolves in three precedence layers: (1) reserved
shell-consent prefixes (`shell-write`/`shell-close`/`session-delete`), (2) extension-registered
routes, (3) built-in routes keyed by `id:<componentId>` or `type:<componentType>`.

---

## 4. Guided Tour (recommended reading path)

Follow these 14 steps in order — they walk the three layers top to bottom and were designed as a
pedagogical path through the architecture.

1. **What Is Aethon?** — Start with `README.md` for the core idea ("pi with a face") and the
   layout-as-payload mental model; `SPEC.md` adds the milestone-by-milestone vision and the
   rationale behind the layered architecture.
2. **Product & Design Intent** — `PRODUCT.md` (target user, brand, design principles) and
   `DESIGN.md` (the Ember Brass palette, typography, elevation, agent-canvas and terminal
   surfaces). Absorb the "why" before reading code.
3. **Frontend Boot** — `src/main.tsx` applies the saved theme before mounting, then hands off to
   `src/App.tsx`, the intentionally thin root that composes ~40 `useX()` hooks and renders the
   A2UI workstation layout.
4. **Layout As A Payload** — `workstation.a2ui.json` describes the entire app chrome as data;
   `slots.json` defines the canonical slot contract any layout must satisfy. The single most
   important idea in the codebase.
5. **The A2UI Renderer & State Model** — `A2UIRenderer.tsx` turns payloads into a live React tree
   (a 19-entry primitive registry + the inline `for-each` = 20 non-overridable types, plus extension components and optimistic `$ref` updates);
   `jsonPointer.ts` + `dataBinding.ts` are how data becomes pixels and input flows back to state.
6. **Shared Types & Two Registries** — `types/tab.ts` and `types/a2ui.ts` are the two
   most-depended-upon files (144 and 100 inbound edges) — the vocabulary the whole frontend
   speaks. `ExtensionRegistry.ts` is the override surface for chrome composites.
7. **Default Layout & Event Routing** — `default-layout/index.ts` registers all the chrome
   components/panels/themes/keybindings; `eventRoutes/index.ts` is the central dispatcher with
   shell-consent → extension → id/type precedence.
8. **Crossing The Bridge: Frontend ↔ Agent** — `useBridgeMessages.ts` pumps the `agent-response`
   Tauri event into the state store; `bridgeMessageHandlers/index.ts` maps each inbound bridge
   message type to its handler. This is the seam where "the agent mutates the UI" happens.
9. **The Agent Bridge** — `agent/main.ts` (bridge entry), `dispatcher.ts` (the JSON-lines reader
   loop, mirror of step 8 on the agent side), and `state.ts` (the `AethonAgentState` class).
10. **`globalThis.aethon`: The Agent's UI API** — `aethon-api.ts` assembles the full runtime the
    agent uses to mutate the UI; `mutation-ack.ts` mints tracked mutation IDs; `origin-gate.ts`
    stamps worker messages so background workers can't clobber the active workspace.
11. **The Rust/Tauri Shell & Agent Supervisor** — `lib.rs` (thin Tauri entry), `commands/mod.rs`
    (IPC barrel), `agent_process/spawn.rs` + `readers.rs` (spawn the bun bridge and run the
    stdout/stderr reader threads that emit `agent-response` events).
12. **PTY Shells & The Nix Devshell Wrap** — `shell/lifecycle/open.rs` (spawns PTY shells with
    devshell env applied), `shell/sharemode.rs` (the per-tab security boundary), `devshell/resolve.rs`
    (the resolver feeding both PTYs and the agent bash tool).
13. **Supporting Subsystems** — `window_state/restore.rs` (logical-unit window geometry),
    `commands/updater.rs` (channel-aware auto-updates), `voice/mod.rs` (Whisper + native OS
    recognizers), `server/mod.rs` (mDNS peer discovery scaffold).
14. **Build Config & CI Capstone** — `flake.nix` (reproducible Nix env, Rust pinned to 1.92),
    `tauri.conf.json` (product identity, overlay titlebar), `package.json` (React 19 +
    pi-coding-agent + Vite/Vitest), and `ci.yml` → `_ci.yml` (the lint + typecheck + Rust/TS test
    + Playwright e2e gate).

---

## 5. File Map

Key files by layer, with what each does. (Tests and minor config omitted; see the layers above for
counts.)

### Rust/Tauri Shell
| File | Role |
| --- | --- |
| `src-tauri/src/lib.rs` | Thin Tauri entry; `run()` builder registers plugins, managed state, IPC handlers, setup hooks (window restore, server boot, watchers). |
| `src-tauri/src/agent_commands.rs` | IPC surface for the agent subprocess: spawns/restarts the bridge, forwards chat + A2UI events, routes payloads global-vs-worker. |
| `src-tauri/src/agent_process/process.rs` | Agent supervisor state machine: readiness/idle tracking, payload routing, mutation-route bookkeeping, retirement, orphan cleanup. |
| `src-tauri/src/agent_process/spawn.rs` | Launches the bun bridge child with user/worker env, devshell-resolved env, per-worker cwd, handshake. |
| `src-tauri/src/shell/lifecycle/open.rs` | Spawns `portable-pty` shell tabs and applies resolved Nix devshell env. |
| `src-tauri/src/shell/sharemode.rs` | `ShareMode` enum + transitions — per-tab opt-in security boundary for shell sharing. |
| `src-tauri/src/devshell/resolve.rs` | Runs `nix print-dev-env` / `direnv exec env` to compute the wrapped environment. |
| `src-tauri/src/window_state/restore.rs` | Persists/restores window geometry in logical units before the window becomes visible. |
| `src-tauri/src/commands/updater.rs` | Channel-aware auto-updates (stable/nightly) with GitHub-API discovery + pending-update stash. |
| `src-tauri/src/boot_probation/monitor.rs` | Post-launch probation: arms an attempt-bounded rollback timer, cancels on healthy boot. |
| `src-tauri/src/voice/mod.rs` | Voice-to-text core orchestrating Whisper / native OS recognizers behind a common engine trait. |
| `src-tauri/src/server/mod.rs` | mDNS discovery scaffold: advertises and browses for peer Aethon instances on the LAN. |
| `src-tauri/build.rs` | Build script: compiles the macOS PlatformSpeech Swift lib, bundles the bun agent sidecar, provisions LFM2. |

### Agent Bridge
| File | Role |
| --- | --- |
| `agent/main.ts` | Bridge entry: builds state, loads profiles/extensions/themes/subagents, restores default tab session, starts dispatcher. |
| `agent/dispatcher.ts` | JSON-lines stdin reader routing each inbound message to its handler; mirrors native window state. |
| `agent/state.ts` | `AethonAgentState` — all bridge runtime state (tabs, extensions, themes, mutation tracking, frontend-ready handshake). |
| `agent/aethon-api.ts` | Assembles `globalThis.aethon` (layout, canvas, sessions, shells, windows, dashboard, editor, keybindings, themes, notifications). |
| `agent/mutation-ack.ts` | Round-trip ack primitive — mints tracked mutation IDs so an agent-initiated UI change can be confirmed/rejected. |
| `agent/chat.ts` | Chat dispatch: routes prompt/steer/follow-up to the per-tab pi session; owns model, thinking-level, stop handling. |
| `agent/layout-manager.ts` | Owns A2UI layout state: set/patch operations, named-layout registration with id validation, runtime-snapshot summary. |
| `agent/state-mutation.ts` | Core JSON-pointer write path (global vs per-tab extension state) with payload-size limits + the canvas API. |
| `agent/auth-profiles/manager.ts` | Credential persistence, OAuth/API-key login, per-tab pi service registries, usage-limit-driven account auto-switch. |
| `agent/subagents/task-tool.ts` | The `task`/`task_batch` tools delegating work to subagents (inline isolated session or background tab). |
| `agent/system-prompt.ts` | Composes the system prompt: static template + user overrides + subagents section + runtime snapshot. |
| `agent/source-guard.ts` | Wraps tool execution to block writes/edits outside the project root and enforce plan-mode read-only. |
| `agent/devshell/client.ts` | Process-local devshell env cache + bridge-query client for the agent bash tool, keyed by cwd. |

### Frontend UI & A2UI Layout
| File | Role |
| --- | --- |
| `src/components/A2UIRenderer.tsx` | The rendering engine: payloads → React trees, the 19-entry `PRIMITIVE_REGISTRY` + inline `for-each` (20 non-overridable types) + extension components, optimistic `$ref` updates, event dispatch. |
| `src/components/primitives/layout.tsx` | Layout primitives — Card, Container (macOS drag-region), List, Table — resolving `$ref`-bound collections. |
| `src/components/primitives/{controls,form,media,text}.tsx` | Interactive control, form, media, and text primitives bound to state via `$ref` (`context-menu.tsx` is a shared menu helper, not a registered primitive type). |
| `src/extensions/default-layout/workstation.a2ui.json` | The default UI as data — the entire app chrome + initial state store. |
| `src/extensions/default-layout/index.ts` | Default-layout entry: assembles slots, registers all chrome components/panels/themes/keybindings. |
| `src/extensions/default-layout/chat-input.tsx` | The composer: draft state, slash/@-mention pickers, voice input, attachments, keyboard handling. |
| `src/extensions/default-layout/sidebar/file-tree.tsx` + `useFileTreeData.ts` | The host → project → workspace sidebar tree and its data layer. |
| `src/extensions/default-layout/shell/{panel,canvas,tab-strip}.tsx` | The bottom terminal panel and its PTY shell surfaces. |
| `src/monaco/aethon-themes.ts` | Monaco editor themes for the editor canvas. |
| `src/styles/{chrome,themes}.css` | Chrome drag/no-drag CSS and the theme palette. |

### Frontend Runtime & State
| File | Role |
| --- | --- |
| `src/App.tsx` | Root shell composing ~40 hooks; bootstraps state, OS-edge listeners, native window sync, renders the layout. |
| `src/app/AppRoot.tsx` | Top-level chrome shell composing the layout with overlay portals (settings, palette, search, auth, tasks). |
| `src/eventRoutes/index.ts` | Central A2UI event dispatcher (shell-consent → extension → id/type precedence). |
| `src/hooks/useBridgeMessages.ts` | Wires the `agent-response` Tauri event into a batched payload pump driving the state store. |
| `src/hooks/bridgeMessageHandlers/index.ts` | Registry mapping every inbound bridge message type to its handler. |
| `src/config.ts` | Reads the Rust TOML config via `read_config` and normalizes it into a typed, defaulted `AethonConfig`. |
| `src/runtime/windowApi.ts` | Builds the public `window.aethon` runtime API (setLayout, registerExtension, openProject, …). |
| `src/hooks/useVcsStatus.ts` | Consolidates working-tree changes, branch ahead/behind, PR state, CI rollup into the `/vcs` slice. |
| `src/hooks/useProjects.ts` / `src/projects.ts` | Project list persistence (MRU, `~/.aethon/projects.json`) and active-project switching. |
| `src/hooks/projectOps/tabBuckets.ts` | Per-workspace tab bucketing. |

### Shared Utilities & Types
| File | Role |
| --- | --- |
| `src/types/tab.ts` | The `Tab` type + pure bucketing/active-tab helpers — the most depended-upon file (144 inbound edges). |
| `src/types/a2ui.ts` | The A2UI payload protocol types (components, slots, messages, `$ref` bindings, app state shape) — 100 inbound edges. |
| `src/utils/jsonPointer.ts` | Immutable JSON-Pointer toolkit (resolve/set/delete, structural sharing, `$ref` resolution) for the single store. |
| `src/utils/dataBinding.ts` | Turns `{"$ref": "/path"}` props into concrete values. |
| `src/utils/agentResponseNormalizer.ts` | Normalizes raw agent messages for display (strips thinking tags, parses JSON envelopes). |
| `src/utils/toolCardGrouping.ts` | Groups chat messages into collapsible tool-card units for the history renderer. |

### CLI & Tooling (selected)
| File | Role |
| --- | --- |
| `cli/aethonctl.ts` + `cli/aethonControl.ts` | The `aethonctl` control CLI: tabs/accounts/chat/agent/skills/state/eval against a running instance. |
| `scripts/dev.sh` | Dev launcher: finds free Vite + debug ports, records them in `~/.aethon/dev-info.json`, supervises `cargo tauri dev`. |
| `e2e/support/aethon-harness.ts` | Playwright harness that mocks the Tauri invoke/event surface + a fake agent stream. |

### Build & CI (selected)
| File | Role |
| --- | --- |
| `flake.nix` | Reproducible Nix dev/build env (Rust 1.92, WebKit/GTK + macOS linker workarounds, devshell helpers). |
| `src-tauri/tauri.conf.json` | App identity, build hooks, overlay-titlebar window, bundle/updater config. |
| `package.json` | React 19 + pi-coding-agent + Vite/Vitest stack and dev/build/test scripts. |
| `.github/workflows/ci.yml` → `_ci.yml` | The reusable lint + typecheck + Rust/TS test + Playwright e2e gate every change must pass. |

---

## 6. Complexity Hotspots

The graph flags **305 file-level nodes** as `complex` (out of 1043 file-level nodes). Of these,
74 are tests (inherently branchy fixtures, generally safe to read) and the rest are spread across
the code layers. Below are the **architecturally load-bearing** complex files — the ones where a
careless change ripples furthest. Approach these with extra care, read the colocated tests first,
and verify behavior in the running dev app.

### Agent Bridge (35 complex; the routing/state core)
- `agent/state.ts` — single source of truth for all bridge runtime state; touched by nearly every handler.
- `agent/dispatcher.ts` — the JSON-lines routing seam; a mistake here mis-routes every inbound message.
- `agent/aethon-api.ts` — the entire agent-facing UI API; broad blast radius for tools and extensions.
- `agent/chat.ts` — owns the live prompt/steer/stop path to pi sessions.
- `agent/tab-lifecycle/events.ts` — streams assistant/thinking/tool events; handles compaction and context-overflow recovery.
- `agent/auth-profiles/manager.ts` — credential persistence + per-tab login + usage-limit auto-switch; security-sensitive.
- `agent/source-guard.ts` — enforces the write-outside-root and plan-mode floors; weakening it is a safety regression.
- `agent/session-history/restore.ts` + `parse-pi.ts` — transcript reconstruction; subtle ordering/dedup logic.
- `agent/subagents/task-tool.ts` — inline + background subagent execution with model resolution, timeouts, abort.

### Frontend Runtime & State (68 complex; the wiring core)
- `src/App.tsx` — the ~40-hook root; almost every feature passes through it.
- `src/eventRoutes/index.ts` — the central dispatcher; precedence ordering is reserved-prefix → extension → built-in for a reason.
- `src/hooks/useBridgeMessages.ts` + `bridgeMessageHandlers/{a2ui,ready,sessionHistory}.ts` — the inbound-message pump that drives the store.
- `src/config.ts` — normalizes every config field; defaults here are the app's fallback contract.
- `src/hooks/projectOps/*` + `tabOps/*` — project/workspace/tab bucketing and lifecycle; key-separator and migration details matter.
- `src/hooks/useVoice{Conversation,Hotkey,Input}.ts` — push-to-talk and conversation modes with timing-sensitive state.

### Frontend UI & A2UI Layout (54 complex; the renderer + chrome)
- `src/components/A2UIRenderer.tsx` — **the** rendering engine; the 19-entry primitive registry (+ inline `for-each` = 20 types) and optimistic `$ref` logic live here.
- `src/components/primitives/{layout,controls,form,media,text}.tsx` — the non-overridable primitive modules every layout depends on (`context-menu.tsx` is a shared helper, not a registered primitive type).
- `src/extensions/default-layout/workstation.a2ui.json` — the default UI payload; must satisfy the slot contract.
- `src/extensions/default-layout/{chat-input,sidebar/file-tree,shell/panel}.tsx` — the heaviest chrome composites.

### Rust/Tauri Shell (43 complex; the OS-boundary core)
- `src-tauri/src/lib.rs` — the Tauri entry that registers everything; misregistration breaks IPC silently.
- `src-tauri/src/agent_process/{process,spawn}.rs` — the supervisor state machine and child launch; concurrency-sensitive (global-vs-worker routing, retirement, mutation routes).
- `src-tauri/src/shell/lifecycle/{open,reader}.rs` — PTY spawn + the UTF-8-boundary-preserving reader (do **not** switch to per-chunk lossy decode).
- `src-tauri/src/devshell/{detect,resolve,cache}.rs` — devshell resolution state machine feeding both PTYs and agent bash.
- `src-tauri/src/commands/git/*` + `voice/*` + `boot_probation/*` — large, externally-dependent subsystems (git/gh, audio/Whisper, update rollback).
- `src-tauri/build.rs` — compiles the Swift speech lib and bundles the sidecar; build-graph changes here are easy to break across platforms.

### Shared Utilities & Types (7 complex; the vocabulary)
- `src/types/tab.ts` and `src/types/a2ui.ts` — the two most depended-upon files; a type change here fans out across the whole frontend.
- `src/utils/jsonPointer.ts` — the immutable pointer toolkit underpinning the single state store; structural-sharing correctness is critical.

> The remaining complex files (other dashboard panels, editor surfaces, git/voice command handlers,
> CLI scripts, CI workflows, and the long-form docs) are complex mostly because they are large or
> branchy, not because they are central — read them when a task takes you there.
