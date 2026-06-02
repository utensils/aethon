/**
 * Agent-side working-directory git context.
 *
 * The `before_agent_start` hook (wired in `main.ts`) injects a fresh
 * "Working context" block into the model's system prompt every turn so a
 * local model never loses track of the active tab's cwd. Git facts for that
 * block come from the Rust `git_working_context` command, reached through the
 * `git_query` mutation-ack bridge (Rust resolves `git` via the PATH-augmenting
 * `env` helper, so this is correct in Finder-launched release builds too —
 * unlike a bare `child_process` spawn from the bun process).
 *
 * Results are cached per-cwd with a short TTL so a multi-step turn (or rapid
 * re-prompts) doesn't re-query, while still refreshing between turns that are
 * seconds apart — branch/dirty state stays live. Failures degrade silently to
 * the last known value (or null); a missing git context never blocks a turn.
 */

import { trackMutation } from "./mutation-ack";
import type { AethonAgentState, MutationResult } from "./state";
import { logger } from "./logger";

export interface GitWorkingContext {
  repoRoot: string | null;
  branch: string | null;
  isWorktree: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
}

interface CacheEntry {
  ctx: GitWorkingContext | null;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<GitWorkingContext | null>>();

const TTL_MS = 2_500;
const QUERY_TIMEOUT_MS = 4_000;

export interface GitContextDeps {
  send: (obj: Record<string, unknown>) => void;
}

/** Test-only: drop the module-local cache so cases don't bleed into each
 *  other. Not part of the runtime surface. */
export function _resetGitContextCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Resolve the working-directory git context for `cwd`. Returns `null` when
 *  the directory isn't a git work tree (or on a degraded/timed-out query).
 *  `now` is injectable for tests. */
export async function getWorkingContext(
  state: AethonAgentState,
  deps: GitContextDeps,
  cwd: string,
  now: number = Date.now(),
): Promise<GitWorkingContext | null> {
  const cached = cache.get(cwd);
  if (cached && now - cached.ts < TTL_MS) {
    return cached.ctx;
  }
  const pending = inflight.get(cwd);
  if (pending) return pending;

  const fetchPromise = (async () => {
    try {
      const result = await sendQuery(state, deps, cwd);
      if (!result.ok) {
        // Transient failure — keep the previous value (if any) rather than
        // poisoning the cache with a null the next turn would have to undo.
        return cached?.ctx ?? null;
      }
      const ctx = normalizeContext(result.data);
      cache.set(cwd, { ctx, ts: now });
      return ctx;
    } catch (err) {
      logger
        .scope("git-context")
        .warn(`working_context(${cwd}) threw: ${(err as Error).message}`);
      return cached?.ctx ?? null;
    } finally {
      inflight.delete(cwd);
    }
  })();
  inflight.set(cwd, fetchPromise);
  return fetchPromise;
}

async function sendQuery(
  state: AethonAgentState,
  deps: GitContextDeps,
  cwd: string,
): Promise<MutationResult> {
  if (!state.frontendReady) {
    const ready = await Promise.race<boolean>([
      state.frontendReadyPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), QUERY_TIMEOUT_MS),
      ),
    ]);
    if (!ready) return { ok: false, error: "frontend_not_ready" };
  }
  const { id, promise } = trackMutation(state, QUERY_TIMEOUT_MS);
  deps.send({
    type: "git_query",
    mutationId: id,
    op: "working_context",
    args: { cwd },
  });
  return promise;
}

/** Coerce the Rust `Option<GitWorkingContext>` JSON into our shape. `null`
 *  (not a repo) passes through; partial/garbage payloads clamp to safe
 *  defaults so the prompt builder never sees `undefined`. */
function normalizeContext(data: unknown): GitWorkingContext | null {
  if (data == null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return {
    repoRoot: typeof d.repoRoot === "string" ? d.repoRoot : null,
    branch: typeof d.branch === "string" ? d.branch : null,
    isWorktree: d.isWorktree === true,
    changedFiles: typeof d.changedFiles === "number" ? d.changedFiles : 0,
    ahead: typeof d.ahead === "number" ? d.ahead : 0,
    behind: typeof d.behind === "number" ? d.behind : 0,
  };
}
