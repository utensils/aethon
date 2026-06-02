import { describe, expect, it } from "vitest";
import { resolveVisibility } from "./visibilityResolver";

describe("resolveVisibility", () => {
  it("defaults to show when nothing is set", () => {
    expect(resolveVisibility({}, undefined)).toEqual({
      thinking: "show",
      toolCalls: "show",
    });
  });

  it("reads the global default from /transcriptVisibility", () => {
    const state = {
      transcriptVisibility: { thinking: "collapse", toolCalls: "hide" },
    };
    expect(resolveVisibility(state, "t1")).toEqual({
      thinking: "collapse",
      toolCalls: "hide",
    });
  });

  it("lets a per-tab override win over the global default", () => {
    const state = {
      transcriptVisibility: { thinking: "show", toolCalls: "show" },
      tabs: [
        { id: "t1", visibilityOverrides: { thinking: "hide" } },
        { id: "t2", visibilityOverrides: { toolCalls: "collapse" } },
      ],
    };
    expect(resolveVisibility(state, "t1")).toEqual({
      thinking: "hide", // overridden
      toolCalls: "show", // falls back to global
    });
    expect(resolveVisibility(state, "t2")).toEqual({
      thinking: "show",
      toolCalls: "collapse",
    });
  });

  it("treats a null override as 'follow global'", () => {
    const state = {
      transcriptVisibility: { thinking: "collapse", toolCalls: "collapse" },
      tabs: [{ id: "t1", visibilityOverrides: { thinking: null } }],
    };
    expect(resolveVisibility(state, "t1")).toEqual({
      thinking: "collapse",
      toolCalls: "collapse",
    });
  });

  it("clamps unknown global values to show", () => {
    const state = { transcriptVisibility: { thinking: "yolo" } };
    expect(resolveVisibility(state, undefined).thinking).toBe("show");
  });
});
