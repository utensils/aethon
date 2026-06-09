/**
 * Dashboard event routes — project surfaces' CTA + composer events.
 *
 * Three composite types feed these handlers:
 *   - projects-dashboard / project-dashboard — open-project, new-tab,
 *     restore-session, select-project-card, request-card-menu,
 *     remove-project-card, refresh-dashboard, create-worktree,
 *     switch-worktree.
 *   - task-launcher — start-task (the Codex-style "do anything"
 *     composer submit).
 *   - gh-stats-strip — open-url (shells out via tauri-plugin-opener).
 *
 * All are keyed by `type:` in the route table so an extension's custom
 * dashboard (registered via aethon.registerComponent) routes through
 * the same handlers.
 */
import type { EventRouteHandler } from "./types";
import {
  handleSidebarDeleteSession,
  handleSidebarRemoveWorktree,
  handleSidebarSwitchWorktree,
} from "./sidebar";
import { restoreSessionFromSelection } from "./sessionRestore";

/** New-tab / Open Project… / restore-session / select-project-card
 *  for the global projects-dashboard surface. */
export const handleProjectsDashboard: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "new-tab") {
    ctx.newTab();
    return true;
  }
  if (eventType === "open-project") {
    void ctx.openProjectFromPicker();
    return true;
  }
  if (eventType === "select-project-card") {
    const sel = data as { projectId?: string } | undefined;
    if (sel?.projectId) {
      ctx.activateWorktree(null);
      ctx.setActiveProjectById(sel.projectId);
      ctx.setState((prev) => ({ ...prev, landing: null }));
    }
    return true;
  }
  if (eventType === "request-card-menu") {
    // The composite emits the menu request; until we wire the shared
    // context-menu primitive (Phase 2 of the broader plan), no-op so
    // the event doesn't bubble out and forward to the bridge.
    return true;
  }
  if (eventType === "remove-project-card") {
    const sel = data as { projectId?: string } | undefined;
    if (sel?.projectId) ctx.removeProjectById(sel.projectId);
    return true;
  }
  if (eventType === "restore-session") {
    const sel = data as
      | { sessionId?: string; label?: string; cwd?: string }
      | undefined;
    restoreSessionFromSelection(ctx, sel);
    return true;
  }
  if (eventType === "delete-session") {
    return handleSidebarDeleteSession(
      { component: { id: "", type: "sidebar" }, eventType, data },
      ctx,
    );
  }
  return false;
};

/** Per-project dashboard — reuses several of the global routes plus
 *  worktree gestures emitted by the inline worktree rail. */
export const handleProjectDashboard: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "open-url") {
    // The gh-stats-strip is rendered inline inside the dashboard (not via
    // the registry), so its open-url events arrive under this component's
    // context rather than type:gh-stats-strip. Delegate to the shared
    // opener handler so the stat badges actually open GitHub.
    return handleGhStatsStrip(
      { component: { id: "", type: "gh-stats-strip" }, eventType, data },
      ctx,
    );
  }
  if (eventType === "start-task" || eventType === "paste-image-failed") {
    return handleTaskLauncher(
      { component: { id: "", type: "task-launcher" }, eventType, data },
      ctx,
    );
  }
  if (eventType === "create-worktree") {
    const sel = data as { projectId?: string } | undefined;
    if (sel?.projectId) void ctx.createWorktreeForProject(sel.projectId);
    return true;
  }
  if (eventType === "switch-worktree") {
    return handleSidebarSwitchWorktree(
      { component: { id: "", type: "sidebar" }, eventType, data },
      ctx,
    );
  }
  if (eventType === "remove-worktree") {
    return handleSidebarRemoveWorktree(
      { component: { id: "", type: "sidebar" }, eventType, data },
      ctx,
    );
  }
  if (eventType === "refresh-dashboard") {
    // Refresh path doesn't bust the gh cache directly from here — the
    // pi-tool variant does that via refreshRepoOverview. UI-driven
    // refresh just re-fetches the active project's git status; the gh
    // overview cache TTL handles the rest.
    const project = (ctx.stateRef.current as { project?: { path?: string } })
      .project;
    if (project?.path) {
      // Best-effort — the route table doesn't expose refreshGitStatusFor
      // directly, but the next focus/poll tick will pick up changes.
    }
    return true;
  }
  // Reuse global handlers for shared events (restore-session etc).
  return handleProjectsDashboard(
    { component: { id: "", type: "" }, eventType, data },
    ctx,
  );
};

/** task-launcher submit — the heart of the per-project composer. */
export const handleTaskLauncher: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "paste-image-failed") {
    const sel = data as { message?: unknown } | undefined;
    ctx.pushNotification({
      id: "ae-task-paste-image-failed",
      title: "Image paste failed",
      message:
        typeof sel?.message === "string"
          ? sel.message
          : "Could not paste image.",
      kind: "error",
      durationMs: 3000,
    });
    return true;
  }
  if (eventType === "start-task") {
    const sel = data as
      | {
          projectId?: string;
          prompt?: string;
          attachments?: unknown;
          newWorktree?: boolean;
          branch?: string;
          baseBranch?: string;
          worktreeId?: string;
          model?: string;
        }
      | undefined;
    if (!sel?.projectId || !sel.prompt) return true;
    void ctx.startTaskInProject({
      projectId: sel.projectId,
      prompt: sel.prompt,
      newWorktree: sel.newWorktree === true,
      attachments: Array.isArray(sel.attachments) ? sel.attachments : undefined,
      branch: sel.branch,
      baseBranch: sel.baseBranch,
      worktreeId: sel.worktreeId,
      ...(typeof sel.model === "string" && sel.model.length > 0
        ? { model: sel.model }
        : {}),
    });
    return true;
  }
  // The launcher also emits select-project-card when the project chip
  // is changed — re-dispatch to the dashboard handler.
  if (eventType === "select-project-card") {
    return handleProjectsDashboard(
      { component: { id: "", type: "" }, eventType, data },
      ctx,
    );
  }
  return false;
};

/** gh-stats-strip — open-url events shell out via the opener plugin. */
export const handleGhStatsStrip: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "open-url") {
    const sel = data as { url?: string } | undefined;
    if (sel?.url) {
      void ctx.invoke("plugin:opener|open_url", { url: sel.url });
    }
    return true;
  }
  return false;
};
