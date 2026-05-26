import { useEffect, useRef } from "react";
import {
  activeProject,
  loadProjects,
  pickProjectDirectory,
  removeProject,
  upsertProject,
} from "../projects";
import { NO_PROJECT_KEY, type Tab } from "../types/tab";
import { disposeEditorBuffer } from "../monaco/editor-buffers";
import { useProjectStore } from "./projectOps/projectStore";
import {
  projectScopeBucketKey,
  switchProjectBucket as switchTabBucket,
} from "./projectOps/tabBuckets";
import { useWorktreeOperations } from "./projectOps/worktreeOperations";
import type {
  DiscoveredSession,
  TabBucket,
  UseProjectOpsActions,
  UseProjectOpsContext,
} from "./projectOps/types";

export type {
  DiscoveredSession,
  RecentSessionItem,
  SidebarHistoryItem,
  UseProjectOpsActions,
  UseProjectOpsContext,
} from "./projectOps/types";

export {
  nonEmptyProjectTabs,
  projectIdFromBucketKey,
  projectScopeBucketKey,
  tabsForProjectBucket,
  worktreeIdForCwd,
} from "./projectOps/tabBuckets";

/**
 * Project list management + the per-project tab bucket model. Owns:
 *   - `projectsRef` — in-memory project list.
 *   - `tabBucketsRef` — per-project tab snapshots.
 *   - `allDiscoveredSessionsRef` — bridge-discovered sessions awaiting
 *     restore (filtered to the active project's cwd).
 *
 * The hook is intentionally a facade. Store/mirror projection lives in
 * `projectStore`, bucket transitions in `tabBuckets`, and worktree state
 * mutations in `worktreeOperations`.
 */
export function useProjectOps(ctx: UseProjectOpsContext): UseProjectOpsActions {
  const {
    setState,
    stateRef,
    projectsRef,
    gitStatusRef,
    refreshGitStatusFor,
    refreshAllGitStatus,
    announceProjectToBridge,
    watchProjectForBridge,
    unwatchProjectForBridge,
    dispatchTerminalReplay,
    autoRestoreDiscoveredSessions,
    closeTabNow,
  } = ctx;

  const projectsLoadedRef = useRef(false);
  const allDiscoveredSessionsRef = useRef<DiscoveredSession[]>([]);
  const tabBucketsRef = useRef<Map<string, TabBucket>>(new Map());

  const projectStore = useProjectStore({
    setState,
    stateRef,
    projectsRef,
    gitStatusRef,
    allDiscoveredSessionsRef,
  });
  const {
    buildSidebarHistory,
    knownTabIds,
    scopedDiscoveredSessions,
    recentSessionItems,
    syncRecentSessionsToState,
    buildProjectsMirror,
    syncProjectsToState,
    persistProjects,
    scheduleProjectsSave,
  } = projectStore;

  function switchProjectBucket(
    fromKey: string,
    toKey: string,
    opts: { mirrorProjects?: boolean } = {},
  ): string | undefined {
    return switchTabBucket(
      {
        setState,
        stateRef,
        tabBucketsRef,
        buildProjectsMirror,
        dispatchTerminalReplay,
      },
      fromKey,
      toKey,
      opts,
    );
  }

  async function openProjectFromPicker(): Promise<string | null> {
    const path = await pickProjectDirectory();
    if (!path) return null;
    return openProjectByPath(path);
  }

  function openProjectByPath(path: string, label?: string): string {
    const fromKey = projectScopeBucketKey(
      projectsRef.current.activeId,
      projectsRef.current.activeWorktreeId,
    );
    const { state: nextProjects, id } = upsertProject(
      projectsRef.current,
      path,
      label,
    );
    projectsRef.current = { ...nextProjects, activeWorktreeId: null };
    void refreshGitStatusFor(path);
    const nextTabId = switchProjectBucket(
      fromKey,
      projectScopeBucketKey(id, null),
      { mirrorProjects: true },
    );
    scheduleProjectsSave();
    announceProjectToBridge(nextTabId ?? "default", path);
    return id;
  }

  function setActiveProjectById(id: string): boolean {
    const ps = projectsRef.current;
    const target = ps.projects.find((p) => p.id === id);
    if (!target) return false;
    const fromKey = projectScopeBucketKey(ps.activeId, ps.activeWorktreeId);
    const previousActive = activeProject(ps);
    projectsRef.current = {
      ...ps,
      projects: ps.projects.map((p) =>
        p.id === id ? { ...p, lastUsed: Date.now() } : p,
      ),
      activeId: id,
      activeWorktreeId: null,
    };
    const nextTabId = switchProjectBucket(
      fromKey,
      projectScopeBucketKey(id, null),
      {
        mirrorProjects: true,
      },
    );
    scheduleProjectsSave();
    announceProjectToBridge(nextTabId ?? "default", target.path);
    if (previousActive && previousActive.path !== target.path) {
      unwatchProjectForBridge(previousActive.path);
    }
    watchProjectForBridge(target.path);
    void worktreeOps.refreshProjectWorktrees(id);
    return true;
  }

  function clearActiveProject() {
    const fromKey = projectScopeBucketKey(
      projectsRef.current.activeId,
      projectsRef.current.activeWorktreeId,
    );
    const previousActive = activeProject(projectsRef.current);
    projectsRef.current = {
      ...projectsRef.current,
      activeId: null,
      activeWorktreeId: null,
    };
    const nextTabId = switchProjectBucket(fromKey, NO_PROJECT_KEY, {
      mirrorProjects: true,
    });
    scheduleProjectsSave();
    announceProjectToBridge(nextTabId ?? "default", null);
    if (previousActive) unwatchProjectForBridge(previousActive.path);
  }

  function removeProjectById(id: string): boolean {
    const fromKey = projectScopeBucketKey(
      projectsRef.current.activeId,
      projectsRef.current.activeWorktreeId,
    );
    const wasActive = projectsRef.current.activeId === id;
    const removedKey = projectScopeBucketKey(id, null);
    const result = removeProject(projectsRef.current, id);
    if (!result.removed) return false;

    const removedPath = result.removed.path;
    projectsRef.current = result.state;
    gitStatusRef.current.delete(removedPath);
    void persistProjects();

    const removedBucket = tabBucketsRef.current.get(removedKey);
    if (removedBucket) {
      for (const tab of removedBucket.tabs) {
        if (tab.kind === "editor") disposeEditorBuffer(tab.id);
      }
    }

    if (wasActive) {
      const nextTabId = switchProjectBucket(fromKey, NO_PROJECT_KEY);
      syncRecentSessionsToState();
      announceProjectToBridge(nextTabId ?? "default", null);
      tabBucketsRef.current.delete(removedKey);
    } else {
      tabBucketsRef.current.delete(removedKey);
      syncRecentSessionsToState();
    }
    unwatchProjectForBridge(removedPath);

    return true;
  }

  const worktreeOps = useWorktreeOperations({
    projectsRef,
    stateRef,
    tabBucketsRef,
    syncProjectsToState,
    persistProjects,
    scheduleProjectsSave,
    syncRecentSessionsToState,
    switchProjectBucket,
    setActiveProjectById,
    announceProjectToBridge,
    watchProjectForBridge,
    unwatchProjectForBridge,
    closeTabNow,
  });

  // Load projects once at boot. Mirrors into state on resolve so the
  // sidebar populates without requiring a React state owner for projects.
  useEffect(() => {
    (async () => {
      const ps = await loadProjects();
      projectsRef.current = ps;
      projectsLoadedRef.current = true;
      syncProjectsToState();
      void refreshAllGitStatus();
      const active = activeProject(ps);
      const tabId =
        (stateRef.current.activeTabId as string | undefined) ?? "default";
      if (active) {
        announceProjectToBridge(tabId, active.path);
        watchProjectForBridge(active.path);
        setState((prev) => {
          const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((t) =>
            t.projectId == null ? { ...t, projectId: active.id } : t,
          );
          return { ...prev, tabs };
        });
      }
      const scoped = scopedDiscoveredSessions(allDiscoveredSessionsRef.current);
      autoRestoreDiscoveredSessions(scoped, knownTabIds());
      syncRecentSessionsToState();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    projectsLoadedRef,
    allDiscoveredSessionsRef,
    tabBucketsRef,
    buildSidebarHistory,
    knownTabIds,
    scopedDiscoveredSessions,
    recentSessionItems,
    syncRecentSessionsToState,
    syncProjectsToState,
    persistProjects,
    openProjectFromPicker,
    openProjectByPath,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
    ...worktreeOps,
  };
}
