import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Project, ProjectsState } from "../../projects";
import type { ChatMessage } from "../../types/a2ui";
import type { Tab } from "../../types/tab";
import type { Workspace } from "../../workspaces";
import type { GitStatus } from "../useProjects";
import type { WorkspaceRemovalPrompts } from "./workspaceOps/types";

export interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

export interface DiscoveredSession {
  tabId: string;
  lastModified: number;
  cwd?: string;
  /** false when `cwd` is set but the directory no longer exists on disk. */
  cwdExists?: boolean;
  /** First user message text, trimmed to 60 chars by the bridge. Used to
   *  label sidebar history items meaningfully instead of UUID slices. */
  firstUserMessage?: string;
  customLabel?: string;
}

export interface SidebarHistoryItem {
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
  /** Shared per-project/workspace tab buckets. App owns this so useTabs can
   *  prune closed visible tabs from the same mirror useProjectOps switches. */
  tabBucketsRef?: MutableRefObject<Map<string, TabBucket>>;
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
  /** From useTabs: force-close visible tabs after their backing workspace
   *  is removed. Workspace deletion is already destructive, so there is
   *  no separate close confirmation for those session tabs. */
  closeTabNow: (tabId: string) => void;
  /** From useTabs: create an interactive shell sub-tab. Injected so the
   *  capability is available, but project/workspace bucket switches must
   *  NOT auto-invoke it — interactive shells are created only by explicit
   *  user action (Cmd+T / Cmd+Shift+T / the "+" button). A regression test
   *  asserts switching buckets never calls this. */
  newShellTab?: () => void;
  /** Notification-backed prompts for destructive workspace removal flows. */
  workspacePrompts: WorkspaceRemovalPrompts;
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
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>;

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
  buildProjectsMirror: (
    prev: Record<string, unknown>,
    tabsForRecent?: Tab[],
  ) => Record<string, unknown>;

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

  // ─── Workspace ops ──────────────────────────────────────────────────
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  refreshProjectWorkspaces: (projectId: string) => Promise<void>;
  activateWorkspace: (workspaceId: string | null) => void;
  createWorkspaceForProject: (projectId: string) => Promise<void>;
  /** Parameterised workspace-create. Used by the task-launcher composer
   *  and the agent-side `startTask` pi tool; both pass real values
   *  instead of prompting. Returns the path of the new workspace on
   *  success, or null on failure (the pending-row state machine still
   *  surfaces the error in the sidebar). */
  createWorkspaceWithParams: (opts: {
    projectId: string;
    branch?: string;
    targetPath?: string;
    baseBranch?: string;
    activate?: boolean;
  }) => Promise<string | null>;
  removeWorkspaceById: (
    workspaceId: string,
    opts?: { confirmed?: boolean },
  ) => Promise<void>;
  dismissPendingWorkspace: (workspaceId: string) => void;
  retryPendingWorkspace: (workspaceId: string) => Promise<void>;
  renameWorkspace: (workspaceId: string, label: string) => void;
  renameProject: (projectId: string, label: string) => void;
  setProjectWorkspaceBaseBranch: (
    projectId: string,
    baseBranch: string | null,
  ) => void;
  reorderWorkspace: (
    projectId: string,
    workspaceId: string,
    toIndex: number,
  ) => void;
  sortProjectWorkspacesNewest: (projectId: string) => void;
  fetchBranches: (projectId: string) => Promise<string[]>;
  findProjectOfWorkspace: (
    workspaceId: string,
  ) => { project: Project; workspace: Workspace } | null;
}

export interface TabBucket {
  tabs: Tab[];
  activeTabId: string | undefined;
}

export type FirstUserText = (messages: ChatMessage[]) => string;
