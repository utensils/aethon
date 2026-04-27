# globalThis.aethon — Runtime API

`globalThis.aethon` is the bridge between the agent process and the live
React UI. Every method takes effect immediately and survives a webview
reload (state, components, themes, and layout are replayed on `ready`).

`globalThis.aethon` exists in **every** Aethon build (dev and release).
Guard with `if (globalThis.aethon)` only in code that may also run inside
the standalone pi CLI.

## Mutation

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
  tabs: [{ id, model, messageCount }],
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
