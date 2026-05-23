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
  setActiveWorktree as setActiveWorktreeState,
  setProjectIconUrl as setProjectIconUrlState,
  setProjectUiExpanded,
  setProjectWorktrees,
  upsertProject,
  type Project,
  type ProjectsState,
} from "../projects";
import {
  gitBranchList,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitWorktrees,
  newPendingWorktree,
  reconcileWorktrees,
  removeWorktreeFromList,
  updateWorktreePendingState,
  type Worktree,
} from "../worktrees";
import { formatRelativeTime } from "../utils/time";
import { pickWorktreeName } from "../worktreeNames";
import { TAB_MIRROR_KEYS } from "./useTabs";
import { disposeEditorBuffer } from "../monaco/editor-buffers";
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
  /** Stamp a discovered icon (data: URL or remote URL) onto the
   *  project record. Persists to ~/.aethon/projects.json so cold start
   *  paints synchronously off disk next time. No-op when the iconUrl
   *  is already set to the same value. */
  setProjectIconUrl: (projectId: string, iconUrl: string | null) => void;

  // ─── Worktree ops ──────────────────────────────────────────────────
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  refreshProjectWorktrees: (projectId: string) => Promise<void>;
  activateWorktree: (worktreeId: string | null) => void;
  createWorktreeForProject: (projectId: string) => Promise<void>;
  /** Parameterised worktree-create. Used by the task-launcher composer
   *  and the agent-side `startTask` pi tool; both pass real values
   *  instead of prompting. Returns the path of the new worktree on
   *  success, or null on failure (the pending-row state machine still
   *  surfaces the error in the sidebar). */
  createWorktreeWithParams: (opts: {
    projectId: string;
    branch: string;
    targetPath?: string;
    baseBranch?: string;
  }) => Promise<string | null>;
  removeWorktreeById: (
    worktreeId: string,
    opts?: { confirmed?: boolean },
  ) => Promise<void>;
  dismissPendingWorktree: (worktreeId: string) => void;
  retryPendingWorktree: (worktreeId: string) => Promise<void>;
  renameWorktree: (worktreeId: string, label: string) => void;
  renameProject: (projectId: string, label: string) => void;
  fetchBranches: (projectId: string) => Promise<string[]>;
  findProjectOfWorktree: (
    worktreeId: string,
  ) => { project: Project; worktree: Worktree } | null;
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
    // Editor tabs always count — even an empty file viewer is worth
    // keeping during a project bucket swap so the user comes back to
    // the same open files. A dirty buffer is doubly worth preserving.
    if (tab.kind === "editor") return true;
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

  useEffect(() => {
    return () => {
      if (projectSaveTimerRef.current !== null) {
        clearTimeout(projectSaveTimerRef.current);
        projectSaveTimerRef.current = null;
        saveProjectsBestEffort(projectsRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  function buildProjectsMirror(
    prev: Record<string, unknown>,
    tabsForRecent?: Tab[],
  ): Record<string, unknown> {
    const ps = projectsRef.current;
    const active = activeProject(ps);
    const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
    const tabs = tabsForRecent ?? ((prev.tabs as Tab[] | undefined) ?? []);
    const tabIds = new Set(tabs.map((t) => t.id).concat(["default"]));
    return {
      projects: ps.projects,
      activeProjectId: ps.activeId,
      activeWorktreeId: ps.activeWorktreeId,
      project: active
        ? { id: active.id, label: active.label, path: active.path }
        : null,
      sessionLabel: active ? active.label : "",
      sidebar: {
        ...sidebar,
        projects: ps.projects.map((p) => {
          const wts = ps.worktreesByProject[p.id] ?? [];
          return {
            id: p.id,
            // Basename is what we surface; the absolute path lives
            // behind the row's native tooltip (title attribute) so
            // the row label stays compact even with deep paths.
            label: p.label,
            tooltip: p.path,
            iconUrl: p.iconUrl,
            active: p.id === ps.activeId,
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
    setState((prev) => {
      return {
        ...prev,
        ...buildProjectsMirror(prev),
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
  function switchProjectBucket(
    fromKey: string,
    toKey: string,
    opts: { mirrorProjects?: boolean } = {},
  ): string | undefined {
    if (fromKey === toKey) {
      if (opts.mirrorProjects === true) {
        setState((prev) => ({ ...prev, ...buildProjectsMirror(prev) }));
      }
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
      if (opts.mirrorProjects === true) {
        Object.assign(result, buildProjectsMirror(result, next.tabs));
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
    projectsRef.current = { ...nextProjects, activeWorktreeId: null };
    // Fetch git status for the (possibly new) project so the chip
    // appears on the same render that adds the row, not 30s later.
    void refreshGitStatusFor(path);
    // Switch to the project's tab bucket BEFORE notifying the bridge.
    // If this is a brand-new project, the bucket is empty and the empty
    // state composite renders until the user explicitly creates a tab.
    const nextTabId = switchProjectBucket(fromKey, projectBucketKey(id), {
      mirrorProjects: true,
    });
    scheduleProjectsSave();
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
      ...ps,
      projects: ps.projects.map((p) =>
        p.id === id ? { ...p, lastUsed: Date.now() } : p,
      ),
      activeId: id,
      activeWorktreeId: null,
    };
    const nextTabId = switchProjectBucket(fromKey, toKey, {
      mirrorProjects: true,
    });
    scheduleProjectsSave();
    const tabId = nextTabId ?? "default";
    announceProjectToBridge(tabId, target.path);
    // Swap the file-watcher's project ext dir so edits in the new
    // project's `.aethon/extensions/` hot-reload, and edits in the old
    // one stop firing.
    if (previousActive && previousActive.path !== target.path) {
      unwatchProjectForBridge(previousActive.path);
    }
    watchProjectForBridge(target.path);
    // Fire-and-forget worktree refresh on every switch. External git
    // worktree adds/removes/locks can happen while the user is looking
    // at another project, so cached rows are only a fast initial paint,
    // not a reason to skip discovery.
    void refreshProjectWorktrees(id);
    return true;
  }

  function clearActiveProject() {
    const fromKey = projectBucketKey(projectsRef.current.activeId);
    const previousActive = activeProject(projectsRef.current);
    projectsRef.current = {
      ...projectsRef.current,
      activeId: null,
      activeWorktreeId: null,
    };
    const nextTabId = switchProjectBucket(fromKey, NO_PROJECT_KEY, {
      mirrorProjects: true,
    });
    scheduleProjectsSave();
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

    // Dispose Monaco models for any editor tabs sitting in the removed
    // bucket before we drop the bucket itself. `tabBucketsRef.delete`
    // alone would orphan the models in `EDITOR_BUFFERS` (module-level
    // cache, keyed by tabId) for the rest of the app's lifetime.
    // Active-project tabs already round through `switchProjectBucket`
    // first, which snapshots them into the bucket; either way the bucket
    // holds the to-be-removed tabs by the time we get here.
    const removedBucket = tabBucketsRef.current.get(removedKey);
    if (removedBucket) {
      for (const tab of removedBucket.tabs) {
        if (tab.kind === "editor") disposeEditorBuffer(tab.id);
      }
    }

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

  /* -- Worktree operations ------------------------------------------------ */

  // Find a project by id; null when missing.
  function findProject(id: string): Project | null {
    return projectsRef.current.projects.find((p) => p.id === id) ?? null;
  }

  // Find which project owns a given worktreeId by walking the per-project map.
  function findProjectOfWorktree(
    worktreeId: string,
  ): { project: Project; worktree: Worktree } | null {
    const wbp = projectsRef.current.worktreesByProject;
    for (const [pid, list] of Object.entries(wbp)) {
      const wt = list.find((w) => w.id === worktreeId);
      if (wt) {
        const project = findProject(pid);
        if (project) return { project, worktree: wt };
      }
    }
    return null;
  }

  // Refresh `worktreesByProject[projectId]` from git. Best-effort: a
  // failed `git_worktrees` call leaves the prior list intact so the UI
  // doesn't blink to empty on a transient error.
  async function refreshProjectWorktrees(projectId: string): Promise<void> {
    const project = findProject(projectId);
    if (!project) return;
    try {
      const listing = await gitWorktrees(project.path);
      const prior = projectsRef.current.worktreesByProject[projectId] ?? [];
      const next = reconcileWorktrees(projectId, prior, listing);
      let nextState = setProjectWorktrees(
        projectsRef.current,
        projectId,
        next,
      );
      const activeWorktreeId = nextState.activeWorktreeId;
      if (
        nextState.activeId === projectId &&
        activeWorktreeId &&
        !next.some((w) => w.id === activeWorktreeId)
      ) {
        nextState = { ...nextState, activeWorktreeId: null };
      }
      projectsRef.current = nextState;
      void persistProjects();
    } catch {
      // Swallow; project might not be a git repo. The UI shows zero
      // worktrees, which is correct.
    }
  }

  function setProjectExpanded(projectId: string, expanded: boolean): void {
    projectsRef.current = setProjectUiExpanded(
      projectsRef.current,
      projectId,
      expanded,
    );
    // If we just expanded a project and we don't have worktree data
    // for it yet, kick a refresh.
    if (expanded && !projectsRef.current.worktreesByProject[projectId]) {
      void refreshProjectWorktrees(projectId);
    }
    syncProjectsToState();
    scheduleProjectsSave();
  }

  function setProjectIconUrl(projectId: string, iconUrl: string | null): void {
    const next = setProjectIconUrlState(projectsRef.current, projectId, iconUrl);
    if (next === projectsRef.current) return;
    projectsRef.current = next;
    void persistProjects();
  }

  function activateWorktree(worktreeId: string | null): void {
    if (projectsRef.current.activeWorktreeId === worktreeId) return;
    projectsRef.current = setActiveWorktreeState(
      projectsRef.current,
      worktreeId,
    );
    setState((prev) => ({ ...prev, ...buildProjectsMirror(prev) }));
    scheduleProjectsSave();
  }

  // Branch / target path defaults for the "Create worktree" prompt. The
  // target lives next to the project root with `-<branch>` suffix, mirroring
  // a common community convention (and matching Codex's default placement).
  function defaultWorktreePath(projectPath: string, branch: string): string {
    const safe = branch.replace(/[^a-z0-9._-]/gi, "-");
    return `${projectPath.replace(/\/$/, "")}-${safe}`;
  }

  /** One-click worktree create: picks a Helios-pantheon branch name
   *  that's not already in use, then delegates to
   *  `createWorktreeWithParams` so the optimistic-update + error-path
   *  logic stays in exactly one place (this is the same code path the
   *  task-launcher composer + pi `startTask` tool use). The previous
   *  implementation used `window.prompt` which is unreliable inside the
   *  Tauri webview — that's the bug the sidebar context menu hit. */
  async function createWorktreeForProject(projectId: string): Promise<void> {
    const project = findProject(projectId);
    if (!project) return;
    // Build the "taken" set from every branch the local clone knows
    // about (worktree dir names + git-tracked branches) so we don't
    // collide with existing work.
    const taken = new Set<string>();
    for (const w of projectsRef.current.worktreesByProject[projectId] ?? []) {
      if (w.branch) taken.add(w.branch);
      if (w.label) taken.add(w.label);
    }
    try {
      const branches = await gitBranchList(project.path);
      for (const b of branches) taken.add(b.name);
    } catch {
      // Branch list failed (non-git project, gh missing). Pool is
      // large enough that pure-random pick still works fine.
    }
    const branch = pickWorktreeName(taken);
    await createWorktreeWithParams({ projectId, branch });
  }

  async function createWorktreeWithParams(opts: {
    projectId: string;
    branch: string;
    targetPath?: string;
    baseBranch?: string;
  }): Promise<string | null> {
    const project = findProject(opts.projectId);
    if (!project) return null;
    const branch = opts.branch.trim();
    if (!branch) return null;
    const targetPath =
      opts.targetPath?.trim() || defaultWorktreePath(project.path, branch);
    const pending = newPendingWorktree(opts.projectId, branch, targetPath);
    const before = projectsRef.current.worktreesByProject[opts.projectId] ?? [];
    projectsRef.current = setProjectWorktrees(projectsRef.current, opts.projectId, [
      ...before,
      pending,
    ]);
    syncProjectsToState();
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      opts.projectId,
      updateWorktreePendingState(
        projectsRef.current.worktreesByProject[opts.projectId] ?? [],
        pending.id,
        "starting",
      ),
    );
    syncProjectsToState();
    try {
      await gitWorktreeAdd({
        projectPath: project.path,
        targetPath,
        branch,
        base: opts.baseBranch,
      });
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        opts.projectId,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[opts.projectId] ?? [],
          pending.id,
          "succeeded",
        ),
      );
      await refreshProjectWorktrees(opts.projectId);
      return targetPath;
    } catch (err) {
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        opts.projectId,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[opts.projectId] ?? [],
          pending.id,
          "failed",
          String(err),
        ),
      );
      syncProjectsToState();
      return null;
    }
  }

  async function removeWorktreeById(
    worktreeId: string,
    opts: { confirmed?: boolean } = {},
  ): Promise<void> {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit) return;
    const { project, worktree } = hit;
    if (worktree.isMain) {
      window.alert("Cannot remove the main worktree");
      return;
    }
    const label = worktree.label ?? worktree.branch ?? "worktree";
    if (opts.confirmed !== true) {
      const ok = window.confirm(`Remove worktree '${label}'?`);
      if (!ok) return;
    }
    try {
      await gitWorktreeRemove({
        projectPath: project.path,
        worktreePath: worktree.path,
        force: false,
      });
      // Drop locally + clear active pointer if needed.
      const list = removeWorktreeFromList(
        projectsRef.current.worktreesByProject[project.id] ?? [],
        worktreeId,
      );
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        project.id,
        list,
      );
      if (projectsRef.current.activeWorktreeId === worktreeId) {
        projectsRef.current = setActiveWorktreeState(
          projectsRef.current,
          null,
        );
      }
      void persistProjects();
    } catch (err) {
      const msg = String(err);
      // Offer a forced retry when the worktree has uncommitted changes.
      if (msg.includes("dirty") || msg.includes("modified")) {
        const forced = window.confirm(
          `${msg}\n\nForce-remove anyway? Uncommitted changes will be lost.`,
        );
        if (!forced) return;
        try {
          await gitWorktreeRemove({
            projectPath: project.path,
            worktreePath: worktree.path,
            force: true,
          });
          const list = removeWorktreeFromList(
            projectsRef.current.worktreesByProject[project.id] ?? [],
            worktreeId,
          );
          projectsRef.current = setProjectWorktrees(
            projectsRef.current,
            project.id,
            list,
          );
          void persistProjects();
          return;
        } catch (e2) {
          window.alert(`Failed: ${String(e2)}`);
          return;
        }
      }
      window.alert(`Failed: ${msg}`);
    }
  }

  function dismissPendingWorktree(worktreeId: string): void {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit) return;
    const list = removeWorktreeFromList(
      projectsRef.current.worktreesByProject[hit.project.id] ?? [],
      worktreeId,
    );
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      list,
    );
    void persistProjects();
  }

  async function retryPendingWorktree(worktreeId: string): Promise<void> {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit || !hit.worktree.branch) return;
    dismissPendingWorktree(worktreeId);
    // Reuse the same path + branch the failed entry had; if it's gone
    // already (user-removed) the user re-creates via the menu.
    const pending = newPendingWorktree(
      hit.project.id,
      hit.worktree.branch,
      hit.worktree.path,
    );
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      [
        ...(projectsRef.current.worktreesByProject[hit.project.id] ?? []),
        pending,
      ],
    );
    syncProjectsToState();
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      updateWorktreePendingState(
        projectsRef.current.worktreesByProject[hit.project.id] ?? [],
        pending.id,
        "starting",
      ),
    );
    syncProjectsToState();
    try {
      await gitWorktreeAdd({
        projectPath: hit.project.path,
        targetPath: hit.worktree.path,
        branch: hit.worktree.branch,
      });
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        hit.project.id,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[hit.project.id] ?? [],
          pending.id,
          "succeeded",
        ),
      );
      await refreshProjectWorktrees(hit.project.id);
    } catch (err) {
      projectsRef.current = setProjectWorktrees(
        projectsRef.current,
        hit.project.id,
        updateWorktreePendingState(
          projectsRef.current.worktreesByProject[hit.project.id] ?? [],
          pending.id,
          "failed",
          String(err),
        ),
      );
      syncProjectsToState();
    }
  }

  function renameWorktree(worktreeId: string, label: string): void {
    const hit = findProjectOfWorktree(worktreeId);
    if (!hit) return;
    const trimmed = label.trim();
    const next: Worktree[] = (
      projectsRef.current.worktreesByProject[hit.project.id] ?? []
    ).map((w) =>
      w.id === worktreeId
        ? { ...w, label: trimmed.length > 0 ? trimmed : undefined }
        : w,
    );
    projectsRef.current = setProjectWorktrees(
      projectsRef.current,
      hit.project.id,
      next,
    );
    void persistProjects();
  }

  async function fetchBranches(projectId: string): Promise<string[]> {
    const project = findProject(projectId);
    if (!project) return [];
    try {
      const list = await gitBranchList(project.path);
      return list.map((b) => b.name);
    } catch {
      return [];
    }
  }

  function renameProject(projectId: string, label: string): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    const ps = projectsRef.current;
    projectsRef.current = {
      ...ps,
      projects: ps.projects.map((p) =>
        p.id === projectId ? { ...p, label: trimmed } : p,
      ),
    };
    void persistProjects();
  }

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
    setProjectExpanded,
    setProjectIconUrl,
    refreshProjectWorktrees,
    activateWorktree,
    createWorktreeForProject,
    createWorktreeWithParams,
    removeWorktreeById,
    dismissPendingWorktree,
    retryPendingWorktree,
    renameWorktree,
    fetchBranches,
    renameProject,
    findProjectOfWorktree,
  };
}
