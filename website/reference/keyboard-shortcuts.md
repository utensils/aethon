# Keyboard shortcuts

Aethon binds the same shortcuts under `Cmd` (macOS) and `Ctrl` (Linux /
Windows). Native menu accelerators in the Tauri shell mirror these.
Extensions can override built-ins via `aethon.registerKeybinding` —
extension handlers run first, so user-installed bindings win.

::: tip
This table reads `Cmd` for the OS modifier. Linux and Windows users get
the same combos under `Ctrl` (`Cmd+T` ≡ `Ctrl+T`).
:::

## Tabs and panel

| Combo                         | Action                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cmd+T`                       | New tab — **focus-aware**. Agent tab if focus is outside the bottom panel; shell sub-tab if inside. `[shortcuts] new_tab_kind = "shell"` makes this always open shells.                                  |
| `Cmd+Shift+T`                 | New shell sub-tab (always — auto-opens the panel).                                                                                                                                                       |
| `Cmd+W`                       | Close active tab. Shell tabs prompt before killing a running job (disable via `[shell] prompt_before_close = false`).                                                                                    |
| `Cmd+Opt+T`                   | Reopen most-recently-closed tab.                                                                                                                                                                         |
| `Cmd+Shift+]` / `Cmd+Shift+[` | Next / previous _agent_ tab (top strip; shells filtered). When focus is inside the bottom panel, cycles between sub-tabs (agent-bash + each shell) instead. Matches the iTerm / Terminal.app convention. |
| `Cmd+Opt+]` / `Cmd+Opt+[`     | Move active agent tab right / left. When focus is inside the bottom panel, reorders shell sub-tabs instead.                                                                                              |
| `Cmd+1` … `Cmd+8`             | Jump to agent tab N. When focus is inside the bottom panel, jumps between sub-tabs (1 = agent-bash).                                                                                                     |
| `Cmd+9`                       | Jump to last agent tab (or last shell sub-tab when focus is in panel).                                                                                                                                   |

## Composer and chat

| Combo         | Action                                                                               |
| ------------- | ------------------------------------------------------------------------------------ |
| `Enter`       | Send message.                                                                        |
| `Shift+Enter` | Insert newline in composer.                                                          |
| `Cmd+L`       | Focus active tab's primary input (composer for agent tabs, terminal for shell tabs). |
| `Cmd+K`       | Clear visible chat history. The underlying pi session is preserved.                  |
| `Cmd+.`       | Stop the current prompt.                                                             |
| `Shift+Tab`   | Toggle Plan mode for the active agent session.                                       |
| `Cmd+Shift+M` | Toggle voice input.                                                                  |
| `Cmd+Shift+S` | Export active chat as Markdown to `~/Downloads/` (agent tabs only).                  |

## Overlays and surfaces

| Combo         | Action                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `Cmd+P`       | Quick-open file fuzzy search for the active project. `>` and `?` still pivot to commands and keybindings. |
| `Cmd+Shift+P` | **Command palette** — commands mode (slash commands, keybindings first).                                  |
| `Cmd+\``      | Toggle bottom terminal panel (Agent bash + each shell as a sub-tab).                                      |
| `Cmd+B`       | Toggle sidebar.                                                                                           |
| `Cmd+D`       | Toggle the right-hand files sidebar.                                                                      |
| `Cmd+J`       | Toggle the sidebar's file-tree panel.                                                                     |
| `Cmd+,`       | Open Settings panel.                                                                                      |
| `Cmd+Shift+A` | Toggle the Accounts panel (per-provider auth profiles + usage).                                           |
| `Cmd+Shift+F` | Cross-session search overlay.                                                                             |
| `Cmd+Shift+L` | Open Scheduled Tasks.                                                                                     |
| `Esc`         | Close palette / settings / search / accounts overlay (when open).                                         |

## Editor

| Combo         | Action                                                                                 |
| ------------- | -------------------------------------------------------------------------------------- |
| `Cmd+Shift+V` | Toggle Markdown preview for the active editor tab. No-op outside Markdown editor tabs. |

## View

| Combo                      | Action                                            |
| -------------------------- | ------------------------------------------------- |
| `Cmd+=` / `Cmd+-`          | Zoom in / out.                                    |
| `Cmd+0`                    | Toggle focus between composer and terminal panel. |
| `Cmd+Shift+0`              | Reset zoom.                                       |
| `Cmd+Ctrl+F` (mac) / `F11` | Toggle fullscreen.                                |
| `F12`                      | Toggle WebKit DevTools (debug builds only).       |

## Slash commands and palette prefixes

Inside the command palette, prefixes force a specific section:

| Prefix | Forces              |
| ------ | ------------------- |
| `>`    | Commands mode       |
| `@`    | Tabs section        |
| `?`    | Keybindings section |

See [Slash commands](/reference/slash-commands) for the full slash-command reference.

## Customizing

Two ways to change the bindings:

1. **In an extension**:

   ```ts
   aethon.registerKeybinding("Cmd+T", () => {
     /* override Cmd+T */
   });
   ```

   Extension bindings run first; built-ins still execute unless you
   return a sentinel value. See [Runtime API](/reference/runtime-api).

2. **`[shortcuts] new_tab_kind`** in `config.toml` — controls only
   `Cmd+T`'s focus-aware behaviour. Set to `"shell"` to make `Cmd+T`
   always open a shell sub-tab.
