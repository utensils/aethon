# Skills & extensions

Aethon's UI, themes, slash commands, layouts, and event interceptors
are all **registerable**. Anything you'd think of as "the chrome" can
be replaced or augmented by an extension. This page is the user-facing
overview; for the full authoring guide see the bundled
[`docs/aethon-agent/extensions.md`][ext-docs] reference (also available
inside the running app at `Cmd+P` → "Open agent docs").

[ext-docs]: https://github.com/utensils/aethon/blob/main/docs/aethon-agent/extensions.md

## What an extension can register

| Surface | API | Example |
|---|---|---|
| A2UI components | `aethon.registerComponent("type", template)` | Replace `chat-history`, add `team-status`. |
| Themes | `aethon.registerTheme({ id, vars })` | Drop-in palette. |
| Layouts | `aethon.registerLayout({ id, name, payload })` | Sibling to `workstation` / `editorial`. |
| Slash commands | `aethon.registerSlashCommand(cmd)` | `/team-deploy`, `/standup`. |
| Keybindings | `aethon.registerKeybinding(combo, handler)` | Override or add. |
| Menu items | `aethon.registerMenuItem(item)` | Native menu entries. |
| Event handlers | `aethon.onEvent("a2ui-event", fn)` | Intercept events before default handling. |
| Sidebar sections | `aethon.registerSidebarSection(section)` | Custom sidebar group. |

Full signatures live in [Runtime API reference](/reference/runtime-api).

## Three install paths

### 1 — User-level extensions

Drop a `.ts` file into `~/.aethon/extensions/`:

```
~/.aethon/
└── extensions/
    └── my-helper.ts
```

Aethon's bridge **hot-reloads** it: edit the file, save, and the
extension re-runs without a relaunch. The chat shows an
`extension_lifecycle` event for every load / fail / reload so you get
visible feedback.

### 2 — npm-distributed skills

Some extensions ship as npm packages with an `aethon` field in their
`package.json` manifest:

```json
{
  "name": "@my-org/aethon-team-skills",
  "aethon": {
    "entry": "dist/index.js"
  }
}
```

Install them under `~/.aethon/skills/`:

```bash
npm install --prefix ~/.aethon/skills @my-org/aethon-team-skills
```

Aethon discovers everything under `~/.aethon/skills/node_modules/` whose
`package.json` has the `aethon` field, and loads its declared entry.

### 3 — Project-local extensions

Drop a `.aethon/extensions/` directory anywhere up to your project's git
root:

```
my-repo/
├── .git/
├── .aethon/
│   └── extensions/
│       └── team-slash-commands.ts
└── src/
```

Tabs opened in `my-repo/` (at any depth) load these automatically.
Project-local extensions are great for team-wide slash commands or
internal tooling that shouldn't pollute the user's global setup.

::: tip
Discovery is a *walk* — Aethon starts at the active tab's cwd and walks
**up** to its git root. Extensions found anywhere on the way are loaded.
:::

## Listing what's loaded

The `/skills` slash command lists every loaded extension with:

- Source (`user`, `project`, `npm`).
- Registered components, themes, slash commands, keybindings, layouts.
- Last reload timestamp.
- Any error.

The same data is available inside the agent via
`aethon.listExtensions()`, `aethon.listComponents()`,
`aethon.listThemes()`, and the **runtime snapshot**
(`aethon.getRuntimeSnapshot()`). Aethon also writes the snapshot to
`~/.aethon/state.json` on every change — `cat` it for a quick view
without an introspection round-trip.

## Lifecycle and feedback

Every extension load surfaces an `extension_lifecycle` chat event so
you can see at a glance when something loaded, reloaded, or failed.
Layouts can intercept this event to substitute a toast, sidebar pulse,
or status pill.

A failing extension does **not** crash Aethon — the error is logged,
the chat-side event reports the failure, and other extensions continue
loading.

## Authoring an extension

For a worked example, see the bundled
[`docs/aethon-agent/extensions.md`][ext-docs] (inside the running app
under "Reference" or in the GitHub repo).

The minimum is:

```ts
// ~/.aethon/extensions/hello.ts
export default function (aethon: globalThis.Aethon) {
  aethon.registerSlashCommand({
    command: "hello",
    description: "Say hi.",
    handler: () => "Hello from Aethon!",
  });
}
```

Save → wait for the `extension_lifecycle` event → run `/hello`.

## Where to next

- [Layouts](/guide/layouts) — registering layouts and the slot contract.
- [Themes](/guide/themes) — registering palettes.
- [Runtime API](/reference/runtime-api) — full `aethon.*` surface.
