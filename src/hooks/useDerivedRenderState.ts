import { useMemo } from "react";
import { activeTabKind, OVERVIEW_TAB_ID, type Tab } from "../types/tab";
import type { UseHostInfo } from "./useHostInfo";
import { attachAgentActivity } from "./projectOps/agentActivity";
import { isAgentTabInFlight } from "../utils/agentBusy";

interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

interface SidebarHistoryItem {
  id: string;
  label: string;
  hint?: string;
  tooltip?: string;
  active?: boolean;
}

export interface UseDerivedRenderStateOptions {
  state: Record<string, unknown>;
  buildSidebarHistory: (
    tabs: Tab[],
    activeTabId: string | undefined,
    recentSessions: RecentSessionItem[],
  ) => SidebarHistoryItem[];
  hostInfo: UseHostInfo;
}

export interface DerivedRenderStateResult {
  renderState: Record<string, unknown>;
  notificationsOpen: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  searchOpen: boolean;
  authProfilesOpen: boolean;
  scheduledTasksOpen: boolean;
}

function implicitWorkspaceLanding(
  state: Record<string, unknown>,
): { kind: "workspace"; [key: string]: unknown } | null {
  const workspaceId =
    typeof state.activeWorkspaceId === "string"
      ? state.activeWorkspaceId
      : null;
  if (!workspaceId) return null;
  const activeProjectId =
    typeof state.activeProjectId === "string"
      ? state.activeProjectId
      : ((state.project as { id?: string } | null | undefined)?.id ?? null);
  const sidebarProjects =
    ((state.sidebar as { projects?: unknown } | undefined)?.projects as
      | Array<{
          id: string;
          label?: string;
          iconUrl?: string;
          workspaces?: Array<{
            id: string;
            label?: string;
            branch?: string;
            path?: string;
            isMain?: boolean;
          }>;
        }>
      | undefined) ?? [];
  for (const project of sidebarProjects) {
    if (activeProjectId && project.id !== activeProjectId) continue;
    const workspace = project.workspaces?.find((w) => w.id === workspaceId);
    if (!workspace) continue;
    return {
      kind: "workspace",
      projectId: project.id,
      projectLabel: project.label,
      iconUrl: project.iconUrl,
      workspaceId: workspace.id,
      workspaceLabel: workspace.label,
      branch: workspace.branch,
      path: workspace.path,
      isMain: workspace.isMain === true,
    };
  }
  return null;
}

export function useDerivedRenderState({
  state,
  buildSidebarHistory,
  hostInfo,
}: UseDerivedRenderStateOptions): DerivedRenderStateResult {
  const renderState = useMemo(() => {
    const tabs = (state.tabs as Tab[] | undefined) ?? [];
    const recentSessions =
      (state.recentSessions as RecentSessionItem[] | undefined) ?? [];
    const sidebar =
      (state.sidebar as Record<string, unknown> | undefined) ?? {};
    const activeTabId = state.activeTabId as string | undefined;
    const hasTabs = tabs.length > 0;
    // Shell tabs live in /tabs but render only in the bottom terminal
    // panel — they must not suppress the overview. Only agent + editor
    // tabs count as "sessions" that occupy the canvas.
    const hasSessionTabs = tabs.some(
      (t) => t.kind === "agent" || t.kind === "editor",
    );
    const activeKind = activeTabKind(tabs, activeTabId);
    const overviewActive = activeKind === null || activeKind === "shell";
    const explicitLanding =
      state.landing as { kind?: string } | null | undefined;
    const landing =
      explicitLanding ??
      (overviewActive ? implicitWorkspaceLanding(state) : null);
    const workspaceLandingVisible = !!landing && landing.kind === "workspace";
    const mobileDeviceLandingVisible =
      !!landing && landing.kind === "mobile-device";
    const landingVisible = workspaceLandingVisible || mobileDeviceLandingVisible;
    const effectiveActiveTabId = landingVisible ? OVERVIEW_TAB_ID : activeTabId;
    const history = buildSidebarHistory(
      tabs,
      effectiveActiveTabId,
      recentSessions,
    );
    // The overview owns the canvas when there are no session tabs *or*
    // when the user has explicitly selected the overview pseudo-tab.
    // Either case keeps the host / project dashboards visible while
    // shell tabs and idle agent sessions can still exist in /tabs.
    const empty = (!hasSessionTabs || overviewActive) && !landingVisible;
    const hasActiveProject =
      typeof state.project === "object" && state.project !== null;
    const emptyAndProject = empty && hasActiveProject;
    const emptyAndNoProject = empty && !hasActiveProject;
    const activeProjectId =
      (state.project as { id?: string } | null | undefined)?.id ?? null;
    const sidebarProjects =
      ((state.sidebar as { projects?: unknown } | undefined)?.projects as
        | { id: string; workspaces?: unknown }[]
        | undefined) ?? [];
    const activeHostId = hostInfo.activeHostId ?? hostInfo.localHostId;
    const hostScopedProjects =
      activeHostId && activeHostId !== hostInfo.localHostId
        ? (hostInfo.remoteProjectsByHost[activeHostId] ?? [])
        : sidebarProjects;
    const remoteHostActive =
      activeHostId !== null &&
      activeHostId !== undefined &&
      activeHostId !== hostInfo.localHostId;
    const activeProjectSidebarEntry = hostScopedProjects.find(
      (p) => p.id === activeProjectId,
    );
    const projectDashboardWorkspaces =
      (activeProjectSidebarEntry?.workspaces as unknown[] | undefined) ?? [];
    const projectsArr = Array.isArray(state.projects)
      ? (state.projects as { id: string }[])
      : [];
    const activeHostProjects = remoteHostActive
      ? (hostScopedProjects as { id: string }[])
      : projectsArr;
    const otherProjects = activeProjectId
      ? activeHostProjects.filter((p) => p.id !== activeProjectId)
      : activeHostProjects;
    const existingProjectDashboard =
      (state.projectDashboard as { widgets?: unknown[] } | undefined) ?? {};
    const projectDashboard = {
      ...existingProjectDashboard,
      otherProjects,
      workspaces: projectDashboardWorkspaces,
      recentSessions: (() => {
        const recentSessionsArr = Array.isArray(state.recentSessions)
          ? (state.recentSessions as { cwd?: string }[])
          : [];
        const projectPath =
          (state.project as { path?: string } | null | undefined)?.path ?? null;
        const scopePaths = new Set<string>();
        const addScopePath = (path?: string) => {
          const normalized = (path ?? "").replace(/[/\\]+$/, "");
          if (normalized) scopePaths.add(normalized);
        };
        addScopePath(projectPath ?? undefined);
        for (const workspace of projectDashboardWorkspaces as Array<{
          path?: string;
        }>) {
          addScopePath(workspace.path);
        }
        if (scopePaths.size === 0) return [];
        return recentSessionsArr.filter((s) =>
          scopePaths.has((s.cwd ?? "").replace(/[/\\]+$/, "")),
        );
      })(),
      widgets: existingProjectDashboard.widgets ?? [],
    };
    const existingProjectsDashboard =
      (state.projectsDashboard as { extraCards?: unknown[] } | undefined) ?? {};
    const projectsDashboard = {
      ...existingProjectsDashboard,
      extraCards: existingProjectsDashboard.extraCards ?? [],
    };
    const sidebarHosts = hostInfo.hosts.map((h) => ({
      id: h.id,
      label: h.displayName || h.hostname,
      hostname: h.hostname,
      fingerprint: h.fingerprint ?? h.fingerprintPrefix,
      candidates: h.candidates,
      paired: h.paired === true,
      discovered: h.discovered === true,
      hint: h.isLocal
        ? "this mac"
        : h.connected === true
          ? "connected"
          : (h.paired ? "paired" : h.hostname),
      tooltip: h.hostname,
      active: h.id === activeHostId,
    }));
    const activeMobileDeviceId =
      landing?.kind === "mobile-device" &&
      typeof (landing as { deviceId?: unknown }).deviceId === "string"
        ? (landing as { deviceId: string }).deviceId
        : null;
    const sidebarMobileDevices = hostInfo.mobileDevices.map((device) => {
      const connected = device.connected === true;
      const platform = device.hostname || "mobile";
      return {
        id: device.id,
        label: device.displayName || platform,
        icon: "phone",
        active: device.id === activeMobileDeviceId,
        hint: connected ? "connected" : "paired",
        platform,
        connected,
        paired: device.paired === true,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeen,
        tooltip: `${device.displayName || platform} · ${platform} client`,
      };
    });
    // The mobile-device landing is a snapshot taken at select time —
    // overlay the live entry's connection facts so connect/disconnect
    // updates while the page is open. Label/createdAt stay from the
    // snapshot (rename already updates it optimistically), and a device
    // missing from the list (mid-unpair) keeps the snapshot rather than
    // blanking the page.
    const liveLanding =
      landing?.kind === "mobile-device" && activeMobileDeviceId
        ? (() => {
            const live = hostInfo.mobileDevices.find(
              (device) => device.id === activeMobileDeviceId,
            );
            if (!live) return landing;
            const connected = live.connected === true;
            return {
              ...landing,
              status: connected ? "Connected" : "Paired",
              connected,
              paired: live.paired === true,
              lastSeenAt: live.lastSeen,
            };
          })()
        : landing;
    const activeHost =
      hostInfo.hosts.find((h) => h.id === activeHostId) ?? null;

    // Overlay live agent-activity onto the sidebar project rows. The tab set
    // must span every workspace: the active one in `state.tabs` plus the
    // backgrounded ones mirrored into `state.persistedTabBuckets` (kept in
    // state — not a ref — so this stays a pure render derivation). Liveness
    // comes from the bucket-independent running set, since a backgrounded
    // tab's own `waiting` flag is frozen at switch-away time.
    const agentTabs: Tab[] = [];
    const seenAgentIds = new Set<string>();
    const collectAgents = (list: Tab[] | undefined) => {
      for (const t of list ?? []) {
        if (t.kind === "agent" && !seenAgentIds.has(t.id)) {
          seenAgentIds.add(t.id);
          agentTabs.push(t);
        }
      }
    };
    collectAgents(tabs);
    const persistedBuckets = state.persistedTabBuckets as
      | Record<string, { tabs?: Tab[] }>
      | undefined;
    if (persistedBuckets) {
      for (const bucket of Object.values(persistedBuckets)) {
        collectAgents(bucket?.tabs);
      }
    }
    const runningIds = new Set(
      Object.keys(
        (state.agentRunningTabs as Record<string, unknown> | undefined) ?? {},
      ),
    );
    const attentionIds = new Set(
      Object.keys(
        (state.agentAttentionTabs as Record<string, unknown> | undefined) ?? {},
      ),
    );
    // The running set is the authoritative cross-workspace turn lifecycle:
    // prompt_started adds, response_end / explicit stop / crash removes. The
    // active tab can still promote itself when a visible tool card is live, but
    // render derivation must not demote a running id just because `waiting`
    // briefly drifted false before response_end.
    for (const t of tabs) {
      if (t.kind !== "agent") continue;
      if (isAgentTabInFlight(t)) runningIds.add(t.id);
    }
    const sidebarProjectsWithAgent = Array.isArray(hostScopedProjects)
      ? attachAgentActivity(
          hostScopedProjects as Array<{
            id: string;
            workspaces?: { path?: string; isMain?: boolean }[];
          }>,
          agentTabs,
          runningIds,
          attentionIds,
        )
      : hostScopedProjects;

    return {
      ...state,
      projects: activeHostProjects,
      activeTabId: effectiveActiveTabId,
      hasTabs,
      hasSessionTabs,
      overviewActive: landingVisible ? true : overviewActive,
      overviewTabId: OVERVIEW_TAB_ID,
      landing: liveLanding,
      empty,
      emptyAndProject,
      emptyAndNoProject,
      agentTabActive: activeKind === "agent" && !landingVisible,
      shellTabActive: false,
      editorTabActive: activeKind === "editor" && !landingVisible,
      landingVisible,
      workspaceLandingVisible,
      mobileDeviceLandingVisible,
      sidebar: {
        ...sidebar,
        projects: sidebarProjectsWithAgent,
        history,
        hosts: sidebarHosts,
        mobileDevices: sidebarMobileDevices,
      },
      projectDashboard,
      projectsDashboard,
      hosts: hostInfo.hosts,
      mobileDevices: hostInfo.mobileDevices,
      activeHostId,
      host: activeHost,
    };
  }, [
    buildSidebarHistory,
    hostInfo.activeHostId,
    hostInfo.hosts,
    hostInfo.localHostId,
    hostInfo.mobileDevices,
    hostInfo.remoteProjectsByHost,
    state,
  ]);

  const renderRecord = renderState as Record<string, unknown>;
  const notificationsOpen =
    ((renderRecord.notifications as unknown[] | undefined) ?? []).length > 0;
  const paletteOpen = Boolean(
    (renderRecord.palette as { open?: boolean } | undefined)?.open,
  );
  const settingsOpen = Boolean(
    (renderRecord.settings as { open?: boolean } | undefined)?.open,
  );
  const searchOpen = Boolean(
    (renderRecord.search as { open?: boolean } | undefined)?.open,
  );
  const authProfilesOpen = Boolean(
    (renderRecord.authProfiles as { modal?: { open?: boolean } } | undefined)
      ?.modal?.open,
  );
  const scheduledTasksOpen = Boolean(
    (renderRecord.scheduledTasks as { open?: boolean } | undefined)?.open,
  );

  return {
    renderState,
    notificationsOpen,
    paletteOpen,
    settingsOpen,
    searchOpen,
    authProfilesOpen,
    scheduledTasksOpen,
  };
}
