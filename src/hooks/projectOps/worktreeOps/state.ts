import type { MutableRefObject } from "react";
import {
  activeProject,
  setActiveWorktree as setActiveWorktreeState,
  setProjectIconUrl as setProjectIconUrlState,
  setProjectUiExpanded,
  setProjectWorktreeBaseBranch as setProjectWorktreeBaseBranchState,
  setProjectWorktrees,
  type ProjectsState,
} from "../../../projects";
import {
  removeWorktreeFromList,
  type Worktree,
} from "../../../worktrees";
import { projectScopeBucketKey } from "../tabBuckets";
import { swapProjectWatch } from "./bridgeWatch";
import type { ProjectLookups } from "./types";

interface StateMutationDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  scheduleProjectsSave: (delayMs?: number) => void;
}

interface ActivateWorktreeDeps extends StateMutationDeps {
  lookups: ProjectLookups;
  switchProjectBucket: (
    fromKey: string,
    toKey: string,
    opts?: { mirrorProjects?: boolean },
  ) => string | undefined;
  announceProjectToBridge: (tabId: string, path: string | null) => void;
  watchProjectForBridge: (path: string) => void;
  unwatchProjectForBridge: (path: string) => void;
}

interface RefreshDeps extends StateMutationDeps {
  lookups: ProjectLookups;
}

export function setProjectExpanded(
  deps: StateMutationDeps & { onFirstExpand: (projectId: string) => void },
  projectId: string,
  expanded: boolean,
): void {
  deps.projectsRef.current = setProjectUiExpanded(
    deps.projectsRef.current,
    projectId,
    expanded,
  );
  if (expanded && !deps.projectsRef.current.worktreesByProject[projectId]) {
    deps.onFirstExpand(projectId);
  }
  deps.syncProjectsToState();
  deps.scheduleProjectsSave();
}

export function setProjectIconUrl(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects">,
  projectId: string,
  iconUrl: string | null,
): void {
  const next = setProjectIconUrlState(
    deps.projectsRef.current,
    projectId,
    iconUrl,
  );
  if (next === deps.projectsRef.current) return;
  deps.projectsRef.current = next;
  void deps.persistProjects();
}

export function activateWorktree(
  deps: ActivateWorktreeDeps,
  worktreeId: string | null,
): void {
  const current = deps.projectsRef.current;
  if (current.activeWorktreeId === worktreeId) return;
  const fromKey = projectScopeBucketKey(
    current.activeId,
    current.activeWorktreeId,
  );
  let activeProjectId = current.activeId;
  let nextCwd: string | null;
  let nextProjectPath: string | null;
  if (worktreeId) {
    const hit = deps.lookups.findProjectOfWorktree(worktreeId);
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
  deps.projectsRef.current = setActiveWorktreeState(
    { ...current, activeId: activeProjectId },
    worktreeId,
  );
  const nextTabId = deps.switchProjectBucket(
    fromKey,
    projectScopeBucketKey(activeProjectId, worktreeId),
    { mirrorProjects: true },
  );
  deps.scheduleProjectsSave();
  deps.announceProjectToBridge(nextTabId ?? "default", nextCwd);
  if (crossingProjects) {
    swapProjectWatch(previousActive, nextProjectPath, {
      watchProjectForBridge: deps.watchProjectForBridge,
      unwatchProjectForBridge: deps.unwatchProjectForBridge,
    });
  }
}

export function dismissPendingWorktree(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects"> & {
    lookups: ProjectLookups;
  },
  worktreeId: string,
): void {
  const hit = deps.lookups.findProjectOfWorktree(worktreeId);
  if (!hit) return;
  const list = removeWorktreeFromList(
    deps.projectsRef.current.worktreesByProject[hit.project.id] ?? [],
    worktreeId,
  );
  deps.projectsRef.current = setProjectWorktrees(
    deps.projectsRef.current,
    hit.project.id,
    list,
  );
  void deps.persistProjects();
}

export function renameWorktree(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects"> & {
    lookups: ProjectLookups;
  },
  worktreeId: string,
  label: string,
): void {
  const hit = deps.lookups.findProjectOfWorktree(worktreeId);
  if (!hit) return;
  const trimmed = label.trim();
  const next: Worktree[] = (
    deps.projectsRef.current.worktreesByProject[hit.project.id] ?? []
  ).map((w) =>
    w.id === worktreeId
      ? { ...w, label: trimmed.length > 0 ? trimmed : undefined }
      : w,
  );
  deps.projectsRef.current = setProjectWorktrees(
    deps.projectsRef.current,
    hit.project.id,
    next,
  );
  void deps.persistProjects();
}

export function renameProject(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects">,
  projectId: string,
  label: string,
): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  const ps = deps.projectsRef.current;
  deps.projectsRef.current = {
    ...ps,
    projects: ps.projects.map((p) =>
      p.id === projectId ? { ...p, label: trimmed } : p,
    ),
  };
  void deps.persistProjects();
}

export function setProjectWorktreeBaseBranch(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects">,
  projectId: string,
  baseBranch: string | null,
): void {
  const next = setProjectWorktreeBaseBranchState(
    deps.projectsRef.current,
    projectId,
    baseBranch,
  );
  if (next === deps.projectsRef.current) return;
  deps.projectsRef.current = next;
  void deps.persistProjects();
}

/**
 * Apply a removed-worktree state snapshot (drop the row, sync mirror,
 * persist). Used by remove flows after the git operation succeeds.
 */
export function applyWorktreeRemoval(
  deps: Pick<
    StateMutationDeps,
    "projectsRef" | "syncProjectsToState" | "persistProjects"
  >,
  projectId: string,
  worktreeId: string,
): void {
  const list = removeWorktreeFromList(
    deps.projectsRef.current.worktreesByProject[projectId] ?? [],
    worktreeId,
  );
  deps.projectsRef.current = setProjectWorktrees(
    deps.projectsRef.current,
    projectId,
    list,
  );
  deps.syncProjectsToState();
  void deps.persistProjects();
}

export { type StateMutationDeps, type ActivateWorktreeDeps, type RefreshDeps };
