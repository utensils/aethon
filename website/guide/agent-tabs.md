# Agent tabs

Agent tabs live in the **top tab strip** and host pi conversations.
Each tab owns a chat history, draft, model selection, queued message
counter, and bash output buffer — everything the agent needs to run a
focused session.

## Anatomy of an agent tab

```
┌─────────────────────────────────────────────────┐
│ [Tab title · model]                          [×]│  ← top strip
├─────────────────────────────────────────────────┤
│  Sidebar  │   Chat history (scrollable)         │
│           │                                     │
│           │   ─────────────────────────         │
│           │   Composer (multi-line)        [⏎] │
├─────────────────────────────────────────────────┤
│ Status: model · cwd · queued                    │
└─────────────────────────────────────────────────┘
```

## Tab management

| Action | Shortcut | Notes |
|---|---|---|
| New agent tab | `Cmd+T` | Focus-aware: opens **shell** if focus is in the bottom panel. |
| New agent tab (always) | `Cmd+Shift+T` | Force the *opposite* of `new_tab_kind`. |
| Close tab | `Cmd+W` | Shell tabs prompt before killing a running job. |
| Reopen most-recently closed | `Cmd+Opt+T` | Restores chat + cwd + draft. |
| Next / previous | `Cmd+Shift+]` / `Cmd+Shift+[` | Cycles agent tabs. Matches the iTerm / Terminal.app convention. |
| Jump to N | `Cmd+1` … `Cmd+8` | Index 1 = first agent tab. |
| Jump to last | `Cmd+9` | |
| Move tab right / left | `Cmd+Opt+]` / `Cmd+Opt+[` | Reorders the strip. |

When focus is inside the bottom terminal panel, the same shortcuts cycle
*shell sub-tabs* instead — see [Shells & share modes](/guide/shells-and-share-modes).

## Per-tab state

Aethon persists each tab to `~/.aethon/state.json`:

- **Project (`cwd`)** — immutable for the tab's lifetime.
- **Model** — the model picked for *this* tab. Defaults to `[agent] model`.
- **Draft** — whatever you typed but didn't send.
- **Queue count** — messages queued for the next turn.
- **Bash buffer** — recent stdout from the bash tool, surfaced in the
  bottom panel's "Agent bash" sub-tab.
- **Pi session id** — pointer into `~/.aethon/sessions/<tabId>/`.

If you set `[ui] restore_tabs = true` (the default), all of this comes
back on next launch.

## Composing messages

The composer lives at the bottom of the canvas:

| Combo | Action |
|---|---|
| `Enter` | Send. |
| `Shift+Enter` | Insert newline. |
| `Cmd+L` | Focus the composer (or terminal in shell tabs). |
| `Cmd+.` | Stop the current prompt. |
| `Cmd+K` | Clear visible chat history (pi session preserved). |
| `Cmd+Shift+S` | Export the chat as Markdown to `~/Downloads/` (agent tabs only). |

Slash commands like `/clear`, `/help`, `/theme`, `/model`, `/reset`,
`/terminal`, `/extensions`, `/sidebar`, `/layout`, `/project` are recognised
when typed at the start of the composer. Unknown `/<word>` falls
through to the model — useful when an extension registers its own.

See the full [slash command reference](/reference/slash-commands).

## Queuing messages

If you type and send while the agent is mid-turn, the message is queued.
The status bar shows `queued: N`. The next turn starts immediately after
the current one ends. To cancel a queue, clear the composer or
`Cmd+.` to stop and discard.

## Switching models

`/model` opens the model picker in the active tab. The change applies to
the **next turn** only — already-running turns continue on the previous
model. The new selection is also persisted as the tab's default for
subsequent runs (until you change it again).

To change the *default* model for new tabs, edit `[agent] model` in
`config.toml` or use the Settings panel.

## Tool execution

Pi's tool calls (bash, file reads, file writes, web fetches) surface
as **A2UI tool cards** in the chat. The card streams tool output as
it arrives. Bash output is *also* mirrored to the "Agent bash"
sub-tab in the bottom panel so you can keep watching it while you
scroll chat.

Tool cards collapse by default when their tool finishes — click the
chevron to expand, or set the cursor inside one to keep it open while
you scroll.

## Where to next

- [Shells & share modes](/guide/shells-and-share-modes) — bottom-panel PTY tabs.
- [Command palette](/guide/command-palette) — every tab action is reachable from `Cmd+P`.
- [Settings & search](/guide/settings-and-search) — cross-session search.
