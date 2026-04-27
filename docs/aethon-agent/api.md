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
```

Routing rules: writes to the mirrored keys (`/messages`, `/draft`,
`/waiting`, `/queueCount`, `/canvas`, `/model`) are attributed to the
**currently active tab** (or the tab whose turn is in flight). Other paths
are global. Don't try to write to a specific tab — the bridge handles
attribution via the AsyncLocalStorage in pi's call chain.

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
// Move sidebar from left to right
globalThis.aethon.patchLayout("/components/0/props/columns", "1fr 240px");
globalThis.aethon.patchLayout("/components/0/props/areas", [
  "header sidebar",
  "tabs sidebar",
  "canvas sidebar",
  "terminal sidebar",
  "chat-input sidebar",
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

### `registerEventRoute({ componentId?, eventType? })` / `unregisterEventRoute({ componentId?, eventType? })` / `listEventRoutes()`

Intercept events the App's built-in dispatcher would normally handle
(`chat-input:submit`, `sidebar:select`, `tab-strip:close`, etc.). When
an event matches a registered route the renderer skips the built-in
switch and forwards the event through `a2ui_event` to a paired
`aethon.onEvent({componentType, descendantId})` handler. Wildcards:
omit `componentId` to match any component for that event type; omit
`eventType` to match all events from a component.

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

Built-ins (`Cmd+T` / `Cmd+]` / `Cmd+[` / `Cmd+W` / `Cmd+\``) win on a
collision — extensions can ADD shortcuts but cannot override built-ins
(yet).

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
[{ name: "model-picker", source: "directory" | "skill-package" }, …]
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
