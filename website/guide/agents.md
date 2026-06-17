# Agents

An **agent** is the pi conversation engine that drives a tab: its own
chat history, model selection, working directory, and toolset. Each
[agent tab](/guide/agent-tabs) is exactly one agent. This page covers the
runtime underneath that container: how a tab maps onto the bridge, how to
run different tabs under different accounts, how to delegate work to
subagents, and how to customize the system prompt the model sees.

For the tab UI (the strip, composer, queueing, model picker), see
[Agent tabs](/guide/agent-tabs).

## What an agent is

A single `bun` bridge process serves **every** tab. It is tab-aware but
not tab-specific: there is one process, and per-turn context tracks which
tab's turn is currently active so per-turn hooks inject the right data.

Each agent tab is one **pi session**, persisted at
`~/.aethon/sessions/<tabId>/`. When a tab resumes after a crash or
reload, pi loads the transcript from there.

The bridge speaks JSON lines over stdio:

- Rust to bridge (stdin): a `chat` message routes to the active tab and
  drives its pi session.
- Bridge to Rust (stdout): per-line events such as `agent-response`,
  which Rust relays to the frontend as Tauri events.

Per-tab state stays isolated:

- **Working directory**: each tab is bound to a project root. Switching
  the active project affects **new** tabs; existing tabs keep their cwd.
- **Model**: each tab tracks its own active model. Switching models in
  one tab does not affect any other.
- **Working context**: on every turn, the bridge reads the active tab's
  cwd and injects a fresh "Working context" section describing that tab's
  git state. Tabs on different projects see different git info, different
  working directories, and different subagents.

## Models and providers

The default model for new tabs comes from `[agent] model` in
`~/.aethon/config.toml`. The format is `provider/model-id`:

```toml
[agent]
model = "anthropic/claude-sonnet-4-6"
```

Other examples: `openai/gpt-4o`, `ollama/llama3.3`. The `/model` slash
command updates the **active** tab's model and persists the choice as the
default for new tabs. See [Agent tabs](/guide/agent-tabs#switching-models)
for the picker UI and [config.toml reference](/reference/config-reference)
for the field.

Provider credentials come from the **shell environment**, not from
Aethon's config. The bridge delegates authentication to pi: it does not
set, validate, or modify these variables.

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude). |
| `OPENAI_API_KEY` | OpenAI. |

Other provider keys are read as the configured models need them.

::: warning
Tauri does not set provider keys. Export them in your shell before
launching Aethon, or use [Auth profiles](#auth-profiles-multiple-accounts)
for OAuth and per-account credentials. Changing an environment variable
requires a restart to take effect.
:::

## Auth profiles (multiple accounts)

Auth profiles let different tabs authenticate as different accounts: a
personal Claude account in one tab, a work account in another, several
Ollama hosts side by side. They are managed with the `/login` slash
command (see also [Slash commands](/reference/slash-commands)) or the
account-manager modal.

### Profile kinds

Each profile is scoped to a provider and is one of two kinds:

| Kind | Use |
|---|---|
| `oauth` | Browser login flow (Anthropic, OpenAI, and similar). |
| `api_key` | A directly stored API key (a self-hosted Ollama, an API-key Anthropic account). |

### Storage

Everything lives under `~/.aethon/auth/`:

- `~/.aethon/auth/profiles.json` holds the metadata (the version, the
  list of profiles, and the per-provider defaults).
- `~/.aethon/auth/profiles/<id>/auth.json` holds one profile's
  credentials, isolated per profile, so the metadata file never contains
  tokens or keys. Each profile gets its own pi `AuthStorage` instance
  pointing at its own `auth.json`.

Profile IDs are sanitized to lowercase `[a-z0-9_-]`, hyphen-collapsed,
and truncated to at most 48 characters when generated; any id touching
disk is validated against `/^[a-z0-9_-]{1,80}$/` first, so a crafted id
cannot escape the `auth/profiles/` tree.

### Per-provider defaults and per-tab overrides

The model is a hybrid of provider-wide defaults and per-tab choices:

- **Per-provider default**: each provider has at most one default
  profile (stored in `defaultByProvider`). When a tab opens and its
  model's provider has a default profile, that profile is activated for
  the tab automatically.
- **Per-tab override**: a tab can switch to any profile mid-session with
  `/login use <account>`. Switching recreates the tab's session in the
  new profile's model registry; prior context is preserved if the model
  still exists in the new profile.
- **Default resolution**: when a tab has no explicit override, Aethon
  resolves a default in order: the initial model's provider default, then
  the global default provider's default, then the global default model's
  provider's default, then (if exactly one default exists across all
  providers) that sole default. If multiple or zero defaults exist, none
  is chosen.

### The `/login` command

```
/login [list | use <account> | default <account>]
```

| Command | Action |
|---|---|
| `/login` | Open the account-manager modal. |
| `/login list` | List stored accounts: id, label, provider, kind, and `active` / `default` flags. |
| `/login use <account>` | Switch the **active tab** to a profile (matched by id, then by label). Blocked while the agent is busy. |
| `/login default <account>` | Set a profile as its provider's default for new tabs. |

Lookups match by **id first, then label**.

::: tip
Label matching is case-sensitive. Renaming a profile's label is done in
the account-manager modal; it is not exposed as a `/login` subcommand.
:::

### Example sequence

Two accounts: a personal Claude account and a work OpenAI account.

```bash
# 1. Open the account manager and add accounts via the browser login flow.
/login

# 2. List what you have. Profiles are created with sanitized ids.
/login list
# Stored accounts:
# - `anthropic-claude-home` (Claude Home; anthropic, oauth, default)
# - `openai-codex-work` (Work OpenAI; openai-codex, oauth, default)

# 3. Switch the current tab to the home Claude account.
#    Its session is recreated in that profile's registry.
/login use anthropic-claude-home

# 4. Make the work OpenAI profile the default for the OpenAI provider.
#    Future tabs opening on an OpenAI model use it.
/login default openai-codex-work

# 5. A bad lookup is reported, not silently ignored.
/login use nonexistent
# Unknown account: nonexistent
```

::: warning
`/login use` is blocked while the agent is mid-turn ("agent busy: stop
the current prompt before switching accounts"). Stop or finish the turn
first.
:::

## Subagents

Subagents are specialized agents the main agent delegates work to through
its built-in `task` tool. Each runs as an isolated pi session and never
receives the `task` tool itself, so delegation cannot recurse.

### Where they live

Subagent definitions are Markdown files with YAML frontmatter, in two
scopes:

| Scope | Path |
|---|---|
| User (global) | `~/.aethon/agents/<name>.md` |
| Project (local) | `<project>/.aethon/agents/<name>.md` |

The filename stem is the canonical subagent name (`reviewer.md` is
`reviewer`). Names must match `[a-z0-9][a-z0-9_-]{0,63}`: lowercase
alphanumeric with hyphens and underscores, starting with an alphanumeric
character, at most 64 characters.

Both scopes are loaded and merged by name, with **project scope loaded
second (later wins)**. A project `reviewer.md` entirely overrides a user
`reviewer.md` of the same name. Distinct names coexist: a user
`reviewer.md` and a project `planner.md` both appear in the registry.

### Frontmatter fields

Every definition opens with a YAML frontmatter block between two `---`
lines. The Markdown body below becomes the subagent's system prompt (it
is trimmed and may be empty).

| Field | Required | Type | Default | Description |
|---|---|---|---|---|
| `description` | yes | string | (none) | Drives auto-delegation (the main agent picks the best-fit description) and is shown in the UI and the system-prompt advertisement. |
| `model` | no | `provider/model-id` | inherits the delegating tab's model | The model this subagent runs on (`ollama/llama3.3`, `openai/gpt-4o`). |
| `tools` | no | list or comma-separated string | inherits the full toolset | Tool allowlist. `[]` or `""` locks it to reasoning-only with no tools. Accepts `[read, grep, bash]` or `"read, grep, bash"`. Deduplicated, order-preserved. |
| `surface` | no | `inline` \| `tab` | `inline` | Where the run surfaces. `inline` streams into the delegating turn's tool card; `tab` launches its own agent tab. |
| `timeout` | no | number (seconds) | `[agent] subagent_timeout_seconds` (300) | Inline run timeout. Frontmatter wins over config. Clamped to [1, 86400]. |

### Invoking a subagent

The main agent delegates with its `task` tool:

```ts
task({
  subagent_type: "reviewer",            // canonical subagent name
  prompt: "<self-contained task>",      // full instructions for the subagent
  context: "<optional extra context>",  // prepended to the prompt
});
```

For independent fan-out, the main agent uses `task_batch`:

```ts
task_batch({
  surface: "inline", // default; use "background" only when requested
  tasks: [
    { subagent_type: "kimi", prompt: "<self-contained task>" },
    { subagent_type: "glm-5-2", prompt: "<self-contained task>" },
  ],
});
```

There are two ways a subagent gets picked:

- **Auto-delegation**: the system-prompt advertisement (generated from
  the available subagents) nudges the main model to choose a subagent
  whose `description` best fits the task.
- **Explicit invocation**: prefix a chat message with `@<name>` (for
  example `@reviewer`) to force delegation. Detection is case-insensitive;
  Aethon appends a one-shot steer telling the model to call `task`
  immediately with that subagent's name. Multiple leading mentions such as
  `@kimi and @glm-5-2 peer review` steer the model to `task_batch`. Words
  like `async`, `background`, `don't wait`, or `separate tabs` request
  non-focused background task tabs; otherwise fan-out runs inline.

### Inline vs tab surface

| | `inline` (default) | `tab` |
|---|---|---|
| Runs in | an isolated pi session inside the main agent's flow | its own agent tab via the task launcher (`aethon.tasks.start`) |
| Progress | streams live into the outer tool card; emits a `subagent_progress` sidecar | independent; the delegating turn does not stream it |
| `task` result | the subagent's final text summary, returned to the main conversation | an immediate confirmation message |
| Timeout | enforced on the subagent session | not enforced on the delegating turn (the tab manages its own) |

### Tools, bash, and auth

- **Tools**: if `tools` is set, only those tools are available
  (deduplicated, order-preserved). If omitted, the full toolset is
  inherited. An empty list means no tools at all.
- **Bash and the devshell**: if `bash` is in the allowlist (or
  inherited), the subagent's bash tool shadows the main one with a
  devshell-aware spawn hook, so it inherits the project's Nix environment.
- **Model and auth**: resolved from the provider registry. With an
  explicit `model`, that provider's services (and credentials) are used.
  Without one, the subagent inherits the delegating tab's model and auth
  profile.

### Resolution and timeout precedence

Subagents are resolved against the **delegating tab's cwd**, not a global
registry, so a tab on project A always delegates to project A's
subagents even when several projects are open. The registry is memoized
per cwd and invalidated when a definition is created, edited, or deleted.

The inline timeout is resolved in order, highest precedence first:

1. The subagent's frontmatter `timeout`.
2. The `AETHON_SUBAGENT_TIMEOUT_SECONDS` environment variable (passed by
   Tauri).
3. The `[agent] subagent_timeout_seconds` config field (default 300).
4. The built-in default of 300 seconds.

All values are clamped to [1, 86400] seconds (1 second to 24 hours). See
[`[agent] subagent_timeout_seconds`](/reference/config-reference) for the
config field.

### System prompt for a subagent run

When a subagent runs, its system prompt is composed from its body plus
the delegated task:

```
<subagent markdown body>

---

Task:
<context from task params, if any>
<delegated prompt from task params>
```

### Load issues

When a definition cannot be read or parsed, Aethon records a
`SubagentLoadIssue` rather than throwing. The issue carries the absolute
`filePath`, the `scope` (`user` or `project`), and a human-readable
`error` (for example "missing YAML frontmatter", "invalid subagent
filename", or "read failed: Permission denied"). Issues are surfaced in
Settings so you know which definitions are broken, without taking down
the rest of the registry.

### Example: a full code reviewer

`~/.aethon/agents/code-reviewer.md`:

```markdown
---
description: Reviews code diffs for correctness, edge cases, and best practices.
model: ollama/llama3.3
tools: [read, grep, bash]
surface: inline
timeout: 600
---
You are a meticulous code reviewer with expertise in software engineering
best practices.

Your job is to review code changes and provide constructive feedback.

When asked to review a diff, diff output, or a PR:
1. Identify potential bugs, edge cases, security issues, or performance problems.
2. Check for code style consistency with the project's conventions.
3. Suggest improvements to readability and maintainability.
4. Flag incomplete implementations or TODOs that need attention.

Be concise: focus on the most important issues first. Use references
(file paths, line numbers) when pointing out specific problems.
```

This subagent runs on `ollama/llama3.3` with only `read`, `grep`, and
`bash`, inline, with a 600-second (10-minute) ceiling. The main agent may
auto-select it when a task mentions code review, or you can force it with
`@code-reviewer Review this diff: ...`. Its final text summary becomes the
`task` tool result.

### Example: a minimal reasoning-only planner

`<project>/.aethon/agents/planner.md`:

```markdown
---
description: Plans and breaks down complex tasks into steps.
tools: []
---
You are a strategic planning assistant. Break down complex software
projects and tasks into clear, actionable steps.

When given a task:
1. Understand the goal and constraints.
2. List the key phases and dependencies.
3. Estimate effort and risk.
4. Suggest a sequence that minimizes rework.

Keep your output focused and structured.
```

This one inherits the delegating tab's model (no `model` field), runs
inline with the default 300-second timeout, and `tools: []` gives it no
tools: pure reasoning, no file access, no bash.

## System prompt customization

Two optional files in `~/.aethon/` let you customize the system prompt
without touching code:

| File | Effect |
|---|---|
| `~/.aethon/system-prompt.md` | **Full override.** Replaces Aethon's base prompt entirely. |
| `~/.aethon/system-prompt-append.md` | **Light append.** Concatenated after the base. **Ignored when the override file exists.** |

Choose one, not both. The override is for a complete rewrite of Aethon's
contract description; the append is for org guardrails or reminders on top
of the default.

### Composition order

The system prompt is layered and rebuilt as follows:

1. **Pi's default system prompt**: the static pi agent contract.
2. **Aethon base template**: describes the desktop-app context, A2UI
   component types, the runtime API, and caveats. **Replaced by
   `system-prompt.md` if present.**
3. **Append file**: `system-prompt-append.md`, concatenated after the
   base (ignored when an override is present).
4. **Runtime snapshot**: build mode, loaded and failed extensions,
   registered themes/components/commands/keybindings/layouts, open tabs,
   and frontend UI state.
5. **Working context** (per turn): the active tab's cwd, its git status
   (branch, changed files, ahead/behind), and the optional soft guardrail
   anchor.
6. **Subagents advertisement** (per turn): the available subagents for
   the active tab's cwd, if any.

::: tip
Layers 1 to 4 are cached and rebuilt on `resourceLoader.reload()` (on
extension changes, project switches, or settings changes). Layers 5 and 6
are rebuilt **every turn**, so the model always sees fresh git state and
the right per-tab subagents.
:::

### Applying changes

Both files are read as UTF-8 on each `resourceLoader.reload()`. Edits
take effect on the next reload: `touch agent/main.ts` in a dev build,
switch extensions, or restart the app.

### Example: a full override

`~/.aethon/system-prompt.md`:

```markdown
# Aethon Custom Contract

You are running in a highly customized Aethon workspace built for the Acme
Analytics team. The UI renders A2UI components, and you have direct access
to the runtime API at `globalThis.aethon`.

## Custom rules for this workspace

- Always prefer tabular output over prose for data.
- Project extensions are loaded from `/opt/acme/aethon/` and must NOT be
  modified by you; they are managed by DevOps.
- Use the `/acme-gql` slash command to query the internal GraphQL API
  before making any data decisions.
```

### Example: a light append

`~/.aethon/system-prompt-append.md`:

```markdown
# Custom Company Guidelines

## Code review checklist

Before suggesting code changes, verify:
1. The change fits the active project's architecture.
2. Security: no hardcoded secrets, credentials, or sensitive data in logs.
3. Performance: for data-heavy operations, prefer async plus caching.

## Guardrails

- Do not recommend `sudo` without asking the user first.
- If a test suite exists, run it before proposing changes.
```

The soft guardrail anchor (`[guardrails] soft_prompt_anchor` in
`config.toml`) is a complementary path: it is appended into the per-turn
working context rather than the base prompt. See
[config.toml reference](/reference/config-reference) for that field.

## Agent-driven UI customization

The agent can mutate the UI through the same `globalThis.aethon` surface
that extensions use (mirrored agent-side): `setLayout`,
`registerComponent`, `registerTheme`, `registerLayout`,
`registerSlashCommand`, notifications, and introspection. For authoring,
see the [Extensions guide](/guide/extensions), the
[Runtime API reference](/reference/runtime-api), and the bundled
`docs/aethon-agent/` reference (`api.md`, `components.md`,
`extensions.md`) that ships in the app at `$AETHON_DOCS_DIR`.

::: tip
The bundled `docs/aethon-agent/` authoring references are not yet
published on this site. The agent reads them directly from the app
bundle.
:::

## Where to next

- [Agent tabs](/guide/agent-tabs): the tab UI (strip, composer, queueing).
- [Shells & share modes](/guide/shells-and-share-modes): bottom-panel PTY tabs.
- [Extensions](/guide/extensions): registering UI, themes, and commands.
- [Configuration](/guide/configuration): `config.toml` essentials.
- [Slash commands](/reference/slash-commands): `/login`, `/model`, and the rest.
- [config.toml reference](/reference/config-reference): `[agent]` fields and timeout knobs.
- [Runtime API](/reference/runtime-api): `globalThis.aethon` signatures.
