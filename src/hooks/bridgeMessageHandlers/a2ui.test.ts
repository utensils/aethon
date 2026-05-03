import { describe, expect, it } from "vitest";
import { handleA2ui } from "./a2ui";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleA2ui", () => {
  it("appends an a2ui bubble and flips waiting on done", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    const payload = { components: [{ id: "x", type: "container" }] };
    handleA2ui(
      {
        type: "a2ui",
        payload,
        id: "msg-1",
        done: true,
        tabId: "default",
      },
      ctx,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-1", role: "agent", a2ui: payload }),
      "default",
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    expect(updater(makeEmptyTab("default", "Tab 1")).waiting).toBe(false);
    expect(mocks.setStatusFlags).toHaveBeenCalledWith({ status: "ready" });
  });
});
