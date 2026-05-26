import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { EditorMeta, ShellMeta, Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";

/** Bridge-discovered persistent session awaiting restore.
 *  Surfaced by useProjectOps; useTabs.autoRestoreDiscoveredSessions
 *  consumes them to pre-open recent tabs on boot. */
export interface DiscoveredSession {
  tabId: string;
  lastModified: number;
  cwd?: string;
  firstUserMessage?: string;
  customLabel?: string;
}

/** Subset of the notification payload useTabs actually emits.
 *  Mirrors `pushNotification` from useNotifications without
 *  importing the full type — keeps the deps surface narrow. */
export interface NotificationInput {
  id: string;
  title: string;
  message?: string;
  kind?: "info" | "success" | "warning" | "error";
  durationMs?: number | null;
}

export interface UseTabsContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
  pushNotification: (n: NotificationInput) => void;
  appendSystem: (text: string) => void;
  /** Resolves true on Allow / false on Cancel|dismiss. Drives the
   *  prompt-before-close gate for running shell tabs. */
  promptCloseShellTabConfirmation: (tabLabel: string) => Promise<boolean>;
  /** Live ref to projects state so newTab/newShellTab inherit the active
   *  project's path as cwd. Project bucket swap stays in App.tsx. */
  projectsRef: MutableRefObject<ProjectsState>;
  /** Default model id from pi `ready`. New tabs inherit this when no per-
   *  tab model has been set, preventing a blank picker on race startup. */
  piDefaultModelRef: MutableRefObject<string>;
  /** Reopen-flow callbacks: when the closed tab belongs to a different
   *  project bucket, switch buckets first so it lands in the correct
   *  visible tab list. */
  clearActiveProject: () => void;
  setActiveProjectById: (id: string) => boolean;
  /** Live shell config from getConfig() — set by the boot config effect
   *  and the settings panel apply path. The hook reads via `.current`. */
  defaultShareModeRef: MutableRefObject<ShellMeta["shareMode"]>;
  shellDefaultCommandRef: MutableRefObject<string | null>;
  shellDefaultArgsRef: MutableRefObject<string[]>;
  shellInheritEnvRef: MutableRefObject<boolean>;
  shellPromptBeforeCloseRef: MutableRefObject<boolean>;
}

export interface UseTabsActions {
  /** In-flight tab_open promises keyed by tabId. sendChat awaits this so
   *  the bridge can't race-create the tab via the chat path. */
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  /** Tab ids the auto-restore path has already opened in this session.
   *  Prevents a second restore wave from re-opening the same tab. */
  autoRestoredSessionIdsRef: MutableRefObject<Set<string>>;

  updateTab: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  updateActiveTab: (mutator: (tab: Tab) => Tab) => void;
  applyShareModeToTab: (tabId: string, mode: string) => void;

  dispatchTerminalReplay: (buffer: string) => void;
  setActiveTab: (tabId: string) => void;
  setActiveSubTab: (subId: string) => void;

  newTab: (
    restoreId?: string,
    restoreLabel?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
    },
  ) => void;
  newShellTab: (options?: {
    command?: string;
    args?: string[];
    cwd?: string;
  }) => void;
  /** Open (or focus, if already open) an editor tab for `filePath`.
   *  `filePath` must be inside the active project; the EditorCanvas
   *  composite handles the actual fs_read_file call on mount. */
  newEditorTab: (filePath: string, opts?: { rootPath?: string }) => void;
  /** Set the dirty flag + cursor on the active editor tab. Used by
   *  EditorCanvas to mirror Monaco's model state back to the layout. */
  updateEditorMeta: (tabId: string, patch: Partial<EditorMeta>) => void;
  /** Toggle the active editor tab's markdown preview mode (Cmd+Shift+V). */
  toggleEditorPreview: () => void;
  /** Reconcile open editor tabs after a rename. See implementation
   *  notes inside tabOps/closeTab.ts. */
  renameEditorTabsForPath: (from: string, to: string, kind: string) => void;
  /** Close any open editor tabs whose filePath matches `path` (or is
   *  a descendant when `kind === "dir"`). See implementation notes
   *  inside tabOps/closeTab.ts. */
  closeEditorTabsForPath: (path: string, kind: string) => void;
  autoRestoreDiscoveredSessions: (
    discovered: DiscoveredSession[],
    knownIds: Set<string>,
  ) => void;

  pushClosedTab: (tab: Tab) => void;
  reopenLastClosedTab: () => void;
  closeTab: (tabId: string) => void;
  closeTabNow: (tabId: string) => void;
}
