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

  it("restores overview model defaults when activating the overview sentinel", () => {
    const shell = {
      ...makeEmptyTab("shell-1", "Shell", "p1", "shell"),
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    };
    const { actions, stateRef } = setup({
      tabs: [shell],
      activeTabId: "shell-1",
      project: { id: "p1" },
      defaultModel: "openai-codex/gpt-5.5",
      piDefaultModel: "openai-codex/gpt-5.5",
      defaultThinkingLevel: "medium",
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    });

    act(() => actions.setActiveTab(OVERVIEW_TAB_ID));

    expect(stateRef.current.activeTabId).toBe(OVERVIEW_TAB_ID);
    expect(stateRef.current.landing).toBeNull();
    expect(stateRef.current.model).toBe("openai-codex/gpt-5.5");
    expect(stateRef.current.thinkingLevel).toBe("medium");
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

  it("uses overview defaults instead of shell metadata when a shell tab is selected", () => {
    const shell = {
      ...makeEmptyTab("shell-1", "Shell", "p1", "shell"),
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    };
    const { actions, stateRef } = setup({
      tabs: [shell],
      activeTabId: OVERVIEW_TAB_ID,
      project: { id: "p1" },
      defaultModel: "openai-codex/gpt-5.5",
      piDefaultModel: "openai-codex/gpt-5.5",
      defaultThinkingLevel: "medium",
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "medium",
    });

    act(() => actions.setActiveTab("shell-1"));

    expect(stateRef.current.activeTabId).toBe("shell-1");
    expect(stateRef.current.kind).toBe("shell");
    expect(stateRef.current.model).toBe("openai-codex/gpt-5.5");
    expect(stateRef.current.thinkingLevel).toBe("medium");
  });
});
