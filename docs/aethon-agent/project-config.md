# Project-local `.aethon` configuration

Aethon can read lightweight project-local configuration from a repository's `.aethon/` directory. These files travel with the repo and do not require shipping a UI extension.

## Issue-to-agent templates

The project dashboard's **Open issues** section reads optional templates from `<project>/.aethon/issues.toml`.

When a user sends a GitHub issue to an agent, matching templates replace the built-in handoff prompt. If the file is missing, malformed, or contains no matching valid template, Aethon falls back to the built-in prompt and shows a non-blocking warning for malformed config.

```toml
[issue_templates.default]
label = "Default implementation task"
new_worktree = true
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
- `new_worktree` — optional default launch mode when choosing this template directly.
- `branch` — optional branch name template for new worktree launches. Defaults to Aethon's built-in issue branch.
- `branch_prefix` — optional override for the `{branchPrefix}` variable.
- `when_labels` — optional case-insensitive GitHub label names. Templates without `when_labels` are catch-all templates.

If multiple templates match an issue, label-specific templates are preferred over catch-all templates and the issue context menu includes template-specific choices.

### Variables

Prompt, `branch`, and `branch_prefix` may reference: `{number}`, `{title}`, `{url}`, `{author}`, `{authorLogin}`, `{body}`, `{labels}`, `{comments}`, `{updatedAt}`, `{slug}`, `{branch}`, `{branchPrefix}`, `{projectId}`, `{projectLabel}`, and `{projectPath}`. Unknown variables expand to an empty string.
