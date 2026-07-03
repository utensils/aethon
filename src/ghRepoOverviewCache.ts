/**
 * In-memory cache for `gh_repo_overview` Tauri-command results. The
 * per-project dashboard fetches repo metadata (stars, forks, open
 * issues, open PRs, default branch) on activation. The underlying Rust
 * command runs three parallel `gh` calls; caching keyed by projectPath
 * keeps re-opens instant.
 *
 * Two-tier TTL: live data (gh present + recognised GitHub remote) at
 * 5 minutes, negative results (no gh / non-GitHub remote) at 30 minutes.
 * The negative case is environment-stable for the session, so a fresh
 * shellout per dashboard click would be waste.
 */
import { invokeForHost } from "./remoteInvoke";

export interface GhRepoOverview {
  ghAvailable: boolean;
  repo: string | null;
  description: string | null;
  url: string | null;
  defaultBranch: string | null;
  stargazerCount: number;
  forkCount: number;
  openIssuesCount: number;
  openPrsCount: number;
  /** ISO 8601; null when unknown. */
  pushedAt: string | null;
}

/** Live entries flip on PR/issue activity — minutes-scale freshness. */
const TTL_MS = 5 * 60_000;
/** Negative results don't change within a session. */
const NEGATIVE_TTL_MS = 30 * 60_000;

interface CacheEntry {
  overview: GhRepoOverview;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GhRepoOverview>>();

function cacheKey(projectPath: string, hostId?: string | null): string {
  return `${hostId ?? "local"}|${projectPath}`;
}

function ttlFor(o: GhRepoOverview): number {
  if (!o.ghAvailable || !o.repo) return NEGATIVE_TTL_MS;
  return TTL_MS;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < ttlFor(entry.overview);
}

/** Return cached overview if fresh, otherwise invoke the Tauri command
 *  and cache the result. Concurrent calls for the same project dedupe
 *  through the in-flight map. */
export async function getRepoOverview(
  projectPath: string,
  hostId?: string | null,
): Promise<GhRepoOverview> {
  const key = cacheKey(projectPath, hostId);
  const hit = cache.get(key);
  if (hit && isFresh(hit)) return hit.overview;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = invokeForHost<GhRepoOverview>(
    hostId,
    "gh_repo_overview",
    { projectPath },
  )
    .then((overview) => {
      cache.set(key, { overview, fetchedAt: Date.now() });
      return overview;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Force-refresh a single cache entry. Used by the agent-driven
 *  `refreshDashboard` pi tool and the manual refresh affordance on the
 *  per-project dashboard. */
export async function refreshRepoOverview(
  projectPath: string,
  hostId?: string | null,
): Promise<GhRepoOverview> {
  cache.delete(cacheKey(projectPath, hostId));
  return getRepoOverview(projectPath, hostId);
}

/** Bust every cached entry. Used by the agent's global
 *  `refreshDashboard()` (no projectPath) and by an extension that needs
 *  to force a full re-fetch (e.g. after a `gh auth refresh`). Does not
 *  pre-warm — the next read against each project triggers the gh call.
 *  In-flight Promises are left alone so they resolve normally and write
 *  fresh data to the cache. */
export function clearAllRepoOverviews(): void {
  cache.clear();
}

/** Read-only snapshot for code paths that want cached data without
 *  triggering a fetch (e.g. extension queries via aethon API). */
export function peekRepoOverview(
  projectPath: string,
  hostId?: string | null,
): GhRepoOverview | null {
  const hit = cache.get(cacheKey(projectPath, hostId));
  return hit ? hit.overview : null;
}

/** Test hook — wipe all entries so each test starts fresh. */
export function __clearCacheForTesting(): void {
  cache.clear();
  inFlight.clear();
}

export const __TEST__ = { TTL_MS, NEGATIVE_TTL_MS };
