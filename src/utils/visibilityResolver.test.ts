import { describe, expect, it } from "vitest";
import { resolveVisibility } from "./visibilityResolver";

describe("resolveVisibility", () => {
  it("defaults tool calls to hide when no global value is mirrored", () => {
    expect(resolveVisibility({}, undefined)).toEqual({
      thinking: "hide",
      toolCalls: "hide",
    });
  });

  it("reads the global default from /transcriptVisibility", () => {
    const state = {
      transcriptVisibility: { thinking: "collapse", toolCalls: "group-run" },
    };
    expect(resolveVisibility(state, "t1")).toEqual({
      thinking: "collapse",
      toolCalls: "group-run",
    });
  });

  it("lets a per-tab override win over the global default", () => {
    const state = {
      transcriptVisibility: { thinking: "show", toolCalls: "show" },
      tabs: [
        { id: "t1", visibilityOverrides: { thinking: "hide" } },
        { id: "t2", visibilityOverrides: { toolCalls: "group-block" } },
      ],
    };
    expect(resolveVisibility(state, "t1")).toEqual({
      thinking: "hide", // overridden
      toolCalls: "show", // falls back to global
    });
    expect(resolveVisibility(state, "t2")).toEqual({
      thinking: "show",
      toolCalls: "group-block",
    });
  });

  it("treats a null override as 'follow global'", () => {
    const state = {
      transcriptVisibility: { thinking: "collapse", toolCalls: "group-turn" },
      tabs: [{ id: "t1", visibilityOverrides: { thinking: null } }],
    };
    expect(resolveVisibility(state, "t1")).toEqual({
      thinking: "collapse",
      toolCalls: "group-turn",
    });
  });

  it("clamps unknown global values to show", () => {
    const state = {
      transcriptVisibility: { thinking: "yolo", toolCalls: "group-yolo" },
    };
    expect(resolveVisibility(state, undefined)).toEqual({
      thinking: "show",
      toolCalls: "show",
    });
  });

  it("accepts every tool grouping mode", () => {
    for (const mode of ["group-turn", "group-run", "group-block"] as const) {
      const state = { transcriptVisibility: { toolCalls: mode } };
      expect(resolveVisibility(state, undefined).toolCalls).toBe(mode);
    }
  });

  it("migrates a legacy 'collapse' tool value to group-turn (global + override)", () => {
    // PR #204 persisted "collapse"; it now means per-turn grouping.
    expect(
      resolveVisibility(
        { transcriptVisibility: { toolCalls: "collapse" } },
        undefined,
      ).toolCalls,
    ).toBe("group-turn");
    expect(
      resolveVisibility(
        {
          tabs: [{ id: "t1", visibilityOverrides: { toolCalls: "collapse" } }],
        },
        "t1",
      ).toolCalls,
    ).toBe("group-turn");
  });
});
