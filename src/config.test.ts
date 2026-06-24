import { describe, expect, it } from "vitest";
import {
  DEFAULT_THINKING_VISIBILITY,
  DEFAULT_TOOL_CALLS_VISIBILITY,
  normalizeVisibility,
  normalizeToolCallsVisibility,
} from "./config";

describe("tool-call visibility config", () => {
  it("defaults missing thinking blocks to hidden for a clean transcript", () => {
    expect(DEFAULT_THINKING_VISIBILITY).toBe("hide");
    expect(normalizeVisibility(undefined)).toBe("hide");
  });

  it("keeps malformed explicit thinking values visible", () => {
    expect(normalizeVisibility("yolo")).toBe("show");
  });

  it("defaults missing config to hidden tool calls", () => {
    expect(DEFAULT_TOOL_CALLS_VISIBILITY).toBe("hide");
  });

  it("keeps malformed explicit values visible", () => {
    expect(normalizeToolCallsVisibility(undefined)).toBe("show");
    expect(normalizeToolCallsVisibility("group-yolo")).toBe("show");
  });
});
