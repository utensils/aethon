import type { Tab } from "../types/tab";

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
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
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
  if (typeof input.columns === "string") {
    const first = input.columns.trim().split(/\s+/)[0];
    if (/^\d+px$/.test(first)) {
      next.columns = `${first} minmax(0,1fr)`;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function loadSessionUiSnapshot(): SessionUiSnapshot | null {
  if (!canUseSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
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

export function saveSessionUiSnapshot(state: Record<string, unknown>): void {
  if (!canUseSessionStorage()) return;
  try {
    const tabs = Array.isArray(state.tabs)
      ? (state.tabs as Tab[]).filter(shouldPersistTab).map(trimTab)
      : [];
    if (tabs.length === 0) {
      window.sessionStorage.removeItem(KEY);
      return;
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
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* best-effort; quota or privacy settings should not break the app */
  }
}
