import type { MutableRefObject } from "react";
import type { Project, ProjectsState } from "../../../projects";
import type { Worktree } from "../../../worktrees";
import type { TabBucket } from "../types";

export interface WorktreeOperationDeps {
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
  worktreePrompts: WorktreeRemovalPrompts;
}

export interface WorktreeRemovalPrompts {
  promptRemoveWorktree: (label: string) => Promise<boolean>;
  promptForceRemove: (message: string) => Promise<boolean>;
  promptOrphanCleanup: () => Promise<boolean>;
  notifyCannotRemoveMain: () => void;
  notifyFailure: (message: string) => void;
}

export interface WorktreeOperations {
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  setProjectIconUrl: (projectId: string, iconUrl: string | null) => void;
  refreshProjectWorktrees: (projectId: string) => Promise<void>;
  activateWorktree: (worktreeId: string | null) => void;
  createWorktreeForProject: (projectId: string) => Promise<void>;
  createWorktreeWithParams: (opts: {
    projectId: string;
    branch?: string;
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

export interface ProjectLookups {
  findProject: (id: string) => Project | null;
  findProjectOfWorktree: (
    worktreeId: string,
  ) => { project: Project; worktree: Worktree } | null;
}
