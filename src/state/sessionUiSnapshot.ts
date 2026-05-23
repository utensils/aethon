import type { Tab } from "../types/tab";

export const SESSION_UI_SNAPSHOT_FILE = "session_ui_snapshot";

const KEY = "aethon:session-ui-snapshot:v1";
const MAX_MESSAGES_PER_TAB = 200;
const MAX_TERMINAL_BUFFER = 256 * 1024;

export interface SessionUiSnapshot {
  activeTabId?: string;
  tabs: Tab[];
  layout?: unknown;
  terminal?: unknown;
  terminalPanel?: unknown;
  scrollToMatchByTab?: unknown;
  projectModels?: Record<string, string>;
  savedAt: number;
}

function canUseSessionStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.sessionStorage?.getItem === "function" &&
    typeof window.sessionStorage?.setItem === "function" &&
    typeof window.sessionStorage?.removeItem === "function"
  );
}

function canUseLocalStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.localStorage?.getItem === "function" &&
    typeof window.localStorage?.setItem === "function" &&
    typeof window.localStorage?.removeItem === "function"
  );
}

function trimTab(tab: Tab): Tab {
  return {
    ...tab,
    messages: tab.messages.slice(-MAX_MESSAGES_PER_TAB),
    terminalBuffer: tab.terminalBuffer.slice(-MAX_TERMINAL_BUFFER),
  };
}

function shouldPersistTab(tab: Tab): boolean {
  if (tab.kind === "shell") return false;
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

function durableLayoutSnapshot(layout: unknown): Record<string, unknown> | undefined {
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
    // minmax(0,1fr) so the user's resize sticks across reloads. Three
    // shapes are supported:
    //   "<L>px minmax(0,1fr)"            (files sidebar hidden)
    //   "<L>px minmax(0,1fr) <R>px"      (canonical: left + files-right)
    //   (legacy: any old 2-col shape)    → upgrade to 3-col 280px
    //
    // Critically: when filesSidebarVisible is explicitly false, the live
    // grid is 2-col, and we must keep it 2-col on restore — otherwise
    // the right pane stays hidden but its 280px slot renders as blank
    // space until the user toggles the panel back.
    const filesHidden = input.filesSidebarVisible === false;
    const tokens = input.columns.trim().split(/\s+/);
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (tokens.length >= 2 && /^\d+px$/.test(first)) {
      if (filesHidden) {
        next.columns = `${first} minmax(0,1fr)`;
      } else if (/^\d+px$/.test(last) && tokens.length >= 3) {
        next.columns = `${first} minmax(0,1fr) ${last}`;
      } else {
        // Legacy snapshot — let the boot payload's default fill in
        // the right column so the redesigned 3-column layout still
        // surfaces on first restore after upgrade.
        next.columns = `${first} minmax(0,1fr) 280px`;
      }
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function loadSessionUiSnapshot(): SessionUiSnapshot | null {
  const candidates: string[] = [];
  if (canUseSessionStorage()) {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) candidates.push(raw);
  }
  if (canUseLocalStorage()) {
    const raw = window.localStorage.getItem(KEY);
    if (raw) candidates.push(raw);
  }
  for (const raw of candidates) {
    const parsed = parseSessionUiSnapshot(raw);
    if (parsed) return parsed;
  }
  return null;
}

export function parseSessionUiSnapshot(raw: string): SessionUiSnapshot | null {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionUiSnapshot>;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter((t): t is Tab => {
          const candidate = t as Partial<Tab>;
          return (
            typeof candidate.id === "string" &&
            typeof candidate.label === "string" &&
            Array.isArray(candidate.messages)
          );
        })
      : [];
    if (tabs.length === 0) return null;
    const activeTabId =
      typeof parsed.activeTabId === "string" &&
      tabs.some((t) => t.id === parsed.activeTabId)
        ? parsed.activeTabId
        : tabs[0].id;
    return {
      tabs: tabs.map((t) => ({
        ...t,
        kind: t.kind ?? "agent",
        draft: t.draft ?? "",
        waiting: Boolean(t.waiting),
        queueCount: typeof t.queueCount === "number" ? t.queueCount : 0,
        canvas: t.canvas ?? null,
        model: t.model ?? "",
        terminalBuffer: t.terminalBuffer ?? "",
        projectId: t.projectId ?? null,
        // Preserve editor metadata so a persisted editor tab reopens
        // pointing at the same file. Validate the shape minimally —
        // `filePath` is the field EditorCanvas actually requires; the
        // rest fall back to safe defaults on the next render.
        ...(t.kind === "editor" && t.editor && typeof t.editor.filePath === "string"
          ? {
              editor: {
                filePath: t.editor.filePath,
                language: typeof t.editor.language === "string"
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
      })),
      activeTabId,
      layout: durableLayoutSnapshot(parsed.layout),
      terminal: parsed.terminal,
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
    if (tabs.length === 0) {
      return null;
    }
    const activeTabId =
      typeof state.activeTabId === "string" &&
      tabs.some((t) => t.id === state.activeTabId)
        ? state.activeTabId
        : tabs[0]?.id;
    const snapshot: SessionUiSnapshot = {
      tabs,
      activeTabId,
      layout: durableLayoutSnapshot(state.layout),
      terminal: state.terminal,
      terminalPanel: state.terminalPanel,
      scrollToMatchByTab: state.scrollToMatchByTab,
      projectModels:
        state.projectModels &&
        typeof state.projectModels === "object" &&
        !Array.isArray(state.projectModels)
          ? (state.projectModels as Record<string, string>)
          : undefined,
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
      if (canUseLocalStorage()) window.localStorage.removeItem(KEY);
      persistDisk?.("");
      return;
    }
    if (canUseSessionStorage()) window.sessionStorage.setItem(KEY, serialized);
    if (canUseLocalStorage()) window.localStorage.setItem(KEY, serialized);
    persistDisk?.(serialized);
  } catch {
    /* best-effort; quota or privacy settings should not break the app */
  }
}
