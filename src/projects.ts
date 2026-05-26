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
  type Worktree,
  worktreesForPersist,
} from "./worktrees";

export interface Project {
  id: string;
  /** Human label shown in the sidebar. Defaults to the directory's basename. */
  label: string;
  /** Absolute path to the directory. */
  path: string;
  /** Epoch ms — bumped each time the project becomes active or a new tab opens in it. */
  lastUsed: number;
  /** Per-project disclosure state in the worktree-aware sidebar. */
  uiExpanded?: boolean;
  /** Host this project lives on. Empty / missing => local. v3+ records
   *  always carry one; v2 records inherit the local host id at migration. */
  hostId?: string;
  /** Cached discovered icon (absolute path or asset URL). Populated by
   *  src/projectIcons.ts on hover/intersection. */
  iconUrl?: string;
  /** Default base passed to `git worktree add -b <branch> <path> <base>`.
   *  Missing / blank falls back to DEFAULT_WORKTREE_BASE_BRANCH. */
  worktreeBaseBranch?: string;
}

export interface ProjectsState {
  projects: Project[];
  activeId: string | null;
  /** Active worktree id (or null = the project's main worktree / cwd). */
  activeWorktreeId: string | null;
  /** Worktrees keyed by projectId. Persisted alongside the projects array. */
  worktreesByProject: Record<string, Worktree[]>;
  /** Active host id. Defaults to the local host id at migration time so
   *  upgraded users land on their existing project list. */
  activeHostId: string | null;
}

const FILE = "projects.json";
const MAX_PROJECTS = 16;
const SCHEMA_VERSION = 3;
export const DEFAULT_WORKTREE_BASE_BRANCH = "origin/main";
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
    activeWorktreeId: null,
    worktreesByProject: {},
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
  activeWorktreeId?: string | null;
  worktreesByProject?: Record<string, Worktree[]>;
}
interface PersistedV3 extends PersistedV2 {
  activeHostId?: string | null;
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
    return migrateProjects(parsed, hostId);
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
    .map((p) => ({
      ...p,
      hostId: typeof p.hostId === "string" && p.hostId.length > 0 ? p.hostId : localHostId,
      worktreeBaseBranch:
        typeof p.worktreeBaseBranch === "string" &&
        p.worktreeBaseBranch.trim().length > 0
          ? p.worktreeBaseBranch.trim()
          : undefined,
    }));
  const activeId =
    typeof parsed.activeId === "string" &&
    valid.some((p) => p.id === parsed.activeId)
      ? parsed.activeId
      : null;
  const v2 = parsed as PersistedV2;
  const worktreesByProject: Record<string, Worktree[]> = {};
  if (v2.worktreesByProject && typeof v2.worktreesByProject === "object") {
    for (const [pid, list] of Object.entries(v2.worktreesByProject)) {
      if (!Array.isArray(list)) continue;
      worktreesByProject[pid] = list.filter(
        (w): w is Worktree =>
          typeof w?.id === "string" &&
          typeof w?.projectId === "string" &&
          typeof w?.path === "string",
      );
    }
  }
  // Drop a dangling activeWorktreeId so a pruned-but-recorded worktree
  // doesn't freeze the landing on next boot. Symmetric with the
  // `activeId` check above. The row itself stays in `worktreesByProject`
  // — `removeWorktreeById` can clean it up via the orphan path.
  const rawActiveWorktreeId =
    typeof v2.activeWorktreeId === "string" ? v2.activeWorktreeId : null;
  const activeWorktreeId =
    rawActiveWorktreeId &&
    Object.values(worktreesByProject)
      .flat()
      .some((w) => w.id === rawActiveWorktreeId)
      ? rawActiveWorktreeId
      : null;
  const v3 = parsed as PersistedV3;
  const activeHostId =
    typeof v3.activeHostId === "string" && v3.activeHostId.length > 0
      ? v3.activeHostId
      : localHostId;
  return {
    projects: valid,
    activeId,
    activeWorktreeId,
    worktreesByProject,
    activeHostId,
  };
}

export async function saveProjects(state: ProjectsState): Promise<void> {
  // Strip in-flight pending worktrees before serializing.
  const worktreesByProject: Record<string, Worktree[]> = {};
  for (const [pid, list] of Object.entries(state.worktreesByProject)) {
    worktreesByProject[pid] = worktreesForPersist(list);
  }
  const payload: PersistedV3 = {
    schemaVersion: SCHEMA_VERSION,
    projects: state.projects,
    activeId: state.activeId,
    activeWorktreeId: state.activeWorktreeId,
    worktreesByProject,
    activeHostId: state.activeHostId,
  };
  await writeState(FILE, JSON.stringify(payload));
}

export function setActiveWorktree(
  state: ProjectsState,
  worktreeId: string | null,
): ProjectsState {
  return { ...state, activeWorktreeId: worktreeId };
}

export function setProjectWorktrees(
  state: ProjectsState,
  projectId: string,
  worktrees: Worktree[],
): ProjectsState {
  return {
    ...state,
    worktreesByProject: { ...state.worktreesByProject, [projectId]: worktrees },
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

export function setProjectWorktreeBaseBranch(
  state: ProjectsState,
  projectId: string,
  baseBranch: string | null,
): ProjectsState {
  const trimmed = (baseBranch ?? "").trim();
  const nextBase =
    trimmed.length > 0 && trimmed !== DEFAULT_WORKTREE_BASE_BRANCH
      ? trimmed
      : undefined;
  let changed = false;
  const projects = state.projects.map((p) => {
    if (p.id !== projectId) return p;
    if (p.worktreeBaseBranch === nextBase) return p;
    changed = true;
    return { ...p, worktreeBaseBranch: nextBase };
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
    const updated: Project = { ...existing, lastUsed: now, hostId: existing.hostId ?? resolvedHostId };
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
  // Drop the project's worktrees + clear active worktree if it pointed
  // at one of them.
  const { [id]: dropped, ...worktreesByProject } = state.worktreesByProject;
  const droppedIds = new Set((dropped ?? []).map((w) => w.id));
  const activeWorktreeId =
    state.activeWorktreeId && droppedIds.has(state.activeWorktreeId)
      ? null
      : state.activeWorktreeId;
  return {
    state: {
      projects,
      activeId,
      activeWorktreeId,
      worktreesByProject,
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

/** The effective cwd a new tab should open in: the active worktree's
 *  path when one is set, falling back to the active project's path.
 *  Used by useTabs.newTab / newShellTab and the file tree so that when
 *  the user has switched to a worktree, follow-on tabs and the files
 *  panel both reflect that selection. */
export function activeCwd(state: ProjectsState): string | null {
  const project = activeProject(state);
  if (!project) return null;
  if (state.activeWorktreeId) {
    const list = state.worktreesByProject[project.id] ?? [];
    const wt = list.find((w) => w.id === state.activeWorktreeId);
    if (wt?.path) return wt.path;
  }
  return project.path;
}
