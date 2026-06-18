// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeEmptyTab, type Tab } from "../types/tab";
import { useNotifications } from "./useNotifications";

function ref<T>(current: T): { current: T } {
  return { current };
}

function hiddenAgentTab(): Tab {
  return {
    ...makeEmptyTab("hidden", "NXV publish", "nxv", "agent"),
    cwd: "/repo/nxv",
    messages: [
      {
        id: "done",
        role: "agent",
        text: "Workflow lint is clean. Waiting for your next instruction.",
      },
    ],
  };
}

describe("useNotifications", () => {
  it("names completed background workspace turns in the in-app toast", async () => {
    const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let state: Record<string, unknown> = {
      activeTabId: "koban",
      tabs: [makeEmptyTab("koban", "koban", "koban", "agent")],
      persistedTabBuckets: {
        "nxv::workspace::publish": {
          tabs: [hiddenAgentTab()],
          activeTabId: "hidden",
        },
      },
    };
    const setState = vi.fn((update) => {
      state = typeof update === "function" ? update(state) : update;
      stateRef.current = state;
    });
    const stateRef = ref(state);
    const { result } = renderHook(() =>
      useNotifications({
        setState,
        stateRef,
        notifyOnCompletionRef: ref(true),
        notifyMinDurationMsRef: ref(0),
        resolveShellWriteConsent: vi.fn(),
        resolveShellCloseConsent: vi.fn(),
        resolveWorkspacePrompt: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.maybeFireCompletionNotification({
        tabId: "hidden",
        turnDurationMs: 1,
      });
    });

    expect(state.notifications).toEqual([
      expect.objectContaining({
        id: "agent-complete:hidden",
        title: "NXV publish — ready for your reply",
        message: "Workflow lint is clean. Waiting for your next instruction.",
        durationMs: 10000,
        actions: [{ label: "View", action: "activate-tab:hidden" }],
      }),
    ]);
    focusSpy.mockRestore();
  });
});
