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
  it("drains the head when waiting transitions false", async () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();

    const idleTab = tabWithQueue({ waiting: false }, { id: "q1", content: "go" });
    renderHook(() =>
      useQueuedDispatch({ tabs: [idleTab], sendChat, updateTab }),
    );

    expect(updateTab).toHaveBeenCalledTimes(1);
    const [tabId, mutator] = updateTab.mock.calls[0];
    expect(tabId).toBe("tab-1");
    const next = mutator(idleTab);
    expect(next.queuedMessages).toEqual([]);
    expect(next.queueCount).toBe(0);
    // Optimistic waiting=true keeps the composer's Stop button asserted
    // across the drain transition so it doesn't flash Send.
    expect(next.waiting).toBe(true);
    expect(sendChat).toHaveBeenCalledWith("go", {
      mode: "normal",
      tabId: "tab-1",
    });
  });

  it("does nothing while the tab is still waiting", () => {
    const sendChat = vi.fn(() => Promise.resolve());
    const updateTab = vi.fn();
    const busy = tabWithQueue({ waiting: true }, { id: "q1", content: "wait" });
    renderHook(() =>
      useQueuedDispatch({ tabs: [busy], sendChat, updateTab }),
    );
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
    renderHook(() =>
      useQueuedDispatch({ tabs: [tab], sendChat, updateTab }),
    );
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
    renderHook(() =>
      useQueuedDispatch({ tabs: [shell], sendChat, updateTab }),
    );
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
    const tabB = tabWithQueue(
      { waiting: false },
      { id: "q2", content: "two" },
    );
    rerender({ tabs: [tabB] });
    expect(sendChat).toHaveBeenLastCalledWith("two", {
      mode: "normal",
      tabId: "tab-1",
    });
  });
});
