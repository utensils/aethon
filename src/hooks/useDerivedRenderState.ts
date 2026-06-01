import { useMemo } from "react";
import {
  activeTabKind,
  OVERVIEW_TAB_ID,
  type Tab,
} from "../types/tab";
import type { UseHostInfo } from "./useHostInfo";
import { attachAgentActivity } from "./projectOps/agentActivity";

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
    const history = buildSidebarHistory(
      tabs,
      state.activeTabId as string | undefined,
      recentSessions,
    );
    const activeTabId = state.activeTabId as string | undefined;
    const hasTabs = tabs.length > 0;
    // Shell tabs live in /tabs but render only in the bottom terminal
    // panel — they must not suppress the overview. Only agent + editor
    // tabs count as "sessions" that occupy the canvas.
    const hasSessionTabs = tabs.some(
      (t) => t.kind === "agent" || t.kind === "editor",
    );
    const activeKind = activeTabKind(tabs, activeTabId);
    const overviewActive =
      activeKind === null || activeKind === "shell";
    const landing = state.landing as { kind?: string } | null | undefined;
    const landingVisible = !!landing && landing.kind === "worktree";
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
        | { id: string; worktrees?: unknown }[]
        | undefined) ?? [];
    const activeProjectSidebarEntry = sidebarProjects.find(
      (p) => p.id === activeProjectId,
    );
    const projectDashboardWorktrees =
      (activeProjectSidebarEntry?.worktrees as unknown[] | undefined) ?? [];
    const recentSessionsArr = Array.isArray(state.recentSessions)
      ? (state.recentSessions as { cwd?: string }[])
      : [];
    const projectPath =
      (state.project as { path?: string } | null | undefined)?.path ?? null;
    const projectDashboardSessions = projectPath
      ? recentSessionsArr.filter((s) => {
          const sCwd = (s.cwd ?? "").replace(/[/\\]+$/, "");
          const pCwd = projectPath.replace(/[/\\]+$/, "");
          return sCwd === pCwd;
        })
      : [];
    const projectsArr = Array.isArray(state.projects)
      ? (state.projects as { id: string }[])
      : [];
    const otherProjects = activeProjectId
      ? projectsArr.filter((p) => p.id !== activeProjectId)
      : projectsArr;
    const existingProjectDashboard =
      (state.projectDashboard as { widgets?: unknown[] } | undefined) ?? {};
    const projectDashboard = {
      ...existingProjectDashboard,
      otherProjects,
      worktrees: projectDashboardWorktrees,
      recentSessions: projectDashboardSessions,
      widgets: existingProjectDashboard.widgets ?? [],
    };
    const existingProjectsDashboard =
      (state.projectsDashboard as { extraCards?: unknown[] } | undefined) ?? {};
    const projectsDashboard = {
      ...existingProjectsDashboard,
      extraCards: existingProjectsDashboard.extraCards ?? [],
    };
    const activeHostId = hostInfo.activeHostId ?? hostInfo.localHostId;
    const sidebarHosts = hostInfo.hosts.map((h) => ({
      id: h.id,
      label: h.displayName || h.hostname,
      hint: h.isLocal ? "this mac" : h.hostname,
      tooltip: h.hostname,
      active: h.id === activeHostId,
    }));
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
    const sidebarProjectsWithAgent = Array.isArray(sidebar.projects)
      ? attachAgentActivity(
          sidebar.projects as Array<{
            id: string;
            worktrees?: { path?: string; isMain?: boolean }[];
          }>,
          agentTabs,
          runningIds,
        )
      : sidebar.projects;

    return {
      ...state,
      hasTabs,
      hasSessionTabs,
      overviewActive,
      overviewTabId: OVERVIEW_TAB_ID,
      empty,
      emptyAndProject,
      emptyAndNoProject,
      agentTabActive: activeKind === "agent" && !landingVisible,
      shellTabActive: false,
      editorTabActive: activeKind === "editor" && !landingVisible,
      landingVisible,
      sidebar: {
        ...sidebar,
        projects: sidebarProjectsWithAgent,
        history,
        hosts: sidebarHosts,
      },
      projectDashboard,
      projectsDashboard,
      hosts: hostInfo.hosts,
      activeHostId,
      host: activeHost,
    };
  }, [
    buildSidebarHistory,
    hostInfo.activeHostId,
    hostInfo.hosts,
    hostInfo.localHostId,
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

  return {
    renderState,
    notificationsOpen,
    paletteOpen,
    settingsOpen,
    searchOpen,
    authProfilesOpen,
  };
}
