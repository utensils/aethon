/**
 * In-memory cache for `gh_branch_status` Tauri-command results. The
 * worktree landing page re-renders on every worktree click, and the
 * underlying Rust command shells out to `gh` up to four times per
 * call. Caching keyed by (projectPath, branch) means flipping back to
 * a worktree you already opened is instant.
 *
 * Why in-memory (not disk-backed): PR state changes more often than
 * git index state, so a fresh cold-start fetch is the safe default.
 * In-session revisits are the hot path this layer targets.
 */
import { invoke } from "@tauri-apps/api/core";

export interface GhPr {
  number: number;
  state: string;
  title: string;
  url: string;
  isDraft: boolean;
  merged: boolean;
  baseRefName: string;
}

export interface GhBranchStatus {
  ghAvailable: boolean;
  repo: string | null;
  pushed: boolean;
  prs: GhPr[];
}

/** How long a successful cache entry remains valid. 60s is short
 *  enough that newly-pushed branches or merged PRs reflect quickly,
 *  long enough that a tab-switch round trip stays instant. */
const TTL_MS = 60_000;
/** Negative results (gh missing / not authed / non-GitHub remote)
 *  cache longer — none of those flip second-to-second, so a fresh
 *  shell-out per click would be wasteful. */
const NEGATIVE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  status: GhBranchStatus;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GhBranchStatus>>();

function cacheKey(projectPath: string, branch: string): string {
  return `${projectPath}|${branch}`;
}

function ttlFor(status: GhBranchStatus): number {
  // A repo with a known remote + recent PR data is the dynamic case.
  // Anything else (no gh, no repo) is essentially static for this
  // session — use the longer negative TTL.
  if (!status.ghAvailable || !status.repo) return NEGATIVE_TTL_MS;
  return TTL_MS;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < ttlFor(entry.status);
}

/** Return cached status if fresh, otherwise invoke the Tauri command
 *  and cache the result. Concurrent calls for the same key dedupe
 *  through the in-flight map so two simultaneous renders share one
 *  network round-trip. */
export async function getGhBranchStatus(
  projectPath: string,
  branch: string,
): Promise<GhBranchStatus> {
  const key = cacheKey(projectPath, branch);
  const hit = cache.get(key);
  if (hit && isFresh(hit)) return hit.status;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = invoke<GhBranchStatus>("gh_branch_status", {
    projectPath,
    branch,
  })
    .then((status) => {
      cache.set(key, { status, fetchedAt: Date.now() });
      return status;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Force-refresh a single cache entry. Currently unused, exposed for
 *  a future "refresh" action on the worktree landing. */
export async function refreshGhBranchStatus(
  projectPath: string,
  branch: string,
): Promise<GhBranchStatus> {
  cache.delete(cacheKey(projectPath, branch));
  return getGhBranchStatus(projectPath, branch);
}

/** Test hook — wipe all entries so each test starts fresh. */
export function __clearCacheForTesting(): void {
  cache.clear();
  inFlight.clear();
}

export const __TEST__ = { TTL_MS, NEGATIVE_TTL_MS };
