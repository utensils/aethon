import { describe, expect, it } from "vitest";
import { handleResponse } from "./response";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleResponse", () => {
  it("appends content + flips waiting + ready when done", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleResponse(
      { type: "response", content: "hello", done: true, tabId: "default" },
      ctx,
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "agent", text: "hello" }),
      "default",
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    expect(updater(makeEmptyTab("default", "Tab 1")).waiting).toBe(false);
    expect(mocks.setStatusFlags).toHaveBeenCalledWith({ status: "ready" });
  });

  it("does not flip waiting when done is omitted", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleResponse({ type: "response", content: "partial" }, ctx);
    expect(mocks.updateTab).not.toHaveBeenCalled();
    expect(mocks.setStatusFlags).not.toHaveBeenCalled();
  });
});
