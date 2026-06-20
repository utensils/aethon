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

  it("flips waiting + records turn start + sets active status, deriving queueCount from the client-held queue", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handlePromptStarted(
      { type: "prompt_started", tabId: "default", queued: 2 },
      ctx,
    );
    expect(ctx.turnStartedAtRef.current.has("default")).toBe(true);
    const [, updater] = mocks.updateTab.mock.calls[0];
    // The handler ignores the bridge's stale `queued` field — the
    // CLIENT now owns the queue, and queueCount mirrors
    // `tab.queuedMessages.length`. A tab with two queued messages
    // keeps that count even though the bridge reported 2 (or 0).
    const seedTab = {
      ...makeEmptyTab("default", "Tab 1"),
      queuedMessages: [
        { id: "q1", content: "later 1" },
        { id: "q2", content: "later 2" },
      ],
      queueCount: 2,
    };
    const out = updater(seedTab);
    expect(out.waiting).toBe(true);
    expect(out.queueCount).toBe(2);
    // Two setState calls: the bucket-independent running set, then the
    // active-tab status flip.
    expect(mocks.setState).toHaveBeenCalledTimes(2);
    const runningUpdater = mocks.setState.mock.calls[0][0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(
      runningUpdater({
        agentRunningTabs: {},
        agentAttentionTabs: { default: true },
      }),
    ).toMatchObject({
      agentRunningTabs: { default: true },
      agentAttentionTabs: {},
    });
  });

  it("derives queueCount from the client queue rather than the bridge's stale value", () => {
    // Regression: previously the handler took the bridge's
    // `data.queued` and overwrote queueCount with it, which clobbered
    // a freshly-popped client-side count during auto-drain. The
    // bridge always reports 0 on the new flow because pi's followUp
    // queue is unused.
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handlePromptStarted(
      { type: "prompt_started", tabId: "default", queued: 0 },
      ctx,
    );
    const [, updater] = mocks.updateTab.mock.calls[0];
    const out = updater({
      ...makeEmptyTab("default", "Tab 1"),
      // Simulates a freshly-drained tab: one item remains in the
      // popover, count stays 1, bridge says 0 (stale) — keep 1.
      queuedMessages: [{ id: "q1", content: "next" }],
      queueCount: 1,
    });
    expect(out.queueCount).toBe(1);
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
      queuedMessages: [{ id: "qm-after", content: "after me" }],
      queueCount: 1,
    });
    // queueCount derives from queuedMessages.length — the client
    // queue has one item left, not two.
    expect(out.queueCount).toBe(1);
    expect(out.messages).toEqual([
      { id: "u1", role: "user", text: "running", delivery: "sent" },
      { id: "u2", role: "user", text: "start me", delivery: "sent" },
      { id: "u3", role: "user", text: "after me", delivery: "queued" },
    ]);
  });

  it("schedules an actionable hang-warn notification with session context after hangWarnMs", () => {
    const tabId = "default";
    const { ctx, mocks } = buildHandlerFixture({
      state: {
        activeTabId: tabId,
        tabs: [
          {
            ...makeEmptyTab(tabId, "Tab 1"),
            waiting: true,
            model: "gpt-5",
            cwd: "/Users/jamesbrink/Projects/utensils/aethon",
            queuedMessages: [{ id: "q1", content: "next" }],
            queueCount: 1,
          },
        ],
      },
    });
    handlePromptStarted({ type: "prompt_started", tabId }, ctx);
    expect(mocks.pushNotification).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ctx.hangWarnMs);
    expect(mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `ae-hang-warn:${tabId}`,
        title: "Tab 1 is still working (gpt-5)",
        message:
          "This session has been running longer than expected. Working directory: .../utensils/aethon. 1 queued message waiting.",
        kind: "warning",
        actions: [
          { label: "Open session", action: `activate-tab:${tabId}` },
          { label: "Stop", action: `hang-warn:stop:${tabId}` },
          { label: "Force restart", action: "hang-warn:force-restart" },
        ],
      }),
    );
    expect(ctx.hangWarnActiveRef.current.has(tabId)).toBe(true);
  });
});
