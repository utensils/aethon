// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";
import { OVERVIEW_TAB_ID } from "../../types/tab";
import { makeEmptyTab } from "../../types/tab";
import { useMutations } from "./mutations";

function setup(state: Record<string, unknown>) {
  const stateRef = { current: state };
  const setState = vi.fn((updater: SetStateAction<Record<string, unknown>>) => {
    if (typeof updater === "function") {
      stateRef.current = updater(stateRef.current);
    } else {
      stateRef.current = updater;
    }
  });
  const { result } = renderHook(() => useMutations({ stateRef, setState }));
  return { actions: result.current, stateRef, setState };
}

describe("useMutations setActiveTab", () => {
  it("activates the overview sentinel even though it is not a real tab", () => {
    const tab = makeEmptyTab("tab-1", "Session", null, "agent");
    const { actions, stateRef, setState } = setup({
      tabs: [tab],
      activeTabId: "tab-1",
      landing: { kind: "workspace", workspaceId: "wt-1" },
      messages: [{ role: "user", text: "hello" }],
    });

    act(() => actions.setActiveTab(OVERVIEW_TAB_ID));

    expect(setState).toHaveBeenCalledTimes(1);
    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(stateRef.current.landing).toBeNull();
    expect(stateRef.current.messages).toEqual([
      { role: "user", text: "hello" },
    ]);
  });

  it("clears a completed-turn attention marker when selecting that tab", () => {
    const tab = makeEmptyTab("tab-1", "Session", null, "agent");
    const { actions, stateRef } = setup({
      tabs: [tab],
      activeTabId: OVERVIEW_TAB_ID,
      agentAttentionTabs: { "tab-1": true, other: true },
    });

    act(() => actions.setActiveTab("tab-1"));

    expect(stateRef.current.activeTabId).toBe("tab-1");
    expect(stateRef.current.agentAttentionTabs).toEqual({ other: true });
  });
});
