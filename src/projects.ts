// Projects — directories the agent works in. Persisted at
// `~/.aethon/projects.json` and surfaced via `window.aethon.openProject`.
//
// Pi sessions are scoped to a working directory (SessionManager.continueRecent
// takes one). Aethon's bridge accepts an optional `cwd` on `tab_open`, so the
// active project's path travels with each new tab. Existing tabs keep the cwd
// they were created with — switching project doesn't retro-cwd live sessions.

import { invoke } from "@tauri-apps/api/core";
import { getLocalHostId } from "./hosts";
import { readState, writeState } from "./persist";
import {
  type Workspace,
  type WorkspaceSortMode,
  workspacesForPersist,
} from "./workspaces";

export interface Project {
  id: string;
  /** Human label shown in the sidebar. Defaults to the directory's basename. */
  label: string;
  /** Absolute path to the directory. */
  path: string;
  /** Epoch ms — bumped each time the project becomes active or a new tab opens in it. */
  lastUsed: number;
  /** Per-project disclosure state in the workspace-aware sidebar. */
  uiExpanded?: boolean;
  /** Host this project lives on. Empty / missing => local. v3+ records
   *  always carry one; v2 records inherit the local host id at migration. */
  hostId?: string;
  /** Cached discovered icon (absolute path or asset URL). Populated by
   *  src/projectIcons.ts on hover/intersection. */
  iconUrl?: string;
  /** Default base passed to `git worktree add -b <branch> <path> <base>`.
   *  Missing / blank falls back to DEFAULT_WORKSPACE_BASE_BRANCH. */
  workspaceBaseBranch?: string;
  /** Workspace ordering for this project's nested sidebar rows. */
  workspaceSortMode?: WorkspaceSortMode;
}

export interface ProjectsState {
  projects: Project[];
  activeId: string | null;
  /** Active workspace id (or null = the project's main workspace / cwd). */
  activeWorkspaceId: string | null;
  /** Workspaces keyed by projectId. Persisted alongside the projects array. */
  workspacesByProject: Record<string, Workspace[]>;
  /** Active host id. Defaults to the local host id at migration time so
   *  upgraded users land on their existing project list. */
  activeHostId: string | null;
}

const FILE = "projects.json";
/** Project icons (base64 `data:` URLs) live in a sidecar keyed by project id,
 *  NOT inline in projects.json — embedding them bloated the hot project-list
 *  file to hundreds of KB, slowing every load/save/parse on the sidebar path
 *  (#159). The sidecar is read once on load and rewritten on save. */
const ICONS_FILE = "project-icons.json";
const MAX_PROJECTS = 16;
/** v5 renames the persisted worktree-era keys to workspace terminology:
 *  `activeWorktreeId` → `activeWorkspaceId`, `worktreesByProject` →
 *  `workspacesByProject`, and per-project `worktreeBaseBranch` /
 *  `worktreeSortMode` → `workspaceBaseBranch` / `workspaceSortMode`.
 *  `migrateProjects` reads both spellings; saves write only the new ones. */
const SCHEMA_VERSION = 5;
export const DEFAULT_WORKSPACE_BASE_BRANCH = "origin/main";
/** Fallback used when host_info IPC isn't reachable (tests, plain browser).
 *  Real boots resolve a stable id via `commands::host::host_info`. */
export const FALLBACK_LOCAL_HOST_ID = "local:unknown";

function basename(path: string): string {
  // Last non-empty segment; tolerate `/` and `\` separators so the same code
  // works on Windows. Handles trailing slashes.
  const cleaned = path.replace(/[/\\]+$/, "");
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || cleaned || "project";
}

export function emptyProjectsState(localHostId?: string | null): ProjectsState {
  return {
    projects: [],
    activeId: null,
    activeWorkspaceId: null,
    workspacesByProject: {},
    activeHostId: localHostId ?? null,
  };
}

interface PersistedV1 {
  projects?: Project[];
  activeId?: string | null;
}
interface PersistedV2 {
  schemaVersion?: number;
  projects?: Project[];
  activeId?: string | null;
  activeWorkspaceId?: string | null;
  workspacesByProject?: Record<string, Workspace[]>;
  /** Pre-v5 spellings — read-only legacy keys. */
  activeWorktreeId?: string | null;
  worktreesByProject?: Record<string, Workspace[]>;
}
interface PersistedV3 extends PersistedV2 {
  activeHostId?: string | null;
}
/** Pre-v5 per-project record may carry the old field spellings. */
interface LegacyProjectFields {
  worktreeBaseBranch?: string;
  worktreeSortMode?: WorkspaceSortMode;
}

/** Read the project-icon sidecar: a `{ projectId: iconUrl }` map. Returns an
 *  empty map when absent or malformed (icons are a cosmetic cache). */
async function loadProjectIcons(): Promise<Record<string, string>> {
  const raw = await readState(ICONS_FILE);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [id, url] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof url === "string" && url.length > 0) out[id] = url;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the icon sidecar from the live project list. Only projects that
 *  actually have an icon are written, so the file stays minimal. */
async function saveProjectIcons(projects: Project[]): Promise<void> {
  const map: Record<string, string> = {};
  for (const p of projects) {
    if (p.iconUrl) map[p.id] = p.iconUrl;
  }
  await writeState(ICONS_FILE, JSON.stringify(map));
}

export async function loadProjects(localHostId?: string): Promise<ProjectsState> {
  // Resolve the local host id from the bridge BEFORE migrating so v1/v2
  // entries get stamped with the real id, not the FALLBACK placeholder
  // — otherwise saveProjects persists "local:unknown" into projects.json
  // and host-scoped views can never match the real host on next boot
  // (codex P2 review finding).
  const hostId = localHostId ?? (await getLocalHostId(FALLBACK_LOCAL_HOST_ID));
  const raw = await readState(FILE);
  if (!raw) return emptyProjectsState(hostId);
  try {
    const parsed = JSON.parse(raw) as PersistedV3 | PersistedV2 | PersistedV1;
    const state = migrateProjects(parsed, hostId);
    // Re-attach icons from the sidecar. The sidecar wins; an inline `iconUrl`
    // from a pre-externalization projects.json is kept as a fallback (it gets
    // moved into the sidecar + stripped from the main file on the next save).
    const icons = await loadProjectIcons();
    for (const p of state.projects) {
      const fromSidecar = icons[p.id];
      if (fromSidecar) p.iconUrl = fromSidecar;
    }
    return state;
  } catch {
    return emptyProjectsState(hostId);
  }
}

/** Pure migration from any prior schema version to the current shape.
 *  Idempotent — applying it twice is a no-op. `localHostId` is stamped
 *  onto v1/v2 entries that pre-date the host model. */
export function migrateProjects(
  parsed: PersistedV3 | PersistedV2 | PersistedV1,
  localHostId: string = FALLBACK_LOCAL_HOST_ID,
): ProjectsState {
  const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  // Defensive: drop entries with missing/invalid path or id rather than
  // letting them crash the picker. A malformed file is the user's
  // problem to fix; we surface what we can.
  const valid = projects
    .filter(
      (p): p is Project =>
        typeof p?.id === "string" &&
        typeof p?.path === "string" &&
        typeof p?.label === "string",
    )
    .map((p) => {
      // Read pre-v5 spellings, then drop them so they never re-persist.
      const {
        worktreeBaseBranch: legacyBase,
        worktreeSortMode: legacySort,
        ...rest
      } = p as Project & LegacyProjectFields;
      const baseBranch = rest.workspaceBaseBranch ?? legacyBase;
      const sortMode = rest.workspaceSortMode ?? legacySort;
      return {
        ...rest,
        hostId:
          typeof rest.hostId === "string" && rest.hostId.length > 0
            ? rest.hostId
            : localHostId,
        workspaceBaseBranch:
          typeof baseBranch === "string" && baseBranch.trim().length > 0
            ? baseBranch.trim()
            : undefined,
        workspaceSortMode:
          sortMode === "manual" || sortMode === "newest" ? sortMode : "newest",
      };
    });
  const activeId =
    typeof parsed.activeId === "string" &&
    valid.some((p) => p.id === parsed.activeId)
      ? parsed.activeId
      : null;
  const v2 = parsed as PersistedV2;
  // Pre-v5 files persisted these under the worktree spellings.
  const persistedWorkspaces = v2.workspacesByProject ?? v2.worktreesByProject;
  const workspacesByProject: Record<string, Workspace[]> = {};
  if (persistedWorkspaces && typeof persistedWorkspaces === "object") {
    for (const [pid, list] of Object.entries(persistedWorkspaces)) {
      if (!Array.isArray(list)) continue;
      workspacesByProject[pid] = list.filter(
        (w): w is Workspace =>
          typeof w?.id === "string" &&
          typeof w?.projectId === "string" &&
          typeof w?.path === "string",
      );
    }
  }
  // Drop a dangling activeWorkspaceId so a pruned-but-recorded workspace
  // doesn't freeze the landing on next boot. Symmetric with the
  // `activeId` check above. The row itself stays in `workspacesByProject`
  // — `removeWorkspaceById` can clean it up via the orphan path.
  const persistedActiveWorkspaceId =
    v2.activeWorkspaceId ?? v2.activeWorktreeId;
  const rawActiveWorkspaceId =
    typeof persistedActiveWorkspaceId === "string"
      ? persistedActiveWorkspaceId
      : null;
  const activeWorkspaceId =
    rawActiveWorkspaceId &&
    Object.values(workspacesByProject)
      .flat()
      .some((w) => w.id === rawActiveWorkspaceId)
      ? rawActiveWorkspaceId
      : null;
  const v3 = parsed as PersistedV3;
  const activeHostId =
    typeof v3.activeHostId === "string" && v3.activeHostId.length > 0
      ? v3.activeHostId
      : localHostId;
  return {
    projects: valid,
    activeId,
    activeWorkspaceId,
    workspacesByProject,
    activeHostId,
  };
}

export async function saveProjects(state: ProjectsState): Promise<void> {
  // Strip in-flight pending workspaces before serializing.
  const workspacesByProject: Record<string, Workspace[]> = {};
  for (const [pid, list] of Object.entries(state.workspacesByProject)) {
    workspacesByProject[pid] = workspacesForPersist(list);
  }
  // Externalize icons: keep the (potentially hundreds-of-KB base64) `iconUrl`
  // out of the hot projects.json and in the sidecar instead.
  const projectsForPersist = state.projects.map(({ iconUrl: _icon, ...rest }) =>
    rest,
  );
  const payload: PersistedV3 = {
    schemaVersion: SCHEMA_VERSION,
    projects: projectsForPersist,
    activeId: state.activeId,
    activeWorkspaceId: state.activeWorkspaceId,
    workspacesByProject,
    activeHostId: state.activeHostId,
  };
  await writeState(FILE, JSON.stringify(payload));
  await saveProjectIcons(state.projects);
}

export function setActiveWorkspace(
  state: ProjectsState,
  workspaceId: string | null,
): ProjectsState {
  return { ...state, activeWorkspaceId: workspaceId };
}

export function setProjectWorkspaces(
  state: ProjectsState,
  projectId: string,
  workspaces: Workspace[],
): ProjectsState {
  return {
    ...state,
    workspacesByProject: { ...state.workspacesByProject, [projectId]: workspaces },
  };
}

export function setProjectUiExpanded(
  state: ProjectsState,
  projectId: string,
  expanded: boolean,
): ProjectsState {
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId ? { ...p, uiExpanded: expanded } : p,
    ),
  };
}

/** Stamp a discovered icon URL onto the project record. Idempotent —
 *  no state change when the same URL is already present, so callers
 *  can fire after every discoverIcon without triggering a re-render
 *  loop. */
export function setProjectIconUrl(
  state: ProjectsState,
  projectId: string,
  iconUrl: string | null,
): ProjectsState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId) return p;
    const next = iconUrl ?? undefined;
    if (p.iconUrl === next) return p;
    changed = true;
    return { ...p, iconUrl: next };
  });
  return changed ? { ...state, projects } : state;
}

export function setProjectWorkspaceBaseBranch(
  state: ProjectsState,
  projectId: string,
  baseBranch: string | null,
): ProjectsState {
  const trimmed = (baseBranch ?? "").trim();
  const nextBase =
    trimmed.length > 0 && trimmed !== DEFAULT_WORKSPACE_BASE_BRANCH
      ? trimmed
      : undefined;
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId) return p;
    if (p.workspaceBaseBranch === nextBase) return p;
    changed = true;
    return { ...p, workspaceBaseBranch: nextBase };
  });
  return changed ? { ...state, projects } : state;
}

export function setProjectWorkspaceSortMode(
  state: ProjectsState,
  projectId: string,
  sortMode: WorkspaceSortMode,
): ProjectsState {
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId) return p;
    if (p.workspaceSortMode === sortMode) return p;
    changed = true;
    return { ...p, workspaceSortMode: sortMode };
  });
  return changed ? { ...state, projects } : state;
}

/** Add a directory as a project. If a project at the same path already
 *  exists, that entry is reused (lastUsed bumped) so the picker doesn't
 *  collect duplicates when the user re-opens a familiar directory. */
export function upsertProject(
  state: ProjectsState,
  path: string,
  label?: string,
  hostId?: string,
): { state: ProjectsState; id: string } {
  const existing = state.projects.find((p) => p.path === path);
  const now = Date.now();
  const resolvedHostId = hostId ?? state.activeHostId ?? FALLBACK_LOCAL_HOST_ID;
  if (existing) {
    const updated: Project = {
      ...existing,
      lastUsed: now,
      hostId: existing.hostId ?? resolvedHostId,
      workspaceSortMode: existing.workspaceSortMode ?? "newest",
    };
    if (label && label !== existing.label) updated.label = label;
    const projects = [updated, ...state.projects.filter((p) => p.id !== existing.id)];
    return {
      state: { ...state, projects, activeId: existing.id },
      id: existing.id,
    };
  }
  const id = crypto.randomUUID();
  const next: Project = {
    id,
    label: label ?? basename(path),
    path,
    lastUsed: now,
    hostId: resolvedHostId,
    workspaceSortMode: "newest",
  };
  const projects = [next, ...state.projects].slice(0, MAX_PROJECTS);
  return { state: { ...state, projects, activeId: id }, id };
}

/** Remove a project from Aethon's persisted project list only. This never
 *  touches the directory on disk; it just drops the metadata record. */
export function removeProject(
  state: ProjectsState,
  id: string,
): { state: ProjectsState; removed: Project | null } {
  const removed = state.projects.find((p) => p.id === id) ?? null;
  if (!removed) return { state, removed: null };
  const projects = state.projects.filter((p) => p.id !== id);
  const activeId = state.activeId === id ? null : state.activeId;
  // Drop the project's workspaces + clear active workspace if it pointed
  // at one of them.
  const { [id]: dropped, ...workspacesByProject } = state.workspacesByProject;
  const droppedIds = new Set((dropped ?? []).map((w) => w.id));
  const activeWorkspaceId =
    state.activeWorkspaceId && droppedIds.has(state.activeWorkspaceId)
      ? null
      : state.activeWorkspaceId;
  return {
    state: {
      projects,
      activeId,
      activeWorkspaceId,
      workspacesByProject,
      activeHostId: state.activeHostId,
    },
    removed,
  };
}

/** Pop a native folder picker via the Tauri shell. Returns null when the
 *  user cancels or when running outside Tauri (no dialog plugin → graceful
 *  no-op). */
export async function pickProjectDirectory(): Promise<string | null> {
  if (
    typeof window === "undefined" ||
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      "object"
  ) {
    return null;
  }
  try {
    const path = await invoke<string | null>("pick_project_directory");
    return typeof path === "string" && path.length > 0 ? path : null;
  } catch (err) {
    console.warn("pick_project_directory failed:", err);
    return null;
  }
}

/** Find the active project record, or null. */
export function activeProject(state: ProjectsState): Project | null {
  if (!state.activeId) return null;
  return state.projects.find((p) => p.id === state.activeId) ?? null;
}

/** The effective cwd a new tab should open in: the active workspace's
 *  path when one is set, falling back to the active project's path.
 *  Used by useTabs.newTab / newShellTab and the file tree so that when
 *  the user has switched to a workspace, follow-on tabs and the files
 *  panel both reflect that selection. */
export function activeCwd(state: ProjectsState): string | null {
  const project = activeProject(state);
  if (!project) return null;
  if (state.activeWorkspaceId) {
    const list = state.workspacesByProject[project.id] ?? [];
    const wt = list.find((w) => w.id === state.activeWorkspaceId);
    if (wt?.path) return wt.path;
  }
  return project.path;
}
