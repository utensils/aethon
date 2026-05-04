# Quick start

This walkthrough takes you from a fresh install to a working agent loop
in five minutes.

## 1 — Open a project

Aethon is project-scoped: each tab carries an immutable working directory
that the agent uses as its `cwd`. The first tab opens in your home
directory by default.

To open a different project:

- **Sidebar** → click **Projects** → **Add project…** → pick a directory.
- **Command palette** → `Cmd+P` → search the project name → press Enter.
- **Slash command** → type `/project /path/to/repo` in the chat composer.

The project list lives at `~/.aethon/projects.json` (MRU-ordered, max 16).
Switching the active project affects **new tabs only** — existing tabs
keep the cwd they were created with.

## 2 — Send your first message

Type into the **chat composer** at the bottom of the canvas and press
Enter. The agent streams its reply into the scroll. Multi-line input is
`Shift+Enter`.

Useful keys while a turn is running:

- `Cmd+.` — stop the current prompt.
- `Cmd+K` — clear the visible chat history (the underlying pi session is
  preserved unless you also `/reset`).

## 3 — Switch the model

Each tab has an independent model selection. Either:

- Type `/model` to open the model picker, then pick from the list.
- Open Settings (`Cmd+,`) and set the **default model** for new tabs.

The default model is read from `[agent] model` in `config.toml` and
applied when a new tab is created.

## 4 — Open a shell

The bottom panel hosts a tabbed terminal. Toggle it with **`Cmd+\``**
(backtick).

Two kinds of sub-tabs live there:

| Sub-tab | What it is |
|---|---|
| **Agent bash** (always present, read-only) | Live stream of the bash tool's stdout for the active agent tab. |
| **Shell sub-tabs** (zero or more) | Full interactive PTYs — vim, htop, fzf, ssh. |

Open a new shell sub-tab with `Cmd+Shift+T` (or `Cmd+T` while focus is in
the bottom panel).

A new shell starts in the active tab's project root, with `private` share
mode — the agent cannot read from or write to it until you flip the
share-mode badge. See [Shells & share modes](/guide/shells-and-share-modes)
for the full model.

## 5 — Tabs

`Cmd+T` is **focus-aware**:

- Focus inside the bottom panel → opens a new **shell sub-tab**.
- Focus elsewhere → opens a new **agent tab**.

`Cmd+Shift+T` always opens the *opposite* surface (and auto-opens the
bottom panel for shells).

| Combo | Action |
|---|---|
| `Cmd+W` | Close the active tab. Shell tabs prompt before killing a running job. |
| `Cmd+Opt+T` | Reopen the most recently closed tab. |
| `Cmd+]` / `Cmd+[` | Cycle agent tabs (or shell sub-tabs when focus is in the panel). |
| `Cmd+1` … `Cmd+9` | Jump to tab N. |

See the full [keyboard shortcut reference](/reference/keyboard-shortcuts).

## 6 — Layouts

Aethon currently ships one built-in layout, `workstation` — the
chat-first IDE-density surface you're already in. Layouts are A2UI
payloads, not React components, so skills can register their own and
the user can swap with `/layout <id>` (or `Cmd+P` → "layout"). We
trimmed the sibling variations (`command-deck`, `editorial`,
`live-layout`) while polish focuses on a single surface; they may
return later, but you can already build replacements with
`aethon.registerLayout({ id, name, payload })`.

## 7 — Discover skills

`/extensions` lists every loaded extension — built-in plus
user-installed plus project-local. Drop a `.ts` file into
`~/.aethon/extensions/` and Aethon hot-reloads it.

## What next?

- [Configuration](/guide/configuration) — tune themes, default model, shell behaviour.
- [Command palette](/guide/command-palette) — every action is reachable from `Cmd+P`.
- [Skills & extensions](/guide/skills-and-extensions) — install or write your own.
- [Themes](/guide/themes) — the three built-in palettes and how to add a fourth.
