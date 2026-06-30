import type { ProjectsState } from "../../projects";
import type { Workspace } from "../../workspaces";
import type { GitStatus } from "../useProjects";

function gitStatusEquals(
  a: GitStatus | undefined,
  b: GitStatus | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  );
}

function workspaceBranchFromGitStatus(status: GitStatus | null): string | null {
  const branch = status?.branch ?? null;
  // git_status deliberately falls back to a short SHA on detached HEAD so the
  // project git chip has a useful display value. Workspace.branch follows
  // git_worktrees semantics instead: null means detached. Do not copy display
  // SHAs into workspace rows or they become PR-eligible pseudo-branches.
  if (branch && /^[0-9a-f]{7,40}$/i.test(branch)) return null;
  return branch;
}

function workspaceWithBranch(workspace: Workspace, branch: string | null) {
  if (workspace.branch === branch) return workspace;
  const labelTracksPreviousBranch =
    workspace.label !== undefined && workspace.label === workspace.branch;
  return {
    ...workspace,
    branch,
    ...(labelTracksPreviousBranch ? { label: undefined } : {}),
  };
}

export interface ApplyActiveVcsGitStatusInput {
  projects: ProjectsState;
  gitStatuses: Map<string, GitStatus>;
  root: string;
  status: GitStatus | null;
}

export interface ApplyActiveVcsGitStatusResult {
  projects: ProjectsState;
  changed: boolean;
}

/**
 * Fold the active-root git_status result from /vcs into the project mirror
 * sources before the UI state is rebuilt. This keeps the sidebar project chip,
 * workspace rows, and side-panel headers on the same HEAD branch as /vcs in one
 * React store transaction instead of waiting for the colder project poller or a
 * separate git_worktrees refresh.
 */
export function applyActiveVcsGitStatusToProjects({
  projects,
  gitStatuses,
  root,
  status,
}: ApplyActiveVcsGitStatusInput): ApplyActiveVcsGitStatusResult {
  let changed = false;
  const previousStatus = gitStatuses.get(root);
  if (status) {
    if (!gitStatusEquals(previousStatus, status)) {
      gitStatuses.set(root, status);
      changed = true;
    }
  } else if (previousStatus) {
    gitStatuses.delete(root);
    changed = true;
  }

  const branch = workspaceBranchFromGitStatus(status);
  let workspacesByProject = projects.workspacesByProject;
  for (const [projectId, workspaces] of Object.entries(
    projects.workspacesByProject,
  )) {
    let listChanged = false;
    const next = workspaces.map((workspace) => {
      if (workspace.path !== root) return workspace;
      const updated = workspaceWithBranch(workspace, branch);
      if (updated !== workspace) listChanged = true;
      return updated;
    });
    if (listChanged) {
      if (workspacesByProject === projects.workspacesByProject) {
        workspacesByProject = { ...projects.workspacesByProject };
      }
      workspacesByProject[projectId] = next;
      changed = true;
    }
  }

  return {
    projects:
      workspacesByProject === projects.workspacesByProject
        ? projects
        : { ...projects, workspacesByProject },
    changed,
  };
}
