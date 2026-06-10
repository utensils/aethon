// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEmptyTab, NO_PROJECT_KEY, type Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";
import { installTauriMocks, clearTauriMocks } from "../../test/tauriMocks";
import {
  isOrphanWorkspaceTab,
  sweepOrphanWorkspaceTabs,
  type OrphanTabSweepDeps,
} from "./orphanTabSweep";
import { projectScopeBucketKey } from "./tabBuckets";
import type { TabBucket } from "./types";

afterEach(() => {
  clearTauriMocks();
});

const ref = <T>(value: T) => ({ current: value });

function makeProjects(overrides: Partial<ProjectsState> = {}): ProjectsState {
  return {
    projects: [
      {
        id: "project-1",
        label: "aethon",
        path: "/projects/aethon",
        lastUsed: 1,
      },
    ],
    activeId: "project-1",
    activeWorkspaceId: null,
    workspacesByProject: {
      "project-1": [
        {
          id: "ws-main",
          projectId: "project-1",
          path: "/projects/aethon",
          branch: "main",
          isMain: true,
        },
        {
          id: "ws-live",
          projectId: "project-1",
          path: "/projects/aethon-live",
          branch: "live",
          isMain: false,
        },
      ],
    },
    activeHostId: null,
    ...overrides,
  };
}

function agentTab(id: string, projectId: string | null, cwd?: string): Tab {
  return {
    ...makeEmptyTab(id, id, projectId),
    ...(cwd ? { cwd } : {}),
  };
}

function makeDeps(
  projects: ProjectsState,
  tabs: Tab[],
  buckets: Record<string, TabBucket> = {},
  persisted?: Record<string, TabBucket>,
) {
  const stateRef = ref<Record<string, unknown>>({
    tabs,
    activeTabId: tabs[0]?.id,
    closedSessionIds: [],
    ...(persisted ? { persistedTabBuckets: persisted } : {}),
  });
  const setState = vi.fn(
    (
      next:
        | Record<string, unknown>
        | ((prev: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      stateRef.current =
        typeof next === "function" ? next(stateRef.current) : next;
    },
  );
  const closeTabNow = vi.fn((tabId: string) => {
    stateRef.current = {
      ...stateRef.current,
      tabs: ((stateRef.current.tabs as Tab[]) ?? []).filter(
        (tab) => tab.id !== tabId,
      ),
    };
  });
  const deps: OrphanTabSweepDeps = {
    setState,
    stateRef,
    projectsRef: ref(projects),
    tabBucketsRef: ref(new Map(Object.entries(buckets))),
    closeTabNow,
    syncRecentSessionsToState: vi.fn(),
  };
  return { deps, stateRef, setState, closeTabNow };
}

describe("isOrphanWorkspaceTab", () => {
  it("flags a tab whose cwd resolves to no live project or workspace", () => {
    const projects = makeProjects();
    expect(
      isOrphanWorkspaceTab(
        projects,
        agentTab("t", "project-1", "/projects/aethon-deleted"),
      ),
    ).toBe(true);
  });

  it("keeps tabs on live workspace, main, unknown-list, and no-project paths", () => {
    const projects = makeProjects();
    expect(
      isOrphanWorkspaceTab(
        projects,
        agentTab("a", "project-1", "/projects/aethon-live"),
      ),
    ).toBe(false);
    expect(
      isOrphanWorkspaceTab(
        projects,
        agentTab("b", "project-1", "/projects/aethon/src"),
      ),
    ).toBe(false);
    // No projectId — not ours to judge.
    expect(
      isOrphanWorkspaceTab(projects, agentTab("c", null, "/somewhere")),
    ).toBe(false);
    // Workspace list not loaded — "deleted" is indistinguishable from
    // "not yet fetched".
    const unloaded = makeProjects({ workspacesByProject: {} });
    expect(
      isOrphanWorkspaceTab(
        unloaded,
        agentTab("d", "project-1", "/projects/aethon-deleted"),
      ),
    ).toBe(false);
    // Cwd-less tabs are spared.
    expect(isOrphanWorkspaceTab(projects, agentTab("e", "project-1"))).toBe(
      false,
    );
  });
});

describe("sweepOrphanWorkspaceTabs", () => {
  it("closes visible orphan tabs and spares resolvable ones", () => {
    const harness = installTauriMocks();
    const projects = makeProjects();
    const orphan = agentTab("orphan", "project-1", "/projects/aethon-deleted");
    const live = agentTab("live", "project-1", "/projects/aethon-live");
    const { deps, closeTabNow } = makeDeps(projects, [orphan, live]);

    sweepOrphanWorkspaceTabs(deps);

    expect(closeTabNow).toHaveBeenCalledWith("orphan");
    expect(closeTabNow).not.toHaveBeenCalledWith("live");
    // Visible closes go through closeTabNow (which owns suppression);
    // no direct tab_close should be sent for them here.
    expect(
      harness.invoke.mock.calls.filter(([cmd]) => cmd === "agent_command"),
    ).toHaveLength(0);
  });

  it("prunes buckets whose workspace id is gone and suppresses their sessions", () => {
    const harness = installTauriMocks();
    const projects = makeProjects();
    const deadKey = projectScopeBucketKey("project-1", "ws-deleted");
    const liveKey = projectScopeBucketKey("project-1", "ws-live");
    const deadBucket: TabBucket = {
      tabs: [agentTab("dead-tab", "project-1", "/projects/aethon-deleted")],
      activeTabId: "dead-tab",
    };
    const liveBucket: TabBucket = {
      tabs: [agentTab("live-tab", "project-1", "/projects/aethon-live")],
      activeTabId: "live-tab",
    };
    const { deps, stateRef } = makeDeps(
      projects,
      [],
      { [deadKey]: deadBucket, [liveKey]: liveBucket },
      { [deadKey]: deadBucket, [liveKey]: liveBucket },
    );

    sweepOrphanWorkspaceTabs(deps);

    expect(deps.tabBucketsRef.current.has(deadKey)).toBe(false);
    expect(deps.tabBucketsRef.current.has(liveKey)).toBe(true);
    const persisted = stateRef.current.persistedTabBuckets as Record<
      string,
      TabBucket
    >;
    expect(persisted[deadKey]).toBeUndefined();
    expect(persisted[liveKey]).toBeDefined();
    expect(stateRef.current.closedSessionIds).toContain("dead-tab");
    expect(harness.invoke).toHaveBeenCalledWith("agent_command", {
      payload: JSON.stringify({ type: "tab_close", tabId: "dead-tab" }),
    });
  });

  it("filters orphan tabs out of live buckets and keeps the rest", () => {
    installTauriMocks();
    const projects = makeProjects();
    const liveKey = projectScopeBucketKey("project-1", "ws-live");
    const { deps, stateRef } = makeDeps(projects, [], {
      [liveKey]: {
        tabs: [
          agentTab("stale", "project-1", "/projects/aethon-deleted"),
          agentTab("fresh", "project-1", "/projects/aethon-live"),
        ],
        activeTabId: "stale",
      },
    });

    sweepOrphanWorkspaceTabs(deps);

    const bucket = deps.tabBucketsRef.current.get(liveKey);
    expect(bucket?.tabs.map((tab) => tab.id)).toEqual(["fresh"]);
    expect(bucket?.activeTabId).toBe("fresh");
    expect(stateRef.current.closedSessionIds).toContain("stale");
  });

  it("leaves the no-project bucket and unknown projects alone", () => {
    installTauriMocks();
    const projects = makeProjects();
    const homeless: TabBucket = {
      tabs: [agentTab("homeless", null, "/Users/me/.aethon")],
      activeTabId: "homeless",
    };
    const foreignKey = projectScopeBucketKey("project-unknown", "ws-x");
    const foreign: TabBucket = {
      tabs: [agentTab("foreign", "project-unknown", "/elsewhere")],
      activeTabId: "foreign",
    };
    const { deps, setState } = makeDeps(projects, [], {
      [NO_PROJECT_KEY]: homeless,
      [foreignKey]: foreign,
    });

    sweepOrphanWorkspaceTabs(deps);

    expect(deps.tabBucketsRef.current.get(NO_PROJECT_KEY)).toBe(homeless);
    expect(deps.tabBucketsRef.current.get(foreignKey)).toBe(foreign);
    expect(setState).not.toHaveBeenCalled();
  });
});
