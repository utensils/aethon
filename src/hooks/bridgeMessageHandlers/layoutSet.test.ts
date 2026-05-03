import { describe, expect, it } from "vitest";
import { handleLayoutSet } from "./layoutSet";
import { buildHandlerFixture } from "./testFixtures";

describe("handleLayoutSet", () => {
  it("acks failure when payload lacks components[]", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleLayoutSet(
      { type: "layout_set", payload: {}, mutationId: "m1" },
      ctx,
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith(
      "m1",
      false,
      "payload missing components[]",
    );
    expect(mocks.setLayout).not.toHaveBeenCalled();
  });

  it("sets the layout, deep-merges state defaults, and acks", () => {
    const { ctx, mocks, applySetState } = buildHandlerFixture();
    const payload = {
      components: [{ id: "root", type: "container" }],
      state: { greeting: "hi", existing: "default" },
    };
    handleLayoutSet(
      { type: "layout_set", payload, mutationId: "m1" },
      ctx,
    );
    expect(mocks.setLayout).toHaveBeenCalledWith(payload);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
    const next = applySetState({ existing: "live" });
    // Live value should win over the layout default.
    expect(next.existing).toBe("live");
    expect(next.greeting).toBe("hi");
  });
});
