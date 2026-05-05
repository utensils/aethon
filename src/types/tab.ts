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

export type TabKind = "agent" | "shell";

export interface Tab {
  id: string;
  /** "agent" (chat session) or "shell" (interactive PTY). Default "agent"
   *  for back-compat with persisted tab records that pre-date the field. */
  kind: TabKind;
  label: string;
  messages: ChatMessage[];
  draft: string;
  waiting: boolean;
  queueCount: number;
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
  /** Present iff kind === "shell". */
  shell?: ShellMeta;
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
  /** Shell tabs only — passed back to newShellTab. */
  cwd?: string;
  command?: string;
  args?: string[];
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
    canvas: null,
    model: "",
    terminalBuffer: "",
    projectId,
  };
}

/**
 * Derive `/agentTabActive` and `/shellTabActive` from the current tab
 * list and active id. Both gates require at least one tab; when no
 * tab is active the empty-state composite owns the canvas area.
 *
 * Lives here (rather than as a useEffect mirror) so layout `visible:
 * { $ref: "/agentTabActive" }` bindings can never lag behind a
 * tabs/activeTabId mutation — the gates recompute synchronously
 * inside App.tsx's renderState memo.
 */
export function deriveTabActiveFlags(
  tabs: Tab[],
  activeTabId: string | undefined,
): { agentTabActive: boolean; shellTabActive: boolean } {
  if (tabs.length === 0) {
    return { agentTabActive: false, shellTabActive: false };
  }
  const activeTab = activeTabId
    ? tabs.find((t) => t.id === activeTabId)
    : undefined;
  const isShell = activeTab?.kind === "shell";
  return {
    agentTabActive: !isShell,
    shellTabActive: isShell,
  };
}
