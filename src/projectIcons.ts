// Project icon discovery — Conductor-style "find a sensible logo for
// each project" pass. Resolution order:
//
//   1. cached `project.iconUrl` (persisted on the Project record)
//   2. local scan via the `fs_discover_project_icon` Rust command — one
//      IPC round-trip that walks a curated set of logo / favicon /
//      app-icon locations (logo.*, public/favicon.*, src-tauri/icons/*,
//      …) and returns the first match as a `data:image/...;base64,...`
//      URL. Doing the walk natively keeps it to a single invoke instead
//      of one list+read per candidate directory.
//   3. GitHub avatar via `gh_repo_avatar_url`
//        → returns the canonical `https://github.com/<owner>.png?size=200`.
//   4. null → caller renders the initial-tile fallback.
//
// Caching: TTL pattern mirrors src/ghRepoOverviewCache.ts (positive +
// negative TTLs). The in-memory entry is keyed by project path so two
// projects with the same logo file don't double-fetch.
//
// Persistence: callers that have an updateProject wire-up should write
// the resolved url back onto `Project.iconUrl` so the next cold start
// paints synchronously off the projects.json record.

import { invoke } from "@tauri-apps/api/core";
import type { Project } from "./projects";

const LIVE_TTL_MS = 30 * 60 * 1000; // 30 min — icons don't change minute-to-minute
const NEG_TTL_MS = 24 * 60 * 60 * 1000; // 24 hr — avoid re-hammering gh on every paint

interface CacheEntry {
  value: string | null;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

async function tryLocalScan(projectPath: string): Promise<string | null> {
  try {
    const url = await invoke<string | null>("fs_discover_project_icon", {
      projectPath,
    });
    return url ?? null;
  } catch {
    return null;
  }
}

async function tryGhAvatar(projectPath: string): Promise<string | null> {
  try {
    const url = await invoke<string | null>("gh_repo_avatar_url", {
      projectPath,
    });
    return url ?? null;
  } catch {
    return null;
  }
}

/** Synchronous resolver — returns whatever's already cached on the
 *  project record. Use this for the first paint so the sidebar/cards
 *  never wait on an IPC. */
export function iconForProject(project: Project): string | null {
  return project.iconUrl ?? null;
}

/** Async discovery — runs the resolution chain. Memoized in-process by
 *  project path; safe to call eagerly on every render. */
export async function discoverIcon(project: Project): Promise<string | null> {
  const key = project.path;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  // An already-local persisted icon (`data:`) is the best we can do —
  // trust it without re-scanning (the efficient path).
  if (project.iconUrl?.startsWith("data:")) {
    cache.set(key, { value: project.iconUrl, expires: now + LIVE_TTL_MS });
    return project.iconUrl;
  }
  let resolved: string | null;
  try {
    // Prefer a real in-repo icon over a persisted *remote* avatar so a
    // project that only had the GitHub-org fallback upgrades to its own
    // logo/favicon once. Falls back to the persisted avatar, then a fresh
    // gh lookup, then null.
    resolved =
      (await tryLocalScan(project.path)) ??
      project.iconUrl ??
      (await tryGhAvatar(project.path));
  } catch {
    resolved = project.iconUrl ?? null;
  }
  cache.set(key, {
    value: resolved,
    expires: now + (resolved ? LIVE_TTL_MS : NEG_TTL_MS),
  });
  return resolved;
}

/** Test-only helper. */
export function _clearProjectIconCache(): void {
  cache.clear();
}
