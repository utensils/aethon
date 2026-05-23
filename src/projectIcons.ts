// Project icon discovery — Conductor-style "find a sensible logo for
// each project" pass. Resolution order:
//
//   1. cached `project.iconUrl` (persisted on the Project record)
//   2. local scan: logo.{png,svg,jpg,webp}, .github/logo.*, public/favicon.*
//      → returned as a `data:image/...;base64,...` URL so the renderer
//        doesn't need the asset protocol or convertFileSrc.
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

const LOCAL_CANDIDATES: { sub: string; names: string[] }[] = [
  { sub: "", names: ["logo.png", "logo.svg", "logo.jpg", "logo.webp", "icon.png", "icon.svg"] },
  { sub: ".github", names: ["logo.png", "logo.svg"] },
  { sub: "public", names: ["logo.png", "logo.svg", "favicon.png", "favicon.svg"] },
  { sub: "assets", names: ["logo.png", "logo.svg"] },
  { sub: "docs", names: ["logo.png", "logo.svg"] },
];

interface FsEntry {
  name: string;
  isDir: boolean;
}

function mime(name: string): string {
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function tryLocalScan(projectPath: string): Promise<string | null> {
  for (const { sub, names } of LOCAL_CANDIDATES) {
    let entries: FsEntry[];
    try {
      entries = await invoke<FsEntry[]>("fs_list_dir", {
        root: projectPath,
        path: sub,
      });
    } catch {
      continue;
    }
    const lookup = new Set(entries.filter((e) => !e.isDir).map((e) => e.name.toLowerCase()));
    for (const name of names) {
      if (!lookup.has(name)) continue;
      const relPath = sub ? `${sub}/${name}` : name;
      try {
        const b64 = await invoke<string>("fs_read_file_base64", {
          root: projectPath,
          path: relPath,
        });
        return `data:${mime(name)};base64,${b64}`;
      } catch {
        // File found, read failed — keep walking.
      }
    }
  }
  return null;
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
  if (project.iconUrl) {
    cache.set(key, { value: project.iconUrl, expires: now + LIVE_TTL_MS });
    return project.iconUrl;
  }
  let resolved: string | null;
  try {
    resolved = (await tryLocalScan(project.path)) ?? (await tryGhAvatar(project.path));
  } catch {
    resolved = null;
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
