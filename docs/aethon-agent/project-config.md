# Project-local `.aethon` configuration

Aethon can read lightweight project-local configuration from a repository's `.aethon/` directory. These files travel with the repo and do not require shipping a UI extension.

## Workspace startup commands

Agent tabs opened in a project or workspace run startup work for that root before the agent session starts. Aethon prepares the devshell/env provider first, then runs approved commands from `<project>/.aethon/startup.toml`.

Commands are required by default, run once per root per app launch, and changed command config requires approval again.

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

Fields:

- `[startup].timeout_seconds` — default command timeout in seconds.
- `id` — stable command id; defaults to `command-N`.
- `label` — task label; defaults to `id`.
- `command` — shell command run from the workspace root.
- `required` — failure blocks startup unless `false`; defaults to `true`.
- `timeout_seconds` — per-command timeout.

Users can also trust startup commands globally from `~/.aethon/config.toml`:

```toml
[startup]
auto_approve = true
```

Project-level trust is available from the project overview tab, but it is stored in Aethon's user-owned startup approval store. Project-local `.aethon/startup.toml` is repo-controlled and cannot approve its own commands to run.

## Issue-to-agent templates

The project dashboard's **Open issues** section reads optional templates from `<project>/.aethon/issues.toml`.

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

Issue body:
---
{body}
"""

[issue_templates.docs]
label = "Docs issue"
when_labels = ["documentation"]
branch_prefix = "docs"
prompt = "Write documentation for #{number}: {title}\n\n{body}"
```

### Template fields

Each template lives under `[issue_templates.<id>]`.

- `label` — human-readable menu label. Defaults to `<id>`.
- `prompt` — required multiline or single-line prompt template.
- `new_workspace` — optional default launch mode when choosing this template directly (the legacy `new_worktree` spelling is still accepted).
- `branch` — optional branch name template for new workspace launches. Defaults to Aethon's built-in issue branch.
- `branch_prefix` — optional override for the `{branchPrefix}` variable.
- `when_labels` — optional case-insensitive GitHub label names. Templates without `when_labels` are catch-all templates.

If multiple templates match an issue, label-specific templates are preferred over catch-all templates and the issue context menu includes template-specific choices.

### Variables

Prompt, `branch`, and `branch_prefix` may reference: `{number}`, `{title}`, `{url}`, `{author}`, `{authorLogin}`, `{body}`, `{labels}`, `{comments}`, `{updatedAt}`, `{slug}`, `{branch}`, `{branchPrefix}`, `{projectId}`, `{projectLabel}`, and `{projectPath}`. Unknown variables expand to an empty string.
