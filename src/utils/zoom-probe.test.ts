// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { clampFixedOverlay, resetCoordSpaceCache } from "./zoom-probe";

afterEach(() => {
  resetCoordSpaceCache();
  document.documentElement.style.removeProperty("--app-ui-scale");
  document.documentElement.style.zoom = "";
});

describe("clampFixedOverlay", () => {
  it("keeps overlays inside the viewport inset", () => {
    expect(clampFixedOverlay(2, 3, 120, 80)).toEqual({ x: 8, y: 8 });
    expect(clampFixedOverlay(2_000, 2_000, 120, 80)).toEqual({
      x: window.innerWidth - 120 - 8,
      y: window.innerHeight - 80 - 8,
    });
  });

  it("uses the inset when the overlay is wider than the viewport", () => {
    expect(clampFixedOverlay(500, 500, window.innerWidth * 2, 80).x).toBe(8);
  });
});
