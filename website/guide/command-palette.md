# Command palette

The command palette is Aethon's **everything-finder**: tabs, sessions,
projects, layouts, themes, models, slash commands, and keybindings all
live behind one shortcut.

## Two modes

| Combo | Mode | Order of results |
|---|---|---|
| `Cmd+P` | **Switcher** | Tabs · sessions · projects · layouts · themes · models · commands · keybindings |
| `Cmd+Shift+P` | **Commands** | Slash commands · keybindings · everything else |

`Cmd+P` is for "I want to **switch to** something". `Cmd+Shift+P` is for
"I want to **do** something".

## Query prefixes

Inside the palette, three prefixes force a specific section:

| Prefix | Meaning |
|---|---|
| `>` | Force commands mode (same as `Cmd+Shift+P`). |
| `@` | Force tabs section. |
| `?` | Force keybindings section. |

So:

- `> theme` — find the **Set theme** command.
- `@ readme` — switch to a tab whose title matches "readme".
- `? cmd+t` — find what `Cmd+T` is bound to.

Without a prefix, the palette ranks across all sections and returns a
mixed list.

## Keyboard nav

| Combo | Action |
|---|---|
| `↑` / `↓` | Move selection. |
| `Enter` | Activate selection. |
| `Esc` | Close palette. |

Selection survives content swaps — when the palette re-ranks results
(while you type or content changes), the highlighted index persists
through a focus-tracking strategy. You won't lose your place.

## What's in the palette

| Section | Contents |
|---|---|
| **Tabs** | Every open agent tab and shell sub-tab — title, cwd, model, kind. |
| **Sessions** | Recent pi sessions across all tabs (cross-session — reaches into closed-tab transcripts). |
| **Projects** | The MRU list from `~/.aethon/projects.json`. |
| **Layouts** | Built-in (`workstation`) plus any extension-registered layouts. |
| **Themes** | Built-ins (`ember`, `paper`, `aether`) plus extension-registered. |
| **Models** | Whatever pi reports from the active provider. |
| **Commands** | Every slash command (built-in + extension-registered). |
| **Keybindings** | Every shortcut Aethon recognises. |

## Replacing the palette

The palette is a **registered builtin** (`command-palette` component
type). A skill can override it via:

```ts
aethon.registerComponent("command-palette", myCustomPalette);
```

The replacement renders in the same overlay slot and receives the same
trigger event, so the keybindings keep working — only the visual
shell changes.

## Where to next

- [Keyboard shortcuts](/reference/keyboard-shortcuts) — the full set.
- [Slash commands](/reference/slash-commands) — every `/<cmd>` reference.
- [Skills & extensions](/guide/skills-and-extensions) — registering palette items.
