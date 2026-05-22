// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useTabNavigation } from "./useTabNavigation";
import { makeEmptyTab, type Tab } from "../types/tab";

interface Fixture {
  tabs: Tab[];
  activeTabId: string;
}

function setup(fx: Fixture) {
  const stateRef = { current: { tabs: fx.tabs, activeTabId: fx.activeTabId } };
  const setState = vi.fn();
  const setActiveTab = vi.fn((id: string) => {
    stateRef.current.activeTabId = id;
  });
  const setActiveSubTab = vi.fn();
  const { result } = renderHook(() =>
    useTabNavigation({ stateRef, setState, setActiveTab, setActiveSubTab }),
  );
  return { stateRef, setActiveTab, actions: result.current };
}

describe("nextTab includes editor tabs", () => {
  it("cycles between agent and editor tabs", () => {
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
    actions.nextTab(1); // wrap
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

  it("wraps backwards across editor + agent tabs", () => {
    const editor = makeEmptyTab("editor-1", "App.tsx", null, "editor");
    const agent = makeEmptyTab("agent-1", "Agent", null, "agent");
    const { actions, setActiveTab } = setup({
      tabs: [editor, agent],
      activeTabId: "editor-1",
    });
    actions.nextTab(-1);
    expect(setActiveTab).toHaveBeenLastCalledWith("agent-1");
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
