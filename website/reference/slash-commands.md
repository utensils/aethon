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
| `/layout <id>` | Switch layouts. The only built-in id today is `workstation`; extensions register additional ones via `aethon.registerLayout`. |
| `/project <path>` | Add a project (or activate it if already in the list) and use it as the active project for new tabs. |

## Extension commands

The `/skills` output lists every extension-registered command alongside
its description. Reach them the same way: `/<name> [args…]`.

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
`model`, `reset`, `terminal`, `sidebar`, `layout`, `skills`,
`project`); registering one is rejected with a notice.

## Installing skills

`/skills` lists what's loaded; `/skills install <npm-package|git-url>`
installs new ones. Examples:

```
/skills install @my-org/aethon-team-skills
/skills install github:my-org/aethon-skills
/skills install https://github.com/my-org/aethon-skills.git
```

The Tauri shell runs the equivalent of
`npm install --prefix ~/.aethon/skills <spec>` and restarts the agent
sidecar so the new package is loaded on the next request. Tarballs,
GitHub shorthands, and git URLs are accepted; shell-like option /
whitespace input is rejected.

## Tips

- `/help` is the source of truth for what commands are *currently*
  loaded. Extensions can come and go — the running set is what counts.
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
