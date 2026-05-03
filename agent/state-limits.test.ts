import { describe, expect, it } from "vitest";
import {
  STATE_PAYLOAD_HARD_KB_DEFAULT,
  STATE_PAYLOAD_LIMIT_MAX_KB,
  STATE_PAYLOAD_WARN_KB_DEFAULT,
  makeExtStateLogLimiter,
  readKbEnv,
  resolveStateLimits,
} from "./state-limits";

describe("readKbEnv", () => {
  it("returns fallback when env var is undefined", () => {
    expect(readKbEnv(undefined, 64)).toBe(64);
  });

  it("returns fallback when env var is empty", () => {
    expect(readKbEnv("", 64)).toBe(64);
  });

  it("returns fallback for non-numeric input — better than crashing on a typo", () => {
    expect(readKbEnv("notanumber", 64)).toBe(64);
  });

  it("returns fallback for zero or negative — these aren't meaningful thresholds", () => {
    expect(readKbEnv("0", 64)).toBe(64);
    expect(readKbEnv("-100", 64)).toBe(64);
  });

  it("clamps absurdly large values to the bridge ceiling", () => {
    expect(readKbEnv("999999", 64)).toBe(STATE_PAYLOAD_LIMIT_MAX_KB);
  });

  it("passes valid integers through unchanged", () => {
    expect(readKbEnv("128", 64)).toBe(128);
    expect(readKbEnv("1024", 64)).toBe(1024);
  });
});

describe("resolveStateLimits", () => {
  it("uses defaults when both env vars are absent", () => {
    const { warnKb, hardKb } = resolveStateLimits(undefined, undefined);
    expect(warnKb).toBe(STATE_PAYLOAD_WARN_KB_DEFAULT);
    expect(hardKb).toBe(STATE_PAYLOAD_HARD_KB_DEFAULT);
  });

  it("respects explicit overrides", () => {
    const { warnKb, hardKb } = resolveStateLimits("32", "256");
    expect(warnKb).toBe(32);
    expect(hardKb).toBe(256);
  });

  it("raises hard up to warn so WARN tier remains reachable", () => {
    // If a user inverts the pair (hard < warn), every WARN-tier write
    // would hit the HARD reject first — making the WARN log dead code.
    // Resolve by raising hard to warn, keeping warn unchanged.
    const { warnKb, hardKb } = resolveStateLimits("200", "100");
    expect(warnKb).toBe(200);
    expect(hardKb).toBe(200);
  });

  it("clamps absurdly large hard value to the bridge ceiling", () => {
    const { warnKb, hardKb } = resolveStateLimits("32", "999999");
    expect(warnKb).toBe(32);
    expect(hardKb).toBe(STATE_PAYLOAD_LIMIT_MAX_KB);
  });

  it("treats env var '0' as invalid → falls back to default (not 0KB which would reject every write)", () => {
    // The Rust-side resolver clamps 0 up to 1 when it appears in
    // config.toml, but as an env var '0' likely means a typo or a
    // deliberate "unset" gesture. Treat as fallback so the bridge
    // still has a working guard rather than rejecting every setState.
    const { warnKb, hardKb } = resolveStateLimits("0", "0");
    expect(warnKb).toBeGreaterThan(0);
    expect(hardKb).toBeGreaterThan(0);
  });
});

describe("makeExtStateLogLimiter", () => {
  it("logs the first occurrence", () => {
    const limiter = makeExtStateLogLimiter(60_000, () => 1000);
    const result = limiter.shouldLog("k1");
    expect(result.log).toBe(true);
    expect(result.suppressed).toBe(0);
  });

  it("suppresses repeats within the window", () => {
    let now = 1000;
    const limiter = makeExtStateLogLimiter(60_000, () => now);
    expect(limiter.shouldLog("k1").log).toBe(true);
    now = 30_000;
    expect(limiter.shouldLog("k1").log).toBe(false);
    expect(limiter.shouldLog("k1").log).toBe(false);
  });

  it("emits a count of suppressed entries when the window expires", () => {
    let now = 1000;
    const limiter = makeExtStateLogLimiter(60_000, () => now);
    expect(limiter.shouldLog("k1").log).toBe(true);
    // Three repeats inside the window — all suppressed, none logged.
    now = 10_000;
    limiter.shouldLog("k1");
    limiter.shouldLog("k1");
    limiter.shouldLog("k1");
    // Window expires; next log should report the suppressed count.
    now = 65_000;
    const result = limiter.shouldLog("k1");
    expect(result.log).toBe(true);
    expect(result.suppressed).toBe(3);
  });

  it("tracks separate keys independently", () => {
    const now = 1000;
    const limiter = makeExtStateLogLimiter(60_000, () => now);
    expect(limiter.shouldLog("a").log).toBe(true);
    // 'b' has never logged; should still get its first entry through.
    expect(limiter.shouldLog("b").log).toBe(true);
    // 'a' is in its window; stay suppressed.
    expect(limiter.shouldLog("a").log).toBe(false);
  });

  it("starts a fresh window after a log fires", () => {
    let now = 1000;
    const limiter = makeExtStateLogLimiter(60_000, () => now);
    limiter.shouldLog("k"); // first
    now = 65_000;
    limiter.shouldLog("k"); // second log — window resets here
    now = 70_000;
    // Still inside the second window — should suppress.
    expect(limiter.shouldLog("k").log).toBe(false);
  });
});
