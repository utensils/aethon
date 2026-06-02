/**
 * Per-turn "Working context" section.
 *
 * Appended to the system prompt by the `before_agent_start` hook (see
 * `agent/main.ts`) on every turn, so the model always knows the *active
 * tab's* working directory and live git state — the shared runtime snapshot
 * can't, because it's resolved once at `resourceLoader.reload()` (outside any
 * tab context) and reports the agent process's launch dir for every tab.
 *
 * Kept compact and imperative: a confused local model benefits from a short,
 * unambiguous "you are here, stay here" anchor far more than prose.
 */

import type { GitWorkingContext } from "../git-context";

export interface WorkingContextInput {
  /** The active tab's resolved working directory. */
  cwd: string;
  /** Git facts for `cwd`, or null when it isn't a git work tree / lookup
   *  failed. */
  git: GitWorkingContext | null;
  /** Optional user-configured advisory text (`[guardrails] soft_prompt_anchor`). */
  softAnchor?: string;
}

export function buildWorkingContextSection(input: WorkingContextInput): string {
  const { cwd, git, softAnchor } = input;
  const lines: string[] = ["# Working context (this turn)"];
  lines.push(`Working directory: \`${cwd}\``);

  if (git) {
    if (git.repoRoot && git.repoRoot !== cwd) {
      lines.push(`Repository root: \`${git.repoRoot}\``);
    }
    const parts: string[] = [];
    if (git.branch) {
      parts.push(`branch \`${git.branch}\`${git.isWorktree ? " (worktree)" : ""}`);
    }
    parts.push(
      git.changedFiles === 0
        ? "working tree clean"
        : `${git.changedFiles} changed file${git.changedFiles === 1 ? "" : "s"}`,
    );
    if (git.ahead > 0 || git.behind > 0) {
      parts.push(`ahead ${git.ahead} / behind ${git.behind}`);
    }
    lines.push(`Git: ${parts.join(", ")}.`);
  } else {
    lines.push("Git: not a git repository.");
  }

  lines.push(
    "Operate within this directory. Your tools (bash, read, edit, write) run " +
      "here by default — use paths relative to it, and do not `cd` to or modify " +
      "files outside it unless the user explicitly asks.",
  );

  const anchor = softAnchor?.trim();
  if (anchor) {
    lines.push("");
    lines.push(anchor);
  }

  return lines.join("\n");
}
