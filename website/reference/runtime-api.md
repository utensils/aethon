# Runtime API

This page is a **pointer** to the canonical extension API reference.
The full surface lives in [`docs/aethon-agent/api.md`][api-docs] — the
docs that ship *inside* the binary as a resource the agent reads at
runtime.

[api-docs]: https://github.com/utensils/aethon/blob/main/docs/aethon-agent/api.md

## Why two doc surfaces?

- **`docs/aethon-agent/`** — bundled into the binary as `AETHON_DOCS_DIR`.
  The system prompt directs the agent at these files. They are the
  single source of truth for the API.
- **This site** — synthesizes the user-facing concepts and links here
  for authoritative type signatures and examples.

If the two ever diverge, the bundled docs win.

## Quick map

Agent-side extension APIs are exposed under a single global, `aethon`
(alias of `globalThis.aethon`). Frontend runtime APIs are exposed on
`window.aethon` inside the webview.

The tables below cover the most-used calls. The agent-side
`globalThis.aethon` additionally exposes `windows.*`, `sessions.*`,
`canvas.*`, `dashboard.*`, `tasks.*`, `shells.*`, `notify`,
`registerHighlightGrammar`, and the introspection helpers — see
[`api.md`][api-docs] for the full surface.

### Mutation

Most `register*` calls record **metadata** only. The action is wired
separately via `aethon.onEvent({ componentType, descendantId }, handler)`
— that way a layout can replace either half without touching the other.

| Call | Purpose |
|---|---|
| `aethon.registerComponent(type, template)` | Register an A2UI component template (built-in or extension-scoped). |
| `aethon.registerTheme({ id, label?, vars })` | Register a CSS-variable bundle. |
| `aethon.registerLayout({ id, name, description?, payload })` / `unregisterLayout(id)` / `listLayouts()` | Register a layout sibling to `workstation` (the only built-in id today). |
| `aethon.registerSlashCommand({ name, description, usage? })` | Record a `/command` — pair with `onEvent({ componentType: "slash-command", descendantId: "<name>" })`. |
| `aethon.registerKeybinding({ combo, action?, description? })` / `unregisterKeybinding(combo)` | Bind a key combination — pair with `onEvent({ componentType: "keybinding", descendantId: "<combo>" })`. Extension bindings run first. |
| `aethon.registerMenuItem({ label, action, location?, id?, parent? })` / `unregisterMenuItem(id)` | Register a native menu item — pair with `onEvent({ componentType: "menu-item", descendantId: "<action>" })`. |
| `aethon.registerSidebarSection({ id, title, items })` | Register a sidebar group. |
| `aethon.registerEventRoute({ componentId?, eventType? })` / `unregisterEventRoute(...)` / `listEventRoutes()` / `setEventRoutingMode("builtin" \| "extension")` | Intercept App-dispatched events. |
| `aethon.onEvent(match, handler)` | Wire a handler. `match` is `{ componentType?, componentId?, descendantId?, eventType?, templateRootType? }` — omitted fields wildcard. |
| `aethon.setLayout(payload)` | Replace the active layout payload. |
| `aethon.setState(path, value)` | Mutate a JSON-Pointer-addressed slice of app state. |
| `aethon.patchLayout(path, value)` | Apply a partial layout patch at a JSON Pointer path. |

### Frontend Runtime

These calls are available to frontend extension modules and the dev webview
runtime as `window.aethon`.

| Call | Purpose |
|---|---|
| `window.aethon.askUser({ title?, prompt, choices, allowText? })` | Ask an inline question in chat and resolve with the selected answer. |
| `window.aethon.activateLayout(id)` | Switch to a registered layout by id. **Frontend-only** — not on the agent-side `aethon`. |
| `window.aethon.resetLayout()` | Restore the default-layout boot payload. **Frontend-only.** |
| `window.aethon.openProject(path)` | Register and activate a project. **Frontend-only.** |

### Introspection

| Call | Purpose |
|---|---|
| `aethon.listExtensions()` | Currently loaded extensions (user / project / npm). |
| `aethon.listComponents()` | Registered components, with sources. |
| `aethon.listThemes()` | Registered themes. |
| `aethon.listLayouts()` | Registered layouts. |
| `aethon.getLayout()` | The currently active layout payload. |
| `aethon.getRuntimeSnapshot()` | Full state snapshot — extensions, themes, components, layout, tabs. |

### Shell sharing

| Call | Purpose |
|---|---|
| `aethon.shells.list()` | Enumerate shells the user has explicitly shared (anything not `private`). |
| `aethon.shells.create({ tabId?, cwd?, command?, args?, activate?, inheritEnv? })` | Open a new shell sub-tab (all fields optional). |
| `aethon.shells.read({ tabId, sinceTotal?, maxBytes? })` | Forward-paging read of scrollback bytes. The first call (`sinceTotal` omitted) returns the latest bytes. |
| `aethon.shells.write({ tabId, text })` | Inject keystrokes. In `read-write` mode this pops an Allow/Deny prompt; in `read-write-trusted` it proceeds without one. |

### Editor

| Call | Purpose |
|---|---|
| `aethon.editor.openFile({ path, rootPath? })` | Open or focus a Monaco editor tab. Relative paths resolve against the active agent tab cwd; `rootPath` supplies an alternate validation root. |

### Project tasks and dashboard data

| Call | Purpose |
|---|---|
| `aethon.tasks.start({ projectPath, prompt, model, newWorkspace?, branch?, baseBranch?, bridgePrompt?, activate?, label? })` | Start a dashboard task: optionally create a workspace, open an agent tab at the target cwd, and send the first prompt. **`model` is required for agent-side launches** so a session can't inherit the wrong dashboard/default model. `bridgePrompt` sets a hidden bridge prompt while `prompt` stays the visible tab text. Set `activate: false` to launch without focusing/switching. |
| `aethon.dashboard.getRepoOverview({ projectPath })` | Read the cached GitHub/repo overview used by the project dashboard. |
| `aethon.dashboard.refresh({ projectPath? })` | Refresh dashboard data. |
| `aethon.dashboard.listIssues({ projectPath, limit? })` | Return cached open issues for a project. |
| `aethon.dashboard.getIssue({ projectPath, number })` | Return the full issue title, URL, body, and author. |

::: tip
There is intentionally **no `setShareMode` on the agent surface**. Mode
changes only happen when the user clicks the share-mode badge on the
shell's status line.
:::

## Mutation feedback

Every mutation call returns a `Promise<MutationResult>` with:

```ts
type MutationResult = {
  ok: boolean;
  error?: string;
  data?: unknown; // populated for query-like calls (e.g. shells.list/read/write)
};
```

Extensions should `await` mutations and surface failures in chat (or
through `aethon.onEvent("extension_lifecycle", …)`). A failed mutation
does **not** crash Aethon — the error is logged and the rest of the
extension keeps running.

## Runtime snapshot

`aethon.getRuntimeSnapshot()` returns the same data Aethon writes to
`~/.aethon/state.json` on every change (debounced 200 ms). It contains:

- Loaded extensions, themes, custom components.
- Active layout summary.
- Tab list with cwd, model, kind (agent / shell).
- Registered slash commands, keybindings, menu items.

`cat ~/.aethon/state.json` works for a quick view without an
introspection round-trip — useful for debugging which extensions
loaded and which didn't.

## Bundled docs index

For component reference, A2UI primitives, JSON Pointer data binding,
and the full extension-authoring guide, see the bundled docs:

- [`docs/aethon-agent/api.md`][api-docs] — full API surface.
- [`docs/aethon-agent/components.md`][components-docs] — A2UI primitives + composites.
- [`docs/aethon-agent/extensions.md`][ext-docs] — extension authoring.
- [`docs/aethon-agent/README.md`][readme-docs] — index.

[components-docs]: https://github.com/utensils/aethon/blob/main/docs/aethon-agent/components.md
[ext-docs]: https://github.com/utensils/aethon/blob/main/docs/aethon-agent/extensions.md
[readme-docs]: https://github.com/utensils/aethon/blob/main/docs/aethon-agent/README.md
