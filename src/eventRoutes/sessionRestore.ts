import type { EventRouteContext } from "./types";

interface RestoreSelection {
  sessionId?: string;
  label?: string;
  cwd?: string;
  scrollToMatch?: string;
}

interface ProjectStateItem {
  id?: unknown;
  path?: unknown;
}

interface SidebarProjectItem {
  id?: unknown;
  path?: unknown;
  worktrees?: {
    id?: unknown;
    path?: unknown;
  }[];
}

function normalizePath(path: string | undefined): string {
  return (path ?? "").replace(/[/\\]+$/, "");
}

function alignProjectToSessionCwd(ctx: EventRouteContext, cwd?: string): void {
  const target = normalizePath(cwd);
  if (!target) return;
  const state = ctx.stateRef.current;
  const projects = Array.isArray(state.projects)
    ? (state.projects as ProjectStateItem[])
    : [];
  const sidebar =
    state.sidebar && typeof state.sidebar === "object"
      ? (state.sidebar as { projects?: unknown })
      : {};
  const sidebarProjects = Array.isArray(sidebar.projects)
    ? (sidebar.projects as SidebarProjectItem[])
    : [];

  for (const project of projects) {
    if (
      typeof project.id === "string" &&
      typeof project.path === "string" &&
      normalizePath(project.path) === target
    ) {
      if (state.activeProjectId !== project.id)
        ctx.setActiveProjectById(project.id);
      ctx.activateWorktree(null);
      return;
    }
  }

  for (const project of sidebarProjects) {
    if (typeof project.id !== "string") continue;
    if (
      typeof project.path === "string" &&
      normalizePath(project.path) === target
    ) {
      if (state.activeProjectId !== project.id)
        ctx.setActiveProjectById(project.id);
      ctx.activateWorktree(null);
      return;
    }
    for (const worktree of project.worktrees ?? []) {
      if (
        typeof worktree.id === "string" &&
        typeof worktree.path === "string" &&
        normalizePath(worktree.path) === target
      ) {
        if (state.activeProjectId !== project.id)
          ctx.setActiveProjectById(project.id);
        ctx.activateWorktree(worktree.id);
        return;
      }
    }
  }
}

export function restoreSessionFromSelection(
  ctx: EventRouteContext,
  selection: RestoreSelection | undefined,
): void {
  if (!selection?.sessionId) {
    ctx.newTab();
    return;
  }

  alignProjectToSessionCwd(ctx, selection.cwd);
  ctx.newTab(selection.sessionId, selection.label ?? "Restored Session", {
    restoredSession: true,
    ...(selection.cwd ? { cwd: selection.cwd } : {}),
    ...(selection.scrollToMatch
      ? { scrollToMatch: selection.scrollToMatch }
      : {}),
  });
}
