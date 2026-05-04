# Projects

A **project** is a directory the agent uses as its working directory. Every
agent tab carries a fixed project (its `cwd`) — the agent runs `bash`,
reads files, and discovers project-local extensions relative to that path.

## Why projects matter

Pi (the embedded coding agent) is `cwd`-aware. Project context shapes:

- **`bash` tool root** — every command runs in the project directory.
- **File reads** — relative paths resolve from the project.
- **Extension discovery** — Aethon walks up from the active cwd to its
  git root looking for `.aethon/extensions/`.
- **Pi session state** — pi maintains a per-cwd session. Tabs in the
  same project on the same machine share session continuity (see
  [Agent tabs](/guide/agent-tabs) for the per-tab session model).

## Adding a project

Three ways to register a new project:

1. **Sidebar** → **Projects** section → **Add project…** → pick a directory.
2. **Command palette** (`Cmd+P`) → search "project" → **Add project…**
3. **Slash command** → `/project /absolute/path/to/repo` — adds and activates.

The project list is persisted at `~/.aethon/projects.json`. Maximum
**16 entries**, MRU-ordered: opening a project moves it to the top.

## Active project vs tab project

Aethon maintains an **active project** in the sidebar — that's where
*newly opened* tabs start.

::: warning Tabs are immutable
Once a tab is created, its `cwd` does not change — even if you switch
the active project after. To move work to a different cwd, open a new
tab in the new active project.
:::

## Project-local extensions

When the bridge boots a tab, it walks **upward** from the tab's cwd
looking for a `.aethon/extensions/` directory, stopping at the git root
(or `/` if the tab isn't in a git repo). Every `.ts` file it finds is
loaded as a project-local extension.

Example: a repo with shared team-wide extensions

```
my-repo/
├── .git/
├── .aethon/
│   └── extensions/
│       ├── team-slash-commands.ts
│       └── company-theme.ts
├── src/
└── README.md
```

When you open a tab anywhere inside `my-repo/`, those two extensions
load alongside the user-level extensions in `~/.aethon/extensions/`.
Project-local extensions can register components, themes, slash
commands, layouts — anything user extensions can.

::: tip Discoverability
Run `/extensions` to see every loaded extension and where it came from
(user / project / npm package).
:::

## Switching projects

Click a project in the sidebar to make it active. The active state is
persisted, so quitting and relaunching restores it.

The MRU order is updated whenever you activate a project.

## Removing a project

In the sidebar, hover the project entry → click the **×** button. The
directory itself is **not** deleted — only the entry in `projects.json`.
Tabs already open in that project keep working.

## Per-project pi sessions

Pi stores its conversation state under `~/.aethon/sessions/<tabId>/`.
Tabs share a project but **not** a pi session — every tab gets its own
transcript so you can run parallel conversations against the same repo.

When a tab is closed, its session directory remains; reopening (via
`Cmd+Opt+T` for the most-recent close) restores the conversation. To
permanently discard a session, run `/reset` in the tab.

## Where to next

- [Agent tabs](/guide/agent-tabs) — per-tab models, drafts, history.
- [Skills & extensions](/guide/skills-and-extensions) — writing extensions.
- [Configuration](/guide/configuration) — `[agent] model` for the default model in new tabs.
