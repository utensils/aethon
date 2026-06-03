// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useTabNavigation } from "./useTabNavigation";
import { makeEmptyTab, OVERVIEW_TAB_ID, type Tab } from "../types/tab";

interface Fixture {
  tabs: Tab[];
  activeTabId: string;
  activeSubId?: string;
}

function setup(fx: Fixture) {
  const stateRef = {
    current: {
      tabs: fx.tabs,
      activeTabId: fx.activeTabId,
      terminalPanel: fx.activeSubId ? { activeSubId: fx.activeSubId } : {},
    },
  };
  const setState = vi.fn();
  const setActiveTab = vi.fn((id: string) => {
    stateRef.current.activeTabId = id;
  });
  const setActiveSubTab = vi.fn();
  const { result } = renderHook(() =>
    useTabNavigation({ stateRef, setState, setActiveTab, setActiveSubTab }),
  );
  return { stateRef, setState, setActiveTab, actions: result.current };
}

describe("nextTab includes editor tabs", () => {
  it("cycles forward between agent and editor tabs", () => {
    const agentA = makeEmptyTab("agent-a", "Agent A", null, "agent");
    const editor = makeEmptyTab("editor-1", "App.tsx", null, "editor");
    const agentB = makeEmptyTab("agent-b", "Agent B", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [agentA, editor, agentB],
      activeTabId: "agent-a",
    });
    actions.nextTab(1);
    expect(setActiveTab).toHaveBeenLastCalledWith("editor-1");
    actions.nextTab(1);
    expect(setActiveTab).toHaveBeenLastCalledWith("agent-b");
  });

  it("does not wrap forward past the last tab", () => {
    const agentA = makeEmptyTab("agent-a", "Agent A", null, "agent");
    const agentB = makeEmptyTab("agent-b", "Agent B", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [agentA, agentB],
      activeTabId: "agent-b", // already last
    });
    actions.nextTab(1);
    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it("lands on overview when cycling left past the first tab", () => {
    const agentA = makeEmptyTab("agent-a", "Agent A", null, "agent");
    const agentB = makeEmptyTab("agent-b", "Agent B", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [agentA, agentB],
      activeTabId: "agent-a", // first
    });
    actions.nextTab(-1);
    expect(setActiveTab).toHaveBeenLastCalledWith(OVERVIEW_TAB_ID);
  });

  it("stops at overview when cycling left again", () => {
    const agentA = makeEmptyTab("agent-a", "Agent A", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [agentA],
      activeTabId: OVERVIEW_TAB_ID,
    });
    actions.nextTab(-1);
    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it("enters the first tab when cycling right from overview", () => {
    const agentA = makeEmptyTab("agent-a", "Agent A", null, "agent");
    const agentB = makeEmptyTab("agent-b", "Agent B", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [agentA, agentB],
      activeTabId: OVERVIEW_TAB_ID,
    });
    actions.nextTab(1);
    expect(setActiveTab).toHaveBeenLastCalledWith("agent-a");
  });

  it("skips shell sub-tabs", () => {
    const editor = makeEmptyTab("editor-1", "App.tsx", null, "editor");
    const shell = makeEmptyTab("shell-1", "Shell", null, "shell");
    const agent = makeEmptyTab("agent-1", "Agent", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [editor, shell, agent],
      activeTabId: "editor-1",
    });
    actions.nextTab(1);
    expect(setActiveTab).toHaveBeenLastCalledWith("agent-1");
  });

  it("cycles backward to the previous tab", () => {
    const editor = makeEmptyTab("editor-1", "App.tsx", null, "editor");
    const agent = makeEmptyTab("agent-1", "Agent", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [editor, agent],
      activeTabId: "agent-1",
    });
    actions.nextTab(-1);
    expect(setActiveTab).toHaveBeenLastCalledWith("editor-1");
  });
});

describe("moveActiveTab", () => {
  it("reorders top-strip tabs without moving shell slots", () => {
    const agentA = makeEmptyTab("agent-a", "Agent A", null, "agent");
    const shell = makeEmptyTab("shell-1", "Shell", null, "shell");
    const editor = makeEmptyTab("editor-1", "App.tsx", null, "editor");
    const agentB = makeEmptyTab("agent-b", "Agent B", null, "agent");
    const { actions, setState } = setup({
      tabs: [agentA, shell, editor, agentB],
      activeTabId: "agent-b",
    });

    actions.moveActiveTab(-1);

    const reducer = setState.mock.calls[0][0] as (state: {
      tabs: Tab[];
    }) => { tabs: Tab[] };
    const next = reducer({ tabs: [agentA, shell, editor, agentB] });
    expect(next.tabs.map((t) => t.id)).toEqual([
      "agent-a",
      "shell-1",
      "agent-b",
      "editor-1",
    ]);
  });
});

describe("moveActiveShellSubTab", () => {
  it("reorders shell sub-tabs without moving agent/editor slots", () => {
    const agent = makeEmptyTab("agent-1", "Agent", null, "agent");
    const shellA = makeEmptyTab("shell-a", "Shell A", null, "shell");
    const editor = makeEmptyTab("editor-1", "App.tsx", null, "editor");
    const shellB = makeEmptyTab("shell-b", "Shell B", null, "shell");
    const shellC = makeEmptyTab("shell-c", "Shell C", null, "shell");
    const { actions, setState } = setup({
      tabs: [agent, shellA, editor, shellB, shellC],
      activeTabId: "agent-1",
      activeSubId: "shell-c",
    });

    actions.moveActiveShellSubTab(-1);

    const reducer = setState.mock.calls[0][0] as (state: {
      tabs: Tab[];
      terminalPanel: { activeSubId?: string };
    }) => { tabs: Tab[]; terminalPanel: { activeSubId?: string } };
    const next = reducer({
      tabs: [agent, shellA, editor, shellB, shellC],
      terminalPanel: { activeSubId: "shell-c" },
    });
    expect(next.tabs.map((t) => t.id)).toEqual([
      "agent-1",
      "shell-a",
      "editor-1",
      "shell-c",
      "shell-b",
    ]);
    expect(next.terminalPanel.activeSubId).toBe("shell-c");
  });
});

describe("jumpToTab includes editor tabs", () => {
  it("indexes across agent + editor tabs", () => {
    const a = makeEmptyTab("agent-a", "A", null, "agent");
    const editor = makeEmptyTab("editor-1", "B", null, "editor");
    const b = makeEmptyTab("agent-b", "C", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [a, editor, b],
      activeTabId: "agent-a",
    });
    actions.jumpToTab(1);
    expect(setActiveTab).toHaveBeenLastCalledWith("editor-1");
    actions.jumpToTab(2);
    expect(setActiveTab).toHaveBeenLastCalledWith("agent-b");
  });
});
