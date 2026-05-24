import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePromptStarted } from "./promptStarted";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handlePromptStarted", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips waiting + records turn start + sets active status", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handlePromptStarted(
      { type: "prompt_started", tabId: "default", queued: 2 },
      ctx,
    );
    expect(ctx.turnStartedAtRef.current.has("default")).toBe(true);
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater(makeEmptyTab("default", "Tab 1"));
    expect(out.waiting).toBe(true);
    expect(out.queueCount).toBe(2);
    expect(mocks.setState).toHaveBeenCalledTimes(1);
  });

  it("promotes the oldest queued user message when a queued prompt starts", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handlePromptStarted(
      { type: "prompt_started", tabId: "default", source: "queue", queued: 1 },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater({
      ...makeEmptyTab("default", "Tab 1"),
      messages: [
        { id: "u1", role: "user", text: "running", delivery: "sent" },
        { id: "u2", role: "user", text: "start me", delivery: "queued" },
        { id: "u3", role: "user", text: "after me", delivery: "queued" },
      ],
      queueCount: 2,
    });
    expect(out.queueCount).toBe(1);
    expect(out.messages).toEqual([
      { id: "u1", role: "user", text: "running", delivery: "sent" },
      { id: "u2", role: "user", text: "start me", delivery: "sent" },
      { id: "u3", role: "user", text: "after me", delivery: "queued" },
    ]);
  });

  it("schedules a hang-warn notification after hangWarnMs", () => {
    const tabId = "default";
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        activeTabId: tabId,
        tabs: [{ ...makeEmptyTab(tabId, "Tab 1"), waiting: true }],
      },
    });
    handlePromptStarted({ type: "prompt_started", tabId }, ctx);
    expect(mocks.pushNotification).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ctx.hangWarnMs);
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `ae-hang-warn:${tabId}`,
        title: "Still working…",
        kind: "warning",
      }),
    );
    expect(ctx.hangWarnActiveRef.current.has(tabId)).toBe(true);
  });
});
