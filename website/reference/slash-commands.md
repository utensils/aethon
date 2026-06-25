# Slash commands

Slash commands are recognised when the chat composer starts with `/`.
Aethon ships built-ins for local UI actions, account/profile switching,
pi-native session commands, and extension management. Extensions register
additional commands via
`aethon.registerSlashCommand`. Unknown `/<word>` falls through to pi
(the model), so model-side commands like `/think harder` keep working.

## Built-in commands

| Command | Action |
|---|---|
| `/clear` | Clear the visible chat history. The pi session continues — only the rendered messages are cleared. |
| `/help` | List all registered slash commands (built-in + extension) with their descriptions. |
| `/theme [<id>]` | Open the theme picker (no argument) or activate a specific theme directly (`/theme paper`). |
| `/model [<name>]` | Open the model picker or activate a specific model directly (`/model anthropic/claude-sonnet-4-6`). |
| `/plan [on\|off\|toggle\|status]` | Toggle planning-only mode for the active session (also bound to `Shift+Tab`). |
| `/init` | Create or update the Aethon managed block in the active project's `AGENTS.md`. |
| `/config` | Open guided project setup for MCP servers, startup commands, and project instructions. |
| `/mcp [status\|setup]` | Show or configure MCP servers for the active project, including `.mcp.json` approval/import. No argument lists servers; `status` shows host/policy state; `setup` opens the guided flow. |
| `/mcp-auth [server]` | Open the guided MCP setup/authentication flow for the active project. With a `server` name, runs authentication for that server. |
| `/login [list\|use <account>\|default <account>]` | Open provider login, list stored accounts, switch the active tab's account, or set the default account. |
| `/reset` | Reset the active layout to the default `workstation` payload. |
| `/reload` | Reload the agent bridge and re-discover extensions, themes, slash commands, and disabled-extension state. |
| `/rename [new label]` | Rename the active session. Empty input restores the auto-derived label. |
| `/memory` | Show Aethon's user memory and resolved-project memory. |
| `/context` | Run pi's native context-window usage command for the active tab. |
| `/session` | Run pi's native session-stats command for the active tab. |
| `/compact [instructions]` | Run pi's compaction flow for older context. |
| `/name [name]` | Show or set the pi session display name. |
| `/export [path.html\|path.jsonl]` | Export the pi session as HTML, or JSONL when the path ends in `.jsonl`. |
| `/loop [interval] [prompt] \| reuse <id>` | Run a repeated scheduled task in this session. |
| `/tasks [list\|run\|pause\|resume\|cancel\|delete <id>]` | Open or control Scheduled Tasks. |
| `/terminal` | Toggle the bottom terminal panel. Equivalent to `Ctrl+\``. |
| `/extensions` | List every loaded extension. With `install <npm-package\|git-url>` (or `add`), runs `npm install --prefix ~/.aethon/extensions` and reloads the agent so the new package is picked up. |
| `/sidebar` | Toggle the sidebar. Equivalent to `Cmd+B`. |
| `/files` | Toggle the right-hand files sidebar. |
| `/layout <id>` | Switch layouts. The only built-in id today is `workstation`; extensions register additional ones via `aethon.registerLayout`. |
| `/project [id\|path]` | Open or switch the active project directory. No argument shows a folder picker; an id or path switches to that project for new tabs. |

## Extension commands

The `/extensions` output lists every loaded extension; `/help` lists every
registered command (built-in plus extension-registered) with its
description. Reach extension commands the same way: `/<name> [args…]`.

An extension registers a command in two halves: a metadata record and a
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

Built-in command names are reserved (`clear`, `help`, `theme`, `model`,
`init`, `config`, `mcp`, `mcp-auth`, `login`, `reset`, `reload`, `rename`,
`memory`, `context`, `session`, `compact`, `name`, `export`, `terminal`,
`sidebar`, `files`, `layout`, `extensions`, `project`); registering one is
rejected with a notice. Note that `plan`, `loop`, and `tasks` are
frontend-only commands and are **not** in the reserved set — an extension
may register those names.

## Installing extensions

`/extensions` lists what's loaded; `/extensions install <npm-package|git-url>`
installs new ones (`add` works as an alias). Examples:

```
/extensions install @my-org/aethon-team-extensions
/extensions install github:my-org/aethon-extensions
/extensions install https://github.com/my-org/aethon-extensions.git
```

The Tauri shell runs the equivalent of
`npm install --prefix ~/.aethon/extensions <spec>` and restarts the agent
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

- [Extensions](/guide/extensions) — registering commands.
- [Command palette](/guide/command-palette) — the other path to every command.
- [Runtime API](/reference/runtime-api) — `aethon.registerSlashCommand` signature.
