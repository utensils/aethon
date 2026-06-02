import { OVERVIEW_TAB_ID, type QueuedMessage, type Tab } from "../types/tab";
import type { ChatMessage } from "../types/a2ui";
import { durableImageAttachments } from "../utils/imageAttachments";
import { dedupeToolResultTextMessages } from "../utils/messages";

export const SESSION_UI_SNAPSHOT_FILE = "session_ui_snapshot";

const KEY = "aethon:session-ui-snapshot:v1";
const MAX_MESSAGES_PER_TAB = 200;
const MAX_TERMINAL_BUFFER = 256 * 1024;
const MAX_TERMINAL_BUFFER_ENTRIES = 8;

/** A stashed (non-active) workspace's tabs + its last-active tab, keyed in
 *  `SessionUiSnapshot.buckets` by `projectScopeBucketKey`. */
export interface PersistedTabBucket {
  tabs: Tab[];
  activeTabId?: string;
}

export interface SessionUiSnapshot {
  activeTabId?: string;
  tabs: Tab[];
  layout?: unknown;
  terminal?: unknown;
  terminalPanel?: unknown;
  scrollToMatchByTab?: unknown;
  projectModels?: Record<string, string>;
  /** Non-active workspace tab buckets, keyed by `projectScopeBucketKey`.
   *  The ACTIVE workspace's tabs live in `tabs`; every other workspace the
   *  user had open is stashed here so a restart can restore the tab they
   *  last had open in EACH workspace, not just the global `activeTabId`.
   *  Seeded back into `tabBucketsRef` on boot. */
  buckets?: Record<string, PersistedTabBucket>;
  savedAt: number;
}

export interface ParseSessionUiSnapshotOptions {
  /** Hot webview reloads can reattach/reopen PTYs. Durable disk restore
   *  after an app restart must not silently run saved shell commands. */
  restartShellTabs?: boolean;
  /** A webview reload keeps the Rust/Bun agent workers alive. Preserve
   *  local busy/queue state so the user can still press Stop after the
   *  React tree remounts. Durable disk restore leaves this false because
   *  there is no attached prompt runner after a full app restart. */
  preserveAgentActivity?: boolean;
}

function canUseSessionStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.sessionStorage?.getItem === "function" &&
    typeof window.sessionStorage?.setItem === "function" &&
    typeof window.sessionStorage?.removeItem === "function"
  );
}

function trimTab(tab: Tab): Tab {
  const messages = dedupeToolResultTextMessages(tab.messages)
    .slice(-MAX_MESSAGES_PER_TAB)
    .map((message): ChatMessage => {
      if (!message.attachments || message.attachments.length === 0) {
        return message;
      }
      return {
        ...message,
        attachments: durableImageAttachments(message.attachments),
      };
    });
  return {
    ...tab,
    messages,
    draftAttachments: durableImageAttachments(tab.draftAttachments),
    terminalBuffer: tab.terminalBuffer.slice(-MAX_TERMINAL_BUFFER),
  };
}

function durableQueuedMessages(
  queuedMessages: QueuedMessage[] | undefined,
): QueuedMessage[] {
  return (queuedMessages ?? []).map((message) => ({
    ...message,
    attachments: durableImageAttachments(message.attachments),
  }));
}

function shouldPersistTab(tab: Tab): boolean {
  if (tab.kind === "shell") return tab.shell != null;
  // Editor tabs persist so the user reopens to the same files. The
  // on-disk content is the source of truth on restore — dirty buffers
  // are intentionally not serialised (saving arbitrary in-memory edits
  // could surprise the user on next launch).
  if (tab.kind === "editor") return tab.editor?.filePath != null;
  return (
    tab.messages.length > 0 ||
    tab.draft.trim().length > 0 ||
    tab.waiting ||
    tab.queueCount > 0 ||
    tab.canvas !== null ||
    tab.terminalBuffer.length > 0
  );
}

function restoreShellTab(tab: Tab, restartShellTabs: boolean): Tab {
  if (tab.shell?.shellState === "exited") return tab;
  if (!restartShellTabs) {
    const shell = tab.shell ? { ...tab.shell } : undefined;
    if (shell) delete shell.restartOnMount;
    return {
      ...tab,
      shell: shell
        ? {
            ...shell,
            shellState: "exited",
            exitCode: shell.exitCode ?? -1,
          }
        : shell,
    };
  }
  return {
    ...tab,
    shell: tab.shell
      ? {
          ...tab.shell,
          shellState: "starting",
          restartOnMount: true,
        }
      : tab.shell,
  };
}

function tabCanOwnMainSurface(tab: Tab | undefined): boolean {
  return !!tab && tab.kind !== "shell";
}

function durableLayoutSnapshot(
  layout: unknown,
): Record<string, unknown> | undefined {
  if (!layout || typeof layout !== "object") return undefined;
  const input = layout as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  if (typeof input.sidebarVisible === "boolean") {
    next.sidebarVisible = input.sidebarVisible;
  }
  if (typeof input.filesSidebarVisible === "boolean") {
    next.filesSidebarVisible = input.filesSidebarVisible;
  }
  if (typeof input.columns === "string") {
    // Preserve fixed left + right column widths; reset the center to
    // minmax(0,1fr) so the user's resize sticks across reloads. Hidden
    // sidebars stay as 0px sentinel tracks so the grid can animate
    // toggles instead of changing track count.
    const filesHidden = input.filesSidebarVisible === false;
    const tokens = input.columns.trim().split(/\s+/);
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (tokens.length >= 2 && /^\d+px$/.test(first)) {
      if (/^\d+px$/.test(last) && tokens.length >= 3) {
        next.columns = `${first} minmax(0,1fr) ${last}`;
      } else if (filesHidden) {
        next.columns = `${first} minmax(0,1fr) 0px`;
      } else {
        // Legacy snapshot — let the boot payload's default fill in
        // the right column so the redesigned 3-column layout still
        // surfaces on first restore after upgrade.
        next.columns = `${first} minmax(0,1fr) 360px`;
      }
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function durableTerminalSnapshot(
  terminal: unknown,
): Record<string, unknown> | undefined {
  if (!terminal || typeof terminal !== "object") return undefined;
  const input = terminal as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  if (typeof input.open === "boolean") {
    next.open = input.open;
  }
  const buffer = input.buffer;
  if (buffer && typeof buffer === "object" && !Array.isArray(buffer)) {
    const entries = Object.entries(buffer as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      )
      .slice(-MAX_TERMINAL_BUFFER_ENTRIES)
      .map(([id, value]) => [id, value.slice(-MAX_TERMINAL_BUFFER)]);
    if (entries.length > 0) {
      next.buffer = Object.fromEntries(entries);
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Trim the live `state.persistedTabBuckets` mirror for serialization:
 *  filter + trim each bucket's tabs like the active list, drop empties. */
function serializePersistedBuckets(
  value: unknown,
): Record<string, PersistedTabBucket> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, PersistedTabBucket> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const bucket = raw as { tabs?: unknown; activeTabId?: unknown };
    const tabs = (Array.isArray(bucket.tabs) ? (bucket.tabs as Tab[]) : [])
      .filter(shouldPersistTab)
      .map(trimTab);
    if (tabs.length === 0) continue;
    out[key] = {
      tabs,
      ...(typeof bucket.activeTabId === "string"
        ? { activeTabId: bucket.activeTabId }
        : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Minimal structural validation for a persisted tab record. */
function validTabsFrom(value: unknown): Tab[] {
  return Array.isArray(value)
    ? value.filter((t): t is Tab => {
        const candidate = t as Partial<Tab>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.label === "string" &&
          Array.isArray(candidate.messages)
        );
      })
    : [];
}

/** Normalise a persisted tab back into a live Tab: dedupe + durable-ify
 *  attachments, reset process-local fields (waiting / queue), preserve
 *  editor metadata, and re-arm or quiesce shell tabs. Shared by the main
 *  tab list and the stashed per-workspace buckets so both restore the same
 *  way. */
function restoreTabRecord(
  t: Tab,
  restartShellTabs: boolean,
  preserveAgentActivity: boolean,
): Tab {
  const kind = t.kind ?? "agent";
  const preserveActivity = preserveAgentActivity && kind === "agent";
  const queuedMessages =
    preserveActivity && Array.isArray(t.queuedMessages)
      ? durableQueuedMessages(t.queuedMessages)
      : [];
  const base = {
    ...t,
    kind,
    messages: dedupeToolResultTextMessages(t.messages).map(
      (message): ChatMessage =>
        message.attachments && message.attachments.length > 0
          ? {
              ...message,
              attachments: durableImageAttachments(message.attachments),
            }
          : message,
    ),
    draft: t.draft ?? "",
    draftAttachments: Array.isArray(t.draftAttachments)
      ? durableImageAttachments(t.draftAttachments)
      : [],
    // Waiting is process-local state. Preserve it only for same-process
    // webview reloads; after an app restart there is no still-attached
    // prompt runner behind this tab, so restoring it as busy leaves the UI
    // stuck in "thinking..." with a dead stop button.
    waiting: preserveActivity ? t.waiting === true : false,
    // Client-held queue is restored only for hot reload. Durable app-start
    // restore treats queued messages as abandoned and zeroes the derived
    // count in lockstep.
    queueCount: preserveActivity ? queuedMessages.length : 0,
    queuedMessages,
    canvas: t.canvas ?? null,
    model: t.model ?? "",
    terminalBuffer: t.terminalBuffer ?? "",
    projectId: t.projectId ?? null,
    // Preserve editor metadata so a persisted editor tab reopens pointing at
    // the same file. Validate minimally — `filePath` is what EditorCanvas
    // requires; the rest fall back to safe defaults on the next render.
    ...(t.kind === "editor" &&
    t.editor &&
    typeof t.editor.filePath === "string"
      ? {
          editor: {
            filePath: t.editor.filePath,
            ...(typeof t.editor.rootPath === "string" && t.editor.rootPath
              ? { rootPath: t.editor.rootPath }
              : {}),
            language:
              typeof t.editor.language === "string"
                ? t.editor.language
                : "plaintext",
            isDirty: false,
            ...(typeof t.editor.cursorLine === "number"
              ? { cursorLine: t.editor.cursorLine }
              : {}),
            ...(typeof t.editor.cursorColumn === "number"
              ? { cursorColumn: t.editor.cursorColumn }
              : {}),
          },
        }
      : {}),
  };
  return base.kind === "shell"
    ? restoreShellTab(base, restartShellTabs)
    : base;
}

/** Validate + restore the non-active workspace buckets. Each bucket's tabs
 *  go through `restoreTabRecord`; an empty bucket is dropped. */
function parsePersistedBuckets(
  value: unknown,
  restartShellTabs: boolean,
  preserveAgentActivity: boolean,
): Record<string, PersistedTabBucket> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, PersistedTabBucket> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const bucket = raw as { tabs?: unknown; activeTabId?: unknown };
    const tabs = validTabsFrom(bucket.tabs).map((t) =>
      restoreTabRecord(t, restartShellTabs, preserveAgentActivity),
    );
    if (tabs.length === 0) continue;
    const activeTabId =
      typeof bucket.activeTabId === "string" &&
      tabs.some((t) => t.id === bucket.activeTabId)
        ? bucket.activeTabId
        : tabs[0]?.id;
    out[key] = { tabs, ...(activeTabId ? { activeTabId } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function loadSessionUiSnapshot(): SessionUiSnapshot | null {
  if (canUseSessionStorage()) {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw)
      return parseSessionUiSnapshot(raw, {
        restartShellTabs: true,
        preserveAgentActivity: true,
      });
  }
  return null;
}

export function parseSessionUiSnapshot(
  raw: string,
  options: ParseSessionUiSnapshotOptions = {},
): SessionUiSnapshot | null {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionUiSnapshot>;
    const tabs = validTabsFrom(parsed.tabs);
    const restartShellTabs = options.restartShellTabs === true;
    const preserveAgentActivity = options.preserveAgentActivity === true;
    const buckets = parsePersistedBuckets(
      parsed.buckets,
      restartShellTabs,
      preserveAgentActivity,
    );
    // Nothing to restore if neither the active workspace nor any backgrounded
    // workspace had sessions.
    if (tabs.length === 0 && !buckets) return null;
    // OVERVIEW_TAB_ID is a valid persisted value (the user closed the
    // app while the overview pseudo-tab owned the canvas with sessions
    // open) — keep it as-is. Other ids must still match a real tab. With no
    // active tabs (buckets-only restore), the overview owns the canvas.
    const parsedActiveTab = tabs.find((t) => t.id === parsed.activeTabId);
    const activeTabId =
      tabs.length === 0
        ? OVERVIEW_TAB_ID
        : typeof parsed.activeTabId === "string" &&
            (parsed.activeTabId === OVERVIEW_TAB_ID ||
              tabCanOwnMainSurface(parsedActiveTab))
          ? parsed.activeTabId
          : (tabs.find(tabCanOwnMainSurface)?.id ?? OVERVIEW_TAB_ID);
    return {
      tabs: tabs.map((t) =>
        restoreTabRecord(t, restartShellTabs, preserveAgentActivity),
      ),
      activeTabId,
      layout: durableLayoutSnapshot(parsed.layout),
      terminal: durableTerminalSnapshot(parsed.terminal),
      terminalPanel: parsed.terminalPanel,
      scrollToMatchByTab: parsed.scrollToMatchByTab,
      projectModels:
        parsed.projectModels &&
        typeof parsed.projectModels === "object" &&
        !Array.isArray(parsed.projectModels)
          ? Object.fromEntries(
              Object.entries(parsed.projectModels).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string",
              ),
            )
          : undefined,
      buckets,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function serializeSessionUiSnapshot(
  state: Record<string, unknown>,
): string | null {
  try {
    const tabs = Array.isArray(state.tabs)
      ? (state.tabs as Tab[]).filter(shouldPersistTab).map(trimTab)
      : [];
    const buckets = serializePersistedBuckets(state.persistedTabBuckets);
    // Persist when the active workspace OR any backgrounded workspace has
    // sessions worth keeping. A user sitting on a project's overview while
    // agents run in its worktrees still has state to restore.
    if (tabs.length === 0 && !buckets) {
      return null;
    }
    const activeTab = tabs.find((t) => t.id === state.activeTabId);
    const activeTabId =
      typeof state.activeTabId === "string" &&
      (state.activeTabId === OVERVIEW_TAB_ID || tabCanOwnMainSurface(activeTab))
        ? state.activeTabId
        : (tabs.find(tabCanOwnMainSurface)?.id ?? OVERVIEW_TAB_ID);
    const snapshot: SessionUiSnapshot = {
      tabs,
      activeTabId,
      layout: durableLayoutSnapshot(state.layout),
      terminal: durableTerminalSnapshot(state.terminal),
      terminalPanel: state.terminalPanel,
      scrollToMatchByTab: state.scrollToMatchByTab,
      projectModels:
        state.projectModels &&
        typeof state.projectModels === "object" &&
        !Array.isArray(state.projectModels)
          ? (state.projectModels as Record<string, string>)
          : undefined,
      // Non-active workspace buckets mirrored into state by
      // switchProjectBucket (and seeded at boot). Already trimmed above; the
      // active workspace is excluded by the mirror.
      buckets,
      savedAt: Date.now(),
    };
    return JSON.stringify(snapshot);
  } catch {
    return null;
  }
}

export function saveSessionUiSnapshot(
  state: Record<string, unknown>,
  persistDisk?: (content: string) => void,
): void {
  const serialized = serializeSessionUiSnapshot(state);
  try {
    if (serialized === null) {
      if (canUseSessionStorage()) window.sessionStorage.removeItem(KEY);
      persistDisk?.("");
      return;
    }
    if (canUseSessionStorage()) window.sessionStorage.setItem(KEY, serialized);
    persistDisk?.(serialized);
  } catch {
    /* best-effort; quota or privacy settings should not break the app */
  }
}
