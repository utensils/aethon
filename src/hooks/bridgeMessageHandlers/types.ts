import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { A2UIPayload, ChatMessage } from "../../types/a2ui";
import type { EditorDiffSnapshot, Tab } from "../../types/tab";
import type { ExtensionRegistry } from "../../extensions/ExtensionRegistry";
import type {
  DisabledExtensionRecord,
  ExtensionFailureSummary,
  ExtensionSummary,
  ExtensionTheme,
} from "../useExtensionsHydration";
import type {
  NotificationEntry,
  NotificationKind,
} from "../../extensions/default-layout/notifications";
import type { ProjectsState } from "../../projects";
import type { StartTaskResult } from "../useTaskLauncher";
import type { NativeWindowsRef } from "../../nativeWindows";

/** A bridge-to-frontend message. The `type` discriminator routes to a
 *  handler in the registry; other keys are payload-specific and typed
 *  per-handler with narrowing assertions inside the handler body. */
export interface BridgeMessage {
  type?: string;
  [k: string]: unknown;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  provider: string;
  thinkingLevels?: string[];
  codexFastModeSupported?: boolean;
}

export interface DiscoveredSession {
  tabId: string;
  lastModified: number;
  cwd?: string;
  /** First user message text, trimmed to 60 chars by the bridge. */
  firstUserMessage?: string;
  customLabel?: string;
}

export interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

/** Everything a handler may close over. Flat by design — every handler
 *  imports the same context type, so adding a new handler doesn't require
 *  a context-shape decision. The fields are grouped by source (refs,
 *  setters, app actions, hydrators, helpers) to make audits readable. */
export interface BridgeMessageContext {
  // ─── React state setters ─────────────────────────────────────────────
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  setLayout: Dispatch<SetStateAction<A2UIPayload>>;

  // ─── Live refs ──────────────────────────────────────────────────────
  stateRef: MutableRefObject<Record<string, unknown>>;
  registry: ExtensionRegistry;
  piDefaultModelRef: MutableRefObject<string>;
  allDiscoveredSessionsRef: MutableRefObject<DiscoveredSession[]>;
  projectsRef: MutableRefObject<ProjectsState>;
  projectsLoadedRef: MutableRefObject<boolean>;
  activeResponseIdRef: MutableRefObject<string | null>;
  hangWarnTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  hangWarnActiveRef: MutableRefObject<Set<string>>;
  turnStartedAtRef: MutableRefObject<Map<string, number>>;
  lastExtensionStateKeysRef: MutableRefObject<Set<string>>;
  pendingTabOpens: MutableRefObject<Map<string, Promise<unknown>>>;
  nativeWindowsRef: NativeWindowsRef;

  // ─── Tab actions (from useTabs) ─────────────────────────────────────
  updateTab: (tabId: string, updater: (tab: Tab) => Tab) => void;
  updateActiveTab: (updater: (tab: Tab) => Tab) => void;
  /** Open (or focus) a tab. Used by `session_forked` to open the forked tab
   *  with its restored history. */
  newTab: (
    tabId?: string,
    label?: string,
    options?: {
      restoredSession?: boolean;
      cwd?: string;
      scrollToMatch?: string;
      model?: string;
    },
  ) => void;
  /** Open (or focus) a Monaco editor tab. Used by the agent-side
   *  `openFileInEditor` tool via `editor_query`. */
  newEditorTab: (
    filePath: string,
    opts?: {
      rootPath?: string;
      diff?: boolean;
      diffSnapshot?: EditorDiffSnapshot;
    },
  ) => void;
  dispatchTerminalReplay: (buffer: string) => void;
  prepareWorkspaceStartup?: (cwd: string) => Promise<boolean>;
  autoRestoreDiscoveredSessions: (
    discovered: DiscoveredSession[],
    knownIds: Set<string>,
  ) => void;

  // ─── Extension hydration (from useExtensionsHydration) ──────────────
  hydrateThemes: (list: ExtensionTheme[]) => void;
  hydrateExtensions: (
    loaded: ExtensionSummary[],
    failed: ExtensionFailureSummary[],
    disabled?: ReadonlyArray<DisabledExtensionRecord | string>,
    activeProjectPath?: string | null,
    knownProjectBasenames?: ReadonlySet<string>,
  ) => void;
  hydrateSlashCommands: (
    list: { name: string; description: string; usage?: string }[],
    piCommands?: { name: string; description: string; usage?: string }[],
  ) => void;
  hydrateKeybindings: (
    list: { combo: string; action: string; description?: string }[],
  ) => void;
  hydrateEventRoutes: (
    routes: { componentId?: string; eventType?: string }[],
    mode?: "builtin" | "extension",
  ) => void;
  hydrateExtensionLayouts: (
    list: {
      id: string;
      name: string;
      description?: string;
      payload: A2UIPayload;
    }[],
  ) => void;
  hydrateFrontendModules: (list: { name: string; code: string }[]) => void;

  // ─── Project I/O (from useProjects + App) ───────────────────────────
  announceProjectToBridge: (tabId: string, path: string) => void;

  // ─── Chat / status helpers (defined on App) ─────────────────────────
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  persistLocalChatMessage: (
    msg: ChatMessage,
    tabId: string,
  ) => Promise<boolean>;
  recordProjectModel: (model: string, tabId?: string) => void;
  appendOrAmendAgentText: (
    delta: string,
    messageId?: string,
    tabId?: string,
    channel?: "text" | "thinking",
    model?: string,
  ) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;

  // ─── Notification helpers (defined on App) ──────────────────────────
  pushNotification: (input: {
    id?: string;
    title: string;
    message?: string;
    kind?: NotificationKind;
    durationMs?: number | null;
    actions?: NotificationEntry["actions"];
  }) => void;
  dismissNotification: (id: string) => void;
  maybeFireCompletionNotification: (input: {
    tabId: string;
    turnDurationMs: number;
  }) => Promise<void>;

  // ─── Session-list helpers (defined on App) ──────────────────────────
  knownTabIds: (extraTabs?: { id: string }[]) => Set<string>;
  scopedDiscoveredSessions: (
    discovered: DiscoveredSession[],
  ) => DiscoveredSession[];
  recentSessionItems: (
    discovered: DiscoveredSession[],
    openIds: Set<string>,
  ) => RecentSessionItem[];
  syncRecentSessionsToState: () => void;
  syncNativeWindowsToState: () => void;

  // ─── Misc helpers (defined on App) ──────────────────────────────────
  routeShellWrite: (args: Record<string, unknown>) => Promise<{ ok: true }>;
  /** End-to-end task launch — see App.tsx::startTaskInProject. Reused
   *  by the agent-side `startTask` pi tool via `handleDashboardQuery`
   *  so the bridge can drive the same chain as the UI composer. */
  startTaskInProject: (opts: {
    projectId: string;
    prompt: string;
    newWorkspace?: boolean;
    branch?: string;
    baseBranch?: string;
    model?: string;
    bridgePrompt?: string;
    activate?: boolean;
    label?: string;
  }) => Promise<StartTaskResult | void>;

  // ─── Hook-owned ────────────────────────────────────────────────────
  /** Startup/reload paint gate. The first bridge ready can still represent
   *  a stale project cwd; callers mark chrome paintable only after ready has
   *  the active project's extension/layout surface. */
  markStartupChromeReady: () => void;
  /** Ack a mutation back to the bridge. Provided by useBridgeMessages so
   *  handlers don't have to know about the IPC channel. */
  ackMutation: (
    mutationId: unknown,
    success: boolean,
    error?: string,
    data?: unknown,
  ) => void;
  /** Hang-warn notification id helper. */
  hangWarnNotifId: (tabId: string) => string;
  /** Hang-warn timeout in ms. */
  hangWarnMs: number;
  /** The boot layout payload. Used by `ready` to compute the fallback
   *  layout when an extension hasn't supplied one. */
  bootLayout: A2UIPayload;
}

export type BridgeMessageHandler = (
  message: BridgeMessage,
  ctx: BridgeMessageContext,
) => void;
