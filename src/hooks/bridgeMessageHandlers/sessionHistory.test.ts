import { describe, expect, it } from "vitest";
import { handleSessionHistory } from "./sessionHistory";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleSessionHistory", () => {
  it("replaces the tab's messages and triggers a recents resync", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [
          { id: "1", role: "user", text: "hi" },
          { id: "2", role: "agent", text: "hello" },
        ],
      },
      ctx,
    );
    expect(mocks.updateTab).toHaveBeenCalledTimes(1);
    const [tabId, updater] = mocks.updateTab.mock.calls[0];
    expect(tabId).toBe("tab-1");
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));
    expect(out.messages).toHaveLength(2);
    expect(mocks.syncRecentSessionsToState).toHaveBeenCalledTimes(1);
  });

  it("uses discovered custom session labels for restored chat tabs", () => {
    const { ctx, mocks } = buildHandlerFixture();
    ctx.allDiscoveredSessionsRef.current = [
      {
        tabId: "tab-1",
        lastModified: 1,
        firstUserMessage: "first prompt",
        customLabel: "Named session",
      },
    ];
    handleSessionHistory(
      {
        type: "session_history",
        tabId: "tab-1",
        messages: [{ id: "1", role: "user", text: "hi" }],
      },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("tab-1", "Tab 1"));
    expect(out.label).toBe("Named session");
  });
});
