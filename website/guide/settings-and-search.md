# Settings & search

Two overlay surfaces ship as built-ins — both registered components, so an
extension can replace either without forking the chrome.

## Settings panel — `Cmd+,`

The Settings panel (`Cmd+,` on macOS, `Ctrl+,` elsewhere) is the GUI for
`~/.aethon/config.toml`. Every key writable from `config.toml` has a
field here.

Sections, in order:

- **Appearance** — theme, font size.
- **View** — global default visibility for thinking blocks and tool-call cards.
- **Guardrails** — restrict agent tools to the project root, soft prompt anchor.
- **Notifications** — completion notifications (when unfocused) and minimum turn duration.
- **Agent** — system-prompt override, Codex Fast mode, and provider / bash / inline-subagent timeouts. (The default model is set from the header model picker, which persists `[agent] model`.)
- **Shell** — default share mode, shell program, args, inherit env.
- **Behavior** — confirm-before-close when a shell job is running.
- **Voice** — toggle and hold-to-talk hotkeys, speak-replies-aloud, hands-free conversation, and recognition providers.
- **Updater** — stable/nightly channel and background-check toggle.
- **Nix devshell** — detection mode, cache lifetime, lockfile refresh, and manual refresh.
- **Extensions** — the list of loaded extensions and their sources.
- **Advanced** — a pointer to edit `config.toml` directly for keys not surfaced here, plus two convenience buttons.

The two buttons in **Advanced**:

- **Open `config.toml`** — opens `~/.aethon/config.toml` in Aethon's
  in-app Monaco editor for power-user edits.
- **Reset layout** — restores the sidebar, file sidebar, and terminal
  panel sizes to their defaults without changing `config.toml`.

::: tip Direct edits override
The Settings panel reads the file every time it opens, so manual edits
take effect on next open. Edits made in the panel write back through
a JSON-shaped diff, so any keys you've added by hand that Aethon
doesn't manage are preserved.
:::

## Cross-session search — `Cmd+Shift+F`

`Cmd+Shift+F` opens the **search overlay**. Unlike the command palette
(which searches *active* state), search reaches into:

- All chat history across **closed** tabs (via the on-disk pi sessions).
- All bash output captured in the agent-bash buffer.
- All open tab titles and sidebar entries.

Results are clickable — selecting one opens the originating session
(reopening it from `~/.aethon/sessions/` if needed) and scrolls to the
matching line.

::: tip
Closed-tab search is read-only — selecting a closed-session result
opens it in a new tab; the original tab record stays gone.
:::

## Notification stack

Allow/Deny prompts (from `read-write` shell mode), `extension_lifecycle`
events, completion notifications, and update prompts all stack into a
right-aligned **notification stack** that sits above all other chrome.
It's a registered builtin — replace it with
`aethon.registerComponent("notification-stack", …)` if you want
a different feel.

## Replacing these surfaces

```ts
// Replace the settings panel:
aethon.registerComponent("settings-panel", mySettingsPanel);

// Replace the search overlay:
aethon.registerComponent("search-panel", mySearchPanel);

// Replace notifications:
aethon.registerComponent("notification-stack", myNotificationStack);
```

The keybindings (`Cmd+,`, `Cmd+Shift+F`) still trigger the overlay; only
the visual layer changes.

## Where to next

- [Keyboard shortcuts](/reference/keyboard-shortcuts) — full set.
- [Configuration](/guide/configuration) — what every Settings key writes to.
- [Extensions](/guide/extensions) — replacing builtins.
