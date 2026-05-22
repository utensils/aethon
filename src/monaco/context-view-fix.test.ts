import { describe, expect, it } from "vitest";
import { correctContextViewPosition } from "./context-view-fix";

function target(left: string, top: string) {
  return { style: { left, top } };
}

describe("correctContextViewPosition", () => {
  it("divides the WebKit-visual coords back into layout pixels", () => {
    const el = target("400px", "300px");
    const wrote = correctContextViewPosition(el, 2);
    expect(wrote).toBe(true);
    expect(el.style.left).toBe("200px");
    expect(el.style.top).toBe("150px");
  });

  it("is idempotent — re-running after a correction is a no-op", () => {
    const el = target("400px", "300px");
    correctContextViewPosition(el, 2);
    const ranAgain = correctContextViewPosition(el, 2);
    // The element now reads "200px/150px"; the echo guard remembers
    // that pair and short-circuits the re-application loop.
    expect(ranAgain).toBe(false);
    expect(el.style.left).toBe("200px");
  });

  it("skips when coords are unparseable", () => {
    const el = target("", "auto");
    expect(correctContextViewPosition(el, 2)).toBe(false);
  });

  it("handles zoom == 1 like a passthrough", () => {
    const el = target("200px", "100px");
    // At zoom 1 the divide is a no-op math-wise, but the echo guard
    // also records the (200, 100) pair so a subsequent call would
    // skip. Both outcomes are correct.
    correctContextViewPosition(el, 1);
    expect(el.style.left).toBe("200px");
    expect(el.style.top).toBe("100px");
  });
});
