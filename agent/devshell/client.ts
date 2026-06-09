/**
 * Agent-side devshell cache.
 *
 * Pi's `BashSpawnHook` is *synchronous* — `(ctx) => ctx`, no Promise —
 * so we can't `await` a Tauri IPC call from inside the hook. Instead
 * we maintain a process-local Map keyed by cwd; the hook reads it
 * synchronously. On a miss the hook fires a background fetch (via
 * `deps.send` + `trackMutation`) so the *next* shell open / bash tool
 * call for the same cwd hits a warm entry. The first call after a
 * project switch may still run with the host env; this matches how
 * direnv behaves on first cd and is documented in the agent-bash
 * stream so the user knows why.
 *
 * Frontend-pushed `devshell-ready` / `devshell-failed` events also
 * land here via {@link onDevshellEvent}, keeping the cache in sync
 * when the user manually clicks "Refresh now" or when the resolver
 * completes in the background.
 */

import { trackMutation } from "../mutation-ack";
import type { AethonAgentState } from "../state";
import { logger } from "../logger";

interface CacheEntry {
  kind: string | null;
  env: Record<string, string>;
  resolvedAt: number;
  stale: boolean;
  /** Set while a fetch is in-flight so we don't fan out duplicate
   *  IPC calls when pi runs multiple bash tools concurrently. */
  fetching: boolean;
}

const cache = new Map<string, CacheEntry>();

/** One-shot warning per cwd so the LLM sees a single message in the
 *  agent-bash stream rather than a flood. */
const warned = new Set<string>();

export interface DevshellClientDeps {
  send: (obj: Record<string, unknown>) => void;
}

const FETCH_TIMEOUT_MS = 5_000;
const PREPARE_TIMEOUT_MS = 130_000;
const PREPARED_ENV_KEYS_VAR = "AETHON_WORKER_DEVSHELL_ENV_KEYS";

/** Hit point for the bash spawnHook. Synchronous. Returns the cached
 *  env (possibly empty) and, if necessary, kicks off a background
 *  fetch whose result will populate the cache for next time. */
export function getCachedEnv(
  state: AethonAgentState,
  deps: DevshellClientDeps,
  cwd: string,
): { env: Record<string, string>; kind: string | null; hot: boolean } {
  const entry = cache.get(cwd);
  if (entry && (!entry.fetching || Object.keys(entry.env).length > 0)) {
    return { env: entry.env, kind: entry.kind, hot: true };
  }
  if (!entry) {
    // Fire-and-forget the first fetch.
    void ensureFetched(state, deps, cwd);
  }
  return { env: entry?.env ?? {}, kind: entry?.kind ?? null, hot: false };
}

/** Seed the synchronous bash-hook cache from a tab worker process that Rust
 *  already spawned under a prepared devshell env. This avoids a duplicate
 *  bridge -> frontend -> Rust prepare query before the first prompt can reach
 *  pi, while still keeping Force/None modes honest: callers only invoke this
 *  when the supervisor explicitly marked the worker env prepared. */
export function seedPreparedEnv(
  cwd: string,
  env: NodeJS.ProcessEnv,
  kind: string | null,
): void {
  const keys = preparedEnvKeys(env);
  if (keys.length === 0) return;
  const prepared: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string") prepared[key] = value;
  }
  cache.set(cwd, {
    kind,
    env: prepared,
    resolvedAt: Date.now(),
    stale: false,
    fetching: false,
  });
}

function preparedEnvKeys(env: NodeJS.ProcessEnv): string[] {
  const raw = env[PREPARED_ENV_KEYS_VAR];
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
  } catch {
    return [];
  }
}

/** Explicit fetch — used by tab-lifecycle on session creation so the
 *  cache is warm by the first tool call, and by `getCachedEnv` on miss. */
export async function ensureFetched(
  state: AethonAgentState,
  deps: DevshellClientDeps,
  cwd: string,
): Promise<void> {
  const existing = cache.get(cwd);
  if (existing?.fetching) return;
  // Mark fetching so concurrent callers don't fan out duplicates.
  cache.set(cwd, {
    kind: existing?.kind ?? null,
    env: existing?.env ?? {},
    resolvedAt: existing?.resolvedAt ?? 0,
    stale: existing?.stale ?? false,
    fetching: true,
  });
  try {
    const result = await sendQuery(
      state,
      deps,
      "env_for_path",
      { cwd },
      FETCH_TIMEOUT_MS,
    );
    if (!result.ok) {
      // Don't drop the existing cache on a transient failure — the
      // previous env (if any) is still our best bet. Just clear the
      // fetching flag.
      cache.set(cwd, {
        kind: existing?.kind ?? null,
        env: existing?.env ?? {},
        resolvedAt: existing?.resolvedAt ?? 0,
        stale: true,
        fetching: false,
      });
      logger
        .scope("devshell")
        .warn(`env_for_path(${cwd}) failed: ${result.error ?? "unknown"}`);
      return;
    }
    const payload = (result.data ?? {}) as {
      enabled?: string;
      kind?: string | null;
      env?: Record<string, string>;
      stale?: boolean;
    };
    if (payload.enabled === "never") {
      // Devshell explicitly off — keep the cache entry but flush its
      // env so the spawnHook doesn't carry over a previous run's vars.
      cache.set(cwd, {
        kind: null,
        env: {},
        resolvedAt: Date.now(),
        stale: false,
        fetching: false,
      });
      return;
    }
    cache.set(cwd, {
      kind: payload.kind ?? null,
      env: payload.env ?? {},
      resolvedAt: Date.now(),
      stale: payload.stale === true,
      fetching: false,
    });
  } catch (err) {
    cache.set(cwd, {
      kind: existing?.kind ?? null,
      env: existing?.env ?? {},
      resolvedAt: existing?.resolvedAt ?? 0,
      stale: true,
      fetching: false,
    });
    logger
      .scope("devshell")
      .warn(`env_for_path(${cwd}) threw: ${(err as Error).message}`);
  }
}

/** Blocking preparation used before creating a tab-scoped session. This asks
 *  the frontend/Rust cache to wait for Nix/direnv readiness, then seeds the
 *  synchronous spawn-hook cache with the prepared env. */
export async function ensurePrepared(
  state: AethonAgentState,
  deps: DevshellClientDeps,
  cwd: string,
): Promise<void> {
  const existing = cache.get(cwd);
  cache.set(cwd, {
    kind: existing?.kind ?? null,
    env: existing?.env ?? {},
    resolvedAt: existing?.resolvedAt ?? 0,
    stale: existing?.stale ?? false,
    fetching: true,
  });
  try {
    const result = await sendQuery(
      state,
      deps,
      "prepare_for_path",
      { cwd, includeEnv: true },
      PREPARE_TIMEOUT_MS,
    );
    if (!result.ok) {
      cache.set(cwd, {
        kind: existing?.kind ?? null,
        env: existing?.env ?? {},
        resolvedAt: existing?.resolvedAt ?? 0,
        stale: true,
        fetching: false,
      });
      throw new Error(result.error ?? "devshell prepare failed");
    }
    const payload = (result.data ?? {}) as {
      enabled?: string;
      state?: string;
      kind?: string | null;
      env?: Record<string, string>;
      stale?: boolean;
      reason?: string | null;
    };
    if (payload.enabled === "never" || payload.state === "none") {
      cache.set(cwd, {
        kind: null,
        env: {},
        resolvedAt: Date.now(),
        stale: false,
        fetching: false,
      });
      return;
    }
    if (payload.state === "failed") {
      cache.set(cwd, {
        kind: payload.kind ?? existing?.kind ?? null,
        env: existing?.env ?? {},
        resolvedAt: existing?.resolvedAt ?? 0,
        stale: true,
        fetching: false,
      });
      logger
        .scope("devshell")
        .warn(
          `prepare_for_path(${cwd}) failed: ${payload.reason ?? "unknown"}`,
        );
      return;
    }
    cache.set(cwd, {
      kind: payload.kind ?? null,
      env: payload.env ?? {},
      resolvedAt: Date.now(),
      stale: payload.stale === true,
      fetching: false,
    });
  } catch (err) {
    cache.set(cwd, {
      kind: existing?.kind ?? null,
      env: existing?.env ?? {},
      resolvedAt: existing?.resolvedAt ?? 0,
      stale: true,
      fetching: false,
    });
    throw err;
  }
}

/** Forced refresh — invalidate local cache for a project root and
 *  ask the resolver to re-evaluate. Settings "Refresh now" reaches
 *  here via the frontend bridge. */
export async function refresh(
  state: AethonAgentState,
  deps: DevshellClientDeps,
  root: string,
): Promise<void> {
  // Keep any previous env hot while Rust refreshes the resolver. The bash
  // spawnHook is synchronous, so deleting here would make the next command
  // fall back to the host env for one turn.
  for (const [key, entry] of [...cache.entries()]) {
    if (isUnderRoot(key, root)) cache.set(key, { ...entry, stale: true });
  }
  for (const key of [...warned]) {
    if (isUnderRoot(key, root)) {
      warned.delete(key);
    }
  }
  await sendQuery(state, deps, "refresh", { root }, FETCH_TIMEOUT_MS);
}

/** Push-side handler: frontend forwards `devshell-ready` /
 *  `devshell-failed` Tauri events through `devshell_event` bridge
 *  messages. We invalidate-and-refetch so the next tool call sees the
 *  new env. */
export function onDevshellEvent(
  state: AethonAgentState,
  deps: DevshellClientDeps,
  event: {
    kind: string;
    root: string;
    status: "ready" | "failed" | "resolving";
  },
): void {
  if (event.status === "ready") {
    // Refresh any matching agent-side entries without making the synchronous
    // bash spawnHook go cold. Existing env remains usable until env_for_path
    // returns the freshly prepared resolver output.
    for (const [key, entry] of [...cache.entries()]) {
      if (isUnderRoot(key, event.root)) {
        cache.set(key, { ...entry, stale: true });
        if (!entry.fetching) void ensureFetched(state, deps, key);
      }
    }
    for (const key of [...warned]) {
      if (isUnderRoot(key, event.root)) {
        warned.delete(key);
      }
    }
  } else if (event.status === "failed") {
    // Mark stale so the next call shows the warning again.
    for (const [key, entry] of cache.entries()) {
      if (isUnderRoot(key, event.root)) {
        cache.set(key, { ...entry, stale: true });
      }
    }
  }
}

/** True when `cwd` is `root` or a descendant. Handles trailing
 *  slashes by normalising on the fly. */
function isUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return cwd.startsWith(prefix);
}

/** Emit a one-shot warning to the agent-bash stream when a tool call
 *  ran before the resolver completed. Idempotent per cwd. */
export function maybeWarnColdRun(cwd: string, kind: string | null): boolean {
  if (warned.has(cwd)) return false;
  warned.add(cwd);
  logger
    .scope("devshell")
    .warn(
      `cold devshell run for cwd ${cwd}${kind ? ` (kind=${kind})` : ""}: ` +
        `host env in use until resolver completes. Subsequent calls will inherit the devshell env.`,
    );
  return true;
}

/** Reset cache + warnings. Test-only. */
export function _resetForTests(): void {
  cache.clear();
  warned.clear();
}

interface SendQueryResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

async function sendQuery(
  state: AethonAgentState,
  deps: DevshellClientDeps,
  op: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<SendQueryResult> {
  if (!state.frontendReady) {
    const ready = await Promise.race<boolean>([
      state.frontendReadyPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), timeoutMs),
      ),
    ]);
    if (!ready) return { ok: false, error: "frontend_not_ready" };
  }
  const { id, promise } = trackMutation(state, timeoutMs);
  deps.send({ type: "devshell_query", mutationId: id, op, args });
  return promise;
}
