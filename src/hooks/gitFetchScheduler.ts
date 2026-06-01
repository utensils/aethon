/**
 * Cadence helpers for best-effort `git fetch --all` across known projects.
 * Kept as pure functions so the hook's timer/focus behavior has cheap unit
 * coverage without mounting React timers for every edge case.
 */

/** Remote-tracking refs are refreshed much less often than local status polls.
 *  Ten minutes keeps ahead/behind reasonably fresh without hammering remotes
 *  on focus toggles or short-lived app reloads. */
export const GIT_FETCH_INTERVAL_MS = 10 * 60 * 1000;

export interface GitFetchCadenceState {
  /** Last attempted fetch time keyed by project path. Attempts (not only
   *  successes) are recorded so offline/auth failures don't retry on every
   *  focus event. */
  lastAttemptedAt: Map<string, number>;
  /** Project paths currently being fetched. */
  inFlight: Set<string>;
}

export function uniqueProjectPaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export function dueGitFetchPaths(
  paths: string[],
  state: GitFetchCadenceState,
  now = Date.now(),
  minAgeMs = GIT_FETCH_INTERVAL_MS,
): string[] {
  return uniqueProjectPaths(paths).filter((path) => {
    if (state.inFlight.has(path)) return false;
    const lastAttemptedAt = state.lastAttemptedAt.get(path);
    return lastAttemptedAt === undefined || now - lastAttemptedAt >= minAgeMs;
  });
}
