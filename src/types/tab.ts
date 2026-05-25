import type { ChatMessage } from "./a2ui";
import type { ShareMode } from "../utils/shareMode";

// M6 P1: shell-tab metadata. Present iff Tab.kind === "shell".
// Carried as an optional sibling field (rather than refactoring Tab to a
// discriminated union) so existing agent-tab code paths stay unchanged.
export interface ShellMeta {
  cwd: string;
  command: string;
  args: string[];
  shareMode: ShareMode;
  shellState: "starting" | "running" | "exited";
  exitCode?: number;
}

/**
 * Editor-tab metadata. Present iff Tab.kind === "editor".
 *
 * The buffer (in-memory text) lives on the Monaco model instance,
 * keyed by tabId — we don't mirror it here because (a) Monaco's
 * undo/cursor state is the source of truth while the tab is open
 * and (b) JSON-serialising a 10 MB buffer for every keystroke would
 * choke the persist layer. `isDirty` is what we *do* track in state
 * because the tab strip needs to render the dirty dot.
 *
 * Cursor position is recorded so a tab restored after a restart
 * lands where the user left off. Both `cursorLine` / `cursorColumn`
 * are 1-based to match Monaco's `IPosition` shape.
 */
export interface EditorMeta {
  filePath: string;
  /** Optional filesystem root for files outside the active project tree
   *  (for example ~/.aethon/system-prompt.md opened from Settings). */
  rootPath?: string;
  language: string;
  isDirty: boolean;
  cursorLine?: number;
  cursorColumn?: number;
  /** When true and language === "markdown", the editor canvas renders
   *  the markdown preview instead of Monaco. Toggled by Cmd+Shift+V. */
  previewMode?: boolean;
  /** Increments on every successful save while previewMode is true so
   *  the preview re-reads fresh disk content. */
  previewRefreshKey?: number;
}

export type TabKind = "agent" | "shell" | "editor";

/**
 * A user message held on the client-side queue while a turn is in flight.
 * The popover above the composer renders the list, and the user can edit /
 * delete / promote-to-steer each entry before `useQueuedDispatch` drains the
 * head on the next idle. The message only enters chat history once it is
 * actually dispatched — Claudette-style.
 */
export interface QueuedMessage {
  id: string;
  content: string;
}

export interface Tab {
  id: string;
  /** "agent" (chat session) or "shell" (interactive PTY). Default "agent"
   *  for back-compat with persisted tab records that pre-date the field. */
  kind: TabKind;
  label: string;
  messages: ChatMessage[];
  draft: string;
  waiting: boolean;
  /** Derived: equals `queuedMessages.length`. Kept as a separate field so
   *  the existing `/queueCount` binding (badge in the composer) doesn't
   *  have to re-resolve through the array on every render. Writers must
   *  set both in lockstep — `useChat`'s `withQueue()` helper is the
   *  canonical writer and guarantees the invariant. Bridge handlers
   *  for `queued` / `queue_reset` events are intentionally no-ops on
   *  the new client-held queue path; mutating queueCount without
   *  touching queuedMessages would desync the composer badge and
   *  popover row count. */
  queueCount: number;
  /** Client-held queue of unsent user messages. Drained by
   *  `useQueuedDispatch` when the agent goes idle. Rendered as a popover
   *  above the composer. Only agent tabs ever populate this. */
  queuedMessages: QueuedMessage[];
  /** Id of the queued message currently being promoted via steer. Drives
   *  the per-row spinner so the user knows the click landed before pi
   *  acknowledges. Cleared by the dispatch path on success or error. */
  queuedSteeringId?: string;
  canvas: unknown;
  model: string;
  // Rolling buffer of bash output for this tab. The Terminal component
  // writes to xterm directly for the active tab; this buffer survives
  // tab switches so the panel can replay it when the user comes back.
  // Capped client-side too (TERMINAL_REPLAY_MAX) to bound memory.
  terminalBuffer: string;
  // Project this tab belongs to. `null` means the no-project bucket
  // (tabs created before any project was picked, or after
  // clearActiveProject). Tabs are isolated per project — switching
  // projects swaps `state.tabs` for the target project's bucket and
  // hides everyone else.
  projectId: string | null;
  // Immutable working directory the bridge session was created with.
  // For worktree sessions this is the worktree path, not the project root.
  cwd?: string;
  /** Present iff kind === "shell". */
  shell?: ShellMeta;
  /** Present iff kind === "editor". */
  editor?: EditorMeta;
}

/**
 * A closed-tab snapshot kept on a small stack so the user can reopen an
 * equivalent tab via `reopenLastClosedTab` (Cmd/Ctrl+Opt+T). For agent
 * tabs the original tabId is preserved so the bridge's
 * SessionManager.continueRecent picks up the persisted JSONL session —
 * the user sees their previous conversation, not a fresh chat.
 */
export interface ClosedTabEntry {
  /** Original tabId — used as restoreId on reopen so the bridge resumes
   *  the session via SessionManager.continueRecent. */
  id: string;
  kind: TabKind;
  label: string;
  projectId: string | null;
  /** Agent and shell tabs — passed back to reopen/restore paths. */
  cwd?: string;
  command?: string;
  args?: string[];
  /** Editor tabs only — passed back to newEditorTab so reopen lands on
   *  the same file. */
  filePath?: string;
}

// Sentinel key for the "no project" bucket. Project ids are UUIDs so a
// literal can't collide.
export const NO_PROJECT_KEY = "__no_project__";

export function projectBucketKey(id: string | null | undefined): string {
  return id ?? NO_PROJECT_KEY;
}

export function makeEmptyTab(
  id: string,
  label: string,
  projectId: string | null = null,
  kind: TabKind = "agent",
): Tab {
  return {
    id,
    kind,
    label,
    messages: [],
    draft: "",
    waiting: false,
    queueCount: 0,
    queuedMessages: [],
    canvas: null,
    model: "",
    terminalBuffer: "",
    projectId,
  };
}

/**
 * Derive `/agentTabActive`, `/shellTabActive`, and `/editorTabActive`
 * from the current tab list and active id. All three gates require at
 * least one tab; when no tab is active the empty-state composite owns
 * the canvas area.
 *
 * Lives here (rather than as a useEffect mirror) so layout `visible:
 * { $ref: "/agentTabActive" }` bindings can never lag behind a
 * tabs/activeTabId mutation — the gates recompute synchronously
 * inside App.tsx's renderState memo.
 *
 * The three flags are mutually exclusive; the active tab's `kind`
 * picks exactly one of them.
 */
export function deriveTabActiveFlags(
  tabs: Tab[],
  activeTabId: string | undefined,
): {
  agentTabActive: boolean;
  shellTabActive: boolean;
  editorTabActive: boolean;
} {
  if (tabs.length === 0) {
    return {
      agentTabActive: false,
      shellTabActive: false,
      editorTabActive: false,
    };
  }
  const activeTab = activeTabId
    ? tabs.find((t) => t.id === activeTabId)
    : undefined;
  const kind = activeTab?.kind ?? "agent";
  return {
    agentTabActive: kind === "agent",
    shellTabActive: kind === "shell",
    editorTabActive: kind === "editor",
  };
}
