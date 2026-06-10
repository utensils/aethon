import {
  createWorkspaceForProject,
  createWorkspaceWithParams,
  fetchBranches,
  refreshProjectWorkspaces,
  retryPendingWorkspace,
} from "./workspaceOps/git";
import { makeProjectLookups } from "./workspaceOps/lookups";
import { removeWorkspaceById } from "./workspaceOps/remove";
import {
  activateWorkspace,
  dismissPendingWorkspace,
  renameProject,
  renameWorkspace,
  reorderWorkspace,
  sortProjectWorkspacesNewest,
  setProjectExpanded,
  setProjectIconUrl,
  setProjectWorkspaceBaseBranch,
} from "./workspaceOps/state";
import type {
  WorkspaceOperationDeps,
  WorkspaceOperations,
} from "./workspaceOps/types";

export type { WorkspaceOperationDeps, WorkspaceOperations };

export function useWorkspaceOperations(
  deps: WorkspaceOperationDeps,
): WorkspaceOperations {
  const lookups = makeProjectLookups(deps.projectsRef);

  const activateWorkspaceBound = (workspaceId: string | null): void =>
    activateWorkspace(
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
      workspaceId,
    );

  const tabCleanupDeps = {
    setState: deps.setState,
    stateRef: deps.stateRef,
    tabBucketsRef: deps.tabBucketsRef,
    syncRecentSessionsToState: deps.syncRecentSessionsToState,
    closeTabNow: deps.closeTabNow,
    activateWorkspace: activateWorkspaceBound,
  };

  const refreshDeps = {
    projectsRef: deps.projectsRef,
    lookups,
    persistProjects: deps.persistProjects,
    tabCleanup: tabCleanupDeps,
  };

  const gitDeps = {
    projectsRef: deps.projectsRef,
    stateRef: deps.stateRef,
    lookups,
    syncProjectsToState: deps.syncProjectsToState,
    persistProjects: deps.persistProjects,
    setActiveProjectById: deps.setActiveProjectById,
    activateWorkspace: activateWorkspaceBound,
    tabCleanup: tabCleanupDeps,
  };

  const dismissPendingWorkspaceBound = (workspaceId: string): void =>
    dismissPendingWorkspace(
      {
        projectsRef: deps.projectsRef,
        persistProjects: deps.persistProjects,
        lookups,
      },
      workspaceId,
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
            void refreshProjectWorkspaces(refreshDeps, id);
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
    refreshProjectWorkspaces: (projectId) =>
      refreshProjectWorkspaces(refreshDeps, projectId),
    activateWorkspace: activateWorkspaceBound,
    createWorkspaceForProject: (projectId) =>
      createWorkspaceForProject(gitDeps, projectId),
    createWorkspaceWithParams: (opts) =>
      createWorkspaceWithParams(gitDeps, opts),
    removeWorkspaceById: (workspaceId, opts) =>
      removeWorkspaceById(
        {
          projectsRef: deps.projectsRef,
          lookups,
          syncProjectsToState: deps.syncProjectsToState,
          persistProjects: deps.persistProjects,
          tabCleanupDeps,
          workspacePrompts: deps.workspacePrompts,
        },
        workspaceId,
        opts,
      ),
    dismissPendingWorkspace: dismissPendingWorkspaceBound,
    retryPendingWorkspace: (workspaceId) =>
      retryPendingWorkspace(
        { ...gitDeps, dismissPendingWorkspace: dismissPendingWorkspaceBound },
        workspaceId,
      ),
    renameWorkspace: (workspaceId, label) =>
      renameWorkspace(
        {
          projectsRef: deps.projectsRef,
          persistProjects: deps.persistProjects,
          lookups,
        },
        workspaceId,
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
    setProjectWorkspaceBaseBranch: (projectId, baseBranch) =>
      setProjectWorkspaceBaseBranch(
        {
          projectsRef: deps.projectsRef,
          persistProjects: deps.persistProjects,
        },
        projectId,
        baseBranch,
      ),
    reorderWorkspace: (projectId, workspaceId, toIndex) =>
      reorderWorkspace(
        {
          projectsRef: deps.projectsRef,
          syncProjectsToState: deps.syncProjectsToState,
          persistProjects: deps.persistProjects,
        },
        projectId,
        workspaceId,
        toIndex,
      ),
    sortProjectWorkspacesNewest: (projectId) =>
      sortProjectWorkspacesNewest(
        {
          projectsRef: deps.projectsRef,
          syncProjectsToState: deps.syncProjectsToState,
          persistProjects: deps.persistProjects,
        },
        projectId,
      ),
    findProjectOfWorkspace: lookups.findProjectOfWorkspace,
  };
}
