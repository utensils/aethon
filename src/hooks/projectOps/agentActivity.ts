import type { Tab } from "../../types/tab";
import { normalizeSessionPath } from "./tabBuckets";

/** Aggregate agent state for one sidebar scope (a project's main workspace,
 *  a specific workspace, or a project rollup):
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

interface WorkspaceLike {
  path?: string;
  isMain?: boolean;
}

interface ProjectLike {
  id: string;
  workspaces?: WorkspaceLike[];
}

/** A sidebar project item with agent-activity overlaid. The workspace shape is
 *  preserved apart from an optional `agent` summary added on non-main rows. */
export type WithAgentActivity<P extends ProjectLike> = Omit<P, "workspaces"> & {
  agent: AgentActivitySummary;
  agentRollup: AgentActivitySummary;
  workspaces: Array<
    NonNullable<P["workspaces"]>[number] & { agent?: AgentActivitySummary }
  >;
};

/** Overlay agent-activity summaries onto sidebar project items.
 *
 *  Scoping rules:
 *   - A non-main workspace row gets the agent tabs whose cwd matches its path.
 *   - The project line gets its "main scope" tabs: agent tabs with this
 *     `projectId` whose cwd is NOT one of the project's non-main workspaces
 *     (so a main-workspace session surfaces on the project line and the main
 *     workspace row stays dot-free — they share a path and would otherwise
 *     double up).
 *   - `agentRollup` summarises main ∪ every workspace, used when the project
 *     row is collapsed so a hidden active workspace still shows a dot.
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
    const workspaces = project.workspaces ?? [];
    const nonMainPaths = new Set(
      workspaces
        .filter((w) => !w.isMain)
        .map((w) => normalizeSessionPath(w.path)),
    );

    const mainTabs: Tab[] = [];
    const rollupTabs: Tab[] = [];
    for (const tab of agentTabs) {
      if (tab.kind !== "agent") continue;
      const cwdKey = normalizeSessionPath(tab.cwd);
      const belongsByProject = tab.projectId === project.id;
      const belongsByWorkspace = nonMainPaths.has(cwdKey);
      if (belongsByProject && !belongsByWorkspace) mainTabs.push(tab);
      if (belongsByProject || belongsByWorkspace) rollupTabs.push(tab);
    }

    const nextWorkspaces = workspaces.map((w) => {
      // Main workspace shares the project path — its activity is already
      // surfaced on the project line, so leave its row dot-free.
      if (w.isMain) return w;
      const wtTabs = tabsByCwd.get(normalizeSessionPath(w.path)) ?? [];
      return { ...w, agent: summarizeAgentTabs(wtTabs, runningIds) };
    });

    return {
      ...project,
      agent: summarizeAgentTabs(mainTabs, runningIds),
      agentRollup: summarizeAgentTabs(rollupTabs, runningIds),
      workspaces: nextWorkspaces,
    };
  });
}
