import {
  readStateWithLocalStorageFallback,
  writeState as writePersistedState,
} from "./persist";
import { WORKSTATION_AREAS } from "./hooks/useFocus";

export const LAYOUT_PREFS_FILE = "layout_prefs";

const KEY = "aethon:layout-prefs:v1";
// Keep in sync with the default sidebar column in
// `extensions/default-layout/workstation.a2ui.json` and useFocus.ts so a
// layout reset lands on the same width as a fresh boot.
const DEFAULT_LEFT_WIDTH = "320px";
const DEFAULT_RIGHT_WIDTH = "360px";
const DEFAULT_TERMINAL_HEIGHT = 240;
const TERMINAL_HEIGHT_MIN = 120;
const TERMINAL_HEIGHT_MAX = 720;
export interface LayoutPrefs {
  layout?: Record<string, unknown>;
  terminalPanel?: Record<string, unknown>;
}

type StateWriter = (name: string, content: string) => Promise<boolean>;

function canUseLocalStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.localStorage?.getItem === "function" &&
    typeof window.localStorage?.setItem === "function" &&
    typeof window.localStorage?.removeItem === "function"
  );
}

function isPx(value: unknown): value is string {
  return typeof value === "string" && /^\d+px$/.test(value);
}

function sanitizeColumns(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < 2 || !isPx(tokens[0])) return undefined;
  const right =
    tokens.length >= 3 && isPx(tokens[tokens.length - 1])
      ? tokens[tokens.length - 1]
      : undefined;
  return right
    ? `${tokens[0]} minmax(0,1fr) ${right}`
    : `${tokens[0]} minmax(0,1fr)`;
}

function clampTerminalHeight(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= TERMINAL_HEIGHT_MIN &&
    value <= TERMINAL_HEIGHT_MAX
    ? Math.round(value)
    : DEFAULT_TERMINAL_HEIGHT;
}

function rowsForTerminal(open: unknown, height: unknown): string {
  const track = open === true ? `${clampTerminalHeight(height)}px` : "0px";
  return `38px 38px minmax(0,1fr) ${track} auto auto`;
}

export function sanitizeLayoutPrefs(input: unknown): LayoutPrefs | null {
  if (!input || typeof input !== "object") return null;
  const src = input as { layout?: unknown; terminalPanel?: unknown };
  const prefs: LayoutPrefs = {};

  if (src.layout && typeof src.layout === "object") {
    const layoutInput = src.layout as Record<string, unknown>;
    const layout: Record<string, unknown> = {};
    if (typeof layoutInput.sidebarVisible === "boolean") {
      layout.sidebarVisible = layoutInput.sidebarVisible;
    }
    if (typeof layoutInput.filesSidebarVisible === "boolean") {
      layout.filesSidebarVisible = layoutInput.filesSidebarVisible;
    }
    const columns = sanitizeColumns(layoutInput.columns);
    if (columns) layout.columns = columns;
    if (isPx(layoutInput.lastLeftWidth)) {
      layout.lastLeftWidth = layoutInput.lastLeftWidth;
    }
    if (isPx(layoutInput.lastRightWidth)) {
      layout.lastRightWidth = layoutInput.lastRightWidth;
    }
    if (Object.keys(layout).length > 0) prefs.layout = layout;
  }

  if (src.terminalPanel && typeof src.terminalPanel === "object") {
    const panelInput = src.terminalPanel as Record<string, unknown>;
    const panel: Record<string, unknown> = {};
    if (
      typeof panelInput.height === "number" &&
      panelInput.height >= TERMINAL_HEIGHT_MIN &&
      panelInput.height <= TERMINAL_HEIGHT_MAX
    ) {
      panel.height = panelInput.height;
    }
    if (Object.keys(panel).length > 0) prefs.terminalPanel = panel;
  }

  return Object.keys(prefs).length > 0 ? prefs : null;
}

export function layoutPrefsFromState(
  state: Record<string, unknown>,
): LayoutPrefs | null {
  return sanitizeLayoutPrefs({
    layout: state.layout,
    terminalPanel: state.terminalPanel,
  });
}

export function loadLayoutPrefsSync(): LayoutPrefs | null {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    return sanitizeLayoutPrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function loadLayoutPrefsFromDisk(): Promise<LayoutPrefs | null> {
  const raw = await readStateWithLocalStorageFallback(LAYOUT_PREFS_FILE, KEY);
  try {
    return raw ? sanitizeLayoutPrefs(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function mergeLayoutPrefsIntoState(
  state: Record<string, unknown>,
  prefs: LayoutPrefs | null,
): Record<string, unknown> {
  if (!prefs) return state;
  const layout = (state.layout as Record<string, unknown> | undefined) ?? {};
  const terminalPanel =
    (state.terminalPanel as Record<string, unknown> | undefined) ?? {};
  const mergedTerminalPanel = prefs.terminalPanel
    ? { ...terminalPanel, ...prefs.terminalPanel }
    : terminalPanel;
  const mergedLayout = prefs.layout ? { ...layout, ...prefs.layout } : layout;
  const terminal = state.terminal as { open?: unknown } | undefined;
  return {
    ...state,
    layout: {
      ...mergedLayout,
      rows: rowsForTerminal(terminal?.open, mergedTerminalPanel.height),
      areas: WORKSTATION_AREAS,
    },
    ...(prefs.terminalPanel ? { terminalPanel: mergedTerminalPanel } : {}),
  };
}

export function resetLayoutPrefsInState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const layout = (state.layout as Record<string, unknown> | undefined) ?? {};
  const terminalPanel =
    (state.terminalPanel as Record<string, unknown> | undefined) ?? {};
  const { height: _height, ...terminalRest } = terminalPanel;
  const terminal = state.terminal as { open?: unknown } | undefined;
  return {
    ...state,
    layout: {
      ...layout,
      sidebarVisible: true,
      filesSidebarVisible: true,
      columns: `${DEFAULT_LEFT_WIDTH} minmax(0,1fr) ${DEFAULT_RIGHT_WIDTH}`,
      rows: rowsForTerminal(terminal?.open, DEFAULT_TERMINAL_HEIGHT),
      lastLeftWidth: DEFAULT_LEFT_WIDTH,
      lastRightWidth: DEFAULT_RIGHT_WIDTH,
      areas: WORKSTATION_AREAS,
    },
    terminalPanel: terminalRest,
  };
}

export async function saveLayoutPrefs(
  state: Record<string, unknown>,
  writer: StateWriter = writePersistedState,
): Promise<void> {
  const prefs = layoutPrefsFromState(state);
  const content = prefs ? JSON.stringify(prefs) : "";
  try {
    if (canUseLocalStorage()) {
      if (content) window.localStorage.setItem(KEY, content);
      else window.localStorage.removeItem(KEY);
    }
  } catch {
    /* best-effort */
  }
  await writer(LAYOUT_PREFS_FILE, content);
}

export async function clearLayoutPrefs(
  writer: StateWriter = writePersistedState,
): Promise<void> {
  try {
    if (canUseLocalStorage()) window.localStorage.removeItem(KEY);
  } catch {
    /* best-effort */
  }
  await writer(LAYOUT_PREFS_FILE, "");
}
