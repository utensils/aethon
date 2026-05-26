import type { MutableRefObject } from "react";
import {
  DEFAULT_WORKTREE_BASE_BRANCH,
  activeProject,
  setActiveWorktree as setActiveWorktreeState,
  setProjectIconUrl as setProjectIconUrlState,
  setProjectUiExpanded,
  setProjectWorktreeBaseBranch as setProjectWorktreeBaseBranchState,
  setProjectWorktrees,
  type Project,
  type ProjectsState,
} from "../../projects";
import type { Tab } from "../../types/tab";
import { pickWorktreeName } from "../../worktreeNames";
import {
  gitBranchList,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitWorktreeRemoveOrphan,
  gitWorktrees,
  newPendingWorktree,
  reconcileWorktrees,
  removeWorktreeFromList,
  updateWorktreePendingState,
  type Worktree,
} from "../../worktrees";
import { normalizeSessionPath, projectScopeBucketKey } from "./tabBuckets";
import type { TabBucket } from "./types";

interface WorktreeOperationDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  scheduleProjectsSave: (delayMs?: number) => void;
  syncRecentSessionsToState: () => void;
  switchProjectBucket: (
    fromKey: string,
    toKey: string,
    opts?: { mirrorProjects?: boolean },
  ) => string | undefined;
  setActiveProjectById: (id: string) => boolean;
  announceProjectToBridge: (tabId: string, path: string | null) => void;
  watchProjectForBridge: (path: string) => void;
  unwatchProjectForBridge: (path: string) => void;
  closeTabNow: (tabId: string) => void;
}

export interface WorktreeOperations {
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  setProjectIconUrl: (projectId: string, iconUrl: string | null) => void;
  refreshProjectWorktrees: (projectId: string) => Promise<void>;
  activateWorktree: (worktreeId: string | null) => void;
  createWorktreeForProject: (projectId: string) => Promise<void>;
  createWorktreeWithParams: (opts: {
    projectId: string;
    branch: string;
    targetPath?: string;
    baseBranch?: string;
  }) => Promise<string | null>;
  removeWorktreeById: (
    worktreeId: string,
    opts?: { confirmed?: boolean },
  ) => Promise<void>;
  dismissPendingWorktree: (worktreeId: string) => void;
  retryPendingWorktree: (worktreeId: string) => Promise<void>;
  renameWorktree: (worktreeId: string, label: string) => void;
  fetchBranches: (projectId: string) => Promise<string[]>;
  renameProject: (projectId: string, label: string) => void;
  setProjectWorktreeBaseBranch: (
    projectId: string,
    baseBranch: string | null,
  ) => void;
  findProjectOfWorktree: (
    worktreeId: string,
  ) => { project: Project; worktree: Worktree } | null;
}

export function useWorktreeOperations(
  deps: WorktreeOperationDeps,
): WorktreeOperations {
  const {
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
  } = deps;

  function findProject(id: string): Project | null {
    return projectsRef.current.projects.find((p) => p.id === id) ?? null;
  }

  function findProjectOfWorktree(
    worktreeId: string,
  ): { project: Project; worktree: Worktree } | null {
    const wbp = projectsRef.current.worktreesByProject;
    for (const [pid, list] of Object.entries(wbp)) {
      const wt = list.find((w) => w.id === worktreeId);
      if (wt) {
        const project = findProject(pid);
        if (project) return { project, worktree: wt };
      }
    }
    return null;
  }

  async function refreshProjectWorktrees(projectId: string): Promise<void> {
    const project = findProject(projectId);
    if (!project) return;
    try {
      const listing = await gitWorktrees(project.path);
      const prior = projectsRef.current.worktreesByProject[projectId] ?? [];
      const next = reconcileWorktrees(projectId, prior, listing);
      let nextState = setProjectWorktrees(projectsRef.current, projectId, next);
      const activeWorktreeId = nextState.activeWorktreeId;
      if (
        nextState.activeId === projectId &&
        activeWorktreeId &&
        !next.some((w) => w.id === activeWorktreeId)
      ) {
        nextState = { ...nextState, activeWorktreeId: null };
      }
      projectsRef.current = nextState;
      void persistProjects();
    } catch {
      // Project may not be a git repo; keep the prior list intact.
    }
  }

  function setProjectExpanded(projectId: string, expanded: boolean): void {
    projectsRef.current = setProjectUiExpanded(
      projectsRef.current,
      projectId,
      expanded,
    );
    if (expanded && !projectsRef.current.worktreesByProject[projectId]) {
      void refreshProjectWorktrees(projectId);
    }
    syncProjectsToState();
    scheduleProjectsSave();
  }

  function setProjectIconUrl(projectId: string, iconUrl: string | null): void {
    const next = setProjectIconUrlState(
      projectsRef.current,
      projectId,
      iconUrl,
    );
    if (next === projectsRef.current) return;
    projectsRef.current = next;
    void persistProjects();
  }

  function activateWorktree(worktreeId: string | null): void {
    const current = projectsRef.current;
    if (current.activeWorktreeId === worktreeId) return;
    const fromKey = projectScopeBucketKey(
      current.activeId,
      current.activeWorktreeId,
    );
    let activeProjectId = current.activeId;
    let nextCwd: string | null;
    let nextProjectPath: string | null;
    if (worktreeId) {
      const hit = findProjectOfWorktree(worktreeId);
      if (!hit) return;
      activeProjectId = hit.project.id;
      nextCwd = hit.worktree.path;
      nextProjectPath = hit.project.path;
    } else {
      const project = activeProject(current);
      nextCwd = project?.path ?? null;
      nextProjectPath = project?.path ?? null;
    }
    const previousActive = activeProject(current);
    const crossingProjects =
      activeProjectId !== current.activeId &&
      previousActive != null &&
      nextProjectPath !== null &&
      previousActive.path !== nextProjectPath;
    projectsRef.current = setActiveWorktreeState(
      { ...current, activeId: activeProjectId },
      worktreeId,
    );
    const nextTabId = switchProjectBucket(
      fromKey,
      projectScopeBucketKey(activeProjectId, worktreeId),
      { mirrorProjects: true },
    );
    scheduleProjectsSave();
    announceProjectToBridge(nextTabId ?? "default", nextCwd);
    if (crossingProjects && previousActive && nextProjectPath) {
      unwatchProjectForBridge(previousActive.path);
      watchProjectForBridge(nextProjectPath);
    }
  }

  function tabCwdMatches(tab: Tab, path: string): boolean {
    if (tab.kind !== "agent") return false;
    return normalizeSessionPath(tab.cwd) === normalizeSessionPath(path);
  }

  function removeStoredTabsForWorktreePath(
    path: string,
    removedBucketKey: string,
  ): void {
    tabBucketsRef.current.delete(removedBucketKey);
    for (const [key, bucket] of tabBucketsRef.current.entries()) {
      const tabs = bucket.tabs.filter((tab) => !tabCwdMatches(tab, path));
      if (tabs.length === bucket.tabs.length) continue;
      if (tabs.length === 0) {
        tabBucketsRef.current.delete(key);
        continue;
      }
      const activeTabId = tabs.some((tab) => tab.id === bucket.activeTabId)
        ? bucket.activeTabId
        : tabs[0]?.id;
      tabBucketsRef.current.set(key, { tabs, activeTabId });
    }
  }

  function closeVisibleTabsForWorktreePath(path: string): void {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const closing = tabs
      .filter((tab) => tabCwdMatches(tab, path))
      .map((tab) => tab.id);
    for (const tabId of closing) closeTabNow(tabId);
  }

  function closeTabsForRemovedWorktree(
    projectId: string,
    worktreeId: string,
    path: string,
    wasActive: boolean,
  ): void {
    closeVisibleTabsForWorktreePath(path);
    if (wasActive) activateWorktree(null);
    removeStoredTabsForWorktreePath(
      path,
      projectScopeBucketKey(projectId, worktreeId),
    );
    syncRecentSessionsToState();
  }

  function resolveWorktreeBaseBranch(
    project: Project,
    explicit?: string,
  ): string {
    const trimmed = explicit?.trim();
    if (trimmed) return trimmed;
    return project.worktreeBaseBranch?.trim() || DEFAULT_WORKTREE_BASE_BRANCH;
  }

  function navigateToWorktree(projectId: string, worktreeId: string): void {
    if (projectsRef.current.activeId !== projectId) {
      setActiveProjectById(projectId);
    }
    projectsRef.current = setProjectUiExpanded(
      projectsRef.current,
      projectId,
      true,
    );
    activateWorktree(worktreeId);
  }

  function defaultWorktreePath(projectPath: string, branch: string): string {
    const safe = branch.replace(/[^a-z0-9._-]/gi, "-");
    return `${projectPath.replace(/\/$/, "")}-${safe}`;
  }

  async function createWorktreeForProject(projectId: string): Promise<void> {
    const project = findProject(projectId);
    if (!project) return;
    const taken = new Set<string>();
    for (const w of projectsRef.current.worktreesByProject[projectId] ?? []) {
      if (w.branch) taken.add(w.branch);
      if (w.label) taken.add(w.label);
    }
    try {
      const branches = await gitBranchList(project.path);
      for (const b of branches) taken.add(b.name);
    } catch {
      // Branch list failed; random naming remains good enough.
    }
    const branch = pickWorktreeName(taken);
    await createWorktreeWithParams({ projectId, branch });
  }

  async function createWorktreeWithParams(opts: {
    projectId: string;
    branch: string;
    targetPath?: string;
    baseBranch?: string;
  }): Promise<string | null> {
    const project = findProject(opts.projectId);
    if (!project) return null;
    const branch = opts.branch.trim();
    if (!branch) return null;
    const targetPath =
      opts.targetPath?.trim() || defaultWorktreePath(project.path, branch);
    const pending = newPendingWorktree(opts.projectId, branch, targetPath);
    const baseBranch = resolveWorktreeBaseBranch(project, opts.baseBranch);
    const before = projectsRef.current.worktreesByProject[opts.projectId] ?? [];
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      opts.projectId,
      [...before, pending],
    );
    syncProjectsToState();
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      opts.projectId,
      updateWorktreePendingState(
        projectsRef.current.worktreesByProject[opts.projectId] ?? [],
        pending.id,
        "starting",
      ),
    );
    syncProjectsToState();
    try {
      const created = await gitWorktreeAdd({
        projectPath: project.path,
        targetPath,
        branch,
        base: baseBranch,
      });
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        opts.projectId,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[opts.projectId] ?? [],
          pending.id,
          "succeeded",
        ),
      );
      await refreshProjectWorktrees(opts.projectId);
      const list = projectsRef.current.worktreesByProject[opts.projectId] ?? [];
      const live = list.find(
        (w) =>
          w.id === pending.id ||
          w.path === created.path ||
          w.path === targetPath,
      );
      navigateToWorktree(opts.projectId, live?.id ?? pending.id);
      return live?.path ?? created.path ?? targetPath;
    } catch (err) {
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        opts.projectId,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[opts.projectId] ?? [],
          pending.id,
          "failed",
          String(err),
        ),
      );
      syncProjectsToState();
      return null;
    }
  }

  async function removeWorktreeById(
    worktreeId: string,
    opts: { confirmed?: boolean } = {},
  ): Promise<void> {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit) return;
    const { project, worktree } = hit;
    if (worktree.isMain) {
      window.alert("Cannot remove the main worktree");
      return;
    }
    const label = worktree.label ?? worktree.branch ?? "worktree";
    if (opts.confirmed !== true) {
      const ok = window.confirm(`Remove worktree '${label}'?`);
      if (!ok) return;
    }
    try {
      await gitWorktreeRemove({
        projectPath: project.path,
        worktreePath: worktree.path,
        force: false,
      });
      closeTabsForRemovedWorktree(
        project.id,
        worktreeId,
        worktree.path,
        projectsRef.current.activeWorktreeId === worktreeId,
      );
      const list = removeWorktreeFromList(
        projectsRef.current.worktreesByProject[project.id] ?? [],
        worktreeId,
      );
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        project.id,
        list,
      );
      syncProjectsToState();
      void persistProjects();
    } catch (err) {
      const msg = String(err);
      if (msg.includes("dirty") || msg.includes("modified")) {
        const forced = window.confirm(
          `${msg}\n\nForce-remove anyway? Uncommitted changes will be lost.`,
        );
        if (!forced) return;
        try {
          await gitWorktreeRemove({
            projectPath: project.path,
            worktreePath: worktree.path,
            force: true,
          });
          closeTabsForRemovedWorktree(
            project.id,
            worktreeId,
            worktree.path,
            projectsRef.current.activeWorktreeId === worktreeId,
          );
          const list = removeWorktreeFromList(
            projectsRef.current.worktreesByProject[project.id] ?? [],
            worktreeId,
          );
          projectsRef.current = setProjectWorktrees(
            projectsRef.current,
            project.id,
            list,
          );
          syncProjectsToState();
          void persistProjects();
          return;
        } catch (e2) {
          window.alert(`Failed: ${String(e2)}`);
          return;
        }
      }
      if (msg.includes("worktree not tracked")) {
        const ok = window.confirm(
          `Aethon has this worktree but git no longer tracks it. ` +
            `Remove the leftover folder and forget the entry?`,
        );
        if (!ok) return;
        try {
          await gitWorktreeRemoveOrphan({
            projectPath: project.path,
            worktreePath: worktree.path,
          });
          closeTabsForRemovedWorktree(
            project.id,
            worktreeId,
            worktree.path,
            projectsRef.current.activeWorktreeId === worktreeId,
          );
          const list = removeWorktreeFromList(
            projectsRef.current.worktreesByProject[project.id] ?? [],
            worktreeId,
          );
          projectsRef.current = setProjectWorktrees(
            projectsRef.current,
            project.id,
            list,
          );
          syncProjectsToState();
          void persistProjects();
          return;
        } catch (e2) {
          window.alert(`Failed: ${String(e2)}`);
          return;
        }
      }
      window.alert(`Failed: ${msg}`);
    }
  }

  function dismissPendingWorktree(worktreeId: string): void {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit) return;
    const list = removeWorktreeFromList(
      projectsRef.current.worktreesByProject[hit.project.id] ?? [],
      worktreeId,
    );
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      list,
    );
    void persistProjects();
  }

  async function retryPendingWorktree(worktreeId: string): Promise<void> {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit || !hit.worktree.branch) return;
    dismissPendingWorktree(worktreeId);
    const pending = newPendingWorktree(
      hit.project.id,
      hit.worktree.branch,
      hit.worktree.path,
    );
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      [
        ...(projectsRef.current.worktreesByProject[hit.project.id] ?? []),
        pending,
      ],
    );
    syncProjectsToState();
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      updateWorktreePendingState(
        projectsRef.current.worktreesByProject[hit.project.id] ?? [],
        pending.id,
        "starting",
      ),
    );
    syncProjectsToState();
    try {
      await gitWorktreeAdd({
        projectPath: hit.project.path,
        targetPath: hit.worktree.path,
        branch: hit.worktree.branch,
        base: resolveWorktreeBaseBranch(hit.project),
      });
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        hit.project.id,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[hit.project.id] ?? [],
          pending.id,
          "succeeded",
        ),
      );
      await refreshProjectWorktrees(hit.project.id);
      const list = projectsRef.current.worktreesByProject[hit.project.id] ?? [];
      const live = list.find(
        (w) => w.id === pending.id || w.path === hit.worktree.path,
      );
      navigateToWorktree(hit.project.id, live?.id ?? pending.id);
    } catch (err) {
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        hit.project.id,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[hit.project.id] ?? [],
          pending.id,
          "failed",
          String(err),
        ),
      );
      syncProjectsToState();
    }
  }

  function renameWorktree(worktreeId: string, label: string): void {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit) return;
    const trimmed = label.trim();
    const next: Worktree[] = (
      projectsRef.current.worktreesByProject[hit.project.id] ?? []
    ).map((w) =>
      w.id === worktreeId
        ? { ...w, label: trimmed.length > 0 ? trimmed : undefined }
        : w,
    );
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      next,
    );
    void persistProjects();
  }

  async function fetchBranches(projectId: string): Promise<string[]> {
    const project = findProject(projectId);
    if (!project) return [];
    try {
      const list = await gitBranchList(project.path);
      return list.map((b) => b.name);
    } catch {
      return [];
    }
  }

  function renameProject(projectId: string, label: string): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    const ps = projectsRef.current;
    projectsRef.current = {
      ...ps,
      projects: ps.projects.map((p) =>
        p.id === projectId ? { ...p, label: trimmed } : p,
      ),
    };
    void persistProjects();
  }

  function setProjectWorktreeBaseBranch(
    projectId: string,
    baseBranch: string | null,
  ): void {
    const next = setProjectWorktreeBaseBranchState(
      projectsRef.current,
      projectId,
      baseBranch,
    );
    if (next === projectsRef.current) return;
    projectsRef.current = next;
    void persistProjects();
  }

  return {
    setProjectExpanded,
    setProjectIconUrl,
    refreshProjectWorktrees,
    activateWorktree,
    createWorktreeForProject,
    createWorktreeWithParams,
    removeWorktreeById,
    dismissPendingWorktree,
    retryPendingWorktree,
    renameWorktree,
    setProjectWorktreeBaseBranch,
    fetchBranches,
    renameProject,
    findProjectOfWorktree,
  };
}
