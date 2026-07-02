/**
 * Dashboard event routes — project surfaces' CTA + composer events.
 *
 * Three composite types feed these handlers:
 *   - projects-dashboard / project-dashboard — open-project, new-tab,
 *     restore-session, select-project-card, request-card-menu,
 *     remove-project-card, refresh-dashboard, create-workspace,
 *     switch-workspace.
 *   - task-launcher — start-task (the Codex-style "do anything"
 *     composer submit).
 *   - gh-stats-strip — open-url (shells out via tauri-plugin-opener).
 *
 * All are keyed by `type:` in the route table so an extension's custom
 * dashboard (registered via aethon.registerComponent) routes through
 * the same handlers.
 */
import type { EventRouteContext, EventRouteHandler } from "./types";
import type { GitHubIssueSource } from "../types/tab";
import {
  handleSidebarDeleteSession,
  handleSidebarRemoveWorkspace,
  handleSidebarSwitchWorkspace,
} from "./sidebar";
import { restoreSessionFromSelection } from "./sessionRestore";
import { firstIssueSessionTab } from "../extensions/default-layout/dashboard/issue-sessions";
import { DEFAULT_WORKSPACE_BASE_BRANCH } from "../projects";
import { isRemoteHostId } from "../remoteInvoke";

function issueSourceFromStartTask(data: {
  projectId?: string;
  source?: string;
  issueNumber?: unknown;
  issueUrl?: unknown;
  issueTitle?: unknown;
  branch?: string;
  workspaceId?: string;
}): GitHubIssueSource | null {
  const number =
    typeof data.issueNumber === "number"
      ? data.issueNumber
      : Number(data.issueNumber);
  if (
    data.source !== "github-issue" ||
    !data.projectId ||
    !Number.isInteger(number) ||
    number <= 0
  ) {
    return null;
  }
  return {
    kind: "github-issue",
    projectId: data.projectId,
    number,
    url: typeof data.issueUrl === "string" ? data.issueUrl : "",
    title: typeof data.issueTitle === "string" ? data.issueTitle : "",
    ...(data.branch ? { branch: data.branch } : {}),
    ...(data.workspaceId ? { workspaceId: data.workspaceId } : {}),
    createdAt: Date.now(),
  };
}

function projectBaseBranchFromState(
  state: Record<string, unknown>,
  projectId: string,
): string {
  const projects = state.projects;
  if (Array.isArray(projects)) {
    const project = projects.find(
      (candidate): candidate is { id: string; workspaceBaseBranch?: unknown } =>
        Boolean(
          candidate &&
            typeof candidate === "object" &&
            "id" in candidate &&
            candidate.id === projectId,
        ),
    );
    if (
      typeof project?.workspaceBaseBranch === "string" &&
      project.workspaceBaseBranch.trim().length > 0
    ) {
      return project.workspaceBaseBranch.trim();
    }
  }
  return DEFAULT_WORKSPACE_BASE_BRANCH;
}

function activateRemoteProject(
  ctx: EventRouteContext,
  project: {
    projectId: string;
    hostId: string;
    remoteId?: string;
    label?: string;
    path?: string;
    workspaceId?: string | null;
  },
): void {
  ctx.activateWorkspace(project.workspaceId ?? null);
  ctx.clearActiveProject();
  ctx.setActiveHost(project.hostId);
  ctx.setState((prev) => ({
    ...prev,
    project: {
      id: project.projectId,
      remoteId: project.remoteId ?? project.projectId,
      hostId: project.hostId,
      label: project.label ?? project.projectId,
      path: project.path ?? "",
    },
    activeProjectId: project.projectId,
    activeWorkspaceId: project.workspaceId ?? null,
    landing: null,
  }));
}

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
    const activeHostId =
      (ctx.stateRef.current.activeHostId as string | null | undefined) ?? null;
    if (isRemoteHostId(activeHostId)) {
      ctx.pushNotification({
        title: "Open projects on the remote host",
        message: "Pair the host, then use the projects it publishes here.",
        kind: "info",
        durationMs: 5000,
      });
      return true;
    }
    void ctx.openProjectFromPicker();
    return true;
  }
  if (eventType === "select-project-card") {
    const sel = data as
      | {
          projectId?: string;
          hostId?: string;
          remoteId?: string;
          label?: string;
          path?: string;
        }
      | undefined;
    if (sel?.projectId) {
      if (sel.hostId && isRemoteHostId(sel.hostId)) {
        activateRemoteProject(ctx, {
          projectId: sel.projectId,
          hostId: sel.hostId,
          remoteId: sel.remoteId,
          label: sel.label,
          path: sel.path,
        });
      } else {
        ctx.activateWorkspace(null);
        ctx.setActiveProjectById(sel.projectId);
        ctx.setState((prev) => ({ ...prev, landing: null }));
      }
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
  if (eventType === "start-task" || eventType === "paste-image-failed") {
    return handleTaskLauncher(
      { component: { id: "", type: "task-launcher" }, eventType, data },
      ctx,
    );
  }
  return false;
};

/** Per-project dashboard — reuses several of the global routes plus
 *  workspace gestures emitted by the inline workspace rail. */
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
  if (
    eventType === "start-task" ||
    eventType === "open-issue-session" ||
    eventType === "issues-refreshed" ||
    eventType === "paste-image-failed"
  ) {
    return handleTaskLauncher(
      { component: { id: "", type: "task-launcher" }, eventType, data },
      ctx,
    );
  }
  if (eventType === "create-workspace") {
    const sel = data as { projectId?: string } | undefined;
    if (sel?.projectId) void ctx.createWorkspaceForProject(sel.projectId);
    return true;
  }
  if (eventType === "switch-workspace") {
    return handleSidebarSwitchWorkspace(
      { component: { id: "", type: "sidebar" }, eventType, data },
      ctx,
    );
  }
  if (eventType === "remove-workspace") {
    return handleSidebarRemoveWorkspace(
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

/**
 * Launch a start-task selection: host-target chat, an already-open issue
 * session, or a project task via `startTaskInProject`. Resolves `true`
 * when a session surface actually opened (tab activated or task
 * launched) so touch-first callers can gate navigation on the outcome.
 * The desktop task-launcher calls this fire-and-forget — failures
 * surface as notifications either way.
 */
export async function launchStartTask(
  data: unknown,
  ctx: EventRouteContext,
): Promise<boolean> {
  const sel = data as
    | {
        projectId?: string;
        hostId?: string;
        remoteId?: string;
        projectLabel?: string;
        path?: string;
        prompt?: string;
        attachments?: unknown;
        newWorkspace?: boolean;
        branch?: string;
        baseBranch?: string;
        workspaceId?: string;
        model?: string;
        target?: string;
        source?: string;
        issueNumber?: unknown;
        issueUrl?: unknown;
        issueTitle?: unknown;
        issueTemplateId?: string;
        issueTemplateLabel?: string;
      }
    | undefined;
  const attachments = Array.isArray(sel?.attachments)
    ? sel.attachments
    : undefined;
  const prompt = typeof sel?.prompt === "string" ? sel.prompt : "";
  const hasPayload = prompt.length > 0 || (attachments?.length ?? 0) > 0;
  if (sel?.target === "host" && hasPayload) {
    const tabId = crypto.randomUUID();
    ctx.newTab(
      tabId,
      undefined,
      typeof sel.model === "string" && sel.model.length > 0
        ? { model: sel.model }
        : undefined,
    );
    void ctx.sendChat(prompt, {
      tabId,
      attachments,
    });
    return true;
  }
  if (!sel?.projectId || !hasPayload) return false;
  if (sel.hostId && isRemoteHostId(sel.hostId)) {
    if (!sel.path) {
      ctx.pushNotification({
        title: "Could not start task",
        message: "Remote project path is missing.",
        kind: "warning",
      });
      return false;
    }
    activateRemoteProject(ctx, {
      projectId: sel.projectId,
      hostId: sel.hostId,
      remoteId: sel.remoteId,
      label: sel.projectLabel,
      path: sel.path,
      workspaceId: sel.workspaceId ?? null,
    });
    const tabId = crypto.randomUUID();
    ctx.newTab(tabId, undefined, {
      cwd: sel.path,
      hostId: sel.hostId,
      ...(typeof sel.model === "string" && sel.model.length > 0
        ? { model: sel.model }
        : {}),
    });
    void ctx.sendChat(prompt, {
      tabId,
      attachments,
    });
    return true;
  }
  const sourceIssue = issueSourceFromStartTask(sel);
  if (sourceIssue) {
    const existing = firstIssueSessionTab(
      ctx.stateRef.current,
      sourceIssue.projectId,
      sourceIssue.number,
    );
    if (existing) {
      ctx.activateTabAnywhere(existing.id);
      return true;
    }
  }
  const launched = await ctx.startTaskInProject({
    projectId: sel.projectId,
    prompt,
    newWorkspace: sel.newWorkspace === true,
    attachments,
    branch: sel.branch,
    baseBranch:
      sel.newWorkspace === true
        ? (sel.baseBranch?.trim() ||
          projectBaseBranchFromState(ctx.stateRef.current, sel.projectId))
        : sel.baseBranch,
    workspaceId: sel.workspaceId,
    ...(typeof sel.model === "string" && sel.model.length > 0
      ? { model: sel.model }
      : {}),
    ...(sourceIssue ? { sourceIssue } : {}),
  });
  return launched != null;
}

/** task-launcher submit — the heart of the per-project composer. */
export const handleTaskLauncher: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "open-issue-session") {
    const tabId = (data as { tabId?: string } | undefined)?.tabId;
    if (tabId) ctx.activateTabAnywhere(tabId);
    return true;
  }
  if (eventType === "issues-refreshed") {
    const sel =
      (data as
        | {
            projectId?: string;
            openIssueNumbers?: unknown;
          }
        | undefined) ?? {};
    const numbers = Array.isArray(sel.openIssueNumbers)
      ? new Set(
          sel.openIssueNumbers
            .map((value) =>
              typeof value === "number" ? value : Number(value),
            )
            .filter(
              (value) => Number.isInteger(value) && value > 0,
            ),
        )
      : null;
    if (sel.projectId && numbers) {
      ctx.clearClosedIssueLinksForProject(sel.projectId, numbers);
    }
    return true;
  }
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
    void launchStartTask(data, ctx);
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
