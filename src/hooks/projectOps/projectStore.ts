import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { activeCwd, activeProject, saveProjects } from "../../projects";
import type { ProjectsState } from "../../projects";
import type { ChatMessage } from "../../types/a2ui";
import type { Tab } from "../../types/tab";
import { formatRelativeTime } from "../../utils/time";
import type { GitStatus } from "../useProjects";
import { normalizeSessionPath } from "./tabBuckets";
import type {
  DiscoveredSession,
  RecentSessionItem,
  SidebarHistoryItem,
} from "./types";

interface ProjectStoreDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  projectsRef: MutableRefObject<ProjectsState>;
  gitStatusRef: MutableRefObject<Map<string, GitStatus>>;
  allDiscoveredSessionsRef: MutableRefObject<DiscoveredSession[]>;
}

export interface ProjectStore {
  buildSidebarHistory: (
    tabs: Tab[],
    activeTabId: string | undefined,
    recentSessions: RecentSessionItem[],
  ) => SidebarHistoryItem[];
  knownTabIds: (extraTabs?: { id: string }[]) => Set<string>;
  scopedDiscoveredSessions: (
    discovered: DiscoveredSession[],
  ) => DiscoveredSession[];
  recentSessionItems: (
    discovered: DiscoveredSession[],
    openIds: Set<string>,
  ) => RecentSessionItem[];
  syncRecentSessionsToState: () => void;
  buildProjectsMirror: (
    prev: Record<string, unknown>,
    tabsForRecent?: Tab[],
  ) => Record<string, unknown>;
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  scheduleProjectsSave: (delayMs?: number) => void;
}

export function useProjectStore(deps: ProjectStoreDeps): ProjectStore {
  const {
    setState,
    stateRef,
    projectsRef,
    gitStatusRef,
    allDiscoveredSessionsRef,
  } = deps;
  const projectSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  function saveProjectsBestEffort(snapshot: ProjectsState): void {
    void saveProjects(snapshot).catch((err) => {
      console.warn("saveProjects failed:", err);
    });
  }

  function scheduleProjectsSave(delayMs = 250): void {
    if (projectSaveTimerRef.current !== null) {
      clearTimeout(projectSaveTimerRef.current);
    }
    projectSaveTimerRef.current = setTimeout(() => {
      projectSaveTimerRef.current = null;
      saveProjectsBestEffort(projectsRef.current);
    }, delayMs);
  }

  function flushProjectsSave(): void {
    saveProjectsBestEffort(projectsRef.current);
  }

  useEffect(() => {
    return () => {
      if (projectSaveTimerRef.current !== null) {
        clearTimeout(projectSaveTimerRef.current);
        projectSaveTimerRef.current = null;
        flushProjectsSave();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildSidebarHistory = useCallback(
    (
      tabs: Tab[],
      activeTabId: string | undefined,
      recentSessions: RecentSessionItem[],
    ): SidebarHistoryItem[] => {
      const openIds = new Set(tabs.map((t) => t.id));
      const firstUserText = (messages: ChatMessage[]): string => {
        const first = messages.find(
          (m) =>
            m.role === "user" &&
            typeof m.text === "string" &&
            m.text.trim().length > 0,
        );
        return first?.text?.replace(/\s+/g, " ").trim().slice(0, 48) ?? "";
      };
      const openHistory = tabs
        .filter((t) => t.messages.length > 0)
        .map((t) => {
          const firstMsg = firstUserText(t.messages);
          const label =
            /^Tab \d+$/.test(t.label) && firstMsg ? firstMsg : t.label;
          const hint =
            t.id === activeTabId ? "active" : `${t.messages.length} msg`;
          return {
            id: `tab:${t.id}`,
            label,
            hint,
            tooltip: firstMsg || label,
            active: t.id === activeTabId,
          };
        });
      const restoredHistory = recentSessions
        .filter((s) => !openIds.has(s.id))
        .map((s) => ({
          id: `session:${s.id}`,
          label: s.label,
          hint: s.lastModified,
          tooltip: s.cwd ? s.cwd : "Restore session",
        }));
      return [...openHistory, ...restoredHistory].slice(0, 16);
    },
    [],
  );

  function scopedDiscoveredSessions(
    discovered: DiscoveredSession[],
  ): DiscoveredSession[] {
    const activePath = normalizeSessionPath(
      activeCwd(projectsRef.current) ?? undefined,
    );
    if (!activePath) return discovered;
    return discovered.filter(
      (session) => normalizeSessionPath(session.cwd) === activePath,
    );
  }

  function knownTabIds(extraTabs: { id: string }[] = []): Set<string> {
    return new Set(
      ((stateRef.current.tabs as Tab[] | undefined) ?? [])
        .map((t) => t.id)
        .concat(extraTabs.map((t) => t.id))
        .concat(["default"]),
    );
  }

  function recentSessionItems(
    discovered: DiscoveredSession[],
    openIds: Set<string>,
  ): RecentSessionItem[] {
    return discovered
      .filter((d) => !openIds.has(d.tabId))
      .slice(0, 8)
      .map((d) => {
        const cwdBasename = d.cwd
          ? (d.cwd
              .replace(/[/\\]+$/, "")
              .split(/[/\\]/)
              .pop() ?? "")
          : "";
        const label = d.customLabel
          ? d.customLabel
          : d.firstUserMessage
            ? d.firstUserMessage.replace(/\s+/g, " ").trim()
            : cwdBasename || `Session ${d.tabId.slice(0, 8)}`;
        return {
          id: d.tabId,
          label,
          lastModified: formatRelativeTime(d.lastModified),
          ...(d.cwd ? { cwd: d.cwd } : {}),
        };
      });
  }

  function syncRecentSessionsToState() {
    const sessions = recentSessionItems(
      scopedDiscoveredSessions(allDiscoveredSessionsRef.current),
      knownTabIds(),
    );
    setState((prev) => ({ ...prev, recentSessions: sessions }));
  }

  function buildProjectsMirror(
    prev: Record<string, unknown>,
    tabsForRecent?: Tab[],
  ): Record<string, unknown> {
    const ps = projectsRef.current;
    const active = activeProject(ps);
    const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
    const tabs = tabsForRecent ?? (prev.tabs as Tab[] | undefined) ?? [];
    const tabIds = new Set(tabs.map((t) => t.id).concat(["default"]));
    return {
      projects: ps.projects,
      activeProjectId: ps.activeId,
      activeWorktreeId: ps.activeWorktreeId,
      project: active
        ? {
            id: active.id,
            label: active.label,
            path: active.path,
            worktreeBaseBranch: active.worktreeBaseBranch,
          }
        : null,
      sessionLabel: active ? active.label : "",
      sidebar: {
        ...sidebar,
        projects: ps.projects.map((p) => {
          const wts = ps.worktreesByProject[p.id] ?? [];
          const projectIsActive = p.id === ps.activeId;
          const activeWorktreeBelongsToProject =
            projectIsActive &&
            !!ps.activeWorktreeId &&
            wts.some((w) => w.id === ps.activeWorktreeId && !w.isMain);
          return {
            id: p.id,
            label: p.label,
            tooltip: p.path,
            iconUrl: p.iconUrl,
            active: projectIsActive && !activeWorktreeBelongsToProject,
            git: gitStatusRef.current.get(p.path),
            expanded: p.uiExpanded === true,
            worktrees: wts.map((w) => ({
              id: w.id,
              label: w.label ?? w.branch ?? "worktree",
              branch: w.branch,
              path: w.path,
              active: w.id === ps.activeWorktreeId,
              isMain: w.isMain,
              pendingState: w.pendingState,
              pendingError: w.pendingError,
              locked: w.locked,
            })),
          };
        }),
      },
      recentSessions: recentSessionItems(
        scopedDiscoveredSessions(allDiscoveredSessionsRef.current),
        tabIds,
      ),
    };
  }

  function syncProjectsToState() {
    setState((prev) => ({
      ...prev,
      ...buildProjectsMirror(prev),
    }));
  }

  async function persistProjects() {
    syncProjectsToState();
    try {
      await saveProjects(projectsRef.current);
    } catch (err) {
      console.warn("saveProjects failed:", err);
    }
  }

  return {
    buildSidebarHistory,
    knownTabIds,
    scopedDiscoveredSessions,
    recentSessionItems,
    syncRecentSessionsToState,
    buildProjectsMirror,
    syncProjectsToState,
    persistProjects,
    scheduleProjectsSave,
  };
}
