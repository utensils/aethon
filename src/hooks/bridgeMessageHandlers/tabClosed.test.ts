import { describe, expect, it } from "vitest";
import { handleTabClosed } from "./tabClosed";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleTabClosed", () => {
  it("returns early when tabId is missing", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleTabClosed({ type: "tab_closed" }, ctx);
    expect(mocks.setState).not.toHaveBeenCalled();
  });

  it("removes the tab and dispatches replay when active tab was closed", () => {
    const tabA = makeEmptyTab("tab-a", "A");
    const tabB = { ...makeEmptyTab("tab-b", "B"), terminalBuffer: "scrollback" };
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: "tab-a",
        tabs: [tabA, tabB],
        sidebar: { models: [] },
      },
    });
    handleTabClosed({ type: "tab_closed", tabId: "tab-a" }, ctx);
    const next = applySetState();
    expect((next.tabs as { id: string }[]).map((t) => t.id)).toEqual(["tab-b"]);
    expect(next.activeTabId).toBe("tab-b");
    expect(mocks.dispatchTerminalReplay).toHaveBeenCalledWith("scrollback");
  });

  it("does not dispatch replay when the closed tab was not active", () => {
    const tabA = makeEmptyTab("tab-a", "A");
    const tabB = makeEmptyTab("tab-b", "B");
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "tab-a", tabs: [tabA, tabB], sidebar: {} },
    });
    handleTabClosed({ type: "tab_closed", tabId: "tab-b" }, ctx);
    expect(mocks.dispatchTerminalReplay).not.toHaveBeenCalled();
  });
});
