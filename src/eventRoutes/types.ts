import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  EditorDiffSnapshot,
  EditorMeta,
  GitHubIssueSource,
  Tab,
} from "../types/tab";
import type { ChatAttachment } from "../types/a2ui";
import type { ShareMode } from "../utils/shareMode";
import type {
  NotificationEntry,
  NotificationKind,
} from "../extensions/default-layout/notifications";
import type { PaletteItem } from "../extensions/default-layout/palette-items";

/** A renderer-side event from `<A2UIRenderer onEvent>`. The renderer
 *  calls `onEvent({id, type}, eventType, data)`; we package the trio
 *  here so handlers can pattern-match on a single argument. */
export interface EventRouteEvent {
  component: { id: string; type?: string };
  eventType: string;
  data?: unknown;
}

/** Tracks pending session/project listings the dispatcher needs to
 *  drive sidebar history mutations. */
export interface DiscoveredSession {
  tabId: string;
  lastModified: number;
  cwd?: string;
  firstUserMessage?: string;
  customLabel?: string;
}

/** Everything a route handler may close over. Flat by design — every
 *  handler imports the same context, so adding a new handler doesn't
 *  require a context-shape decision. Mirrors the BridgeMessageContext
 *  pattern from #36. */
export interface EventRouteContext {
  // ─── React state setters ─────────────────────────────────────────────
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;

  // ─── Live refs ──────────────────────────────────────────────────────
  stateRef: MutableRefObject<Record<string, unknown>>;
  extensionEventRoutesRef: MutableRefObject<
    { componentId?: string; eventType?: string }[]
  >;
  extensionEventRoutingModeRef: MutableRefObject<"builtin" | "extension">;
  allDiscoveredSessionsRef: MutableRefObject<DiscoveredSession[]>;

  // ─── Shell-consent gates (from useShellConsent) ─────────────────────
  hasPendingShellWriteConsent: (id: string) => boolean;
  resolveShellWriteConsent: (id: string, allowed: boolean) => void;
  hasPendingShellCloseConsent: (id: string) => boolean;
  resolveShellCloseConsent: (id: string, allowed: boolean) => void;
  hasPendingSessionDeleteConsent: (id: string) => boolean;
  resolveSessionDeleteConsent: (id: string, allowed: boolean) => void;
  promptDeleteSessionConfirmation: (label: string) => Promise<boolean>;
  hasPendingWorkspacePrompt: (id: string) => boolean;
  resolveWorkspacePrompt: (id: string, allowed: boolean) => void;

  // ─── Notifications ──────────────────────────────────────────────────
  pushNotification: (input: {
    id?: string;
    title: string;
    message?: string;
    kind?: NotificationKind;
    durationMs?: number | null;
    actions?: NotificationEntry["actions"];
  }) => void;
  dismissNotification: (id: string) => void;

  // ─── Chat / prompt ──────────────────────────────────────────────────
  sendChat: (
    text: string,
    options?: {
      mode?: "normal" | "steer";
      tabId?: string;
      attachments?: ChatAttachment[];
    },
  ) => Promise<void>;
  stopPrompt: (explicitTabId?: string) => Promise<void>;
  updateTab: (tabId: string, updater: (tab: Tab) => Tab) => void;
  updateActiveTab: (updater: (tab: Tab) => Tab) => void;

  // ─── Queue (popover above composer) ─────────────────────────────────
  editQueuedMessage: (
    tabId: string,
    messageId: string,
    content: string,
  ) => void;
  deleteQueuedMessage: (tabId: string, messageId: string) => void;
  steerQueuedMessage: (tabId: string, messageId: string) => Promise<void>;
  clearQueuedMessages: (tabId: string) => void;

  // ─── Tab / shell actions (from useTabs) ─────────────────────────────
  newTab: (
    tabId?: string,
    label?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
      model?: string;
      sourceIssue?: GitHubIssueSource;
    },
  ) => void;
  newShellTab: () => void;
  newEditorTab: (
    filePath: string,
    opts?: {
      rootPath?: string;
      hostId?: string;
      diff?: boolean;
      diffSnapshot?: EditorDiffSnapshot;
    },
  ) => void;
  updateEditorMeta: (tabId: string, patch: Partial<EditorMeta>) => void;
  /** Toggle markdown preview on the active editor tab. No-op unless the
   *  active tab is a markdown editor tab. Backs both Cmd+Shift+V and the
   *  in-editor Preview button. */
  toggleEditorPreview: () => void;
  /** Reconcile any open editor tabs whose `editor.filePath` is `from`
   *  (or, when `kind === "dir"`, starts with `from/`) to point at the
   *  renamed location. Used after fs_rename completes so the next
   *  Cmd+S writes to the new path. */
  renameEditorTabsForPath: (from: string, to: string, kind: string) => void;
  /** Close any open editor tabs whose `editor.filePath` is `path`
   *  (or, when `kind === "dir"`, starts with `path/`). Called after a
   *  successful fs_delete so a dangling buffer can't recreate the
   *  trashed file on the next Cmd+S. */
  closeEditorTabsForPath: (path: string, kind: string) => void;
  closeTab: (tabId: string) => void;
  closeAllWorkspaceSessions: () => void;
  setActiveTab: (tabId: string) => void;
  /** Activate a tab by id no matter which workspace owns it. If the tab is
   *  in the active workspace it selects it directly; otherwise it switches
   *  to the owning project/workspace bucket first, then selects it. Backs
   *  the completion toast's click-to-jump. */
  activateTabAnywhere: (tabId: string) => void;
  setActiveSubTab: (subId: string) => void;
  applyShareModeToTab: (tabId: string, mode: ShareMode) => void;

  // ─── Settings panel ─────────────────────────────────────────────────
  closeSettings: () => void;
  applySettingsPatch: (patch: Record<string, unknown>) => void;
  saveSettings: () => Promise<void>;

  // ─── Search panel ───────────────────────────────────────────────────
  closeSessionSearch: () => void;
  setSearchQuery: (value: string) => void;
  setSearchScope: (scope: "all" | "current") => void;
  openSearchHit: (hit: { tabId?: string; snippetMatch?: string }) => void;

  // ─── Command palette ────────────────────────────────────────────────
  closePalette: () => void;
  runPaletteItem: (item: PaletteItem) => Promise<void>;

  // ─── Sidebar / chrome / projects ────────────────────────────────────
  toggleTerminal: () => void;
  clearChat: () => void;
  setModel: (id: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setCodexFastMode: (enabled: boolean) => Promise<void>;
  setTheme: (id: string) => void;
  activateLayoutById: (id: string) => void;
  openProjectFromPicker: () => Promise<string | null>;
  setActiveProjectById: (id: string) => void;
  clearActiveProject: () => void;
  removeProjectById: (id: string) => boolean;
  /** Switch the active host (HOSTS sidebar section). App's implementation
   *  also clears the active project so host selection lands in the
   *  no-project workspace. */
  setActiveHost: (id: string | null) => void;
  syncRecentSessionsToState: () => void;
  // ─── Workspaces ─────────────────────────────────────────────────────
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  refreshProjectWorkspaces: (projectId: string) => Promise<void>;
  activateWorkspace: (workspaceId: string | null) => void;
  createWorkspaceForProject: (projectId: string) => Promise<void>;
  /** End-to-end task launch from the dashboard composer (or the
   *  agent-side `startTask` pi tool). Creates a workspace when
   *  newWorkspace is set; otherwise uses `workspaceId` (existing workspace)
   *  or the project root as the cwd. Spawns a new agent tab with the
   *  resolved cwd and forwards the prompt as the tab's first user
   *  message. Failures surface via the notification stack. */
  startTaskInProject: (opts: {
    projectId: string;
    prompt: string;
    attachments?: ChatAttachment[];
    newWorkspace?: boolean;
    branch?: string;
    baseBranch?: string;
    /** Existing workspace to launch under. Ignored when newWorkspace is
     *  true. When omitted, the project root is used. */
    workspaceId?: string;
    /** Model the launched session should use (task-launcher model chip). */
    model?: string;
    bridgePrompt?: string;
    activate?: boolean;
    label?: string;
    sourceIssue?: GitHubIssueSource;
  }) => Promise<unknown>;
  clearClosedIssueLinksForProject: (
    projectId: string,
    openIssueNumbers: ReadonlySet<number>,
  ) => void;
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

  // ─── Tauri IPC (injected so tests can mock it) ─────────────────────
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Persist key/value to disk via the Tauri state command. Returns
   *  `true` on success; the dispatcher's callers ignore the boolean
   *  (best-effort write). */
  writeState: (name: string, content: string) => Promise<boolean>;
}

/** A single route handler. Returns `true` when it has handled the
 *  event (renderer should suppress its default forward); `false` if it
 *  did not match (dispatcher tries the next route). */
export type EventRouteHandler = (
  event: EventRouteEvent,
  ctx: EventRouteContext,
) => boolean | Promise<boolean>;
