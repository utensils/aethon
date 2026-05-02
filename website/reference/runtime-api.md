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

The extension API is exposed under a single global, `aethon` (alias of
`globalThis.aethon`):

### Mutation

Most `register*` calls record **metadata** only. The action is wired
separately via `aethon.onEvent({ componentType, descendantId }, handler)`
— that way a layout can replace either half without touching the other.

| Call | Purpose |
|---|---|
| `aethon.registerComponent(type, template)` | Register an A2UI component template (built-in or skill-scoped). |
| `aethon.registerTheme({ id, label?, vars })` | Register a CSS-variable bundle. |
| `aethon.registerLayout({ id, name, description?, payload })` / `unregisterLayout(id)` / `listLayouts()` | Register a layout sibling to `workstation` / `editorial` / etc. |
| `aethon.registerSlashCommand({ name, description, usage? })` | Record a `/command` — pair with `onEvent({ componentType: "slash-command", descendantId: "<name>" })`. |
| `aethon.registerKeybinding({ combo, action?, description? })` / `unregisterKeybinding(combo)` | Bind a key combination — pair with `onEvent({ componentType: "keybinding", descendantId: "<combo>" })`. Extension bindings run first. |
| `aethon.registerMenuItem({ label, action, location?, id?, parent? })` / `unregisterMenuItem(id)` | Register a native menu item — pair with `onEvent({ componentType: "menu-item", descendantId: "<action>" })`. |
| `aethon.registerSidebarSection({ id, title, items })` | Register a sidebar group. |
| `aethon.registerEventRoute({ componentId?, eventType? })` / `unregisterEventRoute(...)` / `listEventRoutes()` / `setEventRoutingMode("builtin" \| "extension")` | Intercept App-dispatched events. |
| `aethon.onEvent(match, handler)` | Wire a handler. `match` is `{ componentType?, componentId?, descendantId?, eventType?, templateRootType? }` — omitted fields wildcard. |
| `aethon.setLayout(payload)` | Replace the active layout payload. |
| `aethon.activateLayout(id)` | Switch to a registered layout by id. |
| `aethon.resetLayout()` | Restore the default-layout boot payload. |
| `aethon.setState(path, value)` | Mutate a JSON-Pointer-addressed slice of app state. |
| `aethon.patchLayout(patch)` | Apply a partial layout patch. |
| `aethon.openProject(path)` | Register and activate a project. |

### Introspection

| Call | Purpose |
|---|---|
| `aethon.listExtensions()` | Currently loaded extensions (user / project / npm). |
| `aethon.listComponents()` | Registered components, with sources. |
| `aethon.listThemes()` | Registered themes. |
| `aethon.listSkills()` | Active skills. |
| `aethon.getLayout()` | The currently active layout payload. |
| `aethon.getRuntimeSnapshot()` | Full state snapshot — extensions, themes, components, layout, tabs. |

### Shell sharing

| Call | Purpose |
|---|---|
| `aethon.shells.list()` | Enumerate shells the user has explicitly shared (anything not `private`). |
| `aethon.shells.read(id, { cursor? })` | Forward-paging read of scrollback bytes. The first call (cursor omitted) returns the latest `max_bytes`. |
| `aethon.shells.write(id, bytes)` | Inject keystrokes. In `read-write` mode this pops an Allow/Deny prompt; in `read-write-trusted` it proceeds without one. |

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

Skills should `await` mutations and surface failures in chat (or
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
