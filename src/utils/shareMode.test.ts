import { describe, expect, it } from "vitest";
import {
  allowsWrite,
  cycleShareMode,
  isShareable,
  shareModeLabel,
  shareModeTooltip,
  SHARE_MODES,
  type ShareMode,
} from "./shareMode";

describe("shareMode", () => {
  it("cycles through every mode in monotonic order and wraps to private", () => {
    let m: ShareMode = "private";
    const seen: ShareMode[] = [m];
    for (let i = 0; i < SHARE_MODES.length; i++) {
      m = cycleShareMode(m);
      seen.push(m);
    }
    expect(seen).toEqual([
      "private",
      "read",
      "read-write",
      "read-write-trusted",
      "private",
    ]);
  });

  it("treats unknown input as private", () => {
    expect(cycleShareMode("bogus" as ShareMode)).toBe("private");
  });

  it("isShareable matches the Rust enforcement boundary", () => {
    expect(isShareable("private")).toBe(false);
    expect(isShareable("read")).toBe(true);
    expect(isShareable("read-write")).toBe(true);
    expect(isShareable("read-write-trusted")).toBe(true);
  });

  it("allowsWrite is only the two writable modes", () => {
    expect(allowsWrite("private")).toBe(false);
    expect(allowsWrite("read")).toBe(false);
    expect(allowsWrite("read-write")).toBe(true);
    expect(allowsWrite("read-write-trusted")).toBe(true);
  });

  it("each mode has a non-empty label and tooltip", () => {
    for (const m of SHARE_MODES) {
      expect(shareModeLabel(m).length).toBeGreaterThan(0);
      expect(shareModeTooltip(m).length).toBeGreaterThan(0);
    }
  });

  it("tooltips reference click-to-advance to keep the UX self-discoverable", () => {
    // Every non-final mode tooltip should hint at what one more click
    // does. The trusted mode tooltip points back to revocation.
    for (const m of SHARE_MODES) {
      expect(shareModeTooltip(m).toLowerCase()).toMatch(/click/);
    }
  });
});
