import type { EventRouteHandler } from "../types";
import { OVERVIEW_TAB_ID, type Tab } from "../../types/tab";
import { normalizeSessionPath } from "../../hooks/projectOps/tabBuckets";
import { isRemoteHostId } from "../../remoteInvoke";

interface SidebarWorkspaceItem {
  id: string;
  remoteId?: string;
  projectId?: string;
  remoteProjectId?: string;
  hostId?: string;
  label?: string;
  branch?: string;
  path?: string;
  isMain?: boolean;
}

interface SidebarProjectItem {
  id: string;
  remoteId?: string;
  hostId?: string;
  label: string;
  path?: string;
  iconUrl?: string;
  workspaces?: SidebarWorkspaceItem[];
}

interface WorkspaceEventPayload {
  workspaceId?: string;
  projectId?: string;
  hostId?: string;
  remoteId?: string;
  remoteProjectId?: string;
  path?: string;
}

interface WorkspaceMatch {
  project: SidebarProjectItem;
  workspace: SidebarWorkspaceItem;
  hostId?: string;
}

function sidebarState(state: Record<string, unknown>): {
  projects?: SidebarProjectItem[];
  projectsByHost?: Record<string, SidebarProjectItem[]>;
} {
  const raw = (state.sidebar as Record<string, unknown> | undefined) ?? {};
  const projects = Array.isArray(raw.projects)
    ? (raw.projects as SidebarProjectItem[])
    : undefined;
  const projectsByHost =
    raw.projectsByHost && typeof raw.projectsByHost === "object"
      ? Object.fromEntries(
          Object.entries(raw.projectsByHost as Record<string, unknown>).filter(
            (entry): entry is [string, SidebarProjectItem[]] =>
              Array.isArray(entry[1]),
          ),
        )
      : undefined;
  return { projects, projectsByHost };
}

function findWorkspaceInProjects(
  projects: SidebarProjectItem[] | undefined,
  workspaceId: string,
  payload: WorkspaceEventPayload,
  hostId?: string,
): WorkspaceMatch | null {
  for (const project of projects ?? []) {
    if (
      payload.projectId &&
      project.id !== payload.projectId &&
      project.remoteId !== payload.projectId &&
      project.remoteId !== payload.remoteProjectId
    ) {
      continue;
    }
    const workspace = project.workspaces?.find(
      (w) =>
        w.id === workspaceId ||
        w.remoteId === workspaceId ||
        (payload.remoteId && w.remoteId === payload.remoteId),
    );
    if (workspace) {
      return {
        project,
        workspace,
        hostId: workspace.hostId ?? project.hostId ?? payload.hostId ?? hostId,
      };
    }
  }
  return null;
}

function findSidebarWorkspace(
  state: Record<string, unknown>,
  workspaceId: string,
  payload: WorkspaceEventPayload,
): WorkspaceMatch | null {
  const sidebar = sidebarState(state);
  const seen = new Set<string>();
  const search = (
    key: string,
    projects: SidebarProjectItem[] | undefined,
    hostId?: string,
  ) => {
    if (seen.has(key)) return null;
    seen.add(key);
    return findWorkspaceInProjects(projects, workspaceId, payload, hostId);
  };
  if (payload.hostId) {
    const match = search(
      `host:${payload.hostId}`,
      sidebar.projectsByHost?.[payload.hostId],
      payload.hostId,
    );
    if (match) return match;
  }
  const activeMatch = search("active", sidebar.projects);
  if (activeMatch) return activeMatch;
  for (const [hostId, projects] of Object.entries(
    sidebar.projectsByHost ?? {},
  )) {
    const match = search(`host:${hostId}`, projects, hostId);
    if (match) return match;
  }
  return null;
}

function activateRemoteWorkspace(
  ctx: Parameters<EventRouteHandler>[1],
  match: WorkspaceMatch,
  options: { showLanding: boolean },
): void {
  if (!match.hostId) return;
  const { project, workspace } = match;
  const activeWorkspaceId = workspace.isMain === true ? null : workspace.id;
  ctx.clearActiveProject();
  ctx.setActiveHost(match.hostId);
  ctx.setState((prev) => ({
    ...prev,
    activeHostId: match.hostId,
    project: {
      id: project.id,
      remoteId: project.remoteId ?? workspace.remoteProjectId ?? project.id,
      hostId: match.hostId,
      label: project.label,
      path: project.path ?? workspace.path ?? "",
    },
    activeProjectId: project.id,
    activeWorkspaceId,
    activeTabId: options.showLanding ? OVERVIEW_TAB_ID : prev.activeTabId,
    landing: options.showLanding
      ? {
          kind: "workspace",
          projectId: project.id,
          projectLabel: project.label,
          hostId: match.hostId,
          iconUrl: project.iconUrl,
          workspaceId: workspace.id,
          workspaceLabel: workspace.label,
          branch: workspace.branch,
          path: workspace.path,
          isMain: workspace.isMain === true,
        }
      : null,
  }));
}

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
  const payload = (data as WorkspaceEventPayload | undefined) ?? {};
  // Find the workspace + its parent project in state. The sidebar's
  // /sidebar/projects items carry the active host, while
  // /sidebar/projectsByHost carries independently expanded inactive
  // hosts. Mirror that shape into /landing so the landing component can
  // render without re-fetching.
  const match = findSidebarWorkspace(
    ctx.stateRef.current,
    workspaceId,
    payload,
  );
  if (match) {
    const { project, workspace, hostId } = match;
    if (hostId && isRemoteHostId(hostId)) {
      activateRemoteWorkspace(ctx, match, { showLanding: true });
      return true;
    }
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
      activeTabId: OVERVIEW_TAB_ID,
      landing: {
        kind: "workspace",
        projectId: project.id,
        projectLabel: project.label,
        hostId: workspace.hostId ?? project.hostId,
        iconUrl: project.iconUrl,
        workspaceId: workspace.id,
        workspaceLabel: workspace.label,
        branch: workspace.branch,
        path: workspace.path,
        isMain: workspace.isMain === true,
      },
    }));
    return true;
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
  const payload = (data as WorkspaceEventPayload | undefined) ?? {};
  // Walk the sidebar project mirrors to find the parent project + path.
  // Matches the lookup pattern in handleSidebarSwitchWorkspace above.
  const match = findSidebarWorkspace(
    ctx.stateRef.current,
    workspaceId,
    payload,
  );
  if (match?.hostId && isRemoteHostId(match.hostId)) {
    activateRemoteWorkspace(ctx, match, { showLanding: false });
    ctx.newTab(undefined, undefined, {
      cwd: match.workspace.path,
      hostId: match.hostId,
    });
    return true;
  }
  let projectId: string | undefined;
  let path: string | undefined;
  if (match) {
    projectId = match.project.id;
    path = match.workspace.path;
  }
  if (projectId) ctx.setActiveProjectById(projectId);
  ctx.activateWorkspace(match?.workspace.isMain === true ? null : workspaceId);
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
      | {
          workspaceId?: string;
          projectId?: string;
          hostId?: string;
          path?: string;
        }
      | undefined) ?? {};
  if (payload.hostId && isRemoteHostId(payload.hostId)) {
    const match = payload.workspaceId
      ? findSidebarWorkspace(ctx.stateRef.current, payload.workspaceId, payload)
      : null;
    const project =
      match?.project ??
      (ctx.stateRef.current.project as SidebarProjectItem | null | undefined) ??
      null;
    if (project) {
      const workspace =
        match?.workspace ??
        ({
          id: payload.workspaceId ?? `${project.id}::workspace::main`,
          projectId: project.id,
          hostId: payload.hostId,
          path: payload.path ?? project.path,
          isMain: !payload.workspaceId,
        } satisfies SidebarWorkspaceItem);
      activateRemoteWorkspace(
        ctx,
        { project, workspace, hostId: payload.hostId },
        { showLanding: false },
      );
    }
    ctx.newTab(undefined, undefined, {
      ...(payload.path ? { cwd: payload.path } : {}),
      hostId: payload.hostId,
    });
    return true;
  }
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
  const workspaceId = (data as { workspaceId?: string } | undefined)
    ?.workspaceId;
  if (workspaceId) ctx.dismissPendingWorkspace(workspaceId);
  return true;
};

export const handleSidebarRetryPendingWorkspace: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "retry-pending-workspace") return false;
  const workspaceId = (data as { workspaceId?: string } | undefined)
    ?.workspaceId;
  if (workspaceId) void ctx.retryPendingWorkspace(workspaceId);
  return true;
};

export const handleSidebarStopWorkspaceAgent: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "stop-workspace-agent") return false;
  const workspaceId = (data as { workspaceId?: string } | undefined)
    ?.workspaceId;
  if (!workspaceId) return true;

  const sidebar =
    (ctx.stateRef.current.sidebar as
      | {
          projects?: {
            workspaces?: { id: string; path?: string }[];
          }[];
        }
      | undefined) ?? {};
  let workspacePath: string | undefined;
  for (const project of sidebar.projects ?? []) {
    const workspace = project.workspaces?.find((w) => w.id === workspaceId);
    if (workspace) {
      workspacePath = workspace.path;
      break;
    }
  }
  if (!workspacePath) return true;

  const targetPath = normalizeSessionPath(workspacePath);
  const running = new Set(
    Object.keys(
      (ctx.stateRef.current.agentRunningTabs as
        | Record<string, unknown>
        | undefined) ?? {},
    ),
  );
  const tabs: Tab[] = [];
  const collect = (list: Tab[] | undefined) => {
    for (const tab of list ?? []) {
      if (
        tab.kind === "agent" &&
        normalizeSessionPath(tab.cwd) === targetPath
      ) {
        tabs.push(tab);
      }
    }
  };
  collect(ctx.stateRef.current.tabs as Tab[] | undefined);
  const buckets = ctx.stateRef.current.persistedTabBuckets as
    | Record<string, { tabs?: Tab[] }>
    | undefined;
  for (const bucket of Object.values(buckets ?? {})) collect(bucket.tabs);

  const stopIds = tabs
    .filter((tab) => running.has(tab.id) || tab.waiting === true)
    .map((tab) => tab.id);
  for (const tabId of [...new Set(stopIds)]) void ctx.stopPrompt(tabId);
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
    ctx.reorderWorkspace(
      payload.projectId,
      payload.workspaceId,
      payload.toIndex,
    );
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
