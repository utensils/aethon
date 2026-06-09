import type { MutableRefObject } from "react";
import {
  DEFAULT_WORKSPACE_BASE_BRANCH,
  setProjectUiExpanded,
  setProjectWorkspaces,
  type Project,
  type ProjectsState,
} from "../../../projects";
import { pickWorkspaceName } from "../../../workspaceNames";
import {
  gitBranchList,
  gitWorktreeAdd,
  gitWorktrees,
  newPendingWorkspace,
  reconcileWorkspaces,
  updateWorkspacePendingState,
} from "../../../workspaces";
import type { ProjectLookups } from "./types";

interface GitDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  stateRef?: MutableRefObject<Record<string, unknown>>;
  lookups: ProjectLookups;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  setActiveProjectById: (id: string) => boolean;
  activateWorkspace: (workspaceId: string | null) => void;
}

export function resolveWorkspaceBaseBranch(
  project: Project,
  explicit?: string,
): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return project.workspaceBaseBranch?.trim() || DEFAULT_WORKSPACE_BASE_BRANCH;
}

export function defaultWorkspacePath(
  projectPath: string,
  branch: string,
  aethonRoot?: string,
): string {
  const workspaceName = safePathSegment(branch, "workspace");
  const root = aethonRoot?.trim();
  if (root) {
    const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    const repoName = safePathSegment(pathBasename(projectPath), "repo");
    return `${trimTrailingSeparators(root)}${sep}${repoName}${sep}${workspaceName}`;
  }
  return `${projectPath.replace(/[\\/]+$/, "")}-${workspaceName}`;
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function pathBasename(path: string): string {
  const parts = trimTrailingSeparators(path).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "repo";
}

function safePathSegment(value: string, fallback: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "-").replace(/^-+|-+$/g, "") || fallback;
}

async function pickGeneratedWorkspaceBranch(
  deps: Pick<GitDeps, "projectsRef"> & { lookups: ProjectLookups },
  project: Project,
): Promise<string> {
  const taken = new Set<string>();
  for (const w of deps.projectsRef.current.workspacesByProject[project.id] ??
    []) {
    if (w.branch) taken.add(w.branch);
    if (w.label) taken.add(w.label);
  }
  try {
    const branches = await gitBranchList(project.path);
    for (const b of branches) taken.add(b.name);
  } catch {
    // Branch list failed; random naming remains good enough.
  }
  return pickWorkspaceName(taken);
}

export function navigateToWorkspace(
  deps: Pick<
    GitDeps,
    "projectsRef" | "setActiveProjectById" | "activateWorkspace"
  >,
  projectId: string,
  workspaceId: string,
): void {
  if (deps.projectsRef.current.activeId !== projectId) {
    deps.setActiveProjectById(projectId);
  }
  deps.projectsRef.current = setProjectUiExpanded(
    deps.projectsRef.current,
    projectId,
    true,
  );
  deps.activateWorkspace(workspaceId);
}

export async function refreshProjectWorkspaces(
  deps: Pick<GitDeps, "projectsRef" | "lookups" | "persistProjects">,
  projectId: string,
): Promise<void> {
  const project = deps.lookups.findProject(projectId);
  if (!project) return;
  try {
    const listing = await gitWorktrees(project.path);
    const prior = deps.projectsRef.current.workspacesByProject[projectId] ?? [];
    const next = reconcileWorkspaces(projectId, prior, listing);
    let nextState = setProjectWorkspaces(
      deps.projectsRef.current,
      projectId,
      next,
    );
    const activeWorkspaceId = nextState.activeWorkspaceId;
    if (
      nextState.activeId === projectId &&
      activeWorkspaceId &&
      !next.some((w) => w.id === activeWorkspaceId)
    ) {
      nextState = { ...nextState, activeWorkspaceId: null };
    }
    deps.projectsRef.current = nextState;
    void deps.persistProjects();
  } catch {
    // Project may not be a git repo; keep the prior list intact.
  }
}

export async function fetchBranches(
  deps: Pick<GitDeps, "lookups">,
  projectId: string,
): Promise<string[]> {
  const project = deps.lookups.findProject(projectId);
  if (!project) return [];
  try {
    const list = await gitBranchList(project.path);
    return list.map((b) => b.name);
  } catch {
    return [];
  }
}

export async function createWorkspaceForProject(
  deps: GitDeps,
  projectId: string,
): Promise<void> {
  const project = deps.lookups.findProject(projectId);
  if (!project) return;
  await createWorkspaceWithParams(deps, { projectId });
}

export async function createWorkspaceWithParams(
  deps: GitDeps,
  opts: {
    projectId: string;
    branch?: string;
    targetPath?: string;
    baseBranch?: string;
  },
): Promise<string | null> {
  const project = deps.lookups.findProject(opts.projectId);
  if (!project) return null;
  const branch =
    opts.branch?.trim() || (await pickGeneratedWorkspaceBranch(deps, project));
  const aethonRoot =
    typeof deps.stateRef?.current.aethonRoot === "string"
      ? deps.stateRef.current.aethonRoot
      : undefined;
  const targetPath =
    opts.targetPath?.trim() ||
    defaultWorkspacePath(project.path, branch, aethonRoot);
  const pending = newPendingWorkspace(opts.projectId, branch, targetPath);
  const baseBranch = resolveWorkspaceBaseBranch(project, opts.baseBranch);
  const before =
    deps.projectsRef.current.workspacesByProject[opts.projectId] ?? [];
  deps.projectsRef.current = setProjectWorkspaces(
    deps.projectsRef.current,
    opts.projectId,
    [...before, pending],
  );
  deps.syncProjectsToState();
  deps.projectsRef.current = setProjectWorkspaces(
    deps.projectsRef.current,
    opts.projectId,
    updateWorkspacePendingState(
      deps.projectsRef.current.workspacesByProject[opts.projectId] ?? [],
      pending.id,
      "starting",
    ),
  );
  deps.syncProjectsToState();
  try {
    const created = await gitWorktreeAdd({
      projectPath: project.path,
      targetPath,
      branch,
      base: baseBranch,
    });
    deps.projectsRef.current = setProjectWorkspaces(
      deps.projectsRef.current,
      opts.projectId,
      updateWorkspacePendingState(
        deps.projectsRef.current.workspacesByProject[opts.projectId] ?? [],
        pending.id,
        "succeeded",
      ),
    );
    await refreshProjectWorkspaces(deps, opts.projectId);
    const list =
      deps.projectsRef.current.workspacesByProject[opts.projectId] ?? [];
    const live = list.find(
      (w) =>
        w.id === pending.id ||
        w.path === created.path ||
        w.path === targetPath,
    );
    navigateToWorkspace(deps, opts.projectId, live?.id ?? pending.id);
    return live?.path ?? created.path ?? targetPath;
  } catch (err) {
    deps.projectsRef.current = setProjectWorkspaces(
      deps.projectsRef.current,
      opts.projectId,
      updateWorkspacePendingState(
        deps.projectsRef.current.workspacesByProject[opts.projectId] ?? [],
        pending.id,
        "failed",
        String(err),
      ),
    );
    deps.syncProjectsToState();
    return null;
  }
}

export async function retryPendingWorkspace(
  deps: GitDeps & { dismissPendingWorkspace: (workspaceId: string) => void },
  workspaceId: string,
): Promise<void> {
  const hit = deps.lookups.findProjectOfWorkspace(workspaceId);
  if (!hit || !hit.workspace.branch) return;
  deps.dismissPendingWorkspace(workspaceId);
  const pending = newPendingWorkspace(
    hit.project.id,
    hit.workspace.branch,
    hit.workspace.path,
  );
  deps.projectsRef.current = setProjectWorkspaces(
    deps.projectsRef.current,
    hit.project.id,
    [
      ...(deps.projectsRef.current.workspacesByProject[hit.project.id] ?? []),
      pending,
    ],
  );
  deps.syncProjectsToState();
  deps.projectsRef.current = setProjectWorkspaces(
    deps.projectsRef.current,
    hit.project.id,
    updateWorkspacePendingState(
      deps.projectsRef.current.workspacesByProject[hit.project.id] ?? [],
      pending.id,
      "starting",
    ),
  );
  deps.syncProjectsToState();
  try {
    await gitWorktreeAdd({
      projectPath: hit.project.path,
      targetPath: hit.workspace.path,
      branch: hit.workspace.branch,
      base: resolveWorkspaceBaseBranch(hit.project),
    });
    deps.projectsRef.current = setProjectWorkspaces(
      deps.projectsRef.current,
      hit.project.id,
      updateWorkspacePendingState(
        deps.projectsRef.current.workspacesByProject[hit.project.id] ?? [],
        pending.id,
        "succeeded",
      ),
    );
    await refreshProjectWorkspaces(deps, hit.project.id);
    const list =
      deps.projectsRef.current.workspacesByProject[hit.project.id] ?? [];
    const live = list.find(
      (w) => w.id === pending.id || w.path === hit.workspace.path,
    );
    navigateToWorkspace(deps, hit.project.id, live?.id ?? pending.id);
  } catch (err) {
    deps.projectsRef.current = setProjectWorkspaces(
      deps.projectsRef.current,
      hit.project.id,
      updateWorkspacePendingState(
        deps.projectsRef.current.workspacesByProject[hit.project.id] ?? [],
        pending.id,
        "failed",
        String(err),
      ),
    );
    deps.syncProjectsToState();
  }
}

export type { GitDeps };
