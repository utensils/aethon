# Layouts

A **layout** in Aethon is not a piece of React code — it's an **A2UI
JSON payload** that the renderer turns into the UI you see. The default
layout is itself a skill (`src/skills/default-layout/`), and switching
layouts is a runtime payload swap.

This is the central insight: **the chrome is data**.

## The four built-in layouts

All four ride on Aethon's signature Æther palette and ship as part of
the default-layout skill.

| Layout | `id` | Vibe |
|---|---|---|
| **Workstation** | `workstation` | The default — chat-first, sidebar + canvas + composer + terminal. |
| **Command Deck** | `command-deck` | Denser, dashboard-feel — multi-column with status grid. |
| **Editorial** | `editorial` | Generous typography, long-form reading mode. |
| **Live Layout** | `live-layout` | Animated demo layout showcasing transitions. |

Switch them with the `/layout <id>` slash command:

```
/layout editorial
```

…or via the **Command palette** (`Cmd+P`) → search "layout" → pick.

## The slot contract

Layouts are interchangeable because they share a **slot contract**.
Canonical area names:

| Slot | What renders there |
|---|---|
| `header` | Tab strip and window-level chrome. |
| `sidebar` | Project list, skills, sessions, themes, layouts. |
| `canvas` | The agent's main render surface (chat history). |
| `composer` | Chat input. |
| `terminal` | Bottom panel with Agent bash + shell sub-tabs. |
| `status` | Status bar (model · cwd · queue · errors). |

Two slots are **required**: `canvas` and `composer`. A layout that omits
them won't be activatable.

Layouts that don't use the canonical names declare a `slotMap` that
maps their own area names back to canonical ones. This lets a skill ship
a creative layout without having to use the same JSON keys as the
defaults.

## Switching layouts

Three paths:

1. **Slash command** — `/layout <id>`.
2. **Command palette** — `Cmd+P`, search "layout".
3. **Sidebar** — the **Layouts** section lists every registered layout;
   click to activate.

The active layout is persisted, so quitting and relaunching restores it.

## Registering custom layouts

Skills can register a layout via:

```ts
aethon.registerLayout({
  id: "my-layout",
  name: "My Layout",
  payload: {
    /* A2UI payload — see docs/aethon-agent/components.md for the full spec */
  },
});
```

Reserved ids: `workstation`, `command-deck`, `editorial`, `live-layout`.
Custom ids must match `^[A-Za-z][\w-]*$`.

A layout registered this way:

- Appears in the sidebar's **Layouts** section.
- Appears in the command palette (`Cmd+P` → search by name).
- Survives across reloads (the registration is part of the runtime state
  that gets re-emitted on restart).

To **also activate** the layout when the skill loads, return it from a
skill's setup function — see [Skills & extensions](/guide/skills-and-extensions).

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
- [Skills & extensions](/guide/skills-and-extensions) — registering layouts and components.
- [Runtime API reference](/reference/runtime-api) — `aethon.registerLayout` signature.
