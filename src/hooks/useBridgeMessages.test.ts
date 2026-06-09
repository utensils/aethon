import { describe, expect, test } from "vitest";
import { bridgeDispatchDecision } from "./useBridgeMessages";

const activeTabs = () => new Set(["tab-active", "tab-two"]);

describe("bridgeDispatchDecision", () => {
  test("unstamped messages from the global bridge are handled", () => {
    expect(
      bridgeDispatchDecision(
        { type: "extension_components", mutationId: "m1" },
        true,
        activeTabs,
      ),
    ).toEqual({ kind: "handle" });
  });

  test("registry hydrate from an active-workspace worker is handled", () => {
    expect(
      bridgeDispatchDecision(
        {
          type: "extension_components",
          mutationId: "m1",
          originTabId: "tab-active",
        },
        true,
        activeTabs,
      ),
    ).toEqual({ kind: "handle" });
  });

  test("registry hydrate from a background-workspace worker is rejected", () => {
    const decision = bridgeDispatchDecision(
      {
        type: "extension_themes",
        mutationId: "m2",
        originTabId: "tab-background",
      },
      true,
      activeTabs,
    );
    expect(decision.kind).toBe("ack-reject");
    if (decision.kind === "ack-reject") {
      expect(decision.error).toContain("tab-background");
    }
  });

  test("foreign-origin layout_set without a mutationId is still rejected", () => {
    // projectLifecycle's unload path sends layout_set with no mutationId;
    // the reject must not depend on having one.
    const decision = bridgeDispatchDecision(
      { type: "layout_set", originTabId: "gone" },
      true,
      activeTabs,
    );
    expect(decision.kind).toBe("ack-reject");
  });

  test("unhandled mutation-bearing message is acked as failed", () => {
    const decision = bridgeDispatchDecision(
      { type: "future_type", mutationId: "m3" },
      false,
      activeTabs,
    );
    expect(decision.kind).toBe("ack-reject");
    if (decision.kind === "ack-reject") {
      expect(decision.error).toContain("future_type");
    }
  });

  test("unhandled message without a mutationId is ignored silently", () => {
    expect(
      bridgeDispatchDecision({ type: "future_type" }, false, activeTabs),
    ).toEqual({ kind: "ignore" });
  });
});
