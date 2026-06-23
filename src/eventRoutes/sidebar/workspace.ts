import type { EventRouteHandler } from "../types";
import { activateOverview } from "../tabStrip";

/** Workspace event family — all routed through useProjectOps actions. */
export const handleSidebarCreateWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "create-workspace") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (projectId) void ctx.createWorkspaceForProject(projectId);
  return true;
};

/**
 * switch-workspace: switch to the selected workspace's session scope and
 * route the user to its landing page. The landing presents a
 * "Start Session" CTA that fires `start-session`, which opens a fresh
 * agent tab inside that already-selected scope.
 */
export const handleSidebarSwitchWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "switch-workspace") return false;
  const workspaceId =
    (data as { workspaceId?: string } | undefined)?.workspaceId ?? null;
  if (!workspaceId) {
    ctx.activateWorkspace(null);
    ctx.setState((prev) => ({ ...prev, landing: null }));
    return true;
  }
  // Find the workspace + its parent project in state. The sidebar's
  // /sidebar/projects items carry the canonical workspaces array; we
  // mirror its shape into /landing so the landing component can render
  // without re-fetching.
  const sidebar =
    (ctx.stateRef.current.sidebar as
      | {
          projects?: {
            id: string;
            label: string;
            iconUrl?: string;
            workspaces?: {
              id: string;
              label?: string;
              branch?: string;
              path?: string;
              isMain?: boolean;
            }[];
          }[];
        }
      | undefined) ?? {};
  for (const project of sidebar.projects ?? []) {
    const workspace = project.workspaces?.find((w) => w.id === workspaceId);
    if (workspace) {
      const activeProjectId = ctx.stateRef.current.activeProjectId;
      const activeWorkspaceId = ctx.stateRef.current.activeWorkspaceId;
      const routeWorkspaceId = workspace.isMain === true ? null : workspace.id;
      const wasAlreadyActiveWorkspace =
        workspace.isMain === true
          ? activeProjectId === project.id && activeWorkspaceId == null
          : activeWorkspaceId === workspace.id;
      if (workspace.isMain === true) {
        ctx.setActiveProjectById(project.id);
      }
      ctx.activateWorkspace(routeWorkspaceId);
      const tabs = Array.isArray(ctx.stateRef.current.tabs)
        ? ctx.stateRef.current.tabs
        : [];
      const activeTabId = ctx.stateRef.current.activeTabId;
      const hasVisibleSession =
        tabs.length > 0 &&
        typeof activeTabId === "string" &&
        tabs.some((tab) => {
          return (
            tab &&
            typeof tab === "object" &&
            "id" in tab &&
            tab.id === activeTabId
          );
        });
      // Re-clicking the active workspace while a session owns the canvas
      // is the user's "back to the workspace landing" gesture. Fall
      // through to the landing-rebuild path and also deselect the
      // session tab so the landing actually renders.
      if (hasVisibleSession && !wasAlreadyActiveWorkspace) {
        ctx.setState((prev) => ({ ...prev, landing: null }));
        return true;
      }
      ctx.setState((prev) => ({
        ...prev,
        landing: {
          kind: "workspace",
          projectId: project.id,
          projectLabel: project.label,
          iconUrl: project.iconUrl,
          workspaceId: workspace.id,
          workspaceLabel: workspace.label,
          branch: workspace.branch,
          path: workspace.path,
          isMain: workspace.isMain === true,
        },
      }));
      if (wasAlreadyActiveWorkspace && hasVisibleSession) {
        activateOverview(ctx);
      }
      return true;
    }
  }
  // Fallback when state doesn't have the workspace (race during refresh):
  // activate directly so the click never becomes a no-op.
  ctx.activateWorkspace(workspaceId);
  return true;
};

/**
 * open-workspace-in-new-tab: double-click on a workspace row in the
 * sidebar. CLAUDE.md's "Tab kinds" promise: single-click activates the
 * workspace (renders the landing), double-click activates AND spawns a
 * fresh agent tab pointing at the workspace's cwd. Mirrors the
 * start-session route's chain so the two gestures stay symmetric.
 */
export const handleSidebarOpenWorkspaceInNewTab: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "open-workspace-in-new-tab") return false;
  const workspaceId =
    (data as { workspaceId?: string } | undefined)?.workspaceId ?? null;
  if (!workspaceId) return true;
  // Walk /sidebar/projects to find the parent project + path. Matches
  // the lookup pattern in handleSidebarSwitchWorkspace above.
  const sidebar =
    (ctx.stateRef.current.sidebar as
      | {
          projects?: {
            id: string;
            workspaces?: { id: string; path?: string }[];
          }[];
        }
      | undefined) ?? {};
  let projectId: string | undefined;
  let path: string | undefined;
  for (const project of sidebar.projects ?? []) {
    const wt = project.workspaces?.find((w) => w.id === workspaceId);
    if (wt) {
      projectId = project.id;
      path = wt.path;
      break;
    }
  }
  if (projectId) ctx.setActiveProjectById(projectId);
  ctx.activateWorkspace(workspaceId);
  ctx.setState((prev) => ({ ...prev, landing: null }));
  ctx.newTab(undefined, undefined, path ? { cwd: path } : undefined);
  return true;
};

/**
 * start-session: emitted by the workspace landing's "Start Session" CTA.
 * Activates the workspace (so subsequent new tabs inherit its cwd) and
 * opens a fresh agent tab pointing at the workspace's path. Clears the
 * landing so the new tab gets the chat canvas instead.
 */
export const handleSidebarStartSession: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "start-session") return false;
  const payload =
    (data as
      | { workspaceId?: string; projectId?: string; path?: string }
      | undefined) ?? {};
  if (payload.projectId) ctx.setActiveProjectById(payload.projectId);
  if (payload.workspaceId) ctx.activateWorkspace(payload.workspaceId);
  ctx.setState((prev) => ({ ...prev, landing: null }));
  ctx.newTab(
    undefined,
    undefined,
    payload.path ? { cwd: payload.path } : undefined,
  );
  return true;
};

export const handleSidebarRemoveWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "remove-workspace") return false;
  const selected =
    (data as { workspaceId?: string; confirmed?: boolean } | undefined) ?? {};
  if (selected.workspaceId) {
    void ctx.removeWorkspaceById(selected.workspaceId, {
      confirmed: selected.confirmed === true,
    });
  }
  return true;
};

export const handleSidebarCancelPendingWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "cancel-pending-workspace") return false;
  const workspaceId = (data as { workspaceId?: string } | undefined)?.workspaceId;
  if (workspaceId) ctx.dismissPendingWorkspace(workspaceId);
  return true;
};

export const handleSidebarRetryPendingWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "retry-pending-workspace") return false;
  const workspaceId = (data as { workspaceId?: string } | undefined)?.workspaceId;
  if (workspaceId) void ctx.retryPendingWorkspace(workspaceId);
  return true;
};

export const handleSidebarRenameWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-workspace") return false;
  const { workspaceId, label } =
    (data as { workspaceId?: string; label?: string } | undefined) ?? {};
  if (workspaceId && typeof label === "string")
    ctx.renameWorkspace(workspaceId, label);
  return true;
};

export const handleSidebarReorderWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "reorder-workspace") return false;
  const payload =
    (data as
      | { projectId?: string; workspaceId?: string; toIndex?: number }
      | undefined) ?? {};
  if (
    payload.projectId &&
    payload.workspaceId &&
    typeof payload.toIndex === "number"
  ) {
    ctx.reorderWorkspace(payload.projectId, payload.workspaceId, payload.toIndex);
  }
  return true;
};

export const handleSidebarSortProjectWorkspaces: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "sort-project-workspaces") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (projectId) ctx.sortProjectWorkspacesNewest(projectId);
  return true;
};

export const handleSidebarOpenWorkspaceInFinder: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "open-workspace-in-finder") return false;
  const path = (data as { path?: string } | undefined)?.path;
  if (!path) return true;
  await ctx.invoke("fs_open_in_file_manager", { path }).catch(() => {});
  return true;
};

export const handleSidebarCopyWorkspacePath: EventRouteHandler = ({
  eventType,
  data,
}) => {
  if (eventType !== "copy-workspace-path") return false;
  const path = (data as { path?: string } | undefined)?.path;
  if (path && navigator.clipboard) {
    void navigator.clipboard.writeText(path).catch(() => {});
  }
  return true;
};
