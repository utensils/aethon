/**
 * Tiered cadence for git status polling across workspaces (Claudette-style
 * hot / warm / cold), replacing the flat poll-everything-every-30s loop.
 *
 *   - Hot: the active workspace root. Owned by `useVcsStatus` (20s tick +
 *     `git-state-changed` events) — never scheduled here.
 *   - Warm: recently activated workspace roots (MRU, capped) — polled every
 *     WARM_POLL_INTERVAL_MS so switching back paints fresh sidebar badges.
 *   - Cold: every other known project path — every COLD_POLL_INTERVAL_MS,
 *     enough for the sidebar chips of projects the user isn't touching.
 *
 * Pure functions + a tiny module-level MRU so the hook's timer behavior has
 * cheap unit coverage (same pattern as gitFetchScheduler).
 */

export const WARM_POLL_INTERVAL_MS = 60_000;
export const COLD_POLL_INTERVAL_MS = 5 * 60_000;
/** How many recently-activated workspace roots stay warm. */
export const WARM_ROOTS_MAX = 4;

export interface DueStatusRootsInput {
  /** Known project main paths (the cold tier). */
  coldRoots: string[];
  /** Recently activated workspace roots (the warm tier). A root in both
   *  tiers polls at the warm cadence. */
  warmRoots: string[];
  /** Last completed status refresh per root (epoch ms). */
  lastPolledAt: Map<string, number>;
  now?: number;
}

/** Roots whose tier cadence has elapsed, deduped, warm tier first. */
export function dueStatusRoots(input: DueStatusRootsInput): string[] {
  const now = input.now ?? Date.now();
  const due: string[] = [];
  const seen = new Set<string>();
  const consider = (root: string, intervalMs: number) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    const last = input.lastPolledAt.get(root);
    if (last === undefined || now - last >= intervalMs) due.push(root);
  };
  for (const root of input.warmRoots) consider(root, WARM_POLL_INTERVAL_MS);
  for (const root of input.coldRoots) consider(root, COLD_POLL_INTERVAL_MS);
  return due;
}

/* ------------------------------------------------------------------ */
/* Warm-roots MRU (module singleton — activations happen in            */
/* useProjectOps / workspaceOps, polling happens in useProjects).      */
/* ------------------------------------------------------------------ */

let warmRootsMru: string[] = [];

/** Record that a workspace root became active. Front of the MRU = most
 *  recent. Call from project / workspace activation paths. */
export function recordWorkspaceActivation(
  root: string | null | undefined,
): void {
  if (!root) return;
  warmRootsMru = [root, ...warmRootsMru.filter((r) => r !== root)].slice(
    0,
    WARM_ROOTS_MAX,
  );
}

/** Snapshot of the warm tier, most recent first. */
export function warmStatusRoots(): string[] {
  return [...warmRootsMru];
}

/** Test hook. */
export function __resetWarmRootsForTesting(): void {
  warmRootsMru = [];
}
