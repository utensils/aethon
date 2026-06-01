import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  activeProject,
  loadProjects,
  pickProjectDirectory,
  removeProject,
  upsertProject,
} from "../projects";
import {
  isOverviewActive,
  makeEmptyTab,
  NO_PROJECT_KEY,
  OVERVIEW_TAB_ID,
  type Tab,
} from "../types/tab";
import {
  isProjectHydrated,
  loadEditorTabsStore,
  markProjectHydrated,
  persistedTabsForProject,
} from "../editorTabs";
import { editorLabelForPath } from "./tabOps/helpers";
import { TAB_MIRROR_KEYS } from "./tabOps/constants";
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
    newShellTab,
    worktreePrompts,
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
    const wasOverview = isOverviewActive(
      stateRef.current.activeTabId as string | undefined,
    );
    const nextTabId = switchTabBucket(
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
    preserveOverviewIfNeeded(wasOverview);
    maybeSpawnOverviewShell();
    return nextTabId;
  }

  function maybeSpawnOverviewShell(): void {
    if (!newShellTab) return;
    const state = stateRef.current;
    const terminal = state.terminal as { open?: boolean } | undefined;
    if (terminal?.open !== true) return;
    const activeTabId = state.activeTabId as string | undefined;
    if (!isOverviewActive(activeTabId)) return;
    const tabs = (state.tabs as Tab[] | undefined) ?? [];
    if (tabs.some((t) => t.kind === "shell")) return;
    newShellTab();
  }

  function preserveOverviewIfNeeded(wasOverview: boolean): void {
    if (!wasOverview) return;
    setState((prev) => {
      if (prev.activeTabId === OVERVIEW_TAB_ID) return prev;
      return { ...prev, activeTabId: OVERVIEW_TAB_ID };
    });
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
    void restoreEditorTabs(id, path);
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
    // Hydrate this project's persisted editor tabs the first time it
    // becomes active (no-op on later switches) so they survive restarts
    // even when it wasn't the boot project — and so persistence isn't
    // gated off for it.
    void restoreEditorTabs(id, target.path);
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
    worktreePrompts,
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
      if (active) await restoreEditorTabs(active.id, active.path);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Restore the active project's persisted editor tabs, dropping any whose
   *  file no longer exists. Appends to /tabs (deduping against already-open
   *  editor tabs) and activates the previously-active editor tab only when
   *  the overview is still showing (so a restored agent session keeps
   *  focus). */
  async function restoreEditorTabs(
    projectId: string,
    projectPath: string,
  ): Promise<void> {
    // Idempotent per project (boot + every project switch calls this).
    if (isProjectHydrated(projectId)) return;
    await loadEditorTabsStore();
    // Mark hydrated up front (before any early return) so persistence is
    // enabled for this project even when it has no saved tabs yet — that's
    // what lets newly-opened tabs in a fresh project get saved.
    markProjectHydrated(projectId);
    const persisted = persistedTabsForProject(projectId);
    if (persisted.tabs.length === 0) return;
    const checks = await Promise.all(
      persisted.tabs.map((p) =>
        invoke<boolean>("fs_exists", {
          root: p.rootPath ?? projectPath,
          path: p.filePath,
        }).catch(() => false),
      ),
    );
    const restored: Tab[] = [];
    persisted.tabs.forEach((p, i) => {
      if (!checks[i]) return;
      const id = crypto.randomUUID();
      const baseLabel = editorLabelForPath(p.filePath);
      restored.push({
        ...makeEmptyTab(
          id,
          p.diff ? `${baseLabel} (diff)` : baseLabel,
          projectId,
          "editor",
        ),
        editor: {
          filePath: p.filePath,
          ...(p.rootPath ? { rootPath: p.rootPath } : {}),
          language: p.language,
          isDirty: false,
          ...(p.diff ? { diff: true } : {}),
          ...(typeof p.cursorLine === "number"
            ? { cursorLine: p.cursorLine }
            : {}),
          ...(typeof p.cursorColumn === "number"
            ? { cursorColumn: p.cursorColumn }
            : {}),
        },
      });
    });
    if (restored.length === 0) return;
    const dedupeKey = (t: Tab) =>
      `${t.editor?.filePath}::${t.editor?.diff ? "d" : "e"}`;
    const activeRestored = persisted.activeFilePath
      ? restored.find(
          (t) => t.editor?.filePath === persisted.activeFilePath && !t.editor?.diff,
        )
      : undefined;
    setState((prev) => {
      const existing = (prev.tabs as Tab[] | undefined) ?? [];
      const have = new Set(
        existing.filter((t) => t.kind === "editor").map(dedupeKey),
      );
      const toAdd = restored.filter((t) => !have.has(dedupeKey(t)));
      if (toAdd.length === 0) return prev;
      const result: Record<string, unknown> = {
        ...prev,
        tabs: [...existing, ...toAdd],
        hasTabs: true,
        empty: false,
      };
      if (
        activeRestored &&
        toAdd.some((t) => t.id === activeRestored.id) &&
        isOverviewActive(prev.activeTabId as string | undefined)
      ) {
        result.activeTabId = activeRestored.id;
        const rec = activeRestored as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = rec[key as string];
        }
      }
      return result;
    });
  }

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
