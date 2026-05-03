/**
 * State-payload size guard helpers — extracted from main.ts so the
 * env-var parsing and per-(extension, path) rate limiter can be unit
 * tested without booting the full bridge.
 *
 * Mirrors the Rust-side `resolve_ext_state_limits` in
 * `src-tauri/src/helpers.rs` — the shell side already clamps user input
 * before we see it, but we re-clamp here in case a user pokes the env
 * var directly. The two implementations must agree on:
 *   1. defaults (64 / 512 KB)
 *   2. min / max bounds (1 / 8192 KB)
 *   3. the "raise hard up to warn" normalization
 */

export const STATE_PAYLOAD_LIMIT_MIN_KB = 1;
export const STATE_PAYLOAD_LIMIT_MAX_KB = 8 * 1024;
export const STATE_PAYLOAD_WARN_KB_DEFAULT = 64;
export const STATE_PAYLOAD_HARD_KB_DEFAULT = 512;

/** Parse a positive integer from an env var, clamped to bridge bounds. */
export function readKbEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(STATE_PAYLOAD_LIMIT_MAX_KB, Math.max(STATE_PAYLOAD_LIMIT_MIN_KB, n));
}

/**
 * Resolve the (warn, hard) pair the bridge will use. Applies defaults
 * for missing values, clamps each, then guarantees `warn <= hard` by
 * raising hard up to warn — otherwise the WARN tier could never fire.
 */
export function resolveStateLimits(
  warnRaw: string | undefined,
  hardRaw: string | undefined,
): { warnKb: number; hardKb: number } {
  const warnKb = readKbEnv(warnRaw, STATE_PAYLOAD_WARN_KB_DEFAULT);
  const hardKbRaw = readKbEnv(hardRaw, STATE_PAYLOAD_HARD_KB_DEFAULT);
  const hardKb = Math.max(warnKb, hardKbRaw);
  return { warnKb, hardKb };
}

/**
 * Per-(kind, extension, path) rate limiter for ext-state log lines.
 * First occurrence in a window logs immediately. Repeats within the
 * window are counted and folded into the next log line as a "+N
 * suppressed" suffix once the window expires.
 */
export interface RateLimiter {
  shouldLog(key: string): { log: boolean; suppressed: number };
}

export function makeExtStateLogLimiter(
  windowMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const state = new Map<string, { lastAt: number; suppressed: number }>();
  return {
    shouldLog(key: string) {
      const t = now();
      const entry = state.get(key);
      if (!entry || t - entry.lastAt >= windowMs) {
        const suppressed = entry?.suppressed ?? 0;
        state.set(key, { lastAt: t, suppressed: 0 });
        return { log: true, suppressed };
      }
      entry.suppressed += 1;
      return { log: false, suppressed: 0 };
    },
  };
}
