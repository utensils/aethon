import { describe, expect, it } from "vitest";
import { handleQueueReset } from "./queueReset";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleQueueReset", () => {
  it("zeroes the per-tab queueCount", () => {
    const { ctx, mocks } = buildHandlerFixture();
    handleQueueReset({ type: "queue_reset", tabId: "default" }, ctx);
    const [, updater] = mocks.updateTab.mock.calls[0];
    const seed = { ...makeEmptyTab("default", "Tab 1"), queueCount: 7 };
    expect(updater(seed).queueCount).toBe(0);
  });
});
