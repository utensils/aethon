import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Project, ProjectsState } from "../../../projects";
import type { Workspace } from "../../../workspaces";
import type { TabBucket } from "../types";

export interface WorkspaceOperationDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
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
  workspacePrompts: WorkspaceRemovalPrompts;
}

export interface WorkspaceRemovalPrompts {
  promptRemoveWorkspace: (label: string) => Promise<boolean>;
  promptForceRemove: (message: string) => Promise<boolean>;
  promptOrphanCleanup: () => Promise<boolean>;
  notifyCannotRemoveMain: () => void;
  notifyFailure: (message: string) => void;
}

export interface WorkspaceOperations {
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  setProjectIconUrl: (projectId: string, iconUrl: string | null) => void;
  refreshProjectWorkspaces: (projectId: string) => Promise<void>;
  activateWorkspace: (workspaceId: string | null) => void;
  createWorkspaceForProject: (projectId: string) => Promise<void>;
  createWorkspaceWithParams: (opts: {
    projectId: string;
    branch?: string;
    targetPath?: string;
    baseBranch?: string;
    activate?: boolean;
  }) => Promise<string | null>;
  removeWorkspaceById: (
    workspaceId: string,
    opts?: { confirmed?: boolean },
  ) => Promise<void>;
  dismissPendingWorkspace: (workspaceId: string) => void;
  retryPendingWorkspace: (workspaceId: string) => Promise<void>;
  renameWorkspace: (workspaceId: string, label: string) => void;
  fetchBranches: (projectId: string) => Promise<string[]>;
  renameProject: (projectId: string, label: string) => void;
  setProjectWorkspaceBaseBranch: (
    projectId: string,
    baseBranch: string | null,
  ) => void;
  reorderWorkspace: (
    projectId: string,
    workspaceId: string,
    toIndex: number,
  ) => void;
  sortProjectWorkspacesNewest: (projectId: string) => void;
  findProjectOfWorkspace: (
    workspaceId: string,
  ) => { project: Project; workspace: Workspace } | null;
}

export interface ProjectLookups {
  findProject: (id: string) => Project | null;
  findProjectOfWorkspace: (
    workspaceId: string,
  ) => { project: Project; workspace: Workspace } | null;
}
