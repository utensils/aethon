# Aethon — Design Specification

> Pi with a face. A native desktop shell where the agent decides what you see.

Status legend: `[x]` done · `[~]` partial / in progress · `[ ]` not started.
Last reviewed: 2026-04-26.

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
│  │  │ A2UI Renderer │  │  Static Chrome       │ │    │
│  │  │               │  │  - Chat input        │ │    │
│  │  │  Renders      │  │  - Status bar        │ │    │
│  │  │  agent-       │  │  - Settings          │ │    │
│  │  │  generated    │  │  - Theme switcher    │ │    │
│  │  │  components   │  │                      │ │    │
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
2. **Static Chrome** is the minimal fixed UI: chat input bar, status bar,
   settings panel, theme switcher. Everything else is agent-generated.

### Default Layout (lives as a skill)

The default workspace is itself an A2UI payload, shipped by the
`default-layout` skill. Loading it goes through the same renderer that
handles agent-emitted UI, so users (and other skills) can replace, modify,
or extend it without touching React.

```
┌──────────┬────────────────────────────┬──────────┐
│          │                            │          │
│ Sidebar  │       Main Canvas          │  Right   │
│          │                            │  Panel   │
│ - Files  │  ┌──────────────────────┐  │          │
│ - Skills │  │  Agent output /      │  │ - Props  │
│ - Models │  │  A2UI components     │  │ - Tools  │
│ - Chat   │  │  rendered here       │  │ - Logs   │
│   history│  │                      │  │          │
│          │  └──────────────────────┘  │          │
│          │  ┌──────────────────────┐  │          │
│          │  │  Chat Input          │  │          │
│          │  └──────────────────────┘  │          │
└──────────┴────────────────────────────┴──────────┘
                    Status Bar
```

The persistent location is `~/.aethon/layouts/default.a2ui.json`. The agent
can dynamically modify the layout during a session (collapse sidebar,
expand canvas, add panels) because everything is A2UI.

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
- [x] Hot reload of the agent during dev — Rust watches `agent/` and respawns the child on change (debug builds only)
- [ ] Theme system (dark + light variants, runtime switcher) — currently dark-only
- [ ] Compiled `aethon-agent` binary via `bun build --compile` — currently runs from source
- [x] Filter model picker to user's `enabledModels` patterns from `~/.pi/agent/settings.json` (compiled glob patterns; falls back to authed models if none configured)

### M2 — A2UI Renderer

- [x] A2UI React renderer with built-in component set
  - Primitives: `text`, `card`, `button`, `container`, `code`, `text-input`
  - Skill components (default-layout): `layout`, `sidebar`, `chat-history`, `chat-input`, `status-bar`, `terminal`, `main-canvas`
- [x] Data binding via JSON Pointer (`{"$ref": "/path"}`) — `DynamicString`/`Number`/`Boolean`
- [x] Event dispatch (button clicks, form submissions → agent via Tauri IPC)
- [x] Optimistic state updates for `change`/`submit` events on `$ref`-bound inputs
- [x] Agent emits A2UI payloads — tool execution surfaces as `card` components with summarized args + result
- [x] Tool execution surfaced as A2UI cards (read/bash/edit/write/grep/find/ls events → visible UI). Cards are emitted with a stable `tool-<callId>` message id, so the "running…" state updates in place to the final result instead of duplicating bubbles.
- [~] Streaming progressive component renders — text deltas amend the trailing bubble; tool cards replace by id; full mid-stream A2UI subtree mutation via state $refs is not yet wired

### M3 — Extension & Skill System

- [x] Skill registry primitive (`SkillRegistry`, exposed via React context)
- [x] Default-layout shipped as a registered skill (eats its own dog food)
- [x] Runtime API on `window.aethon` — `setLayout`, `resetLayout`, `registerSkill`, `listSkills`
- [ ] Pi extension loading with Aethon UI extensions (`registerA2UIComponent`, `registerPanel`, `registerTheme`)
- [ ] Skill manifest with A2UI component declarations (read from `package.json#aethon`)
- [ ] Extension hot-reload
- [ ] Discovery from `~/.aethon/extensions/` and `.aethon/extensions/`
- [ ] Package install (npm/git)

### M4 — Polish & Distribution

- [ ] Auto-updater
- [ ] System tray integration
- [ ] Native menus
- [ ] Cross-platform release builds (macOS, Linux, Windows)
- [ ] Nix flake overlay for distribution
- [ ] First public release

### Cross-cutting

- [x] Terminal panel — `xterm.js` with WebGL renderer, toggled from sidebar
- [x] In-memory session per app launch (`SessionManager.inMemory()`)
- [x] `aethon-debug` skill — TCP eval server (`127.0.0.1:19433` in dev) + slash command for driving the running app from Claude (eval, send, set-model, screenshot, wait, status). Mirrors Claudette's `claudette-debug` pattern.
- [ ] Multiple canvases / tabs (one pi session per tab)
- [ ] Persistent state (`~/.aethon/state.json`) — restore last layout on launch
- [ ] Configuration file (`~/.aethon/config.toml`) — currently inheriting `~/.pi/agent/settings.json`
- [~] `dispatch_a2ui_event` consumed by the agent — agent now accepts `a2ui_event` messages without erroring, but doesn't yet route them to handlers

---

## A2UI Integration

### Component registry — three tiers

**Built-in (primitives)** — Hardcoded in `src/components/A2UIRenderer.tsx`'s
`PRIMITIVE_REGISTRY`. Cannot be overridden by skills. Covers the A2UI
standard set: `text`, `heading`, `paragraph`, `code`, `card`, `container`,
`divider`, `button`, `text-input`, `select`, `checkbox`, `slider`,
`date-picker`, `table`, `list`, `image`, `icon`, `form`, `form-field`.
Currently only the core six are wired (`text`, `card`, `button`, `container`,
`code`, `text-input`); the rest are tracked under M2.

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

### Aethon extensions (new — not yet implemented)

- `registerA2UIComponent(type, ReactComponent)` — Register custom component types
- `registerPanel(id, a2uiSchema)` — Register persistent UI panels
- `registerTheme(name, themeConfig)` — Register custom themes
- `on('a2ui:interaction', ...)` — Hook into UI interaction events
- `ctx.canvas.emit(a2uiPayload)` — Programmatically push UI updates

### Discovery

Same as pi: `~/.aethon/extensions/` (global), `.aethon/extensions/`
(project-local), or via npm/git packages with an `aethon` key in
`package.json`.

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

Discovery: `~/.aethon/themes/`, `.aethon/themes/`, or via packages.

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
- Nix: Flake with overlay

---

## Configuration

```toml
# ~/.aethon/config.toml

[llm]
provider = "anthropic"          # or "openai", "google", "custom"
model = "claude-sonnet-4-6"     # default model
api_key_env = "ANTHROPIC_API_KEY"

[llm.custom]
base_url = "http://localhost:11434/v1"  # for local models

[ui]
theme = "aethon-dark"
font_size = 14
show_status_bar = true

[agent]
max_iterations = 50             # 0 = unlimited
```

Until `~/.aethon/config.toml` exists, Aethon reads model + provider config
from pi's own `~/.pi/agent/settings.json`.

---

## Resolved Decisions

1. **A2UI layout engine** — A2UI Container components with CSS Grid/Flexbox
   layout props. The layout skill uses these to define the default workspace.
   Agents and skills use the same Container primitives to modify layout
   dynamically.
2. **Persistent state** — Yes. Canvas layout persists across sessions in
   `~/.aethon/state.json`. Fresh sessions restore the last layout. `aethon
   reset` clears to default.
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
