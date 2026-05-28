import { useMemo } from "react";
import { deriveTabActiveFlags, type Tab } from "../types/tab";
import type { UseHostInfo } from "./useHostInfo";

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
    const hasTabs = tabs.length > 0;
    const { agentTabActive, shellTabActive, editorTabActive } =
      deriveTabActiveFlags(tabs, state.activeTabId as string | undefined);
    const landing = state.landing as { kind?: string } | null | undefined;
    const landingVisible = !!landing && landing.kind === "worktree";
    const empty = !hasTabs && !landingVisible;
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

    return {
      ...state,
      hasTabs,
      empty,
      emptyAndProject,
      emptyAndNoProject,
      agentTabActive: agentTabActive && !landingVisible,
      shellTabActive: shellTabActive && !landingVisible,
      editorTabActive: editorTabActive && !landingVisible,
      landingVisible,
      sidebar: {
        ...sidebar,
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
