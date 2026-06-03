/**
 * Two-scope subagent loader.
 *
 * Reads `~/.aethon/agents/*.md` (user scope) then
 * `<projectCwd>/.aethon/agents/*.md` (project scope) and merges them by
 * canonical name (the file stem). Project scope is loaded second, so a
 * project `reviewer.md` overrides a user `reviewer.md`.
 *
 * Everything is best-effort: a missing directory, an oversized file, or a
 * malformed definition is recorded as a {@link SubagentLoadIssue} and skipped
 * — one bad file never breaks the registry.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AethonAgentState } from "../state";
import { isSafeSubagentName, parseSubagentMarkdown } from "./parse";
import type { Subagent, SubagentLoadIssue, SubagentScope } from "./types";

/** Hard cap on a single definition file, matching the config.toml convention. */
const MAX_SUBAGENT_BYTES = 64 * 1024;

export interface LoadSubagentsResult {
  /** Merged effective registry, project-wins-by-name. */
  byName: Map<string, Subagent>;
  issues: SubagentLoadIssue[];
}

export function userAgentsDir(userDir: string): string {
  return join(userDir, "agents");
}

export function projectAgentsDir(projectCwd: string): string {
  return join(projectCwd, ".aethon", "agents");
}

export function loadSubagents(opts: {
  userDir: string;
  projectCwd?: string | null;
}): LoadSubagentsResult {
  const byName = new Map<string, Subagent>();
  const issues: SubagentLoadIssue[] = [];
  loadScopeInto(byName, issues, userAgentsDir(opts.userDir), "user");
  if (opts.projectCwd) {
    loadScopeInto(byName, issues, projectAgentsDir(opts.projectCwd), "project");
  }
  return { byName, issues };
}

function loadScopeInto(
  byName: Map<string, Subagent>,
  issues: SubagentLoadIssue[],
  dir: string,
  scope: SubagentScope,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // ENOENT / unreadable — simply no subagents at this scope.
    return;
  }
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || !entry.toLowerCase().endsWith(".md")) continue;
    const filePath = join(dir, entry);
    const name = entry.slice(0, -3).toLowerCase();
    if (!isSafeSubagentName(name)) {
      issues.push({
        filePath,
        scope,
        error: `invalid subagent filename "${entry}" (name must be [a-z0-9_-], starting alphanumeric)`,
      });
      continue;
    }
    let raw: string;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SUBAGENT_BYTES) {
        issues.push({
          filePath,
          scope,
          error: `subagent file too large (${stat.size} bytes; max ${MAX_SUBAGENT_BYTES})`,
        });
        continue;
      }
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      issues.push({
        filePath,
        scope,
        error: `read failed: ${(err as Error).message}`,
      });
      continue;
    }
    const { subagent, error } = parseSubagentMarkdown(raw, {
      filePath,
      scope,
      name,
    });
    if (!subagent) {
      issues.push({ filePath, scope, error: error ?? "unknown parse error" });
      continue;
    }
    // Project scope loads after user scope, so this overrides by name.
    byName.set(name, subagent);
  }
}

/**
 * Re-merge the subagent registry into shared state from the current user dir
 * and active project cwd. Called at boot, on project change, and when the UI
 * edits a definition. Cheap and synchronous (a handful of small file reads).
 */
export function refreshSubagents(state: AethonAgentState): void {
  const { byName, issues } = loadSubagents({
    userDir: state.userDir,
    projectCwd: state.currentProjectCwd,
  });
  state.subagents.clear();
  for (const [name, sub] of byName) state.subagents.set(name, sub);
  state.subagentIssues = issues;
}
