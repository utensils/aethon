import { afterEach, describe, expect, test, vi } from "vitest";
import {
  bridgeDispatchDecision,
  createBridgePayloadPump,
} from "./useBridgeMessages";

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

describe("createBridgePayloadPump", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("drains bridge payloads in bounded chunks so input can run between batches", () => {
    vi.useFakeTimers();
    const processed: string[] = [];
    const pump = createBridgePayloadPump((payload) => {
      processed.push(payload);
    });

    for (let i = 0; i < 81; i += 1) {
      pump.enqueue(`m${i}`);
    }

    vi.runOnlyPendingTimers();
    expect(processed).toHaveLength(80);
    expect(processed[0]).toBe("m0");
    expect(processed[79]).toBe("m79");

    vi.runOnlyPendingTimers();
    expect(processed).toHaveLength(81);
    expect(processed[80]).toBe("m80");
  });

  test("dispose drops queued payloads and cancels the scheduled drain", () => {
    vi.useFakeTimers();
    const processed: string[] = [];
    const pump = createBridgePayloadPump((payload) => {
      processed.push(payload);
    });

    pump.enqueue("late");
    pump.dispose();
    vi.runOnlyPendingTimers();

    expect(processed).toEqual([]);
  });
});
