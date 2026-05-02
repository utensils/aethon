// Pure-logic tests for default-layout components. The component render
// itself runs in node without jsdom, so these tests target the
// extractable helpers (`formatToolDuration` is exported from
// components.tsx) and the form-control shapes the settings-panel binds
// against (BUILTIN_THEMES, ANSI_PREVIEW_KEYS, share mode round-trip).
//
// React-level rendering tests (settings-panel form submission, share
// badge clicks) belong in a future jsdom-backed harness; the security
// boundary lives in shell.rs and the privacy guardrail is tested by
// `agent/shell-tools.test.ts` and the cargo `share_state_*` suite.

import { describe, expect, it } from "vitest";
import { formatToolDuration } from "./components";
import { cycleShareMode, shareModeLabel } from "../../utils/shareMode";

describe("formatToolDuration", () => {
  it("renders sub-minute runs as `Xs` with one decimal", () => {
    expect(formatToolDuration(0)).toBe("0.0s");
    expect(formatToolDuration(123)).toBe("0.1s");
    expect(formatToolDuration(999)).toBe("1.0s");
    expect(formatToolDuration(1500)).toBe("1.5s");
    expect(formatToolDuration(12_400)).toBe("12.4s");
    expect(formatToolDuration(59_900)).toBe("59.9s");
  });

  it("renders ≥60s runs as `Xm SSs`", () => {
    expect(formatToolDuration(60_000)).toBe("1m 00s");
    expect(formatToolDuration(125_000)).toBe("2m 05s");
    expect(formatToolDuration(605_000)).toBe("10m 05s");
  });

  it("clamps negative inputs to 0s without crashing", () => {
    // Tool-card timestamp races could yield a negative `now - start` in
    // theory; the formatter must not panic on this.
    expect(formatToolDuration(-1)).toBe("0.0s");
    expect(formatToolDuration(-500)).toBe("0.0s");
  });
});

describe("share-badge cycle integration", () => {
  // The share-badge in ShellCanvas calls `cycleShareMode` directly; this
  // test asserts the user-facing labels round-trip through the cycle so
  // the badge text stays sensible regardless of which mode is current.
  it("rotates through all four modes with stable labels", () => {
    let mode: ReturnType<typeof cycleShareMode> = "private";
    const visited: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      visited.push(`${mode}:${shareModeLabel(mode)}`);
      mode = cycleShareMode(mode);
    }
    expect(visited).toEqual([
      "private:private",
      "read:read",
      "read-write:read-write",
      "read-write-trusted:read-write · trusted",
    ]);
    // After 4 cycles we're back where we started — stable rotation.
    expect(mode).toBe("private");
  });
});
