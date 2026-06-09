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
  workspaces?: {
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
      ctx.activateWorkspace(null);
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
      ctx.activateWorkspace(null);
      return;
    }
    for (const workspace of project.workspaces ?? []) {
      if (
        typeof workspace.id === "string" &&
        typeof workspace.path === "string" &&
        normalizePath(workspace.path) === target
      ) {
        if (state.activeProjectId !== project.id)
          ctx.setActiveProjectById(project.id);
        ctx.activateWorkspace(workspace.id);
        return;
      }
    }
  }
}

export function restoreSessionFromSelection(
  ctx: EventRouteContext,
  selection: RestoreSelection | undefined,
): void {
  ctx.setState((prev) => ({ ...prev, landing: null }));
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
