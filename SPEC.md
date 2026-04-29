# Aethon — Design Specification

> Pi with a face. A native desktop shell where the agent decides what you see.

Status legend: `[x]` done · `[~]` partial / in progress · `[ ]` not started.
Last reviewed: 2026-04-28 (audit-driven cleanup pass: bridge-side `aethon.registerLayout` shipped, table cell scope grew `/$column` and `/$cell`, the layout's `/hasTabs` / `/empty` gates are now derived from `tabs.length` in `renderState` so the visibility cells can never drift, and React-component skills landed via `aethon.frontendEntry` in `package.json`). Recent additions: viewport-compensated UI zoom (`--app-ui-scale` + measured viewport tokens), project/git status badges in sidebar and palette, Cmd/Ctrl+K clear-chat and Cmd/Ctrl+. stop-prompt wiring, project-local `.aethon/extensions/` discovery from cwd to git root, in-app `/skills install <npm-package|git-url>` skill installation, layout-slot contract (`slots.json` + canonical area names + `slotMap`), generic `extension_lifecycle` feedback channel, extension-deletion state pruning via `extensionStateKeys`, cargo + vitest unit-test scaffolding, ESLint with react-hooks rules wired into `check`, a Nix distribution package + overlay, tag-driven GitHub release publishing for v0.2.0, and Windows x64 NSIS release bundles.

---

## Vision

Aethon is a cross-platform desktop application that embeds the pi coding agent
and renders its output as rich, interactive UI via the A2UI protocol. Instead
of a fixed IDE layout, the interface is a canvas the agent populates
dynamically — skills bring their own UI components, themes control the look,
and the agent decides the layout based on what you're doing.

The name comes from Greek mythology: Αἴθων, one of the horses that pulled
Helios's sun chariot. The blazing one that shapes what you see.

## Core Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Agent runtime | Pi SDK (embedded) | Direct `createAgentSession()`, no subprocess bridge for agent logic |
| Primary language | TypeScript (agent + UI) / Rust (OS shim) | Native pi integration, single language for extensions |
| Desktop framework | Tauri 2 | Native binary, ~5MB shell, system webview |
| UI protocol | A2UI v0.9 (full spec) | Agent-generated declarative UI, framework-agnostic |
| LLM providers | Multi-provider via pi-ai | Anthropic, OpenAI, Google, any OpenAI-compatible endpoint. BYOK. |
| Agent model | Opinionated default layout + full canvas flexibility | Ships with a Claudette-style layout as the default, but the layout itself is A2UI — users and skills can replace or extend it |
| Packaging | Compiled pi binary (bun build --compile) + Tauri shell in single .app | No runtime dependencies for end users |
| License | MIT | Open source under utensils org |
| Relation to Claudette | None | Independent project, no shared code |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Aethon (.app)                     │
│                                                     │
│  ┌───────────────┐    stdio/socket    ┌───────────┐ │
│  │  Tauri Shell   │◄──────────────────►│ Pi Agent  │ │
│  │  (Rust)        │                    │ (compiled │ │
│  │                │                    │  Bun bin) │ │
│  │  - Window mgmt │    A2UI JSON      │           │ │
│  │  - File access │◄──────────────────│  - pi-ai  │ │
│  │  - System tray │                    │  - tools  │ │
│  │  - Menus       │    Events/cmds     │  - skills │ │
│  │                │──────────────────►│  - exts   │ │
│  └───────┬───────┘                    └───────────┘ │
│          │                                           │
│          │ Tauri IPC                                 │
│          ▼                                           │
│  ┌─────────────────────────────────────────────┐    │
│  │           React Frontend                     │    │
│  │                                              │    │
│  │  ┌──────────────┐  ┌──────────────────────┐ │    │
│  │  │ A2UI Renderer │  │  Host Shell          │ │    │
│  │  │               │  │  - Boot/hydration    │ │    │
│  │  │  Renders      │  │  - Menus/shortcuts   │ │    │
│  │  │  agent +      │  │  - Persistence       │ │    │
│  │  │  skill UI     │  │  - Root overlays     │ │    │
│  │  │               │  │                      │ │    │
│  │  └──────────────┘  └──────────────────────┘ │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Layer responsibilities

**Tauri Shell (Rust)** — Owns the OS boundary. Window management, filesystem
access, system tray, native menus, notifications, auto-updater. No business
logic. No agent awareness beyond spawning + I/O. Exposes Tauri commands for
filesystem, clipboard, shell execution.

**Pi Agent (Compiled Bun Binary)** — The brain. Runs as a compiled standalone
binary, communicates with the Tauri shell via stdio or local socket. Handles
all LLM interaction, tool execution, session management, extension loading.
Emits A2UI JSON payloads describing what the UI should show. Receives user
input events (chat messages, button clicks, form submissions) from the
frontend.

**React Frontend** — The face. Two parts:

1. **A2UI Renderer** consumes the agent's A2UI JSON stream, maps component
   types to React components, handles data binding and event dispatch. This
   is the dynamic canvas.
2. **Host shell** owns bootstrapping, persistence, native menu/shortcut
   dispatch, and root overlays. The visible workspace chrome (tabs, sidebar,
   canvas, composer, terminal, status, palette, notifications) is provided by
   the `default-layout` A2UI skill and can be replaced or extended.

### Default Layout (lives as a skill)

The default workspace is itself an A2UI payload, shipped by the
`default-layout` skill. Loading it goes through the same renderer that
handles agent-emitted UI, so users (and other skills) can replace, modify,
or extend it without touching React. The skill ships four complete layouts:
`workstation` (boot default), `live-layout`, `editorial`, and `command-deck`.

```
┌──────────┬────────────────────────────────────┐
│ Sidebar  │ Header / tabs / layout controls    │
│          ├────────────────────────────────────┤
│ Projects │ Canvas                             │
│ Models   │ - chat history                     │
│ Themes   │ - agent-emitted A2UI components    │
│ Layouts  │ - empty state / recent sessions    │
│ Skills   ├────────────────────────────────────┤
│          │ Terminal (optional)                │
│          ├────────────────────────────────────┤
│          │ Composer + slash picker            │
└──────────┴────────────────────────────────────┘
                         Status
```

The canonical boot payload and slot catalogue are bundled from
`src/skills/default-layout/*.a2ui.json` and `slots.json` (or release
resources). Users switch layouts via `/layout`, the appearance menu, or
`window.aethon.activateLayout(id)`. Extensions can register layouts at runtime
with `aethon.registerLayout({ id, name, payload })` or replace/patch the active
layout with `setLayout` / `patchLayout`. Layout state is live runtime state,
not a persisted `~/.aethon/layouts/default.a2ui.json` file.

---

## Status Checklist

### M1 — Shell + Agent Communication

- [x] Tauri 2 project scaffold (`src-tauri/`, identifier `com.utensils.aethon`)
- [x] Pi agent bridge spawned as a `bun run agent/main.ts` subprocess from the Rust shell
- [x] JSON-lines stdio protocol (Tauri ↔ pi agent)
- [x] Chat input/output text round-trip
- [x] Streaming text deltas in the UI (response feels live, not blocking)
- [x] Real model name surfaced in the status bar (replaces hardcoded label)
- [x] Model picker (sidebar) — switch model at runtime via `session.setModel()`
- [x] Errors from the agent surface as visible chat messages, not silent hangs
- [x] Stop button — chat input swaps Send → Stop while `state.waiting` is true; Stop calls `session.abort()` via the bridge `stop` command. Bridge does not await `session.prompt()` so subsequent stdin messages (the stop) aren't queued behind it; verified killing in-flight bash within ~3s.
- [x] Hot reload of the agent — Rust watches `agent/` (dev only) plus `~/.aethon/extensions/`, `~/.aethon/skills/node_modules/`, and `~/.pi/agent/extensions/` (dev AND release) and respawns the child on change. Trailing-edge debounce via a single mpsc worker thread collapses install bursts. See M3 "Extension hot-reload" for the full description.
- [x] Theme system — three ship-ready palettes (`ember` warm dark default, `paper` cream light, `aether` ink-blue signature) behind `data-theme` on `<html>`, switcher in sidebar, persisted to `~/.aethon/theme` (legacy `localStorage` migrates on first read). Legacy ids map as `signature` → `aether`, `dark` → `ember`, `light` → `paper`. Boots from disk → `config.toml` `[ui] theme` → OS `prefers-color-scheme` (`paper` for light, `ember` for dark) → `ember`. Extensions and loose JSON themes register additional palettes via `aethon.registerTheme`.
- [x] Theme registry — `aethon.registerTheme({id, label?, vars})` ships extension-supplied CSS custom-property maps; full details in M3 below. Demo at `examples/pi-extensions/aethon-theme.ts`.
- [x] Compiled `aethon-agent` binary — `src-tauri/build.rs` invokes `bun build --compile` for the active Cargo target with mtime-gated rebuilds. Bundled via Tauri `externalBin`. Full details in M4 below.
- [x] Filter model picker to user's `enabledModels` patterns from `~/.pi/agent/settings.json` (compiled glob patterns; falls back to authed models if none configured)

### M2 — A2UI Renderer

- [x] A2UI React renderer with built-in component set
  - Primitives: `text`, `heading`, `paragraph`, `code`, `card`, `container`, `divider`, `button`, `text-input`, `date-picker`, `select`, `checkbox`, `slider`, `table`, `list`, `image`, `icon`, `form`, `form-field`
  - Skill components (default-layout): `layout`, `sidebar`, `chat-history`, `chat-input`, `status-bar`, `tab-strip`, `terminal`, `main-canvas`, `empty-state`, `command-palette`, `notification-stack`, plus layout-variation composites (`command-bar`, `vertical-tab-rail`, `inspector-pane`, `model-picker`, `appearance-menu`, etc.)
- [x] Data binding via JSON Pointer (`{"$ref": "/path"}`) — `DynamicString`/`Number`/`Boolean`
- [x] Event dispatch (button clicks, form submissions → agent via Tauri IPC)
- [x] Optimistic state updates for `change`/`submit` events on `$ref`-bound inputs
- [x] Agent emits A2UI payloads — tool execution surfaces as `card` components with summarized args + result
- [x] Tool execution surfaced as A2UI cards (read/bash/edit/write/grep/find/ls events → visible UI). Cards are emitted with a stable `tool-<callId>` message id, so the "running…" state updates in place to the final result instead of duplicating bubbles.
- [x] Image content from tool results renders in the card via the `image` primitive (data URLs, capped at 4 per result). Persisted history strips the base64 to avoid blowing the localStorage quota.
- [x] Streaming text bubbles survive intervening tool cards — bridge stamps each text delta with a stable `messageId` (pi `AssistantMessage.timestamp`) so post-tool deltas land in the original bubble instead of a new one
- [x] Streaming progressive component renders — text deltas amend by stable messageId, tool cards replace by stable id, and state-driven live A2UI subtrees can be seeded at `/canvas` then patched mid-turn through array-preserving JSON Pointer writes (e.g. `/canvas/components/0/props/title`) without corrupting `components` / `children` arrays.

### M3 — Extension & Skill System

- [x] Skill registry primitive (`SkillRegistry`, exposed via React context)
- [x] Default-layout shipped as a registered skill (eats its own dog food)
- [x] Runtime API on `window.aethon` (frontend-only, in addition to the bridge-side `globalThis.aethon`): `setLayout`, `resetLayout`, `getLayout`, `registerSkill`, `listSkills`, `newTab`, `closeTab(tabId)`, `switchTab(tabId)`, `listTabs`. Used by the aethon-debug skill, the system menu / tray, and any in-webview script. Do not confuse with the bridge-side surface in `agent/main.ts` — that one is for extensions and adds `setState`, `patchLayout`, `registerComponent`, `registerTheme`, `onEvent`, `getRuntimeSnapshot`, etc.
- [x] Pi extensions reach the Aethon UI surface via `globalThis.aethon` (set before `createAgentSession` so pi's loader sees it). Same `registerComponent` / `setState` / `onEvent` API as Aethon-side extensions, and the global is absent outside Aethon so pi-TUI extensions stay functional. Examples + types under `examples/pi-extensions/`.
- [x] Extension-registered components are interactive — `aethon.onEvent({templateRootType, componentType, descendantId, eventType}, handler)` runs handlers when an A2UI control inside an extension template fires an event. Handlers can call `setState` / `registerComponent` to drive UI without an LLM round-trip. Renderer threads `templateRootType` through descendant dispatches and the bridge extracts `descendantId` from the host-prefixed componentId. Demo at `examples/pi-extensions/aethon-counter.ts`.
- [x] Aethon-side extensions via `~/.aethon/extensions/*.{ts,js}` exporting `register(api)` (same API surface as pi-side). `loadAethonExtensions` in the bridge discovers + dynamic-imports them at boot; missing dir is the no-op default. Bridge retains state as a tree and replays on `ready`; frontend hydrates templates into the SkillRegistry and the renderer expands them inline with host-prefixed ids.
- [x] Project-local Aethon extensions via `<project>/.aethon/extensions/*.{ts,js,mjs}` — when a tab opens or the active project cwd changes, the bridge walks from that cwd up to the nearest git root, loads each existing `.aethon/extensions` directory root-first, dedupes files for the bridge process, refreshes the resource loader, and marks entries as `project-directory` in `listExtensions()` / `RuntimeSnapshot.extensions`. This mirrors pi's project-local extension ergonomics while keeping Aethon's UI API surface identical.
- [x] Extensions can mutate the entire UI: `aethon.setLayout(payload)` replaces the active layout wholesale, `aethon.patchLayout(path, value)` JSON-Pointer patches it (array-preserving), `aethon.registerSidebarSection({id,title,items})` is a convenience wrapper that appends into the sidebar's `extraSections`. Bridge retains both the layout and pending pre-setLayout patches for ready/report replay. Frontend treats layout state as boot defaults so live runtime fields (model, status, messages, draft) survive reload. Demo at `examples/pi-extensions/aethon-sidebar-panel.ts`.
- [x] `ctx.pi` namespace for handlers — `aethon.onEvent` handlers receive a typed pi-coding-agent surface scoped for UI work: `ctx.pi.prompt(text)` fires an LLM turn from a click (frontend flips waiting/Stop via a `prompt_started` outbound message, just like a user-typed prompt), `ctx.pi.notify(message)` pushes a non-terminal system bubble, `ctx.pi.session` exposes current model + last 50 messages read-only, `ctx.pi.signal` is pi's active turn AbortSignal so handler-side fetch/spawn cancels with Stop. The dispatch loop is fire-and-forget so handler awaits never block bridge IPC; handler errors emit as `notice` so they can't clobber waiting state for an in-flight prompt. Demo at `examples/pi-extensions/aethon-actions.ts` (Quick Actions sidebar: Summarize commits, Explain README, Show current model).
- [x] Extensions can register color themes: `aethon.registerTheme({id, label?, vars})` ships a CSS custom-property map (`--bg`, `--text`, `--accent`, …). Bridge sanitizes the id/keys, retains the theme map, emits `extension_themes` deltas, and includes the snapshot in `ready` for reload-replay. Frontend hydrates each theme into a `<style>` tag built via CSSOM `setProperty` so malformed values can't escape the declaration; stale tags are dropped when the list shrinks. Built-in ids `ember`, `paper`, `aether`, and legacy `signature` are reserved. Themes appear in the sidebar Themes section alongside the built-in palettes and persist to `~/.aethon/theme`. Demo at `examples/pi-extensions/aethon-theme.ts` (Solarized Dark + Synthwave).
- [x] Agent self-awareness — `agent/system-prompt.ts` composes a layered prompt: static Aethon base (API surface, A2UI primitives, anti-patterns, env-var contract) → optional `~/.aethon/system-prompt.md` override / `~/.aethon/system-prompt-append.md` append → **runtime snapshot** (loaded extensions, registered themes, custom components, layout summary, open tabs). Snapshot rebuilds every `resourceLoader.reload()`, and the bootstrap loads extensions BEFORE the default tab so the first session's prompt sees them. Bundled docs ship at `$AETHON_DOCS_DIR` (`docs/aethon-agent/{api,components,extensions}.md`) so the agent has authoritative reference material in any build. Live state mirrors to `$AETHON_STATE_FILE` (`~/.aethon/state.json`) — `cat`-able from the agent's bash tool, debounced 200 ms, regenerated on every register* call. Introspection methods on `globalThis.aethon` (`listExtensions`, `listComponents`, `listThemes`, `getLayout`, `getRuntimeSnapshot`) cover the same surface for in-process queries. Pi extensions in `~/.pi/agent/extensions/` that touch `globalThis.aethon` are discovered (grep-based, no execution) and listed alongside Aethon-direct ones so the snapshot covers all UI-driving sources.
- [x] Skill manifest from `package.json#aethon` — `loadAethonSkillManifests` in the bridge walks `~/.aethon/skills/node_modules/*` (plus `@scope/*`), reads each package.json, and for any package with an `aethon.entry` field dynamically imports the entry and calls its `register(api)` export with the same Aethon API surface directory extensions get. Lets users `npm install --prefix ~/.aethon/skills <pkg>` to install third-party skills. Demo at `examples/skill-package/`.
- [x] In-app skill install — `/skills install <npm-package|git-url>` runs the equivalent of `npm install --prefix ~/.aethon/skills <spec>` from the Tauri shell (not the agent sidecar, so the `node_modules` watcher cannot kill the installer mid-flight). The command accepts npm package specs, tarballs, GitHub shorthands, and git URLs, rejects shell-like option/whitespace input, uses the same macOS login-shell PATH recovery as the agent, and terminates the current sidecar after success so the next request loads the new skill package.
- [x] **React-component skills** — `aethon.frontendEntry` in a skill's `package.json` points at a JS file whose body uses `React` + `skill.registerComponent(type, ReactComponent)` to register real React components in the SkillRegistry. Bridge reads the file at boot, ships it to the webview as a string in `extension_skill_modules`, frontend evaluates with `new Function("React", "skill", code)` and reconciles wholesale (re-evaluating drops/replaces components from removed/changed skills). Errors per module are caught + surfaced as a system notice. `RuntimeSnapshot.skillModules` carries `{name, entryPath, bytes}`; code body lives on disk. Same trust model as bridge-side skill code (no sandbox; user installed the package). Demo: `examples/skill-package/src/frontend.js` ships a `pulse-card` component using `React.useEffect`. Loader covered by 9 vitest cases under `src/skills/skillModuleLoader.test.ts`.
- [x] Extension hot-reload — bridge file watcher now runs in dev AND release, watches `~/.aethon/extensions/`, `~/.aethon/skills/node_modules/`, and `~/.pi/agent/extensions/` (when present), plus `<project>/agent/` in dev only. Trailing-edge debounce via a single dedicated worker thread (mpsc channel + `recv_timeout`) collapses npm-install bursts into one settle-then-fire kill. `~/.aethon/extensions` is pre-created on boot so first-install Create events fire without a manual restart.

### M4 — Polish & Distribution

- [x] Auto-updater wired via `tauri-plugin-updater` — Cargo + bun deps, capabilities, plugin registration (gated on a non-empty `plugins.updater.pubkey` in `tauri.conf.json` so unconfigured builds boot safely), `updater_available` Tauri command, and a manual "Check for Updates…" menu item (Aethon submenu on macOS, View on Linux/Windows) plus a tray entry. Reads the `latest.json` manifest from the GitHub Releases endpoint, downloads with progress as system messages, and relaunches via `tauri-plugin-process`. Release signing is activated: the updater public key is committed in `tauri.conf.json`, the private key and passphrase are stored locally under `~/.tauri/`, and the matching `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets are configured so CI can sign updater bundles automatically.
- [x] System tray (status-bar) icon — `TrayIconBuilder` reuses the bundled brand mark in full color (template image strips the orange so it's intentionally off). Left-click focuses the main window (calls `AppHandle::show()` on macOS so Cmd+H'd apps re-surface), and a small menu offers Show Aethon / New Tab (focuses + emits the same "menu" event the app menu / `Cmd/Ctrl+T` fire) / Quit. Same code runs on Linux/Windows; menu pops on left-click on those platforms per their convention.
- [x] Native menus — full bar built with `tauri::menu::MenuBuilder` replaces Tauri's auto-generated default. Standard NS items (Quit, Hide, Cut/Copy/Paste, Minimize, …) come from `PredefinedMenuItem` so they get free native behavior; app-specific items emit a `menu` Tauri event whose payload routes into the same React dispatcher `Cmd/Ctrl+T`, `Cmd/Ctrl+]`, `Cmd/Ctrl+[`, `Cmd/Ctrl+W`, `Cmd/Ctrl+\``, `Cmd/Ctrl+K`, and `Cmd/Ctrl+.` use, so menu and shortcuts can never drift. Layout: Aethon (macOS) / File (New Tab, Close Tab) / Edit / View (Toggle Terminal, Clear Chat, Stop Prompt, Check for Updates… on non-macOS) / Tabs / Help (Documentation, Report Issue) / Window. `Cmd+W` is reserved for `close_tab`; the predefined `close_window` is omitted so macOS doesn't route it to the wrong action. Help submenu opens external URLs via `tauri-plugin-opener`.
- [x] Cross-platform release builds — `cargo tauri build` produces self-contained macOS DMGs/updater tarballs, Linux `.deb`/`.rpm` installers, and a Windows x64 NSIS setup executable from the GitHub release matrix. The `aethon-agent` sidecar is compiled by `src-tauri/build.rs` via `bun build --compile`, bundled via Tauri's `externalBin`, and spawned in release with `PI_PACKAGE_DIR` pointing to a shipped `pi/package.json` resource. mtime-gated so incremental builds no-op when sources haven't changed; cross-target builds honor `cargo --target` / `CARGO_BUILD_TARGET` / `TAURI_ENV_TARGET_TRIPLE` across macOS, Linux, and Windows. **macOS-specific**: the spawn path also runs `<shell> -ilc env` once on first agent launch to recover the user's login-shell PATH (Homebrew, Nix profile, `~/.npm-global/bin`, …) because launchd-spawned `.app` processes inherit a minimal PATH that breaks pi's `npm root -g` and similar package-resolver calls; result is cached for the process lifetime. Bundled resources include `pi/package.json`, `docs/aethon-agent/*.md`, and `skills/default-layout/*.a2ui.json` plus `slots.json`.
- [x] Brand mark — `assets/brand/aethon-logo.svg` (cream Bodoni Æ + orange π badge on dark tile) and `aethon-brand-marks.svg` (6-format reference sheet). Rasterized into every Tauri target via `bun tauri icon`. In-app header shows the logo alongside "Aethon" via Vite `?url` import + `$ref`-bound state.
- [x] macOS About dialog metadata — `bundle.{publisher,homepage,copyright,category,shortDescription,longDescription}` + `bundle.macOS.minimumSystemVersion` populate `Info.plist` (`NSHumanReadableCopyright`, `LSApplicationCategoryType`, etc.). Shows the proper icon + version + "Copyright © 2026 James Brink. MIT License." attribution. Dev binary still shows the generic icon (it's a raw Mach-O without a `.app` wrapper).
- [x] Nix flake overlay for distribution — `flake.nix` now exports `packages.aethon`, `packages.default`, and `overlays.default` (`pkgs.aethon`). The package follows nixpkgs' Tauri packaging path with `cargo-tauri.hook`, the pinned Rust 1.92 toolchain, `fetchNpmDeps` backed by `package-lock.json`, Linux WebKitGTK build inputs, and a macOS `$out/bin/aethon` wrapper around the generated `.app`. Nix builds disable updater artifact generation inside the build copy so distribution packages don't require release signing secrets.
- [x] First public release — `CHANGELOG.md` now has dated `0.1.0` and `0.2.0` sections, and `.github/workflows/release.yml` publishes public GitHub releases from `v*.*.*` tags. The workflow builds signed macOS Apple Silicon + Intel DMGs with updater tarballs/signatures/`latest.json`, Linux x86_64 `.deb` and `.rpm` installers, Windows x64 NSIS setup executables, and the `aethon` Rust crate on crates.io using `CARGO_REGISTRY_TOKEN`. Linux AppImage/updater artifacts are intentionally omitted until `linuxdeploy` is reliable in CI; the Linux installer bundles and Windows NSIS bundle are verified green.

### M5 — Agent Control Surface (the "no hardcoded chrome" gap)

Aethon's stated vision is "the agent decides what you see — A2UI is the
entire UI, no fixed IDE chrome." Today the agent can register components,
themes, sidebar sections, layouts, and event handlers, but several
hardcoded behaviors in the frontend and gaps in the bridge → frontend
contract still prevent **full** agent control. M5 is the work to close
those gaps so any UI surface can be inspected, mutated, and overridden
by an extension without touching React source.

#### Bridge ↔ Frontend contract gaps

- [x] **`getLayout()` returns the active rendered layout** — bridge now preloads the canonical boot layout SYNCHRONOUSLY from `$AETHON_BOOT_LAYOUT_FILE` (set by the Tauri shell, pointing at `src/skills/default-layout/layout.a2ui.json` in dev or the bundled resource in release) BEFORE any extension's `register(api)` runs. `_getLayout()` returns `extensionLayout ?? (bootLayout + pendingLayoutPatches folded)`, and a `boot_layout` inbound message lets the frontend refresh the value when the active layout skill changes. Verified end-to-end: `right-sidebar-model-picker` extension's prior bailout (`if (!layout) return`) now succeeds and applies its 5 patches; layoutSummary correctly reports `sidebar=right` after register-time. Bundled boot layout added to `tauri.conf.json` `bundle.resources` so release builds get it too.
- [x] **Bridge-readable frontend state** — frontend pushes `frontend_state_patch { path, value }` whenever an allowlisted slice changes (`/sidebar/models`, `/sidebar/themes`, `/connection`, `/status`, `/tabs`, `/draft`, `/messagesCount`). Bridge stores in `frontendState` Map; `aethon.getFrontendState(path?)` returns the live value; `getRuntimeSnapshot().uiState` includes the full mirror so the system prompt's runtime section + `~/.aethon/state.json` reflect what's actually on screen. Diff-on-frontend keeps the IPC chatter low (one patch per slice per change). Best-effort mirror, no ack.
- [x] **Mutation feedback channel** — every mutating outbound message (`state_patch`, `layout_set`, `layout_patch`, `extension_components`, `extension_themes`) carries a `mutationId`. Frontend acks via `mutation_ack { mutationId, success, error? }`. Bridge resolves a per-mutation Promise so the API now returns `Promise<{ok: boolean, error?: string}>`. Sync use is unchanged (Promises just GC if not awaited). Pre-frontend-ready calls resolve immediately with `{ok: true}` (covered by retained-state replay). 5-second timeout guards stuck Promises. `registerTheme` validation failures emit a `notice` (not `error`) so they don't clobber waiting state, and the Promise carries the same detail.
- [x] **Boot-layout structural snapshot in `RuntimeSnapshot`** — `RuntimeSnapshot.layoutStructure` ships `{rootId, rootType, columns?, rows?, areas?, children: [{id, type, area?}]}` extracted from the active layout (extension-set or boot+patches). Agent answers "what's in the layout?" without paying for the full `getLayout()` round-trip; the system prompt's runtime section emits a one-liner showing the root's children + areas.

#### A2UI primitive gaps

- [x] **Array-iteration template primitive (`for-each`)** — `{type: "for-each", props: {items: {$ref: "/some/array"}, key?: "<field>"}, children: [<template>]}`. Renderer expands `children` once per array element, suffixing every nested id with `__$idx<n>` so React keys stay stable. Auto-rerenders on array mutation.
- [x] **`$ref` resolution scope inside `for-each`** — iteration injects three special keys into the scoped state map: `/$item` (current element), `/$index` (position), `/$parent` (surrounding state). Standard JSON Pointer resolution finds them — no resolver changes needed. Templates address values via `{ $ref: "/$item/label" }`. Documented in bundled docs (`components.md`) and the system prompt's iteration section.

#### Hardcoded chrome → registerable

- [x] **Registerable keyboard shortcuts** — `aethon.registerKeybinding({combo, action?, description?})` and `aethon.unregisterKeybinding(combo)` are wired. Combos accept any human-readable form (`Cmd`/`Meta`/`Ctrl`/`Alt`/`Option`/`Shift`); bridge and frontend normalize to a canonical key for matching/unregister. Invocations dispatch through `a2ui_event` as `{componentType: "keybinding", componentId: "keybinding__tpl__<combo>", data: {action, combo}}` so a paired `aethon.onEvent` handler fires. Registered bindings run before built-ins, so extensions can intentionally override default chrome shortcuts (`Cmd/Ctrl+P`, `Cmd/Ctrl+Shift+P`, `Cmd/Ctrl+T`, `Cmd/Ctrl+W`, `Cmd/Ctrl+]`, `Cmd/Ctrl+[`, `Cmd/Ctrl+\``, `Cmd/Ctrl+K`, `Cmd/Ctrl+.`, plus UI zoom); unregistering restores the built-in behavior. Surfaced in `RuntimeSnapshot.keybindings`.
- [x] **Registerable slash commands** — `aethon.registerSlashCommand({name, description, usage?})` records metadata; pair with `aethon.onEvent({componentType: "slash-command", descendantId: "<name>"}, handler)` to wire the action. Frontend merges with built-ins for the picker, dispatches invocations through the existing `a2ui_event` route as `{componentType: "slash-command", componentId: "slash-command__tpl__<name>", data: {args}}` so per-tab attribution + handler dedup work the same as any other event. Built-in collisions (`clear`, `help`, `theme`, `model`, `reset`, `terminal`, `sidebar`, `layout`, `skills`, `project`) are rejected with a notice. Replayed on `ready` so reload restores the picker; surfaced in `RuntimeSnapshot.slashCommands`.
- [x] **Registerable menu items** — `aethon.registerMenuItem({label, action, location?, id?, parent?})` and `aethon.unregisterMenuItem(id)` are wired. Bridge ships `extension_menu_items` events to the frontend, which forwards to a `set_extension_menu_items` Tauri command that rebuilds both the App menu (extension entries appear under an "Extensions" submenu) and the tray menu. Click events emit `menu` events with id `ext:<action>`; the React dispatcher routes them via `a2ui_event` so a paired `aethon.onEvent({componentType: "menu-item", descendantId: "<action>"}, handler)` matcher fires. Replayed on `ready` so reload restores the menu. Surfaced in `RuntimeSnapshot.menuItems`.
- [x] **Compositional sidebar items** — each `SidebarItem` can carry `componentType`. When set, the sidebar resolves it through the SkillRegistry and renders the registered template per item with `/$item`, `/$index`, `/$parent` scope keys (same convention as the `for-each` primitive). New `BuiltinComponentProps.renderChildWithState(child, overlay)` helper exposes the renderer's scoped expansion to composites. Click semantics unchanged (`select` event with `{sectionId, itemId}` + descendantId). Documented in bundled docs (`components.md`).
- [x] **Compositional terminal subscription** — bash output now lands in three places: (1) `Tab.terminalBuffer` per-tab record (existing; tab-switch replay), (2) `/terminal/buffer/<tabId>` state path bindable via `$ref` from any A2UI component, (3) `aethon:terminal-tap` window event with `detail = {tabId, content}` firing for every chunk regardless of active tab — multi-subscriber friendly, no monkey-patching. The original `aethon:terminal` event is preserved for the active-tab xterm pump. Documented in bundled `components.md`.
- [x] **Pluggable `onEvent` routing — extensions can intercept or replace built-in events.** `aethon.registerEventRoute({componentId?, eventType?})` and `unregisterEventRoute(...)` intercept matching App-dispatched events so they flow through `a2ui_event` to paired `aethon.onEvent({componentType, descendantId})` handlers. Wildcards via omitted fields (componentId-only or eventType-only). `aethon.listEventRoutes()` returns the registered intercepts. `aethon.setEventRoutingMode("extension")` now switches to full replacement mode: every layout event bypasses the App built-in switch and goes to the bridge; `setEventRoutingMode("builtin")` restores default built-ins for unmatched events. Surfaced in `RuntimeSnapshot.eventRoutingMode`.
- [x] **Built-in `button` fires `click` unconditionally** — `Button` no longer gates on `props.onClick`; the prop is gone from the schema. Disabled buttons remain inert. Pre-existing `examples/` that pass `onClick` continue to work because the renderer ignores unknown props.
- [x] **Sidebar emits per-item `descendantId`** — `BuiltinComponentProps.onEvent` now accepts an optional 3rd argument; when supplied the renderer rewrites the outbound componentId to `<host>__tpl__<descendantId>`, so the bridge's existing `__tpl__` parser pulls it into `match.descendantId`. The documented `aethon.onEvent({componentType:"sidebar", descendantId:"open-readme"}, …)` recipe now matches.
- [x] **Handler `ctx.pi.prompt` errors emit `notice` (non-terminal)** — `handler prompt: …` now sends `type:"notice"` so the frontend's Stop button stays visible for the surrounding turn. The error still rethrows so the calling handler can see it.
- [x] **`registerComponent` accepts both bare and wrapper shapes** — bridge auto-unwraps `{components:[<single component>]}` to the single component for renderer expansion. Docs (`docs/aethon-agent/api.md:57-78`) updated to show the bare-component form as canonical.
- [x] **A2UI primitive coverage** — the full SPEC-enumerated primitive set now ships: `text`, `heading`, `paragraph`, `code`, `card`, `container`, `divider`, `button`, `text-input`, `date-picker`, `select`, `checkbox`, `slider`, `table`, `list`, `image`, `icon`, `form`, and `form-field`. `list` and `table` use the same scoped-render mechanism as `for-each`; `form` serializes named child controls into `{values}`; input-like controls optimistically update `$ref`-bound `value` props.
- [x] **Multi-tab restore on relaunch — discovery + manual or automatic restore.** Bridge's `discoverPersistedTabs()` walks `~/.aethon/sessions/` at boot, reads the newest JSONL metadata for each tab, and returns `[{tabId, lastModified, cwd?}]` sorted descending. Shipped in `ready` as `discoveredTabs`. Frontend scopes `/recentSessions` to the active project cwd, filters out already-open tabIds, and the empty-state/sidebar/palette render clickable "Recent sessions" rows (relative-time labels). Clicking a row calls `newTab(sessionId, label, {cwd, restoredSession:true})`, reusing the same `tabId`; the bridge replays the saved visible transcript from JSONL via `session_history` and uses `SessionManager.continueRecent(cwd, dir)` so pi resumes the same LLM history. `[ui] restore_tabs = true` auto-opens only the active project's discovered sessions after projects load, dedupes repeated `ready` events, opens oldest first so the newest restored session is active, and leaves manual restore available when the setting is false.
- [x] **Concurrent setState attribution race fixed for handler-driven writes.** `dispatch_a2ui_event` handler dispatch now wraps the handler in `tabContext.run(handlerTabId, …)` so any setState (including microtask/promise chains the handler kicks off) inherits the originating tab via AsyncLocalStorage. Pi prompts already had this. setIntervals registered at module-load time still have no ALS context — those fall back to `currentAgentTabId` (best-effort active-tab attribution; documented in the priority-list comment).
- [x] **State file regenerates on `onEvent` registration** — fixed in `agent/main.ts:_onEvent`: `scheduleStateFileWrite` is now called after each handler is registered.
- [x] **Registered event handlers in runtime snapshot** — `RuntimeSnapshot.eventHandlers` ships the match shape only (templateRootType / componentType / descendantId / eventType), no function bodies. Surfaced in the live `~/.aethon/state.json` and the system-prompt runtime section so the agent can answer "what handlers are wired?" without invoking JS.
- [x] **Hardcoded chat-input chrome lifted to props** — `chat-input` now accepts `sendLabel`, `stopLabel`, `stopTitle`, and `queueBadgeFormat` (with `{n}` placeholder for the queue count). All accept `$ref`s. Defaults preserve existing UX. Documented in `docs/aethon-agent/components.md`.
- [x] **Hardcoded chrome strings lifted to composite props** — `main-canvas` accepts `emptyHint`; `terminal` accepts `headerLabel` and `bootGreeting` (re-applied on tab-switch replay too). Extensions overriding brand/voice no longer need to fork the composite.
- [x] **Theme discovery: loose-file loader implemented.** Bridge now loads `~/.aethon/themes/*.json` at boot via `loadAethonThemeDirectory`; each file goes through the same `normalizeTheme` validation as extension-supplied themes. Watcher pre-creates the directory and watches it for hot-reload. SPEC's Themes section updated with the four discovery sources. Lowest-friction path for non-coder users to ship a theme.

#### Layout abstraction gaps

- [x] **Default-layout slot contract** — `src/skills/default-layout/slots.json` declares the canonical slot catalogue (`header`, `sidebar`, `tabs`, `canvas`, `terminal`, `composer`, `status`, `empty-state`) with descriptions, default composite types, and a `required` flag (`canvas` + `composer` are required for a complete workspace). Composites slot via their existing `area` prop; the Layout component honors an optional `slotMap` on the root `<layout>` so a non-canonical layout can host the standard composites under different CSS area names. The four built-in layouts (workstation, editorial, command-deck, live-layout) all use the canonical slot names — `chat-input` area was renamed to `composer`. Catalogue exposed on `window.aethon.layoutSlots` (with `inspectLayoutSlotCoverage(payload?)` for tooling) and on the bridge as `globalThis.aethon.getLayoutSlots()`. Bridge loads it synchronously at boot from `$AETHON_LAYOUT_SLOTS_FILE` (set by the Tauri shell, bundled as `slots.json` in release) and surfaces it in `RuntimeSnapshot.layoutSlots` so the system prompt prints the canonical slot list. Documented in `docs/aethon-agent/components.md` "Layout-slot contract" with a `slotMap` example.
- [x] **Default-layout sidebar opt-in** — sidebar presence binds to `/layout/sidebarVisible`, with `/layout/columns` and `/layout/areas` also state-driven so the grid template-areas adapts on toggle. `Layout` component now resolves `areas` via `$ref` too. New `/sidebar` slash command, `Cmd/Ctrl+B`, and `toggleSidebar` slash context method flip all three keys atomically.
- [x] **Layout-skill catalogue** — `default-layout` skill ships four built-in layouts (`workstation`, `editorial`, `command-deck`, `live-layout`) bundled as separate `.a2ui.json` payloads with shared chrome composites (sidebar, tab-strip, status-bar, chat-input) plus layout-specific components (`editorial-spine`, `editorial-header`, `command-bar`, `vertical-tab-rail`, `inspector-pane`, `layout-toast`, `agent-status-pill`). `window.aethon.listLayouts()`, `window.aethon.activateLayout(id)`, and `window.aethon.registerLayout({id, name, payload})` form the frontend catalogue API. **Bridge mirror**: `globalThis.aethon.registerLayout({id, name, description?, payload})`, `unregisterLayout(id)`, and `listLayouts()` now ship on the agent side too — agent-side extensions and skill packages can append to the catalogue without injecting through the webview. Built-in ids (workstation/editorial/command-deck/live-layout) are reserved. The catalogue replays on `ready` (so reload restores extension layouts) and `RuntimeSnapshot.layouts` carries id+name+description (payloads omitted to keep the snapshot small). `/layout <id>` slash command swaps via the catalogue; `/layout` lists available ids. `workstation` is the boot default.
- [x] **Closing the last tab shows an empty-state composite from default-layout** — `closeTab` no longer guards on `tabs.length <= 1` or `tabId === "default"`; every tab is closable. When the tab list reaches zero, the layout swaps the canvas/composer/tab-strip cells (hidden via `visible: { $ref: "/hasTabs" }`) for an `empty-state` composite (`visible: { $ref: "/empty" }`) that renders a welcome card with a "New Tab" button, quick-start tips, and a recent-sessions slot. The composite is a **registered component on `default-layout` skill** (`empty-state` → `EmptyState` React component) — extensions can override it by re-registering the same type. Layout JSON owns the visibility wiring (`/empty` and `/hasTabs` boot to `false`/`true` and flip on tab transitions). Bridge `tab_close` now allows closing "default" too and gracefully handles an empty `tabs` map (clears `currentAgentTabId`; `ensureTab` lazily recreates whatever tab the next inbound message references). New-tab gestures (`Cmd/Ctrl+T`, system-tray "New Tab", menu, `empty-state:new-tab` event) all work from the empty state.

#### Documentation + agent guardrails

- [x] **System prompt covers `for-each` iteration** — replaces the prior "no array iteration" warning. Documents `{$item, $index, $parent}` scope keys with a worked example.
- [x] **System prompt covers the mutation feedback contract** — `agent/system-prompt.ts` now ships a "Knowing whether a mutation succeeded" section explaining the Promise return, the failure modes (`timeout`, `frontend_rejected: …`, validation), and the pre-connect immediate-resolve behavior. Bundled `docs/aethon-agent/api.md` carries the same contract at the head of the Mutation section.
- [x] **`docs/aethon-agent/{api,components,extensions}.md` updated.** Each shipped M5 item updated the bundled docs alongside the code change — `registerSlashCommand`, `registerKeybinding`, `registerMenuItem`, `registerEventRoute`, `getFrontendState`, `getRuntimeSnapshot.layoutStructure`, `for-each`, `empty-state`, and the full primitive set (`heading`, `paragraph`, `divider`, `checkbox`, `select`, `slider`, `list`, `table`, `date-picker`, `icon`, `form`, `form-field`). Composites' new prop schemas (`emptyHint`, `headerLabel`, `bootGreeting`, `sendLabel`, `stopLabel`, `queueBadgeFormat`) are documented too.

### Cross-cutting

- [x] Terminal panel — `xterm.js` with WebGL renderer, toggled from sidebar
- [x] Bash tool output streams into the terminal panel via the `aethon:terminal` window event (default-layout terminal opts in via `subscribeToBash`). Command echo (`$ <cmd>`) is emitted at `tool_execution_start`; stdout/stderr now stream from pi's `tool_execution_update` rolling tail buffer through a per-`toolCallId` diff so overlapping bash calls stay isolated and the final `tool_execution_end` payload does not replay duplicate output. Covered by stream-diff tests for append-only output, tail truncation overlap, final replay suppression, and interleaved bash calls.
- [x] Per-tab persistent sessions — each tab uses `SessionManager.continueRecent(cwd, $AETHON_SESSIONS_DIR/<tabId>)`, so pi context survives bun restarts (file-watcher in dev, app relaunch in release). Session discovery reads each JSONL session record's `cwd` and the frontend scopes Chat History / recent-session restore to the active project. Restored tabs replay their visible user/assistant transcript from JSONL, then pi resumes the underlying LLM context from the same tab directory. New tabs (no prior file) start fresh. Falls back to `inMemory()` if the per-tab dir can't be created. `tabId` is sanitized against `[A-Za-z0-9_-]{1,128}` before use as a directory name (defense against malformed external callers).
- [x] `aethon-debug` skill — TCP eval server (`127.0.0.1:19433` in dev) + slash command for driving the running app from Claude (eval, send, set-model, screenshot, wait, status). Mirrors Claudette's `claudette-debug` pattern.
- [x] Project workspace switching — recent projects persist to `~/.aethon/projects.json`; selecting a project switches the active cwd for new agent sessions and maintains a separate visible tab bucket per project. The sidebar shows basename + full-path tooltip, plus best-effort git branch and dirty badges from the Tauri `git_status` command. Command palette project rows prioritize full path hints, then git branch tags. `/project` supports picker, id switch, and raw absolute/`~` paths.
- [x] Multi-tab — per-tab pi sessions (`Map<TabId, AgentSession>` sharing
      one auth/registry/resourceLoader), per-tab message history, draft,
      canvas, queue counter, terminal buffer, and model. AsyncLocalStorage
      carries the active turn's tabId through the agent's async chain so
      `globalThis.aethon.setState` calls route to the right tab even under
      concurrent prompts. Tab strip in the layout, `Cmd/Ctrl+T` new,
      `Cmd/Ctrl+]` / `Cmd/Ctrl+[` next/prev, `Cmd/Ctrl+W` close. New tabs inherit the active
      tab's model; bridge `tab_open` accepts a `model` so the pi session
      boots with it (no race window). Per-tab terminal buffer with
      replay on switch via `aethon:terminal-replay`.
- [x] UI scaling — app-wide browser zoom persists to `~/.aethon/ui_zoom`, driven by `Cmd/Ctrl+=`, `Cmd/Ctrl+-`, and `Cmd/Ctrl+0`. `App.tsx` writes `--app-ui-scale`, `--app-viewport-width`, and `--app-viewport-height` so viewport-bound layouts, popovers, palette, slash picker, and terminal sizes divide by the zoom instead of expanding past the visible window. Shipped layouts/components use `minmax(0, 1fr)`, bounded overlays, truncation, and shrink constraints so zoomed UI stays inside the viewport across `ember`, `paper`, `aether`, and extension themes.
- [x] Persistent state — legacy default-tab chat history (`~/.aethon/messages.json`, capped at 200 messages / 8KB per text field, image data URLs stripped before persist), theme (`~/.aethon/theme`), UI zoom (`~/.aethon/ui_zoom`), projects (`~/.aethon/projects.json`), per-tab pi sessions and restorable visible transcripts (`~/.aethon/sessions/<tabId>`), and runtime snapshot (`~/.aethon/state.json`) persist to disk via Tauri commands or the bridge. Cross-platform via Tauri's `home_dir()`. Legacy localStorage values migrate on first read; legacy entries are removed only after a confirmed disk write.
- [x] Client-side slash commands (`/clear`, `/help`, `/theme`, `/model`, `/reset`, `/terminal`, `/sidebar`, `/layout`, `/skills`, `/project`). Unknown commands fall through to the agent so pi-side handling and prompt templates aren't blocked. `//foo` escapes to send a literal `/foo`.
- [x] Slash command picker UI — autocomplete dropdown above the chat input when the draft starts with `/`. Prefix-filters; ↑/↓/Tab/Enter navigate+insert; Esc dismisses; click inserts. Portalled to `document.body` so the layout cell's `overflow:hidden` doesn't clip it. Bound via the `commands` prop on `chat-input` (inline array or `$ref`).
- [x] Configuration file (`~/.aethon/config.toml`) — `read_config` parses TOML into `[ui]` (`theme`, `font_size`, `restore_tabs`) + `[agent]` (`model`) sections. Frontend reads it during boot to seed theme; `[ui] font_size` clamps to 10–24 px and writes the `--app-font-size` CSS custom property the body rule consumes; `[ui] restore_tabs = true` auto-restores discovered per-tab sessions on launch; `[agent] model` seeds the picker default when no per-session model is saved (bridge's session model still wins on `ready` hydration). Pi settings (`~/.pi/agent/settings.json`) still drive model picker filtering and provider/auth — the Aethon config is layered on top.
- [x] Bridge env-var contract — Tauri shell passes `AETHON_DOCS_DIR` (bundled reference docs), `AETHON_USER_DIR` (~/.aethon/), `AETHON_STATE_FILE` (snapshot path), `AETHON_SESSIONS_DIR` (per-tab pi sessions), `AETHON_RELEASE_MODE` (1/0), and `AETHON_PROJECT_ROOT` (dev only). Bundled docs live in the binary via `tauri.conf.json` `bundle.resources` (`docs/aethon-agent/*.md` → `<resource_dir>/docs/aethon-agent/`). System prompt branches on these so release builds don't tell the agent to read source files that aren't there.
- [x] `dispatch_a2ui_event` routes to extension handlers — bridge extracts `descendantId` from host-prefixed `componentId` and matches against `aethon.onEvent({templateRootType, componentType, descendantId, eventType})` predicates. Handlers run fire-and-forget so a slow handler can't block the bridge IPC loop; errors emit as `notice` (not `error`) so they don't clobber the `waiting` flag for an in-flight prompt.
- [x] Window opens maximized via `tauri.conf.json` `app.windows[0].maximized: true` (existing center/width/height stay as the unmaximized fallback).
- [x] **Extension lifecycle feedback channel.** Bridge emits `extension_lifecycle { name, source, status: "loaded"|"failed"|"skipped", error?, path }` for every load attempt from `loadAethonExtensions` and `loadAethonSkillManifests`. Frontend dispatches a cancellable `aethon:extension-lifecycle` window CustomEvent, then (default) appends a system-notice chat bubble. Layouts and extensions can listen on the window event and call `e.preventDefault()` to substitute alternative UX (toast, sidebar pulse, status pill) — the channel is decoupled from chat-history rendering by design.
- [x] **Extension-deletion UI cleanup.** Bridge tracks `extensionStateKeys: Set<string>` of every JSON Pointer path written via extension `setState` and reports the list in `ready`. Frontend keeps a ref of the previous ready's set; on each new ready, paths in (previous − new) are deleted from live state via `deletePointer`. So when an extension is uninstalled (file deleted), the watcher respawns the bridge → new ready has a smaller key set → leftover sidebar sections / canvas cards / state slices vanish without a page reload.
- [x] **Test coverage + linting.** `cargo test --lib` covers `helpers::{validate_state_name, parse_config_toml, clamp_font_size}` (14 tests). `bun run test` / `bunx vitest run` covers `utils/jsonPointer`, `utils/dataBinding`, `slashCommands`, project storage, palette item selection, primitive rendering, and the slot catalogue / inspector (77 tests). `bunx eslint .` enforces 0 errors with type-aware rules + react-hooks plugin (warnings tracked: `react-hooks/set-state-in-effect`, `react-hooks/refs` in `App.tsx` / `ChatInput`). All wired into the `check` devshell command as a single CI gate.

---

## A2UI Integration

### Component registry — three tiers

**Built-in (primitives)** — Hardcoded in `src/components/A2UIRenderer.tsx`'s
`PRIMITIVE_REGISTRY`. Cannot be overridden by skills. The current shipped set
is `text`, `heading`, `paragraph`, `code`, `card`, `container`, `divider`,
`button`, `text-input`, `date-picker`, `select`, `checkbox`, `slider`,
`table`, `list`, `image`, `icon`, `form`, and `form-field`. `list` supports
scoped child templates via `/$item`, `/$index`, and `/$parent`; `table` cell
templates expose `/$row`, `/$index`, `/$parent`, `/$column` (column metadata
— `field`, `header`, `width`), and `/$cell` (resolved value at the column's
`field` path on the row); `form` emits named child control values on submit.

**Skill components** — Registered via `SkillRegistry.register(skill)`. A
skill declares its custom component types in its manifest:

```json
{
  "name": "git-skill",
  "a2ui": {
    "components": {
      "branch-graph": "./components/BranchGraph.tsx",
      "commit-list": "./components/CommitList.tsx",
      "diff-viewer": "./components/DiffViewer.tsx"
    }
  }
}
```

When the agent uses this skill and emits a `branch-graph` component, the
renderer resolves it through the registry.

**User components** — Installed from `~/.aethon/components/` or via packages.
Users can create and share custom A2UI components.

### Data binding

A2UI's `DynamicString` / `DynamicNumber` / `DynamicBoolean` types enable
reactive data binding. The frontend maintains a single state store; components
bind to state paths via JSON Pointer (`{"$ref": "/path/to/value"}`). When
state updates, bound components re-render automatically.

### Event dispatch

User interactions (clicks, form submissions, selections) are dispatched back
to the pi agent as structured events (`dispatch_a2ui_event` Tauri command).
The agent handles them like tool results — processing the interaction and
optionally updating the UI.

---

## Extension Model

Aethon extends pi's existing extension system with UI capabilities.

### Pi extensions (unchanged)

- `registerTool()` — LLM-callable functions
- `registerCommand()` — Slash commands
- `on('tool_call', ...)` — Event hooks
- `ctx.ui.confirm()`, `ctx.ui.select()` — User prompts

### Aethon extensions (current API surface)

Pi extensions reach the Aethon UI via `globalThis.aethon` — see
`examples/pi-extensions/aethon-types.d.ts` for full ambient types.
Aethon-only extensions live in `~/.aethon/extensions/*.{ts,js}` and
receive the same surface as the first arg to their `register(api)`.

- `registerComponent(type, template)` — Register an A2UI subtree as a custom component type
- `setState(jsonPointer, value)` — Mutate live layout state at a path
- `onEvent(match, handler)` — Route component events to extension handlers (no LLM round-trip)
- `setLayout(payload)` — Replace the active layout wholesale
- `patchLayout(jsonPointer, value)` — JSON-Pointer patch the active layout (array-preserving)
- `registerSidebarSection({id, title, items})` — Convenience wrapper for `/sidebar/extraSections`
- `registerTheme({id, label?, vars})` — Register a color scheme (CSS custom properties)
- `registerSlashCommand({name, description, usage?})` — Add slash picker metadata and pair it with an event handler
- `registerKeybinding({combo, action?, description?})` / `unregisterKeybinding(combo)` — Add or override keyboard shortcuts
- `registerMenuItem({label, action, location?, id?, parent?})` / `unregisterMenuItem(id)` — Add menu metadata for A2UI-driven menus
- `registerEventRoute({componentId?, eventType?})` / `unregisterEventRoute(route)` — Route matching built-in events through extension handlers
- `registerLayout({id, name, description?, payload})` / `unregisterLayout(id)` / `listLayouts()` — Append to the runtime layout catalogue from the agent side; activation still goes through `setLayout(payload)` (or, on the frontend, `window.aethon.activateLayout(id)`)
- `getFrontendState(path?)`, `getRuntimeSnapshot()`, `getLayout()`, `getLayoutSlots()` — Introspection helpers used by the system prompt and agent-side diagnostics

### Still on the backlog

- Programmatic canvas push API (`ctx.canvas.emit(...)`)

### Discovery

Today: bridge loads `~/.aethon/extensions/*.{ts,js,mjs}` (Aethon-direct,
loose files), project-local `.aethon/extensions/*.{ts,js,mjs}` discovered
from the selected cwd up to its nearest git root (root-first, loaded once
per bridge process), `~/.aethon/skills/node_modules/*` (npm-distributed
skill packages with an `aethon.entry` field in `package.json`), and
discovers (without loading — pi does that) any
`~/.pi/agent/extensions/*` that references `globalThis.aethon`, tagging
them in the runtime snapshot.

Backlog: no active discovery/install backlog items.

---

## Themes

Themes control the visual layer without affecting functionality. A theme
defines:

- Color palette (background, foreground, accent, semantic colors)
- Typography (font family, sizes, weights)
- Spacing scale
- Border radii
- Component-specific overrides (card shadow, button style, code block theme)
- Dark/light mode variants

Themes are CSS custom properties applied globally. The A2UI renderer reads
these when rendering components. Themes can be switched at runtime.

Discovery: themes can come from any of these sources, all registered
through the same `normalizeTheme` validation path so reserved built-ins
(`ember`, `paper`, `aether`, legacy `signature`) and malformed CSS variable
names are rejected uniformly:

1. **`~/.aethon/themes/*.json`** — loose-file JSON themes loaded by the
   bridge at boot. Each file is `{ id, label?, vars: { "--bg": "...", ... } }`.
   Pre-created on first launch and watched for hot reload — drop a JSON
   file and it appears in the sidebar Themes section without restarting.
2. **Aethon extensions** under `~/.aethon/extensions/*.{ts,js,mjs}` calling
   `globalThis.aethon.registerTheme(…)`.
3. **npm-distributed skill packages** under `~/.aethon/skills/node_modules/<pkg>`
   (manifest `aethon.entry`) calling the same registration.
4. **pi extensions** under `~/.pi/agent/extensions/*` that touch
   `globalThis.aethon.registerTheme(…)`.

Loose-file themes are the lowest-friction option for end users — no code
required.

---

## Skills with UI

The key differentiator. A pi skill in Aethon can include:

1. **Agent tools** (standard pi) — Functions the LLM can call
2. **A2UI components** (new) — Custom React components the agent can render
3. **Prompt templates** (standard pi) — Pre-built prompts
4. **Default layout** (new) — A2UI JSON describing the skill's preferred canvas layout

Example: A "Kubernetes" skill ships with:

- Tools: `kubectl_get`, `kubectl_describe`, `kubectl_logs`
- Components: `PodList`, `ServiceMap`, `LogViewer`
- Default layout: When activated, renders a `PodList` + `LogViewer` side by side

The agent can override or extend the default layout based on conversation.

---

## Packaging

### Development tree

```
aethon/
├── src-tauri/          # Rust Tauri shell (thin)
├── src/                # React frontend + A2UI renderer
├── agent/              # Pi agent entry point + Aethon extensions
├── components/         # Built-in A2UI component implementations
├── themes/             # Built-in themes
├── skills/             # Bundled skills
└── package.json
```

### Build

1. `bun build --compile agent/main.ts` → `aethon-agent` binary (~50MB)
2. `tauri build` → Bundles Rust shell + React frontend + `aethon-agent` into `.app`

### Distribution

- macOS: `.dmg` (Apple Silicon + Intel universal)
- Linux: AppImage (x86_64 + aarch64)
- Windows: `.msi` (x86_64 + ARM64)
- Nix: Flake with `packages.aethon`, `packages.default`, and `overlays.default` (`pkgs.aethon`)

---

## Configuration

**Currently parsed schema** (see `src-tauri/src/lib.rs:read_config` and
`src/config.ts`):

```toml
# ~/.aethon/config.toml

[ui]
theme = "ember"          # built-ins: "ember" | "paper" | "aether"
                         # legacy aliases: "signature" -> "aether",
                         # "dark" -> "ember", "light" -> "paper"
                         # extension/loose-file themes are accepted once
                         # they are registered during boot
font_size = 13           # clamps to 10-24 and writes --app-font-size
restore_tabs = false     # true auto-opens discovered per-tab sessions on launch

[agent]
model = "anthropic/claude-sonnet-4-6"   # seeds the picker/default display
                                        # when no per-session model is saved
```

Pi settings (`~/.pi/agent/settings.json`) drive provider/auth, model
discovery, and `enabledModels` filtering for the picker. Aethon's
config layers on top, not a replacement.

**Backlog**: consider adding `[updater]` (endpoint, channel) and `[shell]`
(login-PATH override) sections as the corresponding code paths grow.

---

## Resolved Decisions

1. **A2UI layout engine** — A2UI Container components with CSS Grid/Flexbox
   layout props. The layout skill uses these to define the default workspace.
   Agents and skills use the same Container primitives to modify layout
   dynamically.
2. **Persistent state** — Yes. Legacy frontend default-tab chat history
   (`~/.aethon/messages.json`), theme (`~/.aethon/theme`), UI zoom
   (`~/.aethon/ui_zoom`), and project list (`~/.aethon/projects.json`)
   persist across launches. Pi LLM context and restorable visible
   transcripts persist per-tab under
   `~/.aethon/sessions/<tabId>/*.jsonl` via pi's own session manager.
   `~/.aethon/state.json` is a *live* snapshot of the bridge's runtime
   registry (extensions, themes, components, layout summary, tabs) —
   rewritten on every registration so the agent can `cat` it for an
   up-to-date view; not a layout persistence file.
3. **Multiple canvases** — Yes, tabs for multiple agent sessions in v1. Each
   tab gets its own pi session and canvas state.
4. **Pi upstream** — No. The A2UI extension API stays Aethon-specific. If pi
   wants it later, they can pull from our implementation. We don't gate our
   progress on upstream acceptance.
5. **Component sandboxing** — None. Same-process, no iframe, no shadow DOM.
   Like pi itself: full trust, full speed. Users install what they choose to
   install. No permission system by default — yolo mode, matching pi's
   philosophy.
6. **Terminal integration** — Embedded `xterm.js` with the WebGL renderer
   for GPU-accelerated terminal output. Pi's tools get shell access through
   this. The terminal is an A2UI component registered by the default layout
   skill — it can be shown, hidden, resized, or replaced like any other
   component.

---

*Author: James Brink <brink.james@gmail.com>*
*Project: utensils/aethon*
*License: MIT*
