import type { ChatAttachment, ChatMessage } from "./a2ui";
import type { ShareMode } from "../utils/shareMode";
import type { VisibilityMode } from "../config";

/**
 * Per-tab transcript visibility overrides. When a field is absent (or null)
 * the tab follows the global default (`[ui] thinking_visibility` /
 * `tool_calls_visibility`); a concrete value overrides it for this session.
 * Persisted with the tab (see `restoreTabRecord` in `state/sessionUiSnapshot`)
 * so a per-session choice survives reloads and restarts.
 */
export interface TabVisibilityOverrides {
  thinking?: VisibilityMode | null;
  toolCalls?: VisibilityMode | null;
}

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
  /** Frontend-only marker used after a webview hot reload. The shell
   *  registry lives in Rust and survives the JS reload less reliably
   *  than React state, so restored shell tabs reopen their PTY once
   *  after mount and then clear this flag. */
  restartOnMount?: boolean;
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
  /** When true, the canvas renders a read-only side-by-side diff
   *  (HEAD vs working tree) instead of the editable Monaco editor.
   *  Set by the Source Control / CI panel's "open changes" flow. */
  diff?: boolean;
}

export interface ContextUsageState {
  tabId?: string;
  model: string;
  status: "known" | "unknown";
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  autoCompactEnabled: boolean;
  reserveTokens: number;
  compactAtTokens: number;
  tokensUntilCompact: number | null;
  compacting?: boolean;
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
  attachments?: ChatAttachment[];
}

export interface Tab {
  id: string;
  /** "agent" (chat session) or "shell" (interactive PTY). Default "agent"
   *  for back-compat with persisted tab records that pre-date the field. */
  kind: TabKind;
  label: string;
  messages: ChatMessage[];
  draft: string;
  draftAttachments?: ChatAttachment[];
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
  contextUsage?: ContextUsageState;
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
  /** Auth profile id selected for this agent session, if any. */
  authProfileId?: string;
  /** Per-session transcript visibility overrides (thinking / tool calls).
   *  Absent → follow the global `[ui]` defaults. Agent tabs only. */
  visibilityOverrides?: TabVisibilityOverrides;
  /** Per-session hard project-root guardrail override. `true`/`false`
   *  overrides the global `[guardrails] hard_enforce_project_root` default;
   *  absent → follow the global default. Rides each chat message to the
   *  agent's source guard. Persisted with the tab. */
  hardEnforceProjectRoot?: boolean;
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

/**
 * Sentinel id for the permanent "overview" pseudo-tab pinned to the left
 * of the tab strip. It is *not* stored in `/tabs` — setting `activeTabId`
 * to this value (or any value that doesn't match a real tab) means
 * "no active session; show the host / project / worktree overview." Tab
 * ids elsewhere are UUIDs, so a literal can't collide.
 */
export const OVERVIEW_TAB_ID = "__overview__";

export function projectBucketKey(id: string | null | undefined): string {
  return id ?? NO_PROJECT_KEY;
}

/** True when `activeTabId` is unset / the overview sentinel — i.e. no
 *  real tab is selected and the overview should own the canvas. */
export function isOverviewActive(activeTabId: string | undefined): boolean {
  return !activeTabId || activeTabId === OVERVIEW_TAB_ID;
}

type TabIdentity = { id: string; kind?: TabKind };

export function activeTabForId<T extends TabIdentity>(
  tabs: readonly T[],
  activeTabId: string | null | undefined,
): T | undefined {
  if (!activeTabId || activeTabId === OVERVIEW_TAB_ID) return undefined;
  return tabs.find((t) => t.id === activeTabId);
}

export function activeTabKind(
  tabs: readonly TabIdentity[],
  activeTabId: string | null | undefined,
): TabKind | null {
  const active = activeTabForId(tabs, activeTabId);
  if (!active) return null;
  return active.kind ?? "agent";
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
    draftAttachments: [],
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
  // Overview sentinel, unset id, or an id that no longer matches any tab
  // all collapse to the same "no active session" state — the overview
  // owns the canvas, not a phantom agent canvas. (Pre-sentinel code path
  // defaulted a missing tab to `agent`, which masked a stale persisted id
  // as a live session.)
  const kind = activeTabKind(tabs, activeTabId);
  if (!kind) {
    return {
      agentTabActive: false,
      shellTabActive: false,
      editorTabActive: false,
    };
  }
  return {
    agentTabActive: kind === "agent",
    shellTabActive: kind === "shell",
    editorTabActive: kind === "editor",
  };
}
