import type { EventRouteHandler } from "../types";
import { activateOverview } from "../tabStrip";

/** Worktree event family — all routed through useProjectOps actions. */
export const handleSidebarCreateWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "create-worktree") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (projectId) void ctx.createWorktreeForProject(projectId);
  return true;
};

/**
 * switch-worktree: switch to the selected worktree's session scope and
 * route the user to its landing page. The landing presents a
 * "Start Session" CTA that fires `start-session`, which opens a fresh
 * agent tab inside that already-selected scope.
 */
export const handleSidebarSwitchWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "switch-worktree") return false;
  const worktreeId =
    (data as { worktreeId?: string } | undefined)?.worktreeId ?? null;
  if (!worktreeId) {
    ctx.activateWorktree(null);
    ctx.setState((prev) => ({ ...prev, landing: null }));
    return true;
  }
  // Find the worktree + its parent project in state. The sidebar's
  // /sidebar/projects items carry the canonical worktrees array; we
  // mirror its shape into /landing so the landing component can render
  // without re-fetching.
  const sidebar =
    (ctx.stateRef.current.sidebar as
      | {
          projects?: {
            id: string;
            label: string;
            iconUrl?: string;
            worktrees?: {
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
    const worktree = project.worktrees?.find((w) => w.id === worktreeId);
    if (worktree) {
      const wasAlreadyActiveWorktree =
        ctx.stateRef.current.activeWorktreeId === worktreeId;
      ctx.activateWorktree(worktreeId);
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
      // Re-clicking the active worktree while a session owns the canvas
      // is the user's "back to the worktree landing" gesture. Fall
      // through to the landing-rebuild path and also deselect the
      // session tab so the landing actually renders.
      if (hasVisibleSession && !wasAlreadyActiveWorktree) {
        ctx.setState((prev) => ({ ...prev, landing: null }));
        return true;
      }
      ctx.setState((prev) => ({
        ...prev,
        landing: {
          kind: "worktree",
          projectId: project.id,
          projectLabel: project.label,
          iconUrl: project.iconUrl,
          worktreeId: worktree.id,
          worktreeLabel: worktree.label,
          branch: worktree.branch,
          path: worktree.path,
          isMain: worktree.isMain === true,
        },
      }));
      if (wasAlreadyActiveWorktree && hasVisibleSession) {
        activateOverview(ctx);
      }
      return true;
    }
  }
  // Fallback when state doesn't have the worktree (race during refresh):
  // activate directly so the click never becomes a no-op.
  ctx.activateWorktree(worktreeId);
  return true;
};

/**
 * open-worktree-in-new-tab: double-click on a worktree row in the
 * sidebar. CLAUDE.md's "Tab kinds" promise: single-click activates the
 * worktree (renders the landing), double-click activates AND spawns a
 * fresh agent tab pointing at the worktree's cwd. Mirrors the
 * start-session route's chain so the two gestures stay symmetric.
 */
export const handleSidebarOpenWorktreeInNewTab: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "open-worktree-in-new-tab") return false;
  const worktreeId =
    (data as { worktreeId?: string } | undefined)?.worktreeId ?? null;
  if (!worktreeId) return true;
  // Walk /sidebar/projects to find the parent project + path. Matches
  // the lookup pattern in handleSidebarSwitchWorktree above.
  const sidebar =
    (ctx.stateRef.current.sidebar as
      | {
          projects?: {
            id: string;
            worktrees?: { id: string; path?: string }[];
          }[];
        }
      | undefined) ?? {};
  let projectId: string | undefined;
  let path: string | undefined;
  for (const project of sidebar.projects ?? []) {
    const wt = project.worktrees?.find((w) => w.id === worktreeId);
    if (wt) {
      projectId = project.id;
      path = wt.path;
      break;
    }
  }
  if (projectId) ctx.setActiveProjectById(projectId);
  ctx.activateWorktree(worktreeId);
  ctx.setState((prev) => ({ ...prev, landing: null }));
  ctx.newTab(undefined, undefined, path ? { cwd: path } : undefined);
  return true;
};

/**
 * start-session: emitted by the worktree landing's "Start Session" CTA.
 * Activates the worktree (so subsequent new tabs inherit its cwd) and
 * opens a fresh agent tab pointing at the worktree's path. Clears the
 * landing so the new tab gets the chat canvas instead.
 */
export const handleSidebarStartSession: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "start-session") return false;
  const payload =
    (data as
      | { worktreeId?: string; projectId?: string; path?: string }
      | undefined) ?? {};
  if (payload.projectId) ctx.setActiveProjectById(payload.projectId);
  if (payload.worktreeId) ctx.activateWorktree(payload.worktreeId);
  ctx.setState((prev) => ({ ...prev, landing: null }));
  ctx.newTab(
    undefined,
    undefined,
    payload.path ? { cwd: payload.path } : undefined,
  );
  return true;
};

export const handleSidebarRemoveWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "remove-worktree") return false;
  const selected =
    (data as { worktreeId?: string; confirmed?: boolean } | undefined) ?? {};
  if (selected.worktreeId) {
    void ctx.removeWorktreeById(selected.worktreeId, {
      confirmed: selected.confirmed === true,
    });
  }
  return true;
};

export const handleSidebarCancelPendingWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "cancel-pending-worktree") return false;
  const worktreeId = (data as { worktreeId?: string } | undefined)?.worktreeId;
  if (worktreeId) ctx.dismissPendingWorktree(worktreeId);
  return true;
};

export const handleSidebarRetryPendingWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "retry-pending-worktree") return false;
  const worktreeId = (data as { worktreeId?: string } | undefined)?.worktreeId;
  if (worktreeId) void ctx.retryPendingWorktree(worktreeId);
  return true;
};

export const handleSidebarRenameWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-worktree") return false;
  const { worktreeId, label } =
    (data as { worktreeId?: string; label?: string } | undefined) ?? {};
  if (worktreeId && typeof label === "string")
    ctx.renameWorktree(worktreeId, label);
  return true;
};

export const handleSidebarReorderWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "reorder-worktree") return false;
  const payload =
    (data as
      | { projectId?: string; worktreeId?: string; toIndex?: number }
      | undefined) ?? {};
  if (
    payload.projectId &&
    payload.worktreeId &&
    typeof payload.toIndex === "number"
  ) {
    ctx.reorderWorktree(payload.projectId, payload.worktreeId, payload.toIndex);
  }
  return true;
};

export const handleSidebarSortProjectWorktrees: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "sort-project-worktrees") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (projectId) ctx.sortProjectWorktreesNewest(projectId);
  return true;
};

export const handleSidebarOpenWorktreeInFinder: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "open-worktree-in-finder") return false;
  const path = (data as { path?: string } | undefined)?.path;
  if (!path) return true;
  await ctx.invoke("fs_open_in_file_manager", { path }).catch(() => {});
  return true;
};

export const handleSidebarCopyWorktreePath: EventRouteHandler = ({
  eventType,
  data,
}) => {
  if (eventType !== "copy-worktree-path") return false;
  const path = (data as { path?: string } | undefined)?.path;
  if (path && navigator.clipboard) {
    void navigator.clipboard.writeText(path).catch(() => {});
  }
  return true;
};
