import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./time";

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-05-03T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty for zero/missing timestamp", () => {
    expect(formatRelativeTime(0)).toBe("");
  });

  it("returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTime(NOW - 30_000)).toBe("just now");
  });

  it("returns minutes for sub-hour deltas", () => {
    expect(formatRelativeTime(NOW - 5 * 60_000)).toBe("5m ago");
  });

  it("returns hours for sub-day deltas", () => {
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000)).toBe("3h ago");
  });

  it("returns 'yesterday' for ~1 day delta", () => {
    expect(formatRelativeTime(NOW - 25 * 60 * 60_000)).toBe("yesterday");
  });

  it("returns days for sub-week deltas", () => {
    expect(formatRelativeTime(NOW - 4 * 24 * 60 * 60_000)).toBe("4d ago");
  });

  it("returns a localized date for older deltas", () => {
    const out = formatRelativeTime(NOW - 60 * 24 * 60 * 60_000);
    expect(out).not.toMatch(/ago|yesterday|just now/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("clamps negative deltas (timestamp in the future) to 'just now'", () => {
    expect(formatRelativeTime(NOW + 60_000)).toBe("just now");
  });
});
