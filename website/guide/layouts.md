# Layouts

A **layout** in Aethon is not a piece of React code — it's an **A2UI
JSON payload** that the renderer turns into the UI you see. The default
layout is itself an extension (`src/extensions/default-layout/`), and switching
layouts is a runtime payload swap.

This is the central insight: **the chrome is data**.

## The built-in layout

Aethon currently ships one layout while polish focuses on a single
surface:

| Layout | `id` | Vibe |
| --- | --- | --- |
| **Workstation** | `workstation` | The default — chat-first, sidebar + canvas + composer + terminal panel. |

Earlier sibling variations (`command-deck`, `editorial`, `live-layout`)
were trimmed to keep the polish loop tight. They may return as official
options later — until then, the same `aethon.registerLayout` API any
extension uses can bring back equivalents.

## The slot contract

Layouts are interchangeable because they share a **slot contract**.
Canonical area names:

| Slot | What renders there |
| --- | --- |
| `header` | Tab strip and window-level chrome. |
| `sidebar` | Project list, extensions, sessions, themes, layouts. |
| `canvas` | The agent's main render surface (chat history). |
| `composer` | Chat input. |
| `terminal` | Bottom panel with Agent bash + shell sub-tabs. |
| `status` | Status bar (model · cwd · queue · errors). |

Two slots are **required**: `canvas` and `composer`. A layout that omits
them won't be activatable.

Layouts that don't use the canonical names declare a `slotMap` that
maps their own area names back to canonical ones. This lets an extension ship
a creative layout without having to use the same JSON keys as the
defaults.

## Switching layouts

Three paths (relevant once more than one layout is registered):

1. **Slash command** — `/layout <id>`.
2. **Command palette** — `Cmd+Shift+P`, search "layout".
3. **Sidebar** — the **Layouts** section lists every registered layout;
   click to activate.

The active layout is persisted, so quitting and relaunching restores it.

## Registering custom layouts

Extensions can register a layout via:

```ts
aethon.registerLayout({
  id: "my-layout",
  name: "My Layout",
  payload: {
    /* A2UI payload — see docs/aethon-agent/components.md for the full spec */
  },
});
```

Reserved id: `workstation`. Custom ids must match `^[A-Za-z][\w-]*$`.

A layout registered this way:

- Appears in the sidebar's **Layouts** section.
- Appears in the command palette (`Cmd+Shift+P` → search by name).
- Survives across reloads (the registration is part of the runtime state
  that gets re-emitted on restart).

To **also activate** the layout when the extension loads, return it from an
extension setup function — see [Extensions](/guide/extensions).

## Resetting

To go back to the default `workstation` layout:

```
/layout workstation
```

Or from the dev console (in dev builds):

```js
window.aethon.resetLayout();
```

## Where to next

- [Themes](/guide/themes) — palettes that work across all layouts.
- [Extensions](/guide/extensions) — registering layouts and components.
- [Runtime API reference](/reference/runtime-api) — `aethon.registerLayout` signature.
