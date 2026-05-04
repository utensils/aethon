import { describe, expect, it } from "vitest";
import { handleTabReady } from "./tabReady";
import { buildHandlerFixture } from "./testFixtures";

describe("handleTabReady", () => {
  it("updates the tab and recomputes the picker when active", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleTabReady(
      { type: "tab_ready", tabId: "default", model: "haiku" },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    expect(mocks.setState).toHaveBeenCalledTimes(1);
  });

  it("skips picker recompute for non-active tabs", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleTabReady(
      { type: "tab_ready", tabId: "tab-2", model: "haiku" },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
