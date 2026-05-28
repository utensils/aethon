import { describe, expect, it } from "vitest";
import { decideShellResize, shouldSkipResize } from "./canvas";

function entry(width: number, height: number): ResizeObserverEntry {
  return {
    contentRect: { width, height } as DOMRectReadOnly,
  } as ResizeObserverEntry;
}

describe("shouldSkipResize", () => {
  it("returns false for a healthy-size entry", () => {
    expect(shouldSkipResize(entry(800, 240))).toBe(false);
  });

  it("returns true when width collapses to zero", () => {
    // Cmd+` collapses the terminal grid track to 0px; the ResizeObserver
    // fires with width=0. Skipping the fit+resize keeps us from sending
    // a tiny `shell_resize` that would raise SIGWINCH on the PTY.
    expect(shouldSkipResize(entry(0, 240))).toBe(true);
  });

  it("returns true when height collapses to zero", () => {
    expect(shouldSkipResize(entry(800, 0))).toBe(true);
  });

  it("returns false when the entry is undefined (defensive)", () => {
    // Some browsers fire with an empty entry list during teardown — fall
    // through to the fit() try/catch rather than dropping the event.
    expect(shouldSkipResize(undefined)).toBe(false);
  });
});

describe("decideShellResize", () => {
  it("emits the dims on the first call (no prior baseline)", () => {
    expect(decideShellResize({ cols: 159, rows: 11 }, null)).toEqual({
      cols: 159,
      rows: 11,
    });
  });

  it("emits when the dims actually changed", () => {
    expect(
      decideShellResize({ cols: 200, rows: 24 }, { cols: 159, rows: 11 }),
    ).toEqual({ cols: 200, rows: 24 });
  });

  it("returns null when the dims match what we last sent", () => {
    // The toggle-off / toggle-on cycle ends with the same xterm dims it
    // started with; returning null skips the redundant shell_resize so
    // bash never sees a no-op SIGWINCH and starship doesn't redraw.
    expect(
      decideShellResize({ cols: 159, rows: 11 }, { cols: 159, rows: 11 }),
    ).toBeNull();
  });

  it("returns null for a zero-cols snapshot", () => {
    // Defensive: xterm.cols can be 0 if the container collapsed between
    // the observer fire and fit().
    expect(decideShellResize({ cols: 0, rows: 11 }, null)).toBeNull();
  });

  it("returns null for a zero-rows snapshot", () => {
    expect(decideShellResize({ cols: 159, rows: 0 }, null)).toBeNull();
  });
});
