# Slash commands

Slash commands are recognised when the chat composer starts with `/`.
Aethon ships ten built-ins (`/clear`, `/help`, `/theme`, `/model`,
`/reset`, `/terminal`, `/extensions`, `/sidebar`, `/layout`,
`/project`); extensions register additional commands via
`aethon.registerSlashCommand`. Unknown `/<word>` falls through to pi
(the model), so model-side commands like `/think harder` keep working.

## Built-in commands

| Command | Action |
|---|---|
| `/clear` | Clear the visible chat history. The pi session continues — only the rendered messages are cleared. |
| `/help` | List all registered slash commands (built-in + extension) with their descriptions. |
| `/theme [<id>]` | Open the theme picker (no argument) or activate a specific theme directly (`/theme paper`). |
| `/model [<name>]` | Open the model picker or activate a specific model directly (`/model anthropic/claude-sonnet-4-6`). |
| `/reset` | Hard-reset the active tab's pi session — clears history *and* discards on-disk session state. The next message starts a fresh conversation. |
| `/terminal` | Toggle the bottom terminal panel. Equivalent to `Cmd+\``. |
| `/extensions` | List every loaded extension. With `install <npm-package\|git-url>` (or `add`), runs `npm install --prefix ~/.aethon/skills` and reloads the agent so the new package is picked up. |
| `/sidebar` | Toggle the sidebar. Equivalent to `Cmd+B`. |
| `/layout <id>` | Switch layouts. The only built-in id today is `workstation`; extensions register additional ones via `aethon.registerLayout`. |
| `/project [id\|path]` | Open or switch the active project directory. No argument shows a folder picker; an id or path switches to that project for new tabs. |

## Extension commands

The `/extensions` output lists every loaded extension; `/help` lists every
registered command (built-in plus extension-registered) with its
description. Reach extension commands the same way: `/<name> [args…]`.

A skill registers a command in two halves: a metadata record and a
paired event handler.

```ts
aethon.registerSlashCommand({
  name: "team-deploy",
  description: "Deploy the active branch to staging.",
  usage: "/team-deploy [staging|prod]",
});

aethon.onEvent(
  { componentType: "slash-command", descendantId: "team-deploy" },
  async (event, ctx) => {
    const args = event.data?.args ?? "";
    /* …implementation… */
    ctx.pi.notify("Deploying…");
  },
);
```

The `registerSlashCommand` call records metadata so the slash-command
picker, palette, and `/help` know about it. The paired
`aethon.onEvent` handler runs when the user invokes `/team-deploy` —
it receives the event with `data.args` set to whatever followed the
command name. Use `ctx.pi.notify` / `ctx.pi.prompt` to push messages
or fire LLM turns.

Built-in command names are reserved (`clear`, `help`, `theme`,
`model`, `reset`, `terminal`, `sidebar`, `layout`, `extensions`,
`project`); registering one is rejected with a notice.

## Installing extensions

`/extensions` lists what's loaded; `/extensions install <npm-package|git-url>`
installs new ones (`add` works as an alias). Examples:

```
/extensions install @my-org/aethon-team-skills
/extensions install github:my-org/aethon-skills
/extensions install https://github.com/my-org/aethon-skills.git
```

The Tauri shell runs the equivalent of
`npm install --prefix ~/.aethon/skills <spec>` and restarts the agent
sidecar so the new package is loaded on the next request. Tarballs,
GitHub shorthands, and git URLs are accepted; shell-like option /
whitespace input is rejected.

## Tips

- `/help` is the source of truth for what commands are *currently*
  loaded (built-ins + extension-registered). `/extensions` is the
  source of truth for which extension packages are loaded.
- Type `/` and pause to surface the **slash-command picker** — it
  ranks built-ins and extension-registered commands and accepts arrow-key
  navigation. The command palette (`Cmd+Shift+P`) covers the same ground
  with a fuzzy search.
- Extensions can register **slash command aliases** by registering
  multiple metadata records that share a handler — pair multiple
  `registerSlashCommand` calls with a single `onEvent` whose
  match uses a wildcard `descendantId`.

## Where to next

- [Skills & extensions](/guide/skills-and-extensions) — registering commands.
- [Command palette](/guide/command-palette) — the other path to every command.
- [Runtime API](/reference/runtime-api) — `aethon.registerSlashCommand` signature.
