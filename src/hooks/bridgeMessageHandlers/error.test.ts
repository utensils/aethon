import { describe, expect, it } from "vitest";
import { handleError } from "./error";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleError", () => {
  it("appends an error message, clears waiting, sets error status when active", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    ctx.activeResponseIdRef.current = "msg-1";
    handleError(
      { type: "error", message: "boom", tabId: "default" },
      ctx,
    );
    expect(ctx.activeResponseIdRef.current).toBeNull();
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "agent", text: "Error: boom" }),
      "default",
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    expect(updater(makeEmptyTab("default", "Tab 1")).waiting).toBe(false);
    expect(mocks.setStatusFlags).toHaveBeenCalledWith({ status: "error" });
  });
});
