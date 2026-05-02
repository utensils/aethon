# Slash commands

Slash commands are recognised when the chat composer starts with `/`.
Aethon ships ten built-ins; extensions register additional commands
via `aethon.registerSlashCommand`. Unknown `/<word>` falls through to
pi (the model), so model-side commands like `/think harder` keep working.

## Built-in commands

| Command | Action |
|---|---|
| `/clear` | Clear the visible chat history. The pi session continues — only the rendered messages are cleared. |
| `/help` | List all registered slash commands (built-in + extension) with their descriptions. |
| `/theme [<id>]` | Open the theme picker (no argument) or activate a specific theme directly (`/theme paper`). |
| `/model [<name>]` | Open the model picker or activate a specific model directly (`/model anthropic/claude-sonnet-4-6`). |
| `/reset` | Hard-reset the active tab's pi session — clears history *and* discards on-disk session state. The next message starts a fresh conversation. |
| `/terminal` | Toggle the bottom terminal panel. Equivalent to `Cmd+\``. |
| `/skills` | List every loaded extension and skill — built-in plus user-installed plus project-local — with their registered components, themes, slash commands, and last reload status. |
| `/sidebar` | Toggle the sidebar. Equivalent to `Cmd+B`. |
| `/layout <id>` | Switch layouts. Reserved built-in ids: `workstation`, `command-deck`, `editorial`, `live-layout`. Extensions register additional ones via `aethon.registerLayout`. |
| `/project <path>` | Add a project (or activate it if already in the list) and use it as the active project for new tabs. |

## Extension commands

The `/skills` output lists every extension-registered command alongside
its description. Reach them the same way: `/<name> [args…]`.

A skill registers a command with:

```ts
aethon.registerSlashCommand({
  command: "team-deploy",
  description: "Deploy the active branch to staging.",
  handler: async (args, ctx) => {
    /* …implementation… */
    return "Deploying…";
  },
});
```

Returning a string from the handler renders that string as an agent
message in the chat. Returning a Promise makes the chat show a
thinking indicator until the Promise resolves. Throwing surfaces an
error in the chat as a red status message.

## Tips

- `/help` is the source of truth for what commands are *currently*
  loaded. Extensions can come and go — the running set is what counts.
- Type just `/` and pause to surface a slash-command suggestion list
  (when extensions register one — the default chat composer doesn't
  ship one, but the command palette `Cmd+Shift+P` covers the same
  ground).
- Extensions can register **slash command aliases** by registering
  multiple commands that share an implementation.

## Where to next

- [Skills & extensions](/guide/skills-and-extensions) — registering commands.
- [Command palette](/guide/command-palette) — the other path to every command.
- [Runtime API](/reference/runtime-api) — `aethon.registerSlashCommand` signature.
