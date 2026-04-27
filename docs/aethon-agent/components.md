# A2UI Components

The A2UI renderer accepts two kinds of component types: **primitives**
(hardcoded in the React renderer, always available) and **composites**
(provided by skills, overridable, currently from `default-layout`).

Every component looks like:

```json
{
  "id": "<unique-id>",
  "type": "<componentType>",
  "props": { ... },
  "children": [ ... ]
}
```

`children` is optional. `id` MUST be unique within the tree.

## Data Binding via `$ref`

Anywhere a prop accepts a value, you can substitute a JSON-Pointer
reference and the renderer reads it from the layout state object.

```json
{ "type": "text", "props": { "content": { "$ref": "/status" } } }
```

The path is RFC 6901 (`/foo/bar/0`). On the source side, write with
`globalThis.aethon.setState("/status", "ready")`.

`text-input` has special bidirectional binding: when its `value` is a
`$ref` and the user types, the renderer optimistically writes the new
value back to the same path. This is how `chat-input` keeps `/draft` in
sync without a round-trip.

## Primitives

These work in every Aethon build and cannot be overridden by extensions.

### `text`

```ts
{ content: string, variant?: "body" | "small" | "large", color?: string }
```

`color` accepts CSS colors including `var(--accent)` etc.

### `card`

```ts
{ title?: string, description?: string, padding?: number }
```

Children render below the description. Use cards for tool output, error
panels, "result of X" summaries.

### `button`

```ts
{ label: string, variant?: "primary" | "secondary" | "ghost", disabled?: boolean }
```

Fires `click` event. No built-in `onClick` prop — register an event
handler via `globalThis.aethon.onEvent({ componentType: "button" }, …)`
or via the broader `descendantId` match.

### `container`

```ts
{
  direction: "row" | "column",
  gap?: number,
  padding?: number,
  align?: "start" | "center" | "end" | "stretch",
  justify?: "start" | "center" | "end" | "space-between" | "space-around",
  area?: string,        // when inside a layout grid
  className?: string,   // for custom CSS hooks
}
```

The grid-area prop only matters inside a `layout` parent.

### `code`

```ts
{ content: string, language?: string, showLineNumbers?: boolean }
```

Use for tool results, file dumps, command output. Don't use for inline
formatting in body text — use Markdown in `text` content instead.

### `image`

```ts
{ src: string, alt?: string, caption?: string, className?: string }
```

`src` accepts `data:` URLs (used for tool result images), file:// URLs in
dev, and http(s) URLs. Tool images cap at 4 per result.

### `for-each`

```ts
{
  items: ArrayValue,           // bound via {$ref: "/path"} (or inline)
  key?: string,                // optional item field used as React key
}
```

Iterates `items` and renders each child once per element. Inside the
expansion, three special state keys are available to nested `$ref`s:

- `/$item` — the current array element
- `/$index` — the 0-based position
- `/$parent` — the surrounding state (still reachable for outside refs)

```json
{
  "type": "for-each",
  "props": {
    "items": { "$ref": "/results" },
    "key": "id"
  },
  "children": [
    { "id": "row", "type": "container",
      "children": [
        { "id": "label", "type": "text",
          "props": { "content": { "$ref": "/$item/label" } } }
      ] }
  ]
}
```

Each iteration's child ids get suffixed with `__$idx<n>` so React keys
stay stable across N expansions. Re-renders automatically when the
bound array mutates.

### `text-input`

```ts
{
  value?: string | { "$ref": string },
  placeholder?: string,
  disabled?: boolean,
  multiline?: boolean,
  rows?: number,
  submitOnEnter?: boolean,
}
```

Fires `change` (per keystroke) and `submit` (Enter without shift, or
explicit submit). When `value` is a `$ref`, the renderer optimistically
writes incoming `change` events back to that path before forwarding to
the handler.

## Skill-Provided Composites (`default-layout`)

These can be overridden by extensions. The current implementations live
in `src/skills/default-layout/components.tsx` (read with `read` if you
need exact prop shapes; bundled docs are reference, not source).

### `layout`

```ts
{ columns: string, rows: string, areas: string[] }
```

CSS Grid. `areas` is the same as `grid-template-areas` (one string per
row, names separated by spaces). Children should set `area: "<name>"`.

### `sidebar`

```ts
{
  area?: string,                        // grid-area
  title?: string,
  items?: { id, label, kind?, active?, swatch? }[],
  themes?: { id, label, active? }[],
  models?: { id, label, available, current? }[],
  extraSections?: { id, title, items: [...] }[],
}
```

Items fire `click` events with `descendantId === item.id`. Themes /
models fire similarly with `descendantId === id`.

### `tab-strip`

```ts
{ tabs: { id, title, model? }[], activeId: string }
```

Fires `select` on tab click, `close` on close button, `new` on the +
button. The frontend handles default behavior; an extension can short-
circuit by registering an event handler on the matching `tabId`.

### `chat-history`

```ts
{ messages: { role: "user" | "agent" | "system", text?, a2ui?, id? }[] }
```

Each message renders as a bubble; tool cards (`message.a2ui`) render
inline as cards. The renderer threads `tabId` through to nested A2UI so
button clicks inside tool cards stay scoped to the right tab.

### `chat-input`

```ts
{ value?: { "$ref": "/draft" }, placeholder?, disabled?, queueCount? }
```

Fires `submit` with the drafted text. Frontend short-circuits to
`send_message` so the agent receives the chat directly.

### `status-bar`

```ts
{ status: string, connection: "connected" | "disconnected" | "reconnecting" }
```

Use `globalThis.aethon.setState("/status", "...")` to update.

### `terminal`

```ts
{ open: boolean, area?: string, readOnly?: boolean }
```

Streams pi's bash output per tab. The buffer is per-tab; switching tabs
replays the active tab's last 256 KiB.

### `main-canvas`

```ts
{ area?: string, components?: ComponentTree[] }
```

The default chat canvas. Most extensions don't need to touch this — to
add ad-hoc UI, return a per-message A2UI payload from the agent or set
state on a bound `$ref`.

### `empty-state`

```ts
{
  area?: string,
  title?: StringValue,             // default: "Welcome to Aethon"
  subtitle?: StringValue,          // default: "All tabs are closed. …"
  primaryButtonLabel?: StringValue, // default: "New Tab"
  tips?: StringValue[],
  recentSessions?: { id, label, lastModified? }[],
}
```

Shown when the tab list is empty. Visibility is wired via the layout
state flags `/empty` (true → show empty-state) and `/hasTabs` (false →
hide canvas/composer/tab-strip). The default layout already binds them
both. Emits `new-tab` on the primary button click and
`restore-session` on a recent-session row click (descendantId =
session id). Replace it by re-registering the `empty-state` component
type from an extension if you want a different welcome surface.

## Layout Payload Shape

The whole UI is one tree. The default layout (boot payload) lives at
`src/skills/default-layout/layout.a2ui.json`. Its top-level grid is:

```
columns: "240px 1fr"   // sidebar | content
rows:    "auto auto 1fr auto auto auto"
areas:
  "sidebar header"
  "sidebar tabs"
  "sidebar canvas"
  "sidebar terminal"
  "sidebar chat-input"
  "status status"
```

Common patches:

| Goal | Patch |
|------|-------|
| Move sidebar right | `/components/0/props/columns` → `"1fr 240px"` and rewrite each area row to put `sidebar` second |
| Hide sidebar | `/components/0/props/columns` → `"1fr"`, drop `sidebar` from each area row |
| Add a row above chat-input | extend `rows` and `areas`, add a new `container` child |

For deeper rewrites use `setLayout` with a fresh payload and copy what
you need from `getLayout()`.
