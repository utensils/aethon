# Project-local `.aethon` configuration

Aethon can read lightweight project-local configuration from a repository's `.aethon/` directory. These files travel with the repo and do not require shipping a UI extension.

## Workspace startup commands

Agent tabs opened in a project or workspace run the startup sequence for that root before the agent session starts. Aethon first prepares the configured devshell/env provider, then runs approved commands from:

```text
<project>/.aethon/startup.toml
```

Startup commands are required by default. Required failures block agent startup and show Retry / Continue controls; optional failures are shown but do not block. Commands run once per root per app launch, and changed startup config must be approved again before commands run.

```toml
[startup]
timeout_seconds = 600

[[startup.commands]]
id = "deps"
label = "Install dependencies"
command = "bun install"

[[startup.commands]]
id = "codegen"
label = "Generate local types"
command = "bun run codegen"
required = false
timeout_seconds = 120
```

### Startup fields

The top-level `[startup]` table supports:

- `timeout_seconds` — default timeout for commands in this file. Defaults to 600 seconds and is capped at 24 hours.

Each `[[startup.commands]]` entry supports:

- `id` — stable command id for UI state. Defaults to `command-N` when omitted.
- `label` — human-readable task label. Defaults to `id`.
- `command` — shell command to run from the workspace root. Required.
- `required` — when `false`, failure is visible but non-blocking. Defaults to `true`.
- `timeout_seconds` — per-command timeout. Defaults to `[startup].timeout_seconds`.

Host-level config can enable the same behavior for every project:

```toml
# ~/.aethon/config.toml
[startup]
auto_approve = true
```

Project-level auto-approval is also available from the project overview tab, but that trust flag is stored in Aethon's user-owned startup approval store, not in `.aethon/startup.toml`. Repo-controlled project config can request commands, but it cannot approve its own commands to run. Host-level auto-approval is inherited and disables the project checkbox because the trust decision already applies globally.

## Issue-to-agent templates

The project dashboard's **Open issues** section reads optional templates from:

```text
<project>/.aethon/issues.toml
```

When a user sends a GitHub issue to an agent, matching templates replace the built-in handoff prompt. If the file is missing, malformed, or contains no matching valid template, Aethon falls back to the built-in prompt and shows a non-blocking warning for malformed config.

```toml
[issue_templates.default]
label = "Default implementation task"
new_workspace = true
branch = "{branchPrefix}/issue-{number}-{slug}"
prompt = """
Work on GitHub issue #{number}: {title}

URL: {url}
Author: {author}
Labels: {labels}
Comments: {comments}
Updated: {updatedAt}

Project: {projectLabel}
Path: {projectPath}

Issue body:
---
{body}
"""

[issue_templates.docs]
label = "Docs issue"
when_labels = ["documentation"]
new_workspace = true
branch_prefix = "docs"
branch = "{branchPrefix}/issue-{number}-{slug}"
prompt = """
Write documentation for issue #{number}: {title}

Follow this repository's docs style and run the docs test command before finalizing.

{body}
"""
```

### Template fields

Each template lives under `[issue_templates.<id>]`.

- `label` — human-readable menu label. Defaults to `<id>`.
- `prompt` — required multiline or single-line prompt template.
- `new_workspace` — optional default launch mode when choosing this template directly (the legacy `new_worktree` spelling is still accepted). Existing explicit actions for "new workspace" and "current workspace/branch" still force that mode.
- `branch` — optional branch name template for new workspace launches. Defaults to Aethon's built-in issue branch.
- `branch_prefix` — optional override for the `{branchPrefix}` variable.
- `when_labels` — optional list of GitHub label names. Matching is case-insensitive. Templates without `when_labels` are catch-all templates.

If multiple templates match an issue, label-specific templates are preferred over catch-all templates and the issue context menu includes template-specific choices.

### Variables

Prompt, `branch`, and `branch_prefix` may reference:

- `{number}`
- `{title}`
- `{url}`
- `{author}` — formatted as `@login` when available
- `{authorLogin}`
- `{body}`
- `{labels}` — comma-separated label names
- `{comments}`
- `{updatedAt}`
- `{slug}` — branch-safe issue-title slug
- `{branch}` — built-in generated issue branch
- `{branchPrefix}` — computed type prefix such as `feat`, `fix`, or `docs`
- `{projectId}`
- `{projectLabel}`
- `{projectPath}`

Unknown variables expand to an empty string.
