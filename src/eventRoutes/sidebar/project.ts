import type { EventRouteHandler } from "../types";

/** sidebar remove-project: delegate to the projects hook. Returns true
 *  when no projectId is present (treat as handled rather than fall
 *  through — there's no other handler that wants this event). */
export const handleSidebarRemoveProject: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "remove-project") return false;
  const selected = data as { projectId?: string; itemId?: string } | undefined;
  const projectId = selected?.projectId ?? selected?.itemId;
  return projectId ? ctx.removeProjectById(projectId) : true;
};

/** Sidebar disclosure on a project row — toggle the per-project
 *  expanded state so workspaces show/hide nested under the row. */
export const handleSidebarToggleProjectExpand: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "toggle-project-expand") return false;
  const selected = data as { itemId?: string } | undefined;
  if (!selected?.itemId) return true;
  // Read current expanded flag from state.
  const projects =
    (ctx.stateRef.current.projects as
      | Array<{ id: string; uiExpanded?: boolean }>
      | undefined) ?? [];
  const project = projects.find((p) => p.id === selected.itemId);
  ctx.setProjectExpanded(selected.itemId, !(project?.uiExpanded ?? false));
  return true;
};

/** Filesystem helpers — open + copy on a project. The path to act on is
 *  read from the projects state when only an id is given. */
export const handleSidebarOpenProjectInFinder: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "open-project-in-finder") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (!projectId) return true;
  const projects =
    (ctx.stateRef.current.projects as
      | Array<{ id: string; path?: string }>
      | undefined) ?? [];
  const path = projects.find((p) => p.id === projectId)?.path;
  if (!path) return true;
  await ctx.invoke("fs_open_in_file_manager", { path }).catch(() => {
    /* command may not exist in older builds; ignore */
  });
  return true;
};

export const handleSidebarCopyProjectPath: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "copy-project-path") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (!projectId) return true;
  const projects =
    (ctx.stateRef.current.projects as
      | Array<{ id: string; path?: string }>
      | undefined) ?? [];
  const path = projects.find((p) => p.id === projectId)?.path;
  if (path && navigator.clipboard) {
    void navigator.clipboard.writeText(path).catch(() => {});
  }
  return true;
};

export const handleSidebarRenameProject: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-project") return false;
  const { projectId, label } =
    (data as { projectId?: string; label?: string } | undefined) ?? {};
  if (projectId && typeof label === "string")
    ctx.renameProject(projectId, label);
  return true;
};

export const handleSidebarSetProjectWorkspaceBase: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "set-project-workspace-base") return false;
  const { projectId, baseBranch } =
    (data as { projectId?: string; baseBranch?: string } | undefined) ?? {};
  if (projectId && typeof baseBranch === "string") {
    ctx.setProjectWorkspaceBaseBranch(projectId, baseBranch);
  }
  return true;
};
