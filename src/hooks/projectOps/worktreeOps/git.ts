import type { MutableRefObject } from "react";
import {
  DEFAULT_WORKTREE_BASE_BRANCH,
  setProjectUiExpanded,
  setProjectWorktrees,
  type Project,
  type ProjectsState,
} from "../../../projects";
import { pickWorktreeName } from "../../../worktreeNames";
import {
  gitBranchList,
  gitWorktreeAdd,
  gitWorktrees,
  newPendingWorktree,
  reconcileWorktrees,
  updateWorktreePendingState,
} from "../../../worktrees";
import type { ProjectLookups } from "./types";

interface GitDeps {
  projectsRef: MutableRefObject<ProjectsState>;
  lookups: ProjectLookups;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  setActiveProjectById: (id: string) => boolean;
  activateWorktree: (worktreeId: string | null) => void;
}

export function resolveWorktreeBaseBranch(
  project: Project,
  explicit?: string,
): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return project.worktreeBaseBranch?.trim() || DEFAULT_WORKTREE_BASE_BRANCH;
}

export function defaultWorktreePath(
  projectPath: string,
  branch: string,
): string {
  const safe = branch.replace(/[^a-z0-9._-]/gi, "-");
  return `${projectPath.replace(/\/$/, "")}-${safe}`;
}

export function navigateToWorktree(
  deps: Pick<
    GitDeps,
    "projectsRef" | "setActiveProjectById" | "activateWorktree"
  >,
  projectId: string,
  worktreeId: string,
): void {
  if (deps.projectsRef.current.activeId !== projectId) {
    deps.setActiveProjectById(projectId);
  }
  deps.projectsRef.current = setProjectUiExpanded(
    deps.projectsRef.current,
    projectId,
    true,
  );
  deps.activateWorktree(worktreeId);
}

export async function refreshProjectWorktrees(
  deps: Pick<GitDeps, "projectsRef" | "lookups" | "persistProjects">,
  projectId: string,
): Promise<void> {
  const project = deps.lookups.findProject(projectId);
  if (!project) return;
  try {
    const listing = await gitWorktrees(project.path);
    const prior = deps.projectsRef.current.worktreesByProject[projectId] ?? [];
    const next = reconcileWorktrees(projectId, prior, listing);
    let nextState = setProjectWorktrees(
      deps.projectsRef.current,
      projectId,
      next,
    );
    const activeWorktreeId = nextState.activeWorktreeId;
    if (
      nextState.activeId === projectId &&
      activeWorktreeId &&
      !next.some((w) => w.id === activeWorktreeId)
    ) {
      nextState = { ...nextState, activeWorktreeId: null };
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

export async function createWorktreeForProject(
  deps: GitDeps,
  projectId: string,
): Promise<void> {
  const project = deps.lookups.findProject(projectId);
  if (!project) return;
  const taken = new Set<string>();
  for (const w of deps.projectsRef.current.worktreesByProject[projectId] ??
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
  const branch = pickWorktreeName(taken);
  await createWorktreeWithParams(deps, { projectId, branch });
}

export async function createWorktreeWithParams(
  deps: GitDeps,
  opts: {
    projectId: string;
    branch: string;
    targetPath?: string;
    baseBranch?: string;
  },
): Promise<string | null> {
  const project = deps.lookups.findProject(opts.projectId);
  if (!project) return null;
  const branch = opts.branch.trim();
  if (!branch) return null;
  const targetPath =
    opts.targetPath?.trim() || defaultWorktreePath(project.path, branch);
  const pending = newPendingWorktree(opts.projectId, branch, targetPath);
  const baseBranch = resolveWorktreeBaseBranch(project, opts.baseBranch);
  const before =
    deps.projectsRef.current.worktreesByProject[opts.projectId] ?? [];
  deps.projectsRef.current = setProjectWorktrees(
    deps.projectsRef.current,
    opts.projectId,
    [...before, pending],
  );
  deps.syncProjectsToState();
  deps.projectsRef.current = setProjectWorktrees(
    deps.projectsRef.current,
    opts.projectId,
    updateWorktreePendingState(
      deps.projectsRef.current.worktreesByProject[opts.projectId] ?? [],
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
    deps.projectsRef.current = setProjectWorktrees(
      deps.projectsRef.current,
      opts.projectId,
      updateWorktreePendingState(
        deps.projectsRef.current.worktreesByProject[opts.projectId] ?? [],
        pending.id,
        "succeeded",
      ),
    );
    await refreshProjectWorktrees(deps, opts.projectId);
    const list =
      deps.projectsRef.current.worktreesByProject[opts.projectId] ?? [];
    const live = list.find(
      (w) =>
        w.id === pending.id ||
        w.path === created.path ||
        w.path === targetPath,
    );
    navigateToWorktree(deps, opts.projectId, live?.id ?? pending.id);
    return live?.path ?? created.path ?? targetPath;
  } catch (err) {
    deps.projectsRef.current = setProjectWorktrees(
      deps.projectsRef.current,
      opts.projectId,
      updateWorktreePendingState(
        deps.projectsRef.current.worktreesByProject[opts.projectId] ?? [],
        pending.id,
        "failed",
        String(err),
      ),
    );
    deps.syncProjectsToState();
    return null;
  }
}

export async function retryPendingWorktree(
  deps: GitDeps & { dismissPendingWorktree: (worktreeId: string) => void },
  worktreeId: string,
): Promise<void> {
  const hit = deps.lookups.findProjectOfWorktree(worktreeId);
  if (!hit || !hit.worktree.branch) return;
  deps.dismissPendingWorktree(worktreeId);
  const pending = newPendingWorktree(
    hit.project.id,
    hit.worktree.branch,
    hit.worktree.path,
  );
  deps.projectsRef.current = setProjectWorktrees(
    deps.projectsRef.current,
    hit.project.id,
    [
      ...(deps.projectsRef.current.worktreesByProject[hit.project.id] ?? []),
      pending,
    ],
  );
  deps.syncProjectsToState();
  deps.projectsRef.current = setProjectWorktrees(
    deps.projectsRef.current,
    hit.project.id,
    updateWorktreePendingState(
      deps.projectsRef.current.worktreesByProject[hit.project.id] ?? [],
      pending.id,
      "starting",
    ),
  );
  deps.syncProjectsToState();
  try {
    await gitWorktreeAdd({
      projectPath: hit.project.path,
      targetPath: hit.worktree.path,
      branch: hit.worktree.branch,
      base: resolveWorktreeBaseBranch(hit.project),
    });
    deps.projectsRef.current = setProjectWorktrees(
      deps.projectsRef.current,
      hit.project.id,
      updateWorktreePendingState(
        deps.projectsRef.current.worktreesByProject[hit.project.id] ?? [],
        pending.id,
        "succeeded",
      ),
    );
    await refreshProjectWorktrees(deps, hit.project.id);
    const list =
      deps.projectsRef.current.worktreesByProject[hit.project.id] ?? [];
    const live = list.find(
      (w) => w.id === pending.id || w.path === hit.worktree.path,
    );
    navigateToWorktree(deps, hit.project.id, live?.id ?? pending.id);
  } catch (err) {
    deps.projectsRef.current = setProjectWorktrees(
      deps.projectsRef.current,
      hit.project.id,
      updateWorktreePendingState(
        deps.projectsRef.current.worktreesByProject[hit.project.id] ?? [],
        pending.id,
        "failed",
        String(err),
      ),
    );
    deps.syncProjectsToState();
  }
}

export type { GitDeps };
