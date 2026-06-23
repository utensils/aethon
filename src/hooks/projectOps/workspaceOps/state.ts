import type { MutableRefObject } from "react";
import {
  activeProject,
  setActiveWorkspace as setActiveWorkspaceState,
  setProjectIconUrl as setProjectIconUrlState,
  setProjectUiExpanded,
  setProjectWorkspaceBaseBranch as setProjectWorkspaceBaseBranchState,
  setProjectWorkspaceSortMode,
  setProjectWorkspaces,
  type ProjectsState,
} from "../../../projects";
import {
  orderWorkspacesForDisplay,
  reorderExtraWorkspaceToIndex,
  removeWorkspaceFromList,
  sortWorkspacesNewestFirst,
  type Workspace,
} from "../../../workspaces";
import { projectScopeBucketKey } from "../tabBuckets";
import { recordWorkspaceActivation } from "../../statusPollScheduler";
import { swapProjectWatch } from "./bridgeWatch";
import type { ProjectLookups } from "./types";

interface StateMutationDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  scheduleProjectsSave: (delayMs?: number) => void;
}

interface ActivateWorkspaceDeps extends StateMutationDeps {
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
  if (expanded && !deps.projectsRef.current.workspacesByProject[projectId]) {
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

export function activateWorkspace(
  deps: ActivateWorkspaceDeps,
  workspaceId: string | null,
): void {
  const current = deps.projectsRef.current;
  const fromKey = projectScopeBucketKey(
    current.activeId,
    current.activeWorkspaceId,
  );
  let activeProjectId = current.activeId;
  let nextWorkspaceId = workspaceId;
  let nextCwd: string | null;
  let nextProjectPath: string | null;
  if (workspaceId) {
    const hit = deps.lookups.findProjectOfWorkspace(workspaceId);
    if (!hit) return;
    activeProjectId = hit.project.id;
    nextCwd = hit.workspace.path;
    nextProjectPath = hit.project.path;
    if (hit.workspace.isMain) {
      nextWorkspaceId = null;
    }
  } else {
    const project = activeProject(current);
    nextCwd = project?.path ?? null;
    nextProjectPath = project?.path ?? null;
  }
  if (
    current.activeId === activeProjectId &&
    current.activeWorkspaceId === nextWorkspaceId
  ) {
    return;
  }
  const previousActive = activeProject(current);
  const crossingProjects =
    activeProjectId !== current.activeId &&
    previousActive != null &&
    nextProjectPath !== null &&
    previousActive.path !== nextProjectPath;
  deps.projectsRef.current = setActiveWorkspaceState(
    { ...current, activeId: activeProjectId },
    nextWorkspaceId,
  );
  const nextTabId = deps.switchProjectBucket(
    fromKey,
    projectScopeBucketKey(activeProjectId, nextWorkspaceId),
    { mirrorProjects: true },
  );
  deps.scheduleProjectsSave();
  deps.announceProjectToBridge(nextTabId ?? "default", nextCwd);
  // Keep this workspace's root in the warm polling tier so switching back
  // paints fresh git badges (statusPollScheduler).
  recordWorkspaceActivation(nextCwd);
  if (crossingProjects) {
    swapProjectWatch(previousActive, nextProjectPath, {
      watchProjectForBridge: deps.watchProjectForBridge,
      unwatchProjectForBridge: deps.unwatchProjectForBridge,
    });
  }
}

export function dismissPendingWorkspace(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects"> & {
    lookups: ProjectLookups;
  },
  workspaceId: string,
): void {
  const hit = deps.lookups.findProjectOfWorkspace(workspaceId);
  if (!hit) return;
  const list = removeWorkspaceFromList(
    deps.projectsRef.current.workspacesByProject[hit.project.id] ?? [],
    workspaceId,
  );
  deps.projectsRef.current = setProjectWorkspaces(
    deps.projectsRef.current,
    hit.project.id,
    list,
  );
  void deps.persistProjects();
}

export function renameWorkspace(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects"> & {
    lookups: ProjectLookups;
  },
  workspaceId: string,
  label: string,
): void {
  const hit = deps.lookups.findProjectOfWorkspace(workspaceId);
  if (!hit) return;
  const trimmed = label.trim();
  const next: Workspace[] = (
    deps.projectsRef.current.workspacesByProject[hit.project.id] ?? []
  ).map((w) =>
    w.id === workspaceId
      ? { ...w, label: trimmed.length > 0 ? trimmed : undefined }
      : w,
  );
  deps.projectsRef.current = setProjectWorkspaces(
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

export function setProjectWorkspaceBaseBranch(
  deps: Pick<StateMutationDeps, "projectsRef" | "persistProjects">,
  projectId: string,
  baseBranch: string | null,
): void {
  const next = setProjectWorkspaceBaseBranchState(
    deps.projectsRef.current,
    projectId,
    baseBranch,
  );
  if (next === deps.projectsRef.current) return;
  deps.projectsRef.current = next;
  void deps.persistProjects();
}

export function reorderWorkspace(
  deps: Pick<
    StateMutationDeps,
    "projectsRef" | "syncProjectsToState" | "persistProjects"
  >,
  projectId: string,
  workspaceId: string,
  toIndex: number,
): void {
  const prior = deps.projectsRef.current.workspacesByProject[projectId] ?? [];
  const project = deps.projectsRef.current.projects.find(
    (entry) => entry.id === projectId,
  );
  const displayOrder = orderWorkspacesForDisplay(
    prior,
    project?.workspaceSortMode,
  );
  const reordered = reorderExtraWorkspaceToIndex(
    displayOrder,
    workspaceId,
    toIndex,
  );
  if (!reordered) return;
  let next = setProjectWorkspaces(
    deps.projectsRef.current,
    projectId,
    reordered,
  );
  next = setProjectWorkspaceSortMode(next, projectId, "manual");
  deps.projectsRef.current = next;
  deps.syncProjectsToState();
  void deps.persistProjects();
}

export function sortProjectWorkspacesNewest(
  deps: Pick<
    StateMutationDeps,
    "projectsRef" | "syncProjectsToState" | "persistProjects"
  >,
  projectId: string,
): void {
  const prior = deps.projectsRef.current.workspacesByProject[projectId] ?? [];
  const sorted = sortWorkspacesNewestFirst(prior);
  const changed = sorted.some((w, index) => w.id !== prior[index]?.id);
  let next = deps.projectsRef.current;
  if (changed) {
    next = setProjectWorkspaces(next, projectId, sorted);
  }
  next = setProjectWorkspaceSortMode(next, projectId, "newest");
  if (next === deps.projectsRef.current && !changed) return;
  deps.projectsRef.current = next;
  deps.syncProjectsToState();
  void deps.persistProjects();
}

/**
 * Apply a removed-workspace state snapshot (drop the row, sync mirror,
 * persist). Used by remove flows after the git operation succeeds.
 */
export function applyWorkspaceRemoval(
  deps: Pick<
    StateMutationDeps,
    "projectsRef" | "syncProjectsToState" | "persistProjects"
  >,
  projectId: string,
  workspaceId: string,
): void {
  const list = removeWorkspaceFromList(
    deps.projectsRef.current.workspacesByProject[projectId] ?? [],
    workspaceId,
  );
  deps.projectsRef.current = setProjectWorkspaces(
    deps.projectsRef.current,
    projectId,
    list,
  );
  deps.syncProjectsToState();
  void deps.persistProjects();
}

export { type StateMutationDeps, type ActivateWorkspaceDeps, type RefreshDeps };
