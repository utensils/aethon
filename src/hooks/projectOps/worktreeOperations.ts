import {
  createWorktreeForProject,
  createWorktreeWithParams,
  fetchBranches,
  refreshProjectWorktrees,
  retryPendingWorktree,
} from "./worktreeOps/git";
import { makeProjectLookups } from "./worktreeOps/lookups";
import { removeWorktreeById } from "./worktreeOps/remove";
import {
  activateWorktree,
  dismissPendingWorktree,
  renameProject,
  renameWorktree,
  reorderWorktree,
  sortProjectWorktreesNewest,
  setProjectExpanded,
  setProjectIconUrl,
  setProjectWorktreeBaseBranch,
} from "./worktreeOps/state";
import type {
  WorktreeOperationDeps,
  WorktreeOperations,
} from "./worktreeOps/types";

export type { WorktreeOperationDeps, WorktreeOperations };

export function useWorktreeOperations(
  deps: WorktreeOperationDeps,
): WorktreeOperations {
  const lookups = makeProjectLookups(deps.projectsRef);

  const activateWorktreeBound = (worktreeId: string | null): void =>
    activateWorktree(
      {
        projectsRef: deps.projectsRef,
        syncProjectsToState: deps.syncProjectsToState,
        persistProjects: deps.persistProjects,
        scheduleProjectsSave: deps.scheduleProjectsSave,
        lookups,
        switchProjectBucket: deps.switchProjectBucket,
        announceProjectToBridge: deps.announceProjectToBridge,
        watchProjectForBridge: deps.watchProjectForBridge,
        unwatchProjectForBridge: deps.unwatchProjectForBridge,
      },
      worktreeId,
    );

  const refreshDeps = {
    projectsRef: deps.projectsRef,
    lookups,
    persistProjects: deps.persistProjects,
  };

  const gitDeps = {
    projectsRef: deps.projectsRef,
    stateRef: deps.stateRef,
    lookups,
    syncProjectsToState: deps.syncProjectsToState,
    persistProjects: deps.persistProjects,
    setActiveProjectById: deps.setActiveProjectById,
    activateWorktree: activateWorktreeBound,
  };

  const dismissPendingWorktreeBound = (worktreeId: string): void =>
    dismissPendingWorktree(
      {
        projectsRef: deps.projectsRef,
        persistProjects: deps.persistProjects,
        lookups,
      },
      worktreeId,
    );

  return {
    setProjectExpanded: (projectId, expanded) =>
      setProjectExpanded(
        {
          projectsRef: deps.projectsRef,
          syncProjectsToState: deps.syncProjectsToState,
          persistProjects: deps.persistProjects,
          scheduleProjectsSave: deps.scheduleProjectsSave,
          onFirstExpand: (id) => {
            void refreshProjectWorktrees(refreshDeps, id);
          },
        },
        projectId,
        expanded,
      ),
    setProjectIconUrl: (projectId, iconUrl) =>
      setProjectIconUrl(
        {
          projectsRef: deps.projectsRef,
          persistProjects: deps.persistProjects,
        },
        projectId,
        iconUrl,
      ),
    refreshProjectWorktrees: (projectId) =>
      refreshProjectWorktrees(refreshDeps, projectId),
    activateWorktree: activateWorktreeBound,
    createWorktreeForProject: (projectId) =>
      createWorktreeForProject(gitDeps, projectId),
    createWorktreeWithParams: (opts) =>
      createWorktreeWithParams(gitDeps, opts),
    removeWorktreeById: (worktreeId, opts) =>
      removeWorktreeById(
        {
          projectsRef: deps.projectsRef,
          lookups,
          syncProjectsToState: deps.syncProjectsToState,
          persistProjects: deps.persistProjects,
          tabCleanupDeps: {
            stateRef: deps.stateRef,
            tabBucketsRef: deps.tabBucketsRef,
            syncRecentSessionsToState: deps.syncRecentSessionsToState,
            closeTabNow: deps.closeTabNow,
            activateWorktree: activateWorktreeBound,
          },
          worktreePrompts: deps.worktreePrompts,
        },
        worktreeId,
        opts,
      ),
    dismissPendingWorktree: dismissPendingWorktreeBound,
    retryPendingWorktree: (worktreeId) =>
      retryPendingWorktree(
        { ...gitDeps, dismissPendingWorktree: dismissPendingWorktreeBound },
        worktreeId,
      ),
    renameWorktree: (worktreeId, label) =>
      renameWorktree(
        {
          projectsRef: deps.projectsRef,
          persistProjects: deps.persistProjects,
          lookups,
        },
        worktreeId,
        label,
      ),
    fetchBranches: (projectId) => fetchBranches({ lookups }, projectId),
    renameProject: (projectId, label) =>
      renameProject(
        {
          projectsRef: deps.projectsRef,
          persistProjects: deps.persistProjects,
        },
        projectId,
        label,
      ),
    setProjectWorktreeBaseBranch: (projectId, baseBranch) =>
      setProjectWorktreeBaseBranch(
        {
          projectsRef: deps.projectsRef,
          persistProjects: deps.persistProjects,
        },
        projectId,
        baseBranch,
      ),
    reorderWorktree: (projectId, worktreeId, toIndex) =>
      reorderWorktree(
        {
          projectsRef: deps.projectsRef,
          syncProjectsToState: deps.syncProjectsToState,
          persistProjects: deps.persistProjects,
        },
        projectId,
        worktreeId,
        toIndex,
      ),
    sortProjectWorktreesNewest: (projectId) =>
      sortProjectWorktreesNewest(
        {
          projectsRef: deps.projectsRef,
          syncProjectsToState: deps.syncProjectsToState,
          persistProjects: deps.persistProjects,
        },
        projectId,
      ),
    findProjectOfWorktree: lookups.findProjectOfWorktree,
  };
}
