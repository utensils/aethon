import { describe, expect, it } from "vitest";
import { handleStatePatch } from "./statePatch";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleStatePatch", () => {
  it("acks failure when path is missing", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleStatePatch({ type: "state_patch", mutationId: "m1" }, ctx);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", false, "missing path");
  });

  it("writes a global path to root state and tracks it", () => {
    const { ctx, mocks, applySetState } = buildHandlerFixture();
    handleStatePatch(
      {
        type: "state_patch",
        path: "/sidebar/foo",
        value: 42,
        mutationId: "m1",
      },
      ctx,
    );
    expect(mocks.ackMutation).toHaveBeenCalledWith("m1", true);
    expect(ctx.lastExtensionStateKeysRef.current.has("/sidebar/foo")).toBe(true);
    const next = applySetState({});
    expect(next).toEqual({ sidebar: { foo: 42 } });
  });

  it("routes a mirrored path with tabId through updateTab", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleStatePatch(
      {
        type: "state_patch",
        path: "/draft",
        value: "hello",
        tabId: "tab-3",
        mutationId: "m2",
      },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    const [tabId, updater] = mocks.updateTab.mock.calls[0];
    expect(tabId).toBe("tab-3");
    const out = updater(makeEmptyTab("tab-3", "Tab 3"));
    expect(out.draft).toBe("hello");
    expect(mocks.ackMutation).toHaveBeenCalledWith("m2", true);
  });

  it("routes a mirrored path without tabId through updateActiveTab", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleStatePatch(
      {
        type: "state_patch",
        path: "/canvas",
        value: { components: [] },
        mutationId: "m3",
      },
      ctx,
    );
    expect(mocks.updateActiveTab).toHaveBeenCalledTimes(1);
    expect(mocks.ackMutation).toHaveBeenCalledWith("m3", true);
  });
});
