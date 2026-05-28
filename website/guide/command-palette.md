# Command palette

The command palette is Aethon's **everything-finder**: files, tabs,
sessions, projects, layouts, themes, models, slash commands, and
keybindings all live behind keyboard-first overlays.

## Three modes

| Combo | Mode | Order of results |
|---|---|---|
| `Cmd+P` | **Files** | Active project's file tree · open agent tabs · commands · keybindings |
| `Cmd+Shift+P` | **Commands** | Slash commands · keybindings · everything else |

`Cmd+P` is for "open a file in this project". `Cmd+Shift+P` is for
"do something". The switcher catalogue still exists behind the palette
state and prefixes: type `@` for tabs, `>` for commands, or `?` for
keybindings.

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

In file mode, unprefixed queries search project-relative paths. In
commands mode, unprefixed queries rank slash commands and keybindings
first, then other sections.

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
| **Files** | Project-relative files from the active project, opened in editor tabs. |
| **Tabs** | Open agent tabs from the top strip. Shell sub-tabs stay in the bottom panel. |
| **Sessions** | Recent pi sessions across all tabs (cross-session — reaches into closed-tab transcripts). |
| **Projects** | The MRU list from `~/.aethon/projects.json`. |
| **Layouts** | Built-in (`workstation`) plus any extension-registered layouts. |
| **Themes** | Built-ins (`ember`, `paper`, `aether`, `brink`, `daylight`, `mist`, `nocturne`) plus extension-registered. |
| **Models** | Whatever pi reports from the active provider. |
| **Commands** | Every slash command (built-in + extension-registered). |
| **Keybindings** | Every shortcut Aethon recognises. |

## Replacing the palette

The palette is a **registered builtin** (`command-palette` component
type). An extension can override it via:

```ts
aethon.registerComponent("command-palette", myCustomPalette);
```

The replacement renders in the same overlay slot and receives the same
trigger event, so the keybindings keep working — only the visual
shell changes.

## Where to next

- [Keyboard shortcuts](/reference/keyboard-shortcuts) — the full set.
- [Slash commands](/reference/slash-commands) — every `/<cmd>` reference.
- [Extensions](/guide/extensions) — registering palette items.
