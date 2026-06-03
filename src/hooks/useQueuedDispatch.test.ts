// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useQueuedDispatch } from "./useQueuedDispatch";
import { makeEmptyTab, type Tab } from "../types/tab";

function tabWithQueue(
  partial: Partial<Tab> = {},
  ...queued: { id: string; content: string }[]
): Tab {
  return {
    ...makeEmptyTab("tab-1", "Tab 1"),
    queuedMessages: queued,
    queueCount: queued.length,
    ...partial,
  };
}

describe("useQueuedDispatch", () => {
  it("drains the head when waiting transitions false and hands off to sendChat", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();

    const idleTab = tabWithQueue(
      { waiting: false },
      { id: "q1", content: "go" },
    );
    renderHook(() =>
      useQueuedDispatch({ tabs: [idleTab], sendChat, updateTab }),
    );

    expect(updateTab).toHaveBeenCalledTimes(1);
    const [tabId, mutator] = updateTab.mock.calls[0];
    expect(tabId).toBe("tab-1");
    const next = mutator(idleTab);
    expect(next.queuedMessages).toEqual([]);
    expect(next.queueCount).toBe(0);
    // CRITICAL: do NOT pre-flip waiting=true here — sendChat reads
    // stateRef synchronously, and would see the tab as busy if we
    // did, routing the popped message right back into the queue.
    // `sendChat`'s normal-dispatch path will set waiting=true; the
    // pop + dispatch setStates batch into one render commit, so
    // there's no visible Send-button flash either.
    expect(next.waiting).toBe(false);
    expect(sendChat).toHaveBeenCalledWith("go", {
      mode: "normal",
      tabId: "tab-1",
    });
  });

  it("forwards a queued entry's hidden bridgeText to sendChat on drain", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();
    const tab = tabWithQueue({ waiting: false });
    tab.queuedMessages = [
      {
        id: "q1",
        content: "review the diff",
        bridgeText: "review the diff\n<expanded>",
      },
    ];
    tab.queueCount = 1;
    renderHook(() => useQueuedDispatch({ tabs: [tab], sendChat, updateTab }));

    // Visible body drives history (first arg); hidden bridge text is what
    // actually reaches the bridge so the expansion isn't lost on drain.
    expect(sendChat).toHaveBeenCalledWith("review the diff", {
      mode: "normal",
      tabId: "tab-1",
      bridgeText: "review the diff\n<expanded>",
    });
  });

  it("does nothing while the tab is still waiting", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();
    const busy = tabWithQueue({ waiting: true }, { id: "q1", content: "wait" });
    renderHook(() => useQueuedDispatch({ tabs: [busy], sendChat, updateTab }));
    expect(sendChat).not.toHaveBeenCalled();
    expect(updateTab).not.toHaveBeenCalled();
  });

  it("does nothing while a tool-card is still running after waiting drifted false", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();
    const busy = tabWithQueue(
      {
        waiting: false,
        messages: [
          {
            id: "tool-message",
            role: "agent",
            a2ui: {
              components: [
                {
                  id: "tool-1",
                  type: "tool-card",
                  props: { title: "bash", startedAt: 1_000 },
                },
              ],
            },
          },
        ],
      },
      { id: "q1", content: "wait" },
    );
    renderHook(() => useQueuedDispatch({ tabs: [busy], sendChat, updateTab }));
    expect(sendChat).not.toHaveBeenCalled();
    expect(updateTab).not.toHaveBeenCalled();
  });

  it("does nothing while a queued steer is in flight", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();
    const tab = tabWithQueue(
      { waiting: false, queuedSteeringId: "q1" },
      { id: "q1", content: "steered" },
    );
    renderHook(() => useQueuedDispatch({ tabs: [tab], sendChat, updateTab }));
    expect(sendChat).not.toHaveBeenCalled();
    expect(updateTab).not.toHaveBeenCalled();
  });

  it("ignores shell tabs even if their queue arrays are populated", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();
    const shell = tabWithQueue(
      {
        kind: "shell",
        waiting: false,
        shell: {
          cwd: "/tmp",
          command: "bash",
          args: [],
          shareMode: "private",
          shellState: "running",
        },
      },
      { id: "q1", content: "x" },
    );
    renderHook(() => useQueuedDispatch({ tabs: [shell], sendChat, updateTab }));
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("tolerates pre-feature tabs lacking queuedMessages", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();
    // Simulate a persisted-from-disk tab that pre-dates the field.
    const legacyTab = {
      ...makeEmptyTab("tab-1", "Tab 1"),
      // Deliberately drop the field so the hook sees undefined.
      queuedMessages: undefined as unknown as Tab["queuedMessages"],
    };
    expect(() => {
      renderHook(() =>
        useQueuedDispatch({ tabs: [legacyTab], sendChat, updateTab }),
      );
    }).not.toThrow();
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("clears the dispatching guard after sendChat resolves so the next drain fires", async () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();

    // First pass: queue has one item, tab idle.
    const tabA = tabWithQueue({ waiting: false }, { id: "q1", content: "one" });
    const { rerender } = renderHook(
      ({ tabs }: { tabs: Tab[] }) =>
        useQueuedDispatch({ tabs, sendChat, updateTab }),
      { initialProps: { tabs: [tabA] } },
    );

    // Let the sendChat microtask resolve so the dispatching guard clears.
    await act(async () => {
      await Promise.resolve();
    });

    expect(sendChat).toHaveBeenCalledTimes(1);

    // Second pass: simulate the agent finishing its turn (waiting flips
    // back to false) with a new head in the queue. The guard must not
    // block the second drain.
    const tabB = tabWithQueue({ waiting: false }, { id: "q2", content: "two" });
    rerender({ tabs: [tabB] });
    expect(sendChat).toHaveBeenLastCalledWith("two", {
      mode: "normal",
      tabId: "tab-1",
    });
  });
});
