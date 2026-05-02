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

Input-like primitives (`text-input`, `date-picker`, `checkbox`, `select`,
`slider`) have bidirectional binding: when `value` is a `$ref` and the user
changes the control, the renderer optimistically writes the new value back to
the same path. This is how `chat-input` keeps `/draft` in sync without a
round-trip.

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

### `icon`

```ts
{
  name?: StringValue,       // built-in glyph name: check, warning, search, terminal, ...
  symbol?: StringValue,     // explicit glyph override
  label?: StringValue,      // accessible label when not decorative
  size?: NumberValue,       // px, default 16
  color?: StringValue,      // CSS color, default currentColor
  decorative?: BooleanValue // default true when label/name is empty
}
```

The built-in icon primitive is dependency-free and renders a stable glyph
map. Register a richer extension component if you need a full icon pack.

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

### `heading`

```ts
{ content: StringValue, level?: 1 | 2 | 3 | 4 | 5 | 6 }
```

`level` defaults to 2.

### `paragraph`

```ts
{ content: StringValue }
```

### `divider`

```ts
{ orientation?: "horizontal" | "vertical" }
```

### `checkbox`

```ts
{ value?: BooleanValue, label?: StringValue, disabled?: BooleanValue }
```

Fires `change` with `{ value: boolean }`.

### `select`

```ts
{
  value?: StringValue,
  options: { value: string, label? }[] | { $ref: string },
  disabled?: BooleanValue,
  placeholder?: StringValue,
}
```

Fires `change` with `{ value: string }`.

### `slider`

```ts
{
  value?: NumberValue,
  min?: NumberValue,    // default 0
  max?: NumberValue,    // default 100
  step?: NumberValue,   // default 1
  disabled?: BooleanValue,
  showValue?: BooleanValue,
}
```

Fires `change` with `{ value: number }`.

### `date-picker`

```ts
{
  value?: StringValue,       // "YYYY-MM-DD"
  min?: StringValue,
  max?: StringValue,
  placeholder?: StringValue,
  disabled?: BooleanValue,
  required?: BooleanValue,
  name?: StringValue,        // included in parent form submit values
}
```

Fires `change` with `{ value: string }`.

### `list`

```ts
{
  items: { $ref: string } | unknown[],
  ordered?: BooleanValue,
}
```

Renders an array as `<ul>` (or `<ol>` when `ordered` is truthy). The
component's `children` are templates expanded per item with the same
`/$item` / `/$index` / `/$parent` scope keys as `for-each`.

```json
{ "type": "list", "props": { "items": { "$ref": "/files" } },
  "children": [
    { "id": "row", "type": "container", "props": { "direction": "row", "gap": 6 },
      "children": [
        { "id": "name", "type": "text",
          "props": { "content": { "$ref": "/$item/name" } } },
        { "id": "size", "type": "text",
          "props": { "content": { "$ref": "/$item/size" }, "variant": "small" } }
      ] }
  ] }
```

### `table`

```ts
{
  rows: { $ref: string } | unknown[],
  columns: {
    header?: string,
    field?: string,         // key into the row object
    width?: string,         // CSS width
    cell?: ComponentTree,   // optional template — sees /$row in scope
  }[],
}
```

Without `cell`, each cell prints `row[field]` as plain text. With `cell`,
the column's template renders inside the cell with these scope keys
available to nested `$ref`s:

- `/$row` — the whole row object
- `/$index` — row position (0-based)
- `/$parent` — surrounding state (the same shape `$ref` resolution would
  use outside the table)
- `/$column` — column metadata (`field`, `header`, `width`)
- `/$cell` — the resolved value at `row[field]` (undefined when `field`
  is absent), so a cell template can read the column's value without
  re-deriving it from `/$row`

Example — render a status badge whose color depends on the cell value:

```ts
{
  type: "table",
  props: {
    rows: { $ref: "/projects" },
    columns: [
      { header: "Project", field: "label" },
      {
        header: "Status",
        field: "status",
        cell: {
          type: "card",
          props: {
            tone: { $ref: "/$cell" },         // "success" | "warning" | …
            title: { $ref: "/$column/header" } // "Status"
          },
          children: [
            { type: "text", props: { value: { $ref: "/$cell" } } }
          ]
        }
      }
    ]
  }
}
```

### `form-field`

```ts
{
  label?: StringValue,
  description?: StringValue,
  error?: StringValue,
  required?: BooleanValue,
}
```

Wraps child controls with a label, help text, and error text. Use it inside
`form` or regular containers.

### `form`

```ts
{
  submitLabel?: StringValue,        // optional built-in submit button
  disabled?: BooleanValue,
  gap?: NumberValue,                // default 10
  direction?: "row" | "column",     // default column
}
```

Renders children inside a native form and fires `submit` with
`{ values: Record<string, unknown> }`. Child controls with a `name` prop are
serialized through native `FormData`; unchecked named checkboxes are included
as `false`.

### `text-input`

```ts
{
  value?: string | { "$ref": string },
  placeholder?: string,
  disabled?: boolean,
  name?: string,
  required?: boolean,
  autocomplete?: string,
  onChange?: string,
  onSubmit?: string,
}
```

Fires `change` per keystroke. When `onSubmit` is present, Enter also fires
`submit` with `{ value }`. When `value` is a `$ref`, the renderer
optimistically writes incoming `change` events back to that path before
forwarding to the handler.

## Skill-Provided Composites (`default-layout`)

These can be overridden by extensions. The current implementations live
in `src/skills/default-layout/components.tsx` (read with `read` if you
need exact prop shapes; bundled docs are reference, not source).

### `layout`

```ts
{
  columns: string,
  rows: string,
  areas: string[],
  // Optional remap from semantic slot name → CSS grid-area name.
  // Lets a layout that uses non-canonical area names still host the
  // standard composites. See "Layout-slot contract" below.
  slotMap?: Record<string, string>,
}
```

CSS Grid. `areas` is the same as `grid-template-areas` (one string per
row, names separated by spaces). Children should set `area: "<name>"`.

#### Layout-slot contract

Composites declare placement via their `area` prop. The Layout component
treats that string as a **slot name**: by default the slot name IS the
CSS grid area, but a layout's optional `slotMap` lets a non-canonical
layout host the standard composites under a different area.

The canonical slot catalogue ships at `skills/default-layout/slots.json`
and is also surfaced by `globalThis.aethon.getLayoutSlots()` and
`window.aethon.layoutSlots` (browser side):

| Slot          | Required | Default composite | Purpose                                                                |
| ------------- | -------- | ----------------- | ---------------------------------------------------------------------- |
| `header`      | no       | `container`       | Top chrome — brand mark, status, navigation                            |
| `sidebar`     | no       | `sidebar`         | Left navigation panel; toggleable via `/sidebar`                       |
| `tabs`        | no       | `tab-strip`       | Horizontal tab strip                                                   |
| `canvas`      | **yes**  | `main-canvas`     | Main content area — chat history, agent A2UI, tool cards               |
| `terminal`    | no       | `terminal`        | Optional terminal panel; toggleable via `/terminal`                    |
| `composer`    | **yes**  | `chat-input`      | User input area                                                        |
| `status`      | no       | `status-bar`      | Bottom status bar                                                      |
| `empty-state` | no       | `empty-state`     | Welcome screen when no tabs are open; conventionally shares `canvas`   |

**Authoring an alternative layout.** Two paths:

1. **Match the contract** — name your grid areas after the canonical
   slots. The standard composites slot in unchanged.
2. **Use `slotMap`** — keep your custom area names; declare the remap
   on the root `<layout>`:

   ```json
   {
     "type": "layout",
     "props": {
       "columns": "1fr",
       "rows": "1fr auto auto",
       "areas": ["main", "footer", "footer-info"],
       "slotMap": {
         "canvas": "main",
         "composer": "footer",
         "status": "footer-info"
       }
     },
     "children": [
       { "id": "canvas", "type": "main-canvas",
         "props": { "area": "canvas", "slot": "/canvas",
                    "messages": { "$ref": "/messages" } } },
       { "id": "input", "type": "chat-input",
         "props": { "area": "composer", "value": { "$ref": "/draft" },
                    "disabled": { "$ref": "/waiting" },
                    "onSubmit": "chat:send" } },
       { "id": "status-bar", "type": "status-bar",
         "props": { "area": "status",
                    "left": { "$ref": "/status" } } }
     ]
   }
   ```

   The composites still ship `area: "<canonical-slot>"`; the layout
   forwards them to its custom CSS area names via `slotMap`.

Slots marked **required** must be filled for the layout to be considered
a complete workspace. `inspectLayoutSlotCoverage(payload)` (exposed on
`window.aethon`) reports which slots are filled/missing/unknown.

### `sidebar` — compositional items

Each item in a `sections[].items` array can opt out of the default
"label-only" rendering by setting `componentType`:

```ts
{
  id: "model-row-1",
  label: "claude-sonnet-4-6",
  componentType: "my-model-row",  // skill-registered template
  // any extra fields are surfaced under /$item alongside id/label
  active: true,
  badge: "fast",
  context: "200K",
}
```

The sidebar resolves `componentType` through the SkillRegistry and
renders the registered template per item with `/$item` (the full item
object), `/$index` (position), and `/$parent` (sidebar's surrounding
state) available to nested `$ref`s — same scope keys as the `for-each`
primitive.

```ts
globalThis.aethon.registerComponent("my-model-row", {
  id: "row", type: "container",
  props: { direction: "row", align: "center", gap: 8, padding: 8 },
  children: [
    { id: "label", type: "text",
      props: { content: { "$ref": "/$item/label" } } },
    { id: "badge", type: "text",
      props: { content: { "$ref": "/$item/badge" }, variant: "small" } },
  ],
});
```

The row's `<li>` still emits `select` with `{sectionId, itemId}` on click
and the existing `descendantId` matcher (`{componentType:"sidebar",
descendantId:"<itemId>"}`) still fires. The custom template controls
visual layout only.

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
{
  value?: StringValue,            // typically { "$ref": "/draft" }
  placeholder?: StringValue,
  disabled?: BooleanValue,        // controls Send ↔ Stop swap
  queueCount?: NumberValue,
  commands?: SlashCommandHint[] | { $ref: string },
  sendLabel?: StringValue,        // default: "Send"
  stopLabel?: StringValue,        // default: "Stop"
  stopTitle?: StringValue,        // default: "Stop the current prompt"
  queueBadgeFormat?: StringValue, // default: "+{n}" — `{n}` = queueCount
}
```

Fires `submit` with the drafted text. Frontend short-circuits to
`send_message` so the agent receives the chat directly. Override the
button labels / queue badge to match a different brand voice without
re-implementing the composer.

### `status-bar`

```ts
{ status: string, connection: "connected" | "disconnected" | "reconnecting" }
```

Use `globalThis.aethon.setState("/status", "...")` to update.

### `terminal`

```ts
{
  open: boolean,
  area?: string,
  readOnly?: boolean,
  fontSize?: NumberValue,
  cols?: NumberValue,
  rows?: NumberValue,
  output?: StringValue,           // bind a $ref to drive xterm directly
  subscribeToBash?: BooleanValue, // opt in to the agent's bash stream
  headerLabel?: StringValue,      // default: "Aethon Terminal"
  bootGreeting?: StringValue,     // default: "Aethon Terminal\r\n$ "
}
```

Streams pi's bash output per tab. The bridge emits the command echo when
the bash tool starts, then diffs pi's rolling `tool_execution_update`
snapshots so stdout/stderr appear while the command is still running
without replaying duplicate text on completion. The buffer is per-tab;
switching tabs replays the active tab's last 256 KiB. Override
`headerLabel` / `bootGreeting` to brand the panel without forking the
composite.

The bash stream lands in three places, so an extension can subscribe
without monkey-patching the composite:

1. **`/terminal/buffer/<tabId>`** state path — A2UI components can
   `$ref` it directly (e.g. `{ "$ref": "/terminal/buffer/default" }`).
   Capped at 256 KiB per tab.
2. **`aethon:terminal-tap`** window event — fires for every chunk
   regardless of active tab. `detail = {tabId, content}`. Multiple
   listeners attach freely.
3. **`aethon:terminal`** window event — fires only for the active tab.
   The default xterm composite consumes this; alternative renderers
   should prefer the tap event.

### `terminal-panel`

The bottom-of-canvas terminal panel. Hosts a sub-tab strip with the
read-only **Agent bash** view always pinned first, plus zero or more
interactive shell sub-tabs. Replaces the standalone `terminal` composite
in the workstation layout (M6 restructure).

```ts
{
  area: "terminal",
  visible?: BooleanValue,        // bound to /terminal/open
  fontSize?: NumberValue,        // forwarded to xterm
}
```

Active sub-tab is tracked at `/terminalPanel/activeSubId` (defaults to
`"agent-bash"`). Skills can drive sub-tab selection via setState; the
default user wiring is the `Cmd+\`` toggle, the `+` button to spawn a
new shell sub-tab, and `Cmd+1..9` to jump between sub-tabs when focus
is in the panel.

### `shell-canvas`

Interactive PTY-backed terminal for a single shell tab. Mounted as the
bottom-panel body when a non-`agent-bash` sub-tab is active. Status line
under the xterm shows `cwd · command · share-mode badge · cols×rows`.
Clicking the share-mode badge cycles through the four modes (`private`
→ `read` → `read-write` → `read-write-trusted`).

The xterm theme reads from CSS custom properties — `--terminal-bg`,
`--terminal-fg`, `--terminal-cursor`, `--terminal-selection`, plus the
16 `--ansi-*` keys. Built-in themes (`ember`, `paper`, `aether`) ship
all 20; extension themes can opt in by setting them in the theme's
`vars` block, otherwise xterm falls back to a sensible dark default.

OSC 0/1/2 title-set sequences in the PTY's stdout (`\x1b]0;<title>\x07`
and the like) update the sub-tab label live so users see
`vim · README.md` / `user@host` / `htop` instead of `Shell N`.

### `tool-card`

Tool-execution surface with a live elapsed-time clock. Replaces the
plain `card` for `bash` / `read` / `write` / etc. Color shifts with
state: idle is dim, running is accent, ≥30 s is amber (long-running
warning), error is danger red. Total duration is formatted as
`Xs` for sub-minute, `Xm SSs` beyond.

### `settings-panel`

`Cmd+,` opens this overlay. Form-based editor for the most-used
`~/.aethon/config.toml` keys. Sections: Appearance, Notifications,
Agent (default model + system-prompt override path), Shell (default
share mode, auto-restart, command/args, inherit_env), Behavior
(prompt-before-close, Cmd+T action, ANSI palette preview), Updater
(channel — placeholder for M7), Advanced (open `config.toml` directly).

Save round-trips through `toml_edit` so leading comments + unknown keys
stay intact.

### `search-panel`

`Cmd+Shift+F` opens this overlay. Cross-session search across every
`~/.aethon/sessions/<tabId>/*.jsonl` file. Project-scope toggle limits
to the active project; results show the project label (when known) and
the matched substring is highlighted in the snippet via a `<mark>`
wrapper. Click a result → restore the originating tab, scroll to the
matching message, briefly flash it.

### `share-mode-badge`

Renders inline inside the shell-canvas status line. Color-coded by
mode:

| Mode | Badge | Tooltip |
|---|---|---|
| `private` | gray | "Agent can't see this shell" |
| `read` | accent | "Agent can read scrollback" |
| `read-write` | warn | "Agent can read + write (each write needs Allow)" |
| `read-write-trusted` | error | "Agent can drive this shell without prompting" |

Clicking the badge cycles to the next mode. The cycle helper lives in
`src/utils/shareMode.ts` and is shared between the badge, the palette,
and the settings panel.

**Override surface** — the badge is a registered component so a skill
can replace it via `aethon.registerComponent("share-mode-badge", …)`.
The host adapter routes events with name `cycle-share-mode` to the
shell-canvas cycle handler; data carries `{tabId}` (auto-injected by
the adapter when omitted from a custom template).

For declarative template overrides, use the `event` prop on the
`button` primitive to emit `cycle-share-mode` directly — the click
maps to the cycle without any host-side heuristics:

```ts
globalThis.aethon.registerComponent("share-mode-badge", {
  id: "ext-badge",
  type: "button",
  props: {
    label: { $ref: "/$props/shareMode" },
    event: "cycle-share-mode",
  },
});
```

`$props` exposes the host's live data (`shareMode`, `tabId`) inside
the template's scoped state. Multi-control templates name their
cycle button with `event: "cycle-share-mode"` and leave the others
emitting plain `click` so they reach the bridge as ordinary
events for extension handlers to observe.

### `main-canvas`

```ts
{
  area?: string,
  slot?: string,                    // pointer to live A2UI subtree
  messages?: { $ref: string },      // chat history binding
  emptyHint?: StringValue,          // shown when no messages + no live subtree
  components?: ComponentTree[],
}
```

The default chat canvas. Most extensions don't need to touch this — to
add ad-hoc UI, return a per-message A2UI payload from the agent or set
state on a bound `$ref`. Override `emptyHint` to show a different
welcome line when the canvas is empty.

For progressive UI, seed the canvas slot with an A2UI payload and patch
nested paths as work completes:

```ts
api.setState("/canvas", {
  components: [{ id: "progress", type: "card", props: { title: "Starting" } }],
});
api.setState("/canvas/components/0/props/title", "Indexing files");
```

State patches preserve arrays, so paths through `components`, `children`,
table rows, and list items keep the subtree renderable.

### `empty-state`

```ts
{
  area?: string,
  title?: StringValue,             // default: "Welcome to Aethon"
  subtitle?: StringValue,          // default: "All tabs are closed. …"
  primaryButtonLabel?: StringValue, // default: "New Tab"
  tips?: StringValue[],
  recentSessions?: { id, label, lastModified?, cwd? }[],
}
```

Shown when the tab list is empty. Visibility is wired via the layout
state flags `/empty` (true → show empty-state) and `/hasTabs` (false →
hide canvas/composer/tab-strip). The default layout already binds them
both. Emits `new-tab` on the primary button click and
`restore-session` on a recent-session row click (descendantId =
session id; data includes `{sessionId, label, cwd?}` so restore keeps
the session scoped to its original project). Replace it by
re-registering the `empty-state` component type from an extension if
you want a different welcome surface.

### `command-palette` and `notification-stack`

Both render at App root, **not** inside layout JSON. The default
implementations are state-driven — `/palette` carries
`{open, mode, query, selectedIndex}`, `/notifications` is the toast
list. Extensions can:

- Drive them programmatically (e.g. `aethon.setState("/palette/open", true)`,
  or call `aethon.notify(...)` to push a toast).
- Replace the visuals by re-registering `command-palette` /
  `notification-stack` via `aethon.registerComponent`. App.tsx renders
  the registered builtin, so the override picks up automatically.

Items shown in the palette are derived from existing state — tabs,
`/recentSessions`, `/sidebar/projects`, `/slashCommands`, the
extension keybinding map, `/layoutCatalogue`, `/sidebar/themes`,
`/sidebar/models`. Register a slash command (`registerSlashCommand`)
or a keybinding (`registerKeybinding`) and it appears in the palette
automatically. Mode prefixes inside the palette: `>` forces commands,
`@` tabs, `?` keybindings.

## Layout Payload Shape

The whole UI is one tree. The default layout (boot payload) lives at
`src/skills/default-layout/layout.a2ui.json`. Its top-level grid uses
the canonical slot names defined in `slots.json`:

```
columns: "240px 1fr"   // sidebar | content
rows:    "auto auto 1fr auto auto auto"
areas:
  "sidebar header"
  "sidebar tabs"
  "sidebar canvas"
  "sidebar terminal"
  "sidebar composer"
  "status status"
```

Common patches:

| Goal | Patch |
|------|-------|
| Move sidebar right | `/components/0/props/columns` → `"1fr 240px"` and rewrite each area row to put `sidebar` second |
| Hide sidebar | `/components/0/props/columns` → `"1fr"`, drop `sidebar` from each area row |
| Add a row above the composer | extend `rows` and `areas`, add a new `container` child with `area: "your-area-name"` |

For deeper rewrites use `setLayout` with a fresh payload and copy what
you need from `getLayout()`.

## Window-event channels

The frontend exposes a small set of `window.addEventListener` channels
extensions can hook for UI-level concerns:

| Event | Detail | Fires when |
|-------|--------|-----------|
| `aethon:terminal` | `string` (raw text chunk) | Active tab gets new bash output |
| `aethon:terminal-tap` | `{ tabId: string, content: string }` | Any tab gets bash output (multi-subscriber) |
| `aethon:terminal-replay` | `string` (full buffer) | Tab switch — terminal needs to repaint |
| `aethon:extension-lifecycle` | `{ name, source, status: "loaded"\|"failed"\|"skipped", error?, path }` | Extension loads, fails, or gets skipped |

The `extension-lifecycle` event is **cancelable** — call
`event.preventDefault()` from your listener to suppress the default
chat-side system-notice rendering. Use this to substitute a toast,
sidebar pulse, status pill, or any other layout-specific feedback.

```ts
window.addEventListener("aethon:extension-lifecycle", (e) => {
  const { name, status, error } = e.detail;
  showToast(`${name} ${status}${error ? `: ${error}` : ""}`);
  e.preventDefault(); // skip the default chat bubble
});
```
