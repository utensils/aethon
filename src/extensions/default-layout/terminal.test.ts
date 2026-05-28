import { describe, expect, it } from "vitest";
import {
  TERMINAL_FIT_DEBOUNCE_MS,
  TERMINAL_FIT_DRAG_THROTTLE_MS,
  terminalFitDelay,
} from "./terminal";

describe("terminalFitDelay", () => {
  it("throttles fit work during terminal resize drags", () => {
    expect(terminalFitDelay(true)).toBe(TERMINAL_FIT_DRAG_THROTTLE_MS);
    expect(TERMINAL_FIT_DRAG_THROTTLE_MS).toBeLessThan(
      TERMINAL_FIT_DEBOUNCE_MS,
    );
  });

  it("keeps non-drag layout changes on the trailing debounce", () => {
    expect(terminalFitDelay(false)).toBe(TERMINAL_FIT_DEBOUNCE_MS);
  });
});
