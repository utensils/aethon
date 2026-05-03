import { describe, expect, it } from "vitest";
import { handleQueued } from "./queued";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleQueued", () => {
  it("bumps the per-tab queueCount", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleQueued({ type: "queued", tabId: "default" }, ctx);
    const [tabId, updater] = mocks.updateTab.mock.calls[0];
    expect(tabId).toBe("default");
    const seed = { ...makeEmptyTab("default", "Tab 1"), queueCount: 3 };
    expect(updater(seed).queueCount).toBe(4);
  });
});
