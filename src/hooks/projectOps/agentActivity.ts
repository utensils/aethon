import type { Tab } from "../../types/tab";
import { normalizeSessionPath } from "./tabBuckets";

/** Aggregate agent state for one sidebar scope (a project's main worktree,
 *  a specific worktree, or a project rollup):
 *   - `running`            — at least one agent turn is in flight.
 *   - `idle-with-session`  — an agent session exists but no turn is running
 *                            (i.e. it's waiting on the user's next input).
 *   - `none`               — no agent session for this scope. */
export type AgentActivity = "running" | "idle-with-session" | "none";

export interface AgentActivitySummary {
  status: AgentActivity;
  /** Agent tabs scoped here. */
  activeCount: number;
  /** Subset of `activeCount` with a turn currently in flight. */
  runningCount: number;
}

const NONE: AgentActivitySummary = {
  status: "none",
  activeCount: 0,
  runningCount: 0,
};

/** Whether `runningIds` is authoritative for liveness rather than each tab's
 *  own `waiting` flag. Background-workspace tabs live in a stashed bucket and
 *  never receive `updateTab` writes, so their `waiting` is stale; the live
 *  running set (maintained from prompt_started/response_end regardless of
 *  bucket) is the only trustworthy signal across every workspace. */
export function summarizeAgentTabs(
  tabs: readonly Tab[],
  runningIds: ReadonlySet<string>,
): AgentActivitySummary {
  let activeCount = 0;
  let runningCount = 0;
  for (const tab of tabs) {
    if (tab.kind !== "agent") continue;
    activeCount += 1;
    if (runningIds.has(tab.id)) runningCount += 1;
  }
  if (activeCount === 0) return NONE;
  return {
    status: runningCount > 0 ? "running" : "idle-with-session",
    activeCount,
    runningCount,
  };
}

interface WorktreeLike {
  path?: string;
  isMain?: boolean;
}

interface ProjectLike {
  id: string;
  worktrees?: WorktreeLike[];
}

/** A sidebar project item with agent-activity overlaid. The worktree shape is
 *  preserved apart from an optional `agent` summary added on non-main rows. */
export type WithAgentActivity<P extends ProjectLike> = Omit<P, "worktrees"> & {
  agent: AgentActivitySummary;
  agentRollup: AgentActivitySummary;
  worktrees: Array<
    NonNullable<P["worktrees"]>[number] & { agent?: AgentActivitySummary }
  >;
};

/** Overlay agent-activity summaries onto sidebar project items.
 *
 *  Scoping rules:
 *   - A non-main worktree row gets the agent tabs whose cwd matches its path.
 *   - The project line gets its "main scope" tabs: agent tabs with this
 *     `projectId` whose cwd is NOT one of the project's non-main worktrees
 *     (so a main-worktree session surfaces on the project line and the main
 *     worktree row stays dot-free — they share a path and would otherwise
 *     double up).
 *   - `agentRollup` summarises main ∪ every worktree, used when the project
 *     row is collapsed so a hidden active worktree still shows a dot.
 *
 *  `agentTabs` must already span every workspace (active `state.tabs` ∪ all
 *  stashed buckets); `runningIds` is the live in-flight set. */
export function attachAgentActivity<P extends ProjectLike>(
  projects: readonly P[],
  agentTabs: readonly Tab[],
  runningIds: ReadonlySet<string>,
): WithAgentActivity<P>[] {
  const tabsByCwd = new Map<string, Tab[]>();
  for (const tab of agentTabs) {
    if (tab.kind !== "agent") continue;
    const key = normalizeSessionPath(tab.cwd);
    const bucket = tabsByCwd.get(key);
    if (bucket) bucket.push(tab);
    else tabsByCwd.set(key, [tab]);
  }

  return projects.map((project) => {
    const worktrees = project.worktrees ?? [];
    const nonMainPaths = new Set(
      worktrees
        .filter((w) => !w.isMain)
        .map((w) => normalizeSessionPath(w.path)),
    );

    const mainTabs: Tab[] = [];
    const rollupTabs: Tab[] = [];
    for (const tab of agentTabs) {
      if (tab.kind !== "agent") continue;
      const cwdKey = normalizeSessionPath(tab.cwd);
      const belongsByProject = tab.projectId === project.id;
      const belongsByWorktree = nonMainPaths.has(cwdKey);
      if (belongsByProject && !belongsByWorktree) mainTabs.push(tab);
      if (belongsByProject || belongsByWorktree) rollupTabs.push(tab);
    }

    const nextWorktrees = worktrees.map((w) => {
      // Main worktree shares the project path — its activity is already
      // surfaced on the project line, so leave its row dot-free.
      if (w.isMain) return w;
      const wtTabs = tabsByCwd.get(normalizeSessionPath(w.path)) ?? [];
      return { ...w, agent: summarizeAgentTabs(wtTabs, runningIds) };
    });

    return {
      ...project,
      agent: summarizeAgentTabs(mainTabs, runningIds),
      agentRollup: summarizeAgentTabs(rollupTabs, runningIds),
      worktrees: nextWorktrees,
    };
  });
}
