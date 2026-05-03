import { describe, expect, it } from "vitest";
import { handleResponseEnd } from "./responseEnd";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleResponseEnd", () => {
  it("clears waiting + status, dismisses hang notification, fires completion", () => {
    const tabId = "default";
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: { activeTabId: tabId, queueCount: 0 },
    });
    ctx.activeResponseIdRef.current = "msg-1";
    ctx.turnStartedAtRef.current.set(tabId, Date.now() - 5000);
    ctx.hangWarnActiveRef.current.add(tabId);
    handleResponseEnd({ type: "response_end", tabId }, ctx);
    expect(ctx.activeResponseIdRef.current).toBeNull();
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab(tabId, "Tab 1"));
    expect(out.waiting).toBe(false);
    const next = applySetState();
    expect(next.status).toBe("ready");
    expect(mocks.dismissNotification).toHaveBeenCalledWith(`ae-hang-warn:${tabId}`);
    // maybeFireCompletionNotification called via void.
    expect(mocks.maybeFireCompletionNotification).toHaveBeenCalled();
  });

  it("preserves waiting when queueCount > 0", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleResponseEnd({ type: "response_end", tabId: "default" }, ctx);
    const [, updater] = mocks.updateTab.mock.calls[0];
    const seed = { ...makeEmptyTab("default", "Tab 1"), queueCount: 1, waiting: true };
    expect(updater(seed)).toEqual(seed);
  });
});
