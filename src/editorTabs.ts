// Persistence for open editor tabs across app restarts. Editor tabs are
// pure frontend state (unlike agent tabs, which restore from pi sessions),
// so without this they vanish on relaunch. Stored at
// `~/.aethon/editor-tabs.json`, keyed by project id so switching projects
// doesn't clobber another project's remembered tabs.
//
// On boot the caller restores the active project's list, dropping any file
// that no longer exists on disk (checked via `fs_exists`) — see
// `useProjectOps`.

import { readState, writeState } from "./persist";
import type { EditorDiffSnapshot, Tab } from "./types/tab";
import {
  diffSnapshotKey,
  isEditorDiffSnapshot,
} from "./utils/editorDiffSnapshot";

const FILE = "editor-tabs.json";
/** Bucket key for tabs opened with no active project. */
export const NO_PROJECT_TABS_KEY = "__noproject__";

export interface PersistedEditorTab {
  filePath: string;
  rootPath?: string;
  language: string;
  diff?: boolean;
  diffSnapshot?: EditorDiffSnapshot;
  cursorLine?: number;
  cursorColumn?: number;
}

export interface PersistedProjectTabs {
  tabs: PersistedEditorTab[];
  /** filePath of the editor tab that was active, restored as active when
   *  it still exists. */
  activeFilePath?: string;
}

interface EditorTabsStore {
  version: 1;
  byProject: Record<string, PersistedProjectTabs>;
}

function emptyStore(): EditorTabsStore {
  return { version: 1, byProject: {} };
}

/** Map a runtime Tab to its persisted shape, or null if it isn't an
 *  editor tab with a real path. */
export function toPersistedEditorTab(tab: Tab): PersistedEditorTab | null {
  if (tab.kind !== "editor" || !tab.editor?.filePath) return null;
  const e = tab.editor;
  return {
    filePath: e.filePath,
    ...(e.rootPath ? { rootPath: e.rootPath } : {}),
    language: e.language,
    ...(e.diff ? { diff: true } : {}),
    ...(e.diffSnapshot ? { diffSnapshot: e.diffSnapshot } : {}),
    ...(typeof e.cursorLine === "number" ? { cursorLine: e.cursorLine } : {}),
    ...(typeof e.cursorColumn === "number"
      ? { cursorColumn: e.cursorColumn }
      : {}),
  };
}

/** Collect the editor tabs from a tab list (deduped by path+diff) plus the
 *  active editor tab's filePath. Pure — unit tested directly. */
export function editorTabsFromTabs(
  tabs: Tab[],
  activeTabId: string | undefined,
): PersistedProjectTabs {
  const out: PersistedEditorTab[] = [];
  const seen = new Set<string>();
  let activeFilePath: string | undefined;
  for (const t of tabs) {
    const p = toPersistedEditorTab(t);
    if (!p) continue;
    const key = [
      p.filePath,
      p.diff ? "d" : "e",
      diffSnapshotKey(p.diffSnapshot),
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (t.id === activeTabId && !p.diff) activeFilePath = p.filePath;
  }
  return activeFilePath ? { tabs: out, activeFilePath } : { tabs: out };
}

function isPersistedTab(v: unknown): v is PersistedEditorTab {
  if (!v || typeof v !== "object") return false;
  const tab = v as PersistedEditorTab;
  return (
    typeof tab.filePath === "string" &&
    typeof tab.language === "string" &&
    (tab.diffSnapshot === undefined ||
      isEditorDiffSnapshot(tab.diffSnapshot))
  );
}

/** Parse the on-disk store, tolerating absent/corrupt input. Pure. */
export function parseEditorTabsStore(raw: string): EditorTabsStore {
  if (!raw) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  const byProjectRaw =
    parsed && typeof parsed === "object"
      ? (parsed as { byProject?: unknown }).byProject
      : undefined;
  if (!byProjectRaw || typeof byProjectRaw !== "object") return emptyStore();
  const byProject: Record<string, PersistedProjectTabs> = {};
  for (const [key, value] of Object.entries(
    byProjectRaw as Record<string, unknown>,
  )) {
    const tabsRaw = (value as { tabs?: unknown })?.tabs;
    if (!Array.isArray(tabsRaw)) continue;
    const tabs = tabsRaw.filter(isPersistedTab);
    if (tabs.length === 0) continue;
    const activeFilePath = (value as { activeFilePath?: unknown })
      .activeFilePath;
    byProject[key] = {
      tabs,
      ...(typeof activeFilePath === "string" ? { activeFilePath } : {}),
    };
  }
  return { version: 1, byProject };
}

// In-memory mirror of the store so saves preserve other projects' entries
// without a read-modify-write race. Loaded once at boot via
// `loadEditorTabsStore`.
let cache: EditorTabsStore = emptyStore();
let loaded = false;
// Projects whose tabs have been restored (hydrated) this session. Saving
// is gated on this so switching to a project before its bucket hydrates
// can't overwrite its persisted tabs with the (momentarily empty) list.
const hydrated = new Set<string>();

/** Mark a project's editor tabs as restored — enables persistence for it. */
export function markProjectHydrated(projectId: string | null | undefined): void {
  hydrated.add(projectId ?? NO_PROJECT_TABS_KEY);
}

/** Whether a project's editor tabs have been restored this session. */
export function isProjectHydrated(projectId: string | null | undefined): boolean {
  return hydrated.has(projectId ?? NO_PROJECT_TABS_KEY);
}

/** Load the store from disk into the in-memory cache. Call once at boot
 *  before any save so saves don't drop other projects' tabs. */
export async function loadEditorTabsStore(): Promise<EditorTabsStore> {
  cache = parseEditorTabsStore(await readState(FILE));
  loaded = true;
  return cache;
}

/** The persisted tabs for a project (from the in-memory cache). */
export function persistedTabsForProject(
  projectId: string | null | undefined,
): PersistedProjectTabs {
  return cache.byProject[projectId ?? NO_PROJECT_TABS_KEY] ?? { tabs: [] };
}

/** Replace one project's persisted editor tabs and flush to disk. An empty
 *  list removes the project's entry so the file stays tidy. */
export async function saveEditorTabsForProject(
  projectId: string | null | undefined,
  tabs: Tab[],
  activeTabId: string | undefined,
): Promise<void> {
  // Never write before the boot load lands — doing so would persist only
  // the active project and drop every other project's remembered tabs.
  if (!loaded) return;
  const key = projectId ?? NO_PROJECT_TABS_KEY;
  // Don't clobber a project's saved tabs before it has been hydrated — its
  // bucket is empty until `restoreEditorTabs` runs for it.
  if (!hydrated.has(key)) return;
  const collected = editorTabsFromTabs(tabs, activeTabId);
  if (collected.tabs.length === 0) {
    delete cache.byProject[key];
  } else {
    cache.byProject[key] = collected;
  }
  await writeState(FILE, JSON.stringify(cache));
}

/** Test-only reset of the in-memory cache + loaded flag. */
export const __testing = {
  reset(): void {
    cache = emptyStore();
    loaded = false;
    hydrated.clear();
  },
  markLoaded(): void {
    loaded = true;
  },
};
