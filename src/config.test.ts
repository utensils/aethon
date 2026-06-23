import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_CALLS_VISIBILITY,
  normalizeToolCallsVisibility,
} from "./config";

describe("tool-call visibility config", () => {
  it("defaults missing config to grouped completed turns", () => {
    expect(DEFAULT_TOOL_CALLS_VISIBILITY).toBe("group-block");
  });

  it("keeps malformed explicit values visible", () => {
    expect(normalizeToolCallsVisibility(undefined)).toBe("show");
    expect(normalizeToolCallsVisibility("group-yolo")).toBe("show");
  });
});
