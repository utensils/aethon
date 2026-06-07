import { describe, expect, it } from "vitest";
import { handleResponseEnd } from "./responseEnd";
import { buildHandlerFixture } from "./testFixtures";
import { makeEmptyTab } from "../../types/tab";

describe("handleResponseEnd", () => {
  it("clears waiting + status, dismisses hang notification, fires completion", () => {
    const tabId = "default";
    const { ctx, mocks, applySetState } = buildHandlerFixture({
      state: {
        activeTabId: tabId,
        queueCount: 0,
        agentRunningTabs: { [tabId]: true },
      },
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
    expect(next.agentRunningTabs).toEqual({});
    expect(mocks.dismissNotification).toHaveBeenCalledWith(
      `ae-hang-warn:${tabId}`,
    );
    // maybeFireCompletionNotification called via void.
    expect(mocks.maybeFireCompletionNotification).toHaveBeenCalled();
  });

  it("freezes running tool cards when the turn ends", () => {
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleResponseEnd({ type: "response_end", tabId: "default" }, ctx);
    const [, updater] = mocks.updateTab.mock.calls[0];
    const seed = {
      ...makeEmptyTab("default", "Tab 1"),
      waiting: true,
      messages: [
        {
          id: "tool-message",
          role: "agent" as const,
          a2ui: {
            components: [
              {
                id: "running-tool",
                type: "tool-card",
                props: { startedAt: 1_000 },
                children: [],
              },
            ],
          },
        },
      ],
    };

    const out = updater(seed);
    const toolCard = out.messages[0].a2ui?.components[0];
    expect(toolCard?.props).toMatchObject({
      status: "cancelled",
      endedAt: expect.any(Number),
    });
    expect(toolCard?.children?.[0].props?.content).toContain("did not finish");
  });

  it("clears waiting even when a client-side queue is non-empty", () => {
    // The client-side queue is drained by useQueuedDispatch on the
    // waiting=true→false transition, so we MUST clear waiting here —
    // otherwise the dispatch effect never sees the idle moment and the
    // queue stalls.
    const { ctx, mocks } = buildHandlerFixture({
      state: { activeTabId: "default" },
    });
    handleResponseEnd({ type: "response_end", tabId: "default" }, ctx);
    const [, updater] = mocks.updateTab.mock.calls[0];
    const seed = {
      ...makeEmptyTab("default", "Tab 1"),
      queueCount: 1,
      queuedMessages: [{ id: "q1", content: "next" }],
      waiting: true,
    };
    expect(updater(seed).waiting).toBe(false);
  });
});
