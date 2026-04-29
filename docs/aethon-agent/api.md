# globalThis.aethon — Runtime API

`globalThis.aethon` is the bridge between the agent process and the live
React UI. Every method takes effect immediately and survives a webview
reload (state, components, themes, and layout are replayed on `ready`).

`globalThis.aethon` exists in **every** Aethon build (dev and release).
Guard with `if (globalThis.aethon)` only in code that may also run inside
the standalone pi CLI.

## Mutation

Every mutating method below returns `Promise<MutationResult>` where
`MutationResult = { ok: boolean; error?: string }`. Sync use is still
fully supported — fire-and-forget callers (`aethon.setState(...)`)
ignore the Promise and behave exactly as before. Awaiting (`await
aethon.setState(...)`) gives you the frontend's confirmation:

```ts
const r = await globalThis.aethon.setState("/status", "indexing…");
if (!r.ok) console.error("setState failed:", r.error);
```

Failure modes:
- `"timeout"` — frontend didn't ack within 5 s (likely crashed or
  unreachable).
- `"frontend_rejected: …"` — frontend received the message but applied
  it with errors (e.g. invalid layout payload, malformed pointer).
- `"<arg> required"` — bridge-side validation (path/payload missing).

Calls made before the frontend has reported `ready` resolve immediately
with `{ ok: true }` — the bridge's retained-state replay covers them
on the next `ready`, so awaiting at register-time doesn't block.

### `setState(path, value)`

Write to frontend layout state at a JSON-Pointer path. Components bound
with `{ "$ref": "<path>" }` re-render. Persisted across webview reload.

```ts
globalThis.aethon.setState("/status", "indexing…");
globalThis.aethon.setState("/myCounter/count", 42);
globalThis.aethon.setState("/canvas", {
  components: [{ id: "progress", type: "card", props: { title: "Starting" } }],
});
globalThis.aethon.setState("/canvas/components/0/props/title", "Streaming");
```

Routing rules: writes to the mirrored keys (`/messages`, `/draft`,
`/waiting`, `/queueCount`, `/canvas`, `/model`) are attributed to the
**currently active tab** (or the tab whose turn is in flight). Other paths
are global. Don't try to write to a specific tab — the bridge handles
attribution via the AsyncLocalStorage in pi's call chain.

Nested writes are array-preserving, so a running extension or handler can
seed `/canvas` with an A2UI payload, then progressively patch paths like
`/canvas/components/0/children/1/props/content` while the same turn is still
streaming.

### `setLayout(payload)`

Replace the entire layout. `payload` is the same shape as
`src/skills/default-layout/layout.a2ui.json` — `{ components, state? }`.

```ts
globalThis.aethon.setLayout({
  components: [{ id: "root", type: "card", props: { title: "Hello" } }],
});
```

### `patchLayout(pointer, value)`

Patch a node inside the active layout (array-preserving JSON Pointer).

```ts
// Move sidebar from left to right (uses canonical slot names — see
// docs/aethon-agent/components.md "Layout-slot contract")
globalThis.aethon.patchLayout("/components/0/props/columns", "1fr 240px");
globalThis.aethon.patchLayout("/components/0/props/areas", [
  "header sidebar",
  "tabs sidebar",
  "canvas sidebar",
  "terminal sidebar",
  "composer sidebar",
  "status status",
]);
```

### `registerComponent(type, template)`

Define a new A2UI component type. The template is a single A2UI component
node (`{ id, type, props?, children? }`) that the renderer expands wherever
`{type:"<type>"}` appears.

```ts
globalThis.aethon.registerComponent("model-chip", {
  id: "chip",
  type: "container",
  props: { direction: "row", gap: 6, padding: 6, className: "chip" },
  children: [
    { id: "chip-label", type: "text",
      props: { content: "Model:", variant: "small" } },
    { id: "chip-value", type: "text",
      props: { content: { "$ref": "/model" }, variant: "small" } },
  ],
});
```

The legacy payload-wrapper shape `{ components: [<single component>] }`
is also accepted (auto-unwrapped) for backward compatibility, but the
bare-component form is preferred.

### `registerSidebarSection({ id, title, items })`

Append a sidebar section. Each item shows as a clickable row.

```ts
globalThis.aethon.registerSidebarSection({
  id: "tools",
  title: "Tools",
  items: [
    { id: "open-readme", label: "Open README" },
    { id: "format-code", label: "Format code" },
  ],
});
```

Wire clicks via `onEvent` (see below).

### `registerSlashCommand({ name, description, usage? })`

Add a slash command to the chat-input picker. `name` must match
`/^[A-Za-z][\w-]*$/` and may not collide with built-ins (`clear`, `help`,
`theme`, `model`, `reset`, `terminal`, `skills`).

```ts
globalThis.aethon.registerSlashCommand({
  name: "tldr",
  description: "Summarize the current conversation in 3 bullets",
  usage: "[topic?]",
});
```

Wire the handler through `aethon.onEvent` with `{componentType: "slash-command",
descendantId: "<name>"}`. The dispatched event carries `data.args` (the text
after the command name):

```ts
globalThis.aethon.onEvent(
  { componentType: "slash-command", descendantId: "tldr" },
  async (event, ctx) => {
    const focus = (event.data as { args?: string } | undefined)?.args ?? "";
    await ctx.pi.prompt(
      focus
        ? `Summarize the conversation focused on ${focus} in 3 bullets.`
        : `Summarize the conversation in 3 bullets.`,
    );
  },
);
```

The picker shows extension commands alongside the built-ins; users get
the same `↑/↓/Tab/Enter` UX. Re-registering with the same `name`
overwrites the previous metadata.

### `registerEventRoute({ componentId?, eventType? })` / `unregisterEventRoute({ componentId?, eventType? })` / `listEventRoutes()` / `setEventRoutingMode(mode)`

Intercept events the App's built-in dispatcher would normally handle
(`chat-input:submit`, `sidebar:select`, `tab-strip:close`, etc.). When
an event matches a registered route the renderer skips the built-in
switch and forwards the event through `a2ui_event` to a paired
`aethon.onEvent({componentType, descendantId})` handler. Wildcards:
omit `componentId` to match any component for that event type; omit
`eventType` to match all events from a component.

For full route-table replacement, call
`globalThis.aethon.setEventRoutingMode("extension")`. In that mode every
layout event bypasses the App switch and is forwarded to the bridge as
`a2ui_event`; call `setEventRoutingMode("builtin")` to restore built-ins.

```ts
// Pre-process every chat submit before the agent sees it.
globalThis.aethon.registerEventRoute({
  componentId: "chat-input",
  eventType: "submit",
});
globalThis.aethon.onEvent(
  { componentType: "chat-input", eventType: "submit" },
  async (event, ctx) => {
    const value = (event.data as { value?: string } | undefined)?.value ?? "";
    const enriched = `[${new Date().toISOString()}] ${value}`;
    await ctx.pi.prompt(enriched);
  },
);
```

`listEventRoutes()` returns the full set of registered intercepts
(extensions only — built-ins are baked into App.tsx and remain the
default for unmatched events).

### `registerLayout({ id, name, description?, payload })` / `unregisterLayout(id)` / `listLayouts()`

Append a named layout to the runtime catalogue so it appears in
`/layout`'s picker, `window.aethon.listLayouts()`, the appearance menu,
and the sidebar Layouts section. Activation goes through
`setLayout(payload)` — registering only adds metadata.

```ts
const focusLayout = {
  components: [/* ... your <layout> tree ... */],
  state: { /* layout's state seeds — merged into live state on activate */ },
};

await globalThis.aethon.registerLayout({
  id: "focus-mode",
  name: "Focus Mode",
  description: "Hide the sidebar and tabs; just a canvas + composer.",
  payload: focusLayout,
});

// Activate it — frontend's window.aethon.activateLayout("focus-mode") works,
// or just push the payload directly:
await globalThis.aethon.setLayout(focusLayout);
```

`id` must match `/^[A-Za-z][\w-]*$/` and cannot collide with the four
built-in layouts (`workstation`, `editorial`, `command-deck`,
`live-layout`). The catalogue replays on `ready` so registrations
survive bridge respawns. `RuntimeSnapshot.layouts` carries the
catalogue (id + name + description, payloads omitted to keep the
snapshot small) so the agent's first-turn context sees it.

### React-component skills (`aethon.frontendEntry`)

A2UI templates cover most extension UI cases, but some components
need real React: charts, virtualized lists, third-party widgets that
already ship as React components, components that need browser APIs
the renderer doesn't expose. A skill package can opt in by adding a
second field next to `aethon.entry`:

```json
{
  "name": "@you/aethon-skill-charts",
  "aethon": {
    "entry": "src/index.ts",
    "frontendEntry": "src/frontend.js"
  }
}
```

The `frontendEntry` is **plain JS, not a module**. The bridge reads
the file as a string and ships it to the webview, where it's wrapped
with:

```ts
new Function("React", "skill", code)(React, skillApi)
```

So write the body as if `React` and `skill` are in scope. `skill` is
a tiny API:

```ts
interface SkillEvalApi {
  registerComponent(
    type: string,
    component: React.ComponentType<BuiltinComponentProps>,
  ): void;
}
```

Registered components receive the same `BuiltinComponentProps` shape
as built-in composites (`component`, `state`, `onEvent`,
`renderChildren`, `renderChildWithState`). Reference them in any A2UI
payload by their declared `type`:

```ts
{ type: "pulse-card", props: { title: "Live", state: "ok" } }
```

The renderer resolves the type through the SkillRegistry just like
any built-in. `examples/skill-package/src/frontend.js` ships a
minimal `pulse-card` demo (CSS-keyframe pulse, hooks via
`React.useEffect`).

**Authoring options.** The simplest path is plain JS — write
`React.createElement(...)` directly. If you want JSX or imports, run
a bundler (esbuild / swc) over a real source file and emit the
bundled output as `frontendEntry`. The result must execute as a
function body — top-level `import` / `export` will fail.

**Lifecycle.** Each `extension_skill_modules` delta is wholesale —
the full set of skills replaces the previous set. Components from a
removed skill are unregistered; components from a re-evaluated skill
replace their prior bindings (so `npm install --prefix
~/.aethon/skills <pkg>` hot-reloads cleanly). Errors per module are
caught and surfaced as a system notice; one broken skill can't kill
the others.

**Trust.** Same model as bridge-side skill code: the user installed
the package, they trust it. `new Function` is essentially eval — no
sandbox. A malicious skill could already do worse from the bridge
side (read disk, fork processes); this channel doesn't widen the
threat model.

`RuntimeSnapshot.skillModules` lists `{ name, entryPath, bytes }`
for each shipped module — code body omitted (read it from
`entryPath` if you need to inspect).

### `registerMenuItem({ label, action, location?, id?, parent? })` / `unregisterMenuItem(id)`

Add an entry to the native macOS menu bar (or system tray) that the
user can click. `location` is `"app"` (App menu — appears under an
"Extensions" submenu) or `"tray"` (status-bar tray menu); defaults to
`"app"`. `id` defaults to `action`.

```ts
globalThis.aethon.registerMenuItem({
  label: "Summarize commits",
  action: "summarize-commits",
  location: "app",
});
globalThis.aethon.onEvent(
  { componentType: "menu-item", descendantId: "summarize-commits" },
  async (_event, ctx) => {
    await ctx.pi.prompt("Summarize the last 5 commits in 3 bullets.");
  },
);
```

The Rust shell rebuilds the native menu on every register / unregister
call, so updates appear immediately. Click events flow through the
same `a2ui_event` route as buttons / sidebar items, so per-tab
attribution and handler dedup work identically.

### `registerKeybinding({ combo, action?, description? })` / `unregisterKeybinding(combo)`

Add an extension-supplied keyboard shortcut. `combo` is a "+"-joined
human-readable token using `Cmd` / `Meta` / `Ctrl` / `Alt` / `Option` /
`Shift` modifiers ("Cmd+Shift+P", "Ctrl+]", "Alt+M") — the frontend
normalizes to a canonical form for matching. `action` is an opaque
string the handler can branch on (defaults to the combo).

Registered keybindings run before built-in shortcuts, so an extension can
intentionally override a default chrome action. Unregistering restores the
built-in behavior. Built-ins without an override are:

| Combo            | Built-in action                       |
| ---------------- | ------------------------------------- |
| `Cmd+P`          | Open command palette (switcher mode)  |
| `Cmd+Shift+P`    | Open command palette (commands mode)  |
| `Cmd+T`          | New tab                               |
| `Cmd+W`          | Close active tab                      |
| `Cmd+]`          | Next tab                              |
| `Cmd+[`          | Previous tab                          |
| `Cmd+\``         | Toggle terminal                       |
| `Cmd+K`          | Clear chat                            |
| `Cmd+.`          | Stop current prompt                   |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | UI zoom controls             |

```ts
globalThis.aethon.registerKeybinding({
  combo: "Cmd+Shift+L",
  action: "summarize-log",
  description: "Summarize the current bash output",
});
globalThis.aethon.onEvent(
  { componentType: "keybinding", descendantId: "meta+shift+l" },
  async (_event, ctx) => {
    await ctx.pi.prompt("Summarize the recent bash output in 3 bullets.");
  },
);
```

The `descendantId` matches the canonical combo (lowercased modifiers in
`meta/ctrl/alt/shift` order, then key). To remove a binding:
`globalThis.aethon.unregisterKeybinding("Cmd+Shift+L")`.

### `registerTheme({ id, label?, vars })`

Register a CSS color scheme. `id` must match `/^[A-Za-z][\w-]*$/` and may
not collide with built-ins (`dark`, `light`). `vars` is a map of CSS
custom properties (each key must start with `--`).

```ts
globalThis.aethon.registerTheme({
  id: "high-contrast",
  label: "High Contrast",
  vars: {
    "--bg": "#000",
    "--text": "#fff",
    "--accent": "#ff0",
    "--border": "#333",
  },
});
```

The theme appears in the sidebar's Themes section automatically.

### `notify({ title, message?, kind?, durationMs?, actions?, id? })` / `dismissNotification(id)`

Push a toast notification onto the App-root notification stack. Toasts
are layout-agnostic and overlay every layout so feedback remains
visible regardless of which chrome the user has active.

| Field         | Type                                                | Default       |
| ------------- | --------------------------------------------------- | ------------- |
| `title`       | string (required)                                   | —             |
| `message`     | string                                              | —             |
| `kind`        | `"info" \| "success" \| "warning" \| "error"`       | `"info"`      |
| `durationMs`  | number, or `null` for sticky                        | `4000`        |
| `actions`     | `{ label: string, action: string }[]`               | `[]`          |
| `id`          | string — pre-assign so you can dismiss later        | auto-uuid     |

```ts
// Transient success toast.
globalThis.aethon.notify({
  title: "Linted clean",
  kind: "success",
});

// Sticky toast with an action — fires `a2ui_event` with
// componentType: "notification", data: { id, action: "undo" } on click.
const id = "extension:tidy-up";
await globalThis.aethon.notify({
  id,
  title: "Tidied 12 files",
  kind: "info",
  durationMs: null,
  actions: [{ label: "Undo", action: "undo" }],
});
globalThis.aethon.onEvent(
  { componentType: "notification", eventType: "invoke" },
  (event) => {
    const data = event.data as { id?: string; action?: string };
    if (data.action === "undo") { /* … */ }
  },
);

// Dismiss programmatically when work completes.
await globalThis.aethon.dismissNotification(id);
```

Use toasts for transient mutation feedback ("Theme set", "Layout
switched", "Update available"). Don't use them for chat content — push
into the conversation via `ctx.pi.notify(...)` if a message belongs in
history.

## Event Handling

### `onEvent(match, handler)`

Route component events to a handler. `match` is a partial filter — any
omitted field matches anything.

```ts
type Match = {
  templateRootType?: string;  // top-level type the renderer expanded
  componentType?: string;     // type of the firing component
  descendantId?: string;      // id portion after `__tpl__` separator
  eventType?: string;         // "click", "submit", "change", …
};
```

Handler signature:

```ts
(event, ctx) => void | Promise<void>
```

`ctx` provides:

- `ctx.setState(path, value)` — same as `globalThis.aethon.setState` but
  scoped to the originating tab (mirrored keys route to that tab).
- `ctx.registerComponent(type, template)` — re-export.
- `ctx.pi.prompt(text)` — fire an LLM turn from the handler. Same chat
  history, same model, same Stop button. Rejects if a prompt is in flight.
- `ctx.pi.notify(message)` — push a system bubble into chat. Non-terminal.
- `ctx.pi.session.model` / `ctx.pi.session.messages` — read-only.
- `ctx.pi.signal` — `AbortSignal` that fires on Stop. Pass to fetch /
  spawn calls so handler work cancels with the rest of the turn.

### Example: sidebar item that runs a turn

```ts
globalThis.aethon.onEvent(
  { componentType: "sidebar-item", descendantId: "open-readme" },
  async (_event, ctx) => {
    await ctx.pi.prompt("Read README.md and summarize the project in 3 bullets.");
  },
);
```

### Example: live-updating UI

```ts
globalThis.aethon.registerComponent("clock", {
  components: [{ id: "clock-text", type: "text",
    props: { content: { "$ref": "/clock/time" } } }],
});
setInterval(() => {
  globalThis.aethon.setState("/clock/time", new Date().toLocaleTimeString());
}, 1000);
```

## Introspection

These return the live state. Use them when the user asks "what's loaded?"
or before mutating something you didn't register yourself.

### `listExtensions()`

```ts
[
  {
    name: "model-picker",
    source: "directory" | "project-directory" | "skill-package" | "pi-extension",
  },
  …
]
```

### `listComponents()`

```ts
{ "model-chip": { components: [...] }, "clock": { components: [...] } }
```

### `listThemes()`

```ts
[{ id: "high-contrast", label: "High Contrast", vars: { "--bg": "#000", … } }, …]
```

### `getLayout()`

Returns the active layout payload (extension-supplied if any, otherwise
the default-layout boot tree).

### `getLayoutSlots()`

Returns the canonical layout-slot catalogue
(`{ version, slots: { <name>: { description, defaultComposite, required } } }`)
or `null` if the bridge couldn't read `slots.json` at boot. Use this to
discover the slot contract any layout that wants to host the standard
composites must honor — see `components.md` "Layout-slot contract" for
the full design.

```ts
const slots = globalThis.aethon.getLayoutSlots();
const required = Object.entries(slots?.slots ?? {})
  .filter(([, def]) => def.required)
  .map(([name]) => name);
// → ["canvas", "composer"]
```

### `getFrontendState(path?)`

Read a frontend-mirrored state slice. With no argument, returns the full
map; with a path returns just that slice (or `undefined`).

```ts
const models = globalThis.aethon.getFrontendState("/sidebar/models");
// → [{id, label, active}, …]

globalThis.aethon.getFrontendState("/connection"); // "connected" | "disconnected"
globalThis.aethon.getFrontendState("/status");     // "ready" | "indexing…" | …
globalThis.aethon.getFrontendState("/tabs");       // [{id, label, model, active}, …]
globalThis.aethon.getFrontendState("/draft");      // active tab's composer text
globalThis.aethon.getFrontendState("/sidebar/themes"); // theme list
globalThis.aethon.getFrontendState("/messagesCount");  // active tab message count
```

The frontend pushes patches into the bridge whenever these slices change,
so the bridge sees the live UI state — not just what extensions have
written via `setState`. Best-effort mirror; small lag (<100 ms) is normal
during state churn.

### `getRuntimeSnapshot()`

One-call summary suitable for chat output:

```ts
{
  release: boolean,
  cwd: string,
  docsDir: string,
  projectRoot?: string,           // dev only
  extensions: [...],
  components: {...},
  themes: [...],
  layoutSummary: string,          // e.g. "default-layout (sidebar=left)"
  layoutStructure: {              // root + children for quick introspection
    rootId, rootType, columns?, rows?, areas?,
    children: [{ id, type, area? }],
  } | null,
  tabs: [{ id, model, messageCount }],
  eventHandlers: [...],           // match shape only (no fn bodies)
  uiState: {                      // frontend-mirrored slices
    "/sidebar/models": [...],
    "/sidebar/themes": [...],
    "/connection": "connected",
    "/status": "ready",
    "/tabs": [...],
    "/draft": "",
    "/messagesCount": 0,
  },
}
```

## What NOT to do

- **Don't restart the agent for UI changes.** Mutating `globalThis.aethon`
  is instant — restarting is destructive and loses pi's queue.
- **Don't write CSS files for theming.** `registerTheme` applies live and
  survives reload.
- **Don't print ASCII tables / boxes for structured data.** A `card` of
  `text` rows renders properly in the GUI.
- **Don't try to edit Aethon source.** In release builds the source isn't
  there. In dev, prefer extensions over source edits unless the user
  explicitly asks you to modify Aethon itself.
