/**
 * In-memory cache for `gh_checks` Tauri-command results — CI / check-run
 * status for a branch's head commit. Sibling to `ghBranchStatusCache.ts`
 * (PR state); both back the VCS surface (header chip + source-control
 * panel) so flipping between branches stays instant.
 *
 * Why in-memory (not disk-backed): CI state changes faster than the git
 * index, so a fresh cold-start fetch is the safe default. The hot path is
 * in-session revisits + the periodic poll in `useVcsStatus`.
 */
import { invoke } from "@tauri-apps/api/core";

export interface GhCheckRun {
  name: string;
  /** `queued` | `in_progress` | `completed`. */
  status: string;
  /** `success` | `failure` | `neutral` | `cancelled` | `skipped` |
   *  `timed_out` | `action_required` | `stale` | null (still running). */
  conclusion: string | null;
  url: string | null;
}

export interface GhChecks {
  ghAvailable: boolean;
  repo: string | null;
  /** Single rolled-up signal the chip reads:
   *  null → not applicable (no gh / no GitHub remote)
   *  "none" → repo found but head commit has no checks
   *  "pending" | "failure" | "success" | "neutral" otherwise. */
  conclusion: string | null;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  checks: GhCheckRun[];
}

/** Successful CI status is dynamic — 45s keeps a running build's spinner
 *  fresh without hammering `gh`. */
const TTL_MS = 45_000;
/** No gh / no GitHub remote is static for the session — cache longer. */
const NEGATIVE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  checks: GhChecks;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GhChecks>>();

function cacheKey(projectPath: string, branch: string): string {
  return `${projectPath}|${branch}`;
}

function ttlFor(checks: GhChecks): number {
  if (!checks.ghAvailable || !checks.repo) return NEGATIVE_TTL_MS;
  return TTL_MS;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < ttlFor(entry.checks);
}

/** Return cached CI status if fresh, else invoke `gh_checks` and cache.
 *  Concurrent calls for the same key dedupe through the in-flight map. */
export async function getGhChecks(
  projectPath: string,
  branch: string,
): Promise<GhChecks> {
  const key = cacheKey(projectPath, branch);
  const hit = cache.get(key);
  if (hit && isFresh(hit)) return hit.checks;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = invoke<GhChecks>("gh_checks", { projectPath, branch })
    .then((checks) => {
      cache.set(key, { checks, fetchedAt: Date.now() });
      return checks;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Force-refresh a single cache entry. */
export async function refreshGhChecks(
  projectPath: string,
  branch: string,
): Promise<GhChecks> {
  cache.delete(cacheKey(projectPath, branch));
  return getGhChecks(projectPath, branch);
}

/** Test hook — wipe all entries so each test starts fresh. */
export function __clearCacheForTesting(): void {
  cache.clear();
  inFlight.clear();
}

export const __TEST__ = { TTL_MS, NEGATIVE_TTL_MS };
