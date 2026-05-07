import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  NO_PROJECT_KEY,
  projectBucketKey,
  type Tab,
} from "../types/tab";
import {
  activeProject,
  loadProjects,
  pickProjectDirectory,
  removeProject,
  saveProjects,
  upsertProject,
  type ProjectsState,
} from "../projects";
import { formatRelativeTime } from "../utils/time";
import { TAB_MIRROR_KEYS } from "./useTabs";
import { recomputeModelPicker } from "../utils/modelPicker";
import type { ChatMessage } from "../types/a2ui";
import type { GitStatus } from "./useProjects";

interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

interface DiscoveredSession {
  tabId: string;
  lastModified: number;
  cwd?: string;
  /** First user message text, trimmed to 60 chars by the bridge. Used to
   *  label sidebar history items meaningfully instead of UUID slices. */
  firstUserMessage?: string;
  customLabel?: string;
}

interface SidebarHistoryItem {
  id: string;
  label: string;
  hint?: string;
  tooltip?: string;
  active?: boolean;
}

export interface UseProjectOpsContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  /** Owned at App-root so useTabs can share the same ref without a
   *  shadow. The hook mutates `.current` in place. */
  projectsRef: MutableRefObject<ProjectsState>;
  /** Pi's default model from the last `ready` event. Owned at App-root
   *  so tab creation can use the same shared default elsewhere. */
  piDefaultModelRef: MutableRefObject<string>;
  /** Cached git status keyed by absolute path — mirrored into
   *  /sidebar/projects badges. Owned by useProjects; read here. */
  gitStatusRef: MutableRefObject<Map<string, GitStatus>>;
  /** Best-effort kick-off git status fetch for a (possibly new) project
   *  so the chip appears on the same render that adds the row. */
  refreshGitStatusFor: (path: string) => Promise<void>;
  refreshAllGitStatus: () => Promise<void>;
  /** Tell the bridge what cwd to use for new sessions on a tab.
   *  Fire-and-forget; the bridge re-announces on next tab_open. */
  announceProjectToBridge: (tabId: string, path: string | null) => void;
  watchProjectForBridge: (path: string) => void;
  unwatchProjectForBridge: (path: string) => void;
  /** Tell the shared xterm panel to clear and replay a tab's terminal
   *  buffer. Provided by useTabs so this hook doesn't have to import
   *  from xterm internals. */
  dispatchTerminalReplay: (buffer: string) => void;
  /** From useTabs: auto-restore previously-discovered sessions for the
   *  active project after the project list loads. */
  autoRestoreDiscoveredSessions: (
    discovered: DiscoveredSession[],
    knownIds: Set<string>,
  ) => void;
}

export interface UseProjectOpsActions {
  // ─── Refs the bridge handlers + window API close over ───────────────
  projectsLoadedRef: MutableRefObject<boolean>;
  allDiscoveredSessionsRef: MutableRefObject<DiscoveredSession[]>;
  /** Tab buckets keyed by project (or NO_PROJECT_KEY). When the user
   *  switches active project, we snapshot the current state.tabs +
   *  activeTabId into the OLD bucket and load the NEW bucket into state
   *  — that's how tabs become per-project visible without filtering on
   *  every render. */
  tabBucketsRef: MutableRefObject<
    Map<string, { tabs: Tab[]; activeTabId: string | undefined }>
  >;

  // ─── Sidebar / session helpers ──────────────────────────────────────
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

  // ─── Project ops ────────────────────────────────────────────────────
  syncProjectsToState: () => void;
  persistProjects: () => Promise<void>;
  openProjectFromPicker: () => Promise<string | null>;
  openProjectByPath: (path: string, label?: string) => string;
  setActiveProjectById: (id: string) => boolean;
  clearActiveProject: () => void;
  removeProjectById: (id: string) => boolean;
}

function normalizeSessionPath(path: string | undefined): string {
  return (path ?? "").replace(/[/\\]+$/, "");
}

export function projectIdFromBucketKey(key: string): string | null {
  return key === NO_PROJECT_KEY ? null : key;
}

export function tabsForProjectBucket(tabs: Tab[], bucketKey: string): Tab[] {
  const projectId = projectIdFromBucketKey(bucketKey);
  return tabs.filter((tab) =>
    projectId === null ? tab.projectId == null : tab.projectId === projectId,
  );
}

export function nonEmptyProjectTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((tab) => {
    if (tab.kind === "shell") return true;
    return (
      tab.messages.length > 0 ||
      tab.draft.trim().length > 0 ||
      tab.waiting ||
      tab.queueCount > 0 ||
      tab.canvas !== null ||
      tab.terminalBuffer.length > 0
    );
  });
}

/**
 * Project list management + the per-project tab bucket model. Owns:
 *   - `projectsRef` — in-memory project list.
 *   - `tabBucketsRef` — per-project tab snapshots.
 *   - `allDiscoveredSessionsRef` — bridge-discovered sessions awaiting
 *     restore (filtered to the active project's cwd).
 *
 * The boot effect runs once on mount: loads projects from disk,
 * mirrors them to state, kicks an initial git status fetch, and
 * auto-restores any discovered sessions belonging to the active
 * project. Everything else is callable from outside (palette, slash
 * commands, sidebar event routes).
 *
 * `switchProjectBucket` is the heart of "tabs are per-project" — it
 * snapshots the OLD bucket, loads the NEW one, and re-mirrors the
 * active tab's view to root state keys. The orphan-active-id healing
 * branch is load-bearing: without it, a stale activeTabId would leave
 * `empty:true` with `tabs.length>0`.
 */
export function useProjectOps(
  ctx: UseProjectOpsContext,
): UseProjectOpsActions {
  const {
    setState,
    stateRef,
    projectsRef,
    gitStatusRef,
    refreshGitStatusFor,
    refreshAllGitStatus,
    announceProjectToBridge,
    watchProjectForBridge,
    unwatchProjectForBridge,
    dispatchTerminalReplay,
    autoRestoreDiscoveredSessions,
  } = ctx;

  const projectsLoadedRef = useRef(false);
  const allDiscoveredSessionsRef = useRef<DiscoveredSession[]>([]);
  const tabBucketsRef = useRef<
    Map<string, { tabs: Tab[]; activeTabId: string | undefined }>
  >(new Map());

  const buildSidebarHistory = useCallback((
    tabs: Tab[],
    activeTabId: string | undefined,
    recentSessions: RecentSessionItem[],
  ): SidebarHistoryItem[] => {
    const openIds = new Set(tabs.map((t) => t.id));
    const firstUserText = (messages: ChatMessage[]): string => {
      const first = messages.find(
        (m) => m.role === "user" && typeof m.text === "string" && m.text.trim().length > 0,
      );
      return first?.text?.replace(/\s+/g, " ").trim().slice(0, 48) ?? "";
    };
    const openHistory = tabs
      .filter((t) => t.messages.length > 0)
      .map((t) => {
        const firstMsg = firstUserText(t.messages);
        // Use first user message as the display label when the tab still has
        // a generic sequential name (Tab 1, Tab 2, …). Explicit renames keep
        // their name.
        const label = /^Tab \d+$/.test(t.label) && firstMsg ? firstMsg : t.label;
        const hint = t.id === activeTabId ? "active" : `${t.messages.length} msg`;
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
  }, []);

  function scopedDiscoveredSessions(
    discovered: DiscoveredSession[],
  ): DiscoveredSession[] {
    const active = activeProject(projectsRef.current);
    if (!active) return discovered;
    const activePath = normalizeSessionPath(active.path);
    return discovered.filter((session) => normalizeSessionPath(session.cwd) === activePath);
  }

  function knownTabIds(extraTabs: { id: string }[] = []): Set<string> {
    return new Set(
      (((stateRef.current.tabs as Tab[] | undefined) ?? []).map((t) => t.id))
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
        // Derive a human-readable label in priority order:
        //   1. First user message text (most descriptive)
        //   2. Project directory basename
        //   3. Fallback UUID prefix
        const cwdBasename = d.cwd
          ? d.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ""
          : "";
        // Custom label (set via /rename or sidebar context menu) wins
        // over the auto-derived first-user-message label.
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

  // Mirror the projects state into app state so layouts can $ref it.
  // Bumps `/projects`, `/activeProjectId`, `/project/{label,path,id}`,
  // `/sessionLabel` and `/sidebar/projects` (sidebar item array).
  // Called on every mutation so a single helper keeps the shape consistent.
  // Carries the cached git status from gitStatusRef so a sync triggered
  // for non-git reasons (lastUsed bump, label change) doesn't drop the
  // badges.
  function syncProjectsToState() {
    const ps = projectsRef.current;
    const active = activeProject(ps);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const tabIds = new Set(
        (((prev.tabs as Tab[] | undefined) ?? []).map((t) => t.id)).concat(["default"]),
      );
      return {
        ...prev,
        projects: ps.projects,
        activeProjectId: ps.activeId,
        project: active
          ? { id: active.id, label: active.label, path: active.path }
          : null,
        sessionLabel: active ? active.label : "",
        sidebar: {
          ...sidebar,
          projects: ps.projects.map((p) => ({
            id: p.id,
            // Basename is what we surface; the absolute path lives
            // behind the row's native tooltip (title attribute) so
            // the row label stays compact even with deep paths.
            label: p.label,
            tooltip: p.path,
            active: p.id === ps.activeId,
            git: gitStatusRef.current.get(p.path),
          })),
        },
        recentSessions: recentSessionItems(
          scopedDiscoveredSessions(allDiscoveredSessionsRef.current),
          tabIds,
        ),
      };
    });
  }

  // Persist + mirror. Errors are logged; the in-memory ref still wins so
  // a transient disk failure doesn't leave the UI inconsistent with what
  // the user just did.
  async function persistProjects() {
    syncProjectsToState();
    try {
      await saveProjects(projectsRef.current);
    } catch (err) {
      console.warn("saveProjects failed:", err);
    }
  }

  // Snapshot current state.tabs + activeTabId into the OLD project's
  // bucket, then load the NEW project's bucket back into state. The
  // active tab's view (messages / draft / canvas / model) is mirrored
  // to the root keys so the layout sees the new project's view
  // immediately. If the new project has no bucket yet, we leave tabs
  // empty + flip /empty so the empty-state composite renders. Project
  // switching never creates conversation tabs.
  function switchProjectBucket(fromKey: string, toKey: string): string | undefined {
    if (fromKey === toKey) {
      return stateRef.current.activeTabId as string | undefined;
    }
    let nextTerminalBuffer = "";
    let nextActiveTabId: string | undefined;
    setState((prev) => {
      // Save current bucket.
      const currentTabs = nonEmptyProjectTabs(
        tabsForProjectBucket(
          ((prev.tabs as Tab[] | undefined) ?? []).slice(),
          fromKey,
        ),
      );
      const currentActive = prev.activeTabId as string | undefined;
      tabBucketsRef.current.set(fromKey, {
        tabs: currentTabs,
        activeTabId: currentTabs.some((t) => t.id === currentActive)
          ? currentActive
          : currentTabs[0]?.id,
      });
      // Load target bucket. When a project has no visible session bucket,
      // keep tabs empty so the empty-state composite owns the canvas.
      const savedNextRaw = tabBucketsRef.current.get(toKey);
      const savedNext = savedNextRaw
        ? {
            tabs: nonEmptyProjectTabs(
              tabsForProjectBucket(savedNextRaw.tabs, toKey),
            ),
            activeTabId: savedNextRaw.activeTabId,
          }
        : undefined;
      const next =
        savedNext && savedNext.tabs.length > 0
          ? savedNext
          : { tabs: [], activeTabId: undefined };
      // Heal an orphaned bucket: tabs present but the saved activeTabId
      // doesn't match any of them (or is missing). Without this fixup,
      // the fallthrough below would set empty:true with tabs.length>0,
      // leaving the canvas and empty-state both visibly inconsistent.
      const hasOrphan =
        next.tabs.length > 0 &&
        !next.tabs.some((t) => t.id === next.activeTabId);
      const activeTabId = hasOrphan ? next.tabs[0].id : next.activeTabId;
      nextActiveTabId = activeTabId;
      const result: Record<string, unknown> = {
        ...prev,
        tabs: next.tabs,
        activeTabId,
      };
      const activeTab = next.tabs.find((t) => t.id === activeTabId);
      if (activeTab) {
        const rec = activeTab as unknown as Record<string, unknown>;
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = rec[key as string];
        }
        result.empty = false;
        result.hasTabs = true;
        result.sidebar = recomputeModelPicker(
          prev.sidebar as Record<string, unknown> | undefined,
          activeTab.model,
        );
        nextTerminalBuffer = activeTab.terminalBuffer ?? "";
      } else {
        for (const key of TAB_MIRROR_KEYS) {
          result[key as string] = undefined;
        }
        result.empty = true;
        result.hasTabs = next.tabs.length > 0;
        nextTerminalBuffer = "";
      }
      return result;
    });
    // Replay the new active tab's terminal buffer (or clear if none).
    dispatchTerminalReplay(nextTerminalBuffer);
    return nextActiveTabId;
  }

  async function openProjectFromPicker(): Promise<string | null> {
    const path = await pickProjectDirectory();
    if (!path) return null;
    return openProjectByPath(path);
  }

  function openProjectByPath(path: string, label?: string): string {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const { state: nextProjects, id } = upsertProject(
      projectsRef.current,
      path,
      label,
    );
    projectsRef.current = nextProjects;
    persistProjects();
    // Fetch git status for the (possibly new) project so the chip
    // appears on the same render that adds the row, not 30s later.
    void refreshGitStatusFor(path);
    // Switch to the project's tab bucket BEFORE notifying the bridge.
    // If this is a brand-new project, the bucket is empty and the empty
    // state composite renders until the user explicitly creates a tab.
    const nextTabId = switchProjectBucket(fromKey, projectBucketKey(id));
    syncRecentSessionsToState();
    const tabId = nextTabId ?? "default";
    announceProjectToBridge(tabId, path);
    return id;
  }

  function setActiveProjectById(id: string): boolean {
    const ps = projectsRef.current;
    const target = ps.projects.find((p) => p.id === id);
    if (!target) return false;
    const fromKey = projectBucketKey(ps.activeId);
    const toKey = projectBucketKey(id);
    const previousActive = activeProject(ps);
    projectsRef.current = {
      projects: ps.projects.map((p) =>
        p.id === id ? { ...p, lastUsed: Date.now() } : p,
      ),
      activeId: id,
    };
    persistProjects();
    const nextTabId = switchProjectBucket(fromKey, toKey);
    syncRecentSessionsToState();
    const tabId = nextTabId ?? "default";
    announceProjectToBridge(tabId, target.path);
    // Swap the file-watcher's project ext dir so edits in the new
    // project's `.aethon/extensions/` hot-reload, and edits in the old
    // one stop firing.
    if (previousActive && previousActive.path !== target.path) {
      unwatchProjectForBridge(previousActive.path);
    }
    watchProjectForBridge(target.path);
    return true;
  }

  function clearActiveProject() {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const previousActive = activeProject(projectsRef.current);
    projectsRef.current = { ...projectsRef.current, activeId: null };
    persistProjects();
    const nextTabId = switchProjectBucket(fromKey, NO_PROJECT_KEY);
    syncRecentSessionsToState();
    const tabId = nextTabId ?? "default";
    announceProjectToBridge(tabId, null);
    if (previousActive) unwatchProjectForBridge(previousActive.path);
  }

  function removeProjectById(id: string): boolean {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const wasActive = projectsRef.current.activeId === id;
    const removedKey = projectBucketKey(id);
    const result = removeProject(projectsRef.current, id);
    if (!result.removed) return false;

    const removedPath = result.removed.path;
    projectsRef.current = result.state;
    gitStatusRef.current.delete(removedPath);
    persistProjects();

    if (wasActive) {
      const nextTabId = switchProjectBucket(fromKey, NO_PROJECT_KEY);
      syncRecentSessionsToState();
      const tabId = nextTabId ?? "default";
      announceProjectToBridge(tabId, null);
      tabBucketsRef.current.delete(removedKey);
    } else {
      tabBucketsRef.current.delete(removedKey);
      syncRecentSessionsToState();
    }
    // Always unwatch — the project may have been active or just on the
    // recents list with its ext dir watched eagerly. Idempotent on the
    // Rust side, so calling for a never-watched path is harmless.
    unwatchProjectForBridge(removedPath);

    return true;
  }

  // Load projects once at boot. Done in its own effect so a slow disk
  // doesn't push out the agent-start path. Mirrors into state on resolve
  // so the sidebar populates without a re-render trigger.
  useEffect(() => {
    (async () => {
      const ps = await loadProjects();
      projectsRef.current = ps;
      projectsLoadedRef.current = true;
      syncProjectsToState();
      // Kick a git status fetch for every loaded project so badges
      // appear on the first paint instead of waiting for the 30s tick.
      void refreshAllGitStatus();
      // Tell the bridge about the active project so the default tab's
      // session opens with the right cwd. ensureTab() in the bridge
      // checks the per-tab cwd record before SessionManager.continueRecent.
      const active = activeProject(ps);
      const tabId =
        (stateRef.current.activeTabId as string | undefined) ?? "default";
      if (active) {
        announceProjectToBridge(tabId, active.path);
        // Hot-reload the active project's `.aethon/extensions/` from
        // boot, not just from the next setActiveProjectById call.
        watchProjectForBridge(active.path);
        // Retag any pre-load tabs (default boot tab + bridge replays) so
        // they live in the active project's bucket from now on. Without
        // this they'd stay in NO_PROJECT_KEY and silently disappear the
        // first time the user switches projects.
        setState((prev) => {
          const tabs = ((prev.tabs as Tab[] | undefined) ?? []).map((t) =>
            t.projectId == null ? { ...t, projectId: active.id } : t,
          );
          return { ...prev, tabs };
        });
      }
      const scoped = scopedDiscoveredSessions(allDiscoveredSessionsRef.current);
      autoRestoreDiscoveredSessions(scoped, knownTabIds());
      syncRecentSessionsToState();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    projectsLoadedRef,
    allDiscoveredSessionsRef,
    tabBucketsRef,
    buildSidebarHistory,
    knownTabIds,
    scopedDiscoveredSessions,
    recentSessionItems,
    syncRecentSessionsToState,
    syncProjectsToState,
    persistProjects,
    openProjectFromPicker,
    openProjectByPath,
    setActiveProjectById,
    clearActiveProject,
    removeProjectById,
  };
}
