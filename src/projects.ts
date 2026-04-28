// Projects — directories the agent works in. Persisted at
// `~/.aethon/projects.json` and surfaced via `window.aethon.openProject`.
//
// Pi sessions are scoped to a working directory (SessionManager.continueRecent
// takes one). Aethon's bridge accepts an optional `cwd` on `tab_open`, so the
// active project's path travels with each new tab. Existing tabs keep the cwd
// they were created with — switching project doesn't retro-cwd live sessions.

import { invoke } from "@tauri-apps/api/core";
import { readState, writeState } from "./persist";

export interface Project {
  id: string;
  /** Human label shown in the sidebar. Defaults to the directory's basename. */
  label: string;
  /** Absolute path to the directory. */
  path: string;
  /** Epoch ms — bumped each time the project becomes active or a new tab opens in it. */
  lastUsed: number;
}

export interface ProjectsState {
  projects: Project[];
  activeId: string | null;
}

const FILE = "projects.json";
const MAX_PROJECTS = 16;

function basename(path: string): string {
  // Last non-empty segment; tolerate `/` and `\` separators so the same code
  // works on Windows. Handles trailing slashes.
  const cleaned = path.replace(/[/\\]+$/, "");
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || cleaned || "project";
}

export function emptyProjectsState(): ProjectsState {
  return { projects: [], activeId: null };
}

export async function loadProjects(): Promise<ProjectsState> {
  const raw = await readState(FILE);
  if (!raw) return emptyProjectsState();
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectsState>;
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    // Defensive: drop entries with missing/invalid path or id rather than
    // letting them crash the picker. A malformed file is the user's
    // problem to fix; we surface what we can.
    const valid = projects.filter(
      (p): p is Project =>
        typeof p?.id === "string" &&
        typeof p?.path === "string" &&
        typeof p?.label === "string",
    );
    const activeId =
      typeof parsed.activeId === "string" &&
      valid.some((p) => p.id === parsed.activeId)
        ? parsed.activeId
        : null;
    return { projects: valid, activeId };
  } catch {
    return emptyProjectsState();
  }
}

export async function saveProjects(state: ProjectsState): Promise<void> {
  await writeState(FILE, JSON.stringify(state));
}

/** Add a directory as a project. If a project at the same path already
 *  exists, that entry is reused (lastUsed bumped) so the picker doesn't
 *  collect duplicates when the user re-opens a familiar directory. */
export function upsertProject(
  state: ProjectsState,
  path: string,
  label?: string,
): { state: ProjectsState; id: string } {
  const existing = state.projects.find((p) => p.path === path);
  const now = Date.now();
  if (existing) {
    const updated: Project = { ...existing, lastUsed: now };
    if (label && label !== existing.label) updated.label = label;
    const projects = [updated, ...state.projects.filter((p) => p.id !== existing.id)];
    return { state: { projects, activeId: existing.id }, id: existing.id };
  }
  const id = crypto.randomUUID();
  const next: Project = {
    id,
    label: label ?? basename(path),
    path,
    lastUsed: now,
  };
  const projects = [next, ...state.projects].slice(0, MAX_PROJECTS);
  return { state: { projects, activeId: id }, id };
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
  return { state: { projects, activeId }, removed };
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
