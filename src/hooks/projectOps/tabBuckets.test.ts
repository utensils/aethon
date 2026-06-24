import type { Dispatch, SetStateAction } from "react";
import { describe, it, expect } from "vitest";
import { makeEmptyTab, type Tab } from "../../types/tab";
import { switchProjectBucket } from "./tabBuckets";
import type { TabBucket } from "./types";
import type { ProjectsState } from "../../projects";

function agentTab(id: string, projectId: string, cwd: string): Tab {
  return {
    ...makeEmptyTab(id, id, projectId, "agent"),
    cwd,
    messages: [{ id: `${id}-m`, role: "user", text: id }],
  };
}

function shellTab(id: string, projectId: string, cwd: string): Tab {
  return {
    ...makeEmptyTab(id, id, projectId, "shell"),
    shell: {
      cwd,
      command: "",
      args: [],
      shareMode: "private",
      shellState: "running",
    },
  };
}

const projects: ProjectsState = {
  projects: [{ id: "P", label: "Project", path: "/P", lastUsed: 1 }],
  activeId: "P",
  activeWorkspaceId: null,
  activeHostId: null,
  workspacesByProject: {
    P: [
      { id: "main", projectId: "P", path: "/P", branch: "main", isMain: true },
      { id: "A", projectId: "P", path: "/P/A", branch: "A", isMain: false },
      { id: "B", projectId: "P", path: "/P/B", branch: "B", isMain: false },
    ],
  },
};

function makeHarness(initial: Record<string, unknown>) {
  let state = initial;
  const stateRef = { current: state };
  const setState: Dispatch<SetStateAction<Record<string, unknown>>> = (
    update,
  ) => {
    state = typeof update === "function" ? update(state) : update;
    stateRef.current = state;
  };
  const tabBucketsRef = { current: new Map<string, TabBucket>() };
  const deps = {
    setState,
    stateRef,
    projects,
    tabBucketsRef,
    buildProjectsMirror: () => ({}),
    dispatchTerminalReplay: () => {},
  };
  return { deps, tabBucketsRef, setState, get: () => state };
}

describe("switchProjectBucket", () => {
  it("keeps each workspace's tabs separate and restores the last-active tab", () => {
    const tabP = agentTab("p-main", "P", "/P");
    const h = makeHarness({ tabs: [tabP], activeTabId: "p-main" });

    // P-main -> workspace A (empty bucket -> overview).
    switchProjectBucket(h.deps, "P", "P::workspace::A");
    expect(h.tabBucketsRef.current.get("P")?.tabs.map((t) => t.id)).toEqual([
      "p-main",
    ]);
    expect((h.get().tabs as Tab[]).length).toBe(0);

    // Open a session in workspace A.
    const tabA = agentTab("a1", "P", "/P/A");
    h.deps.setState((prev) => ({ ...prev, tabs: [tabA], activeTabId: "a1" }));

    // A -> B.
    switchProjectBucket(h.deps, "P::workspace::A", "P::workspace::B");
    expect(
      h.tabBucketsRef.current.get("P::workspace::A")?.tabs.map((t) => t.id),
    ).toEqual(["a1"]);

    // Open a session in workspace B.
    const tabB = agentTab("b1", "P", "/P/B");
    h.deps.setState((prev) => ({ ...prev, tabs: [tabB], activeTabId: "b1" }));

    // B -> back to P-main: should restore p-main, not the landing.
    const restored = switchProjectBucket(h.deps, "P::workspace::B", "P");
    expect(restored).toBe("p-main");
    expect((h.get().tabs as Tab[]).map((t) => t.id)).toEqual(["p-main"]);
    expect(h.get().activeTabId).toBe("p-main");

    // No cross-contamination: each workspace bucket kept only its own tab.
    expect(
      h.tabBucketsRef.current.get("P::workspace::A")?.tabs.map((t) => t.id),
    ).toEqual(["a1"]);
    expect(
      h.tabBucketsRef.current.get("P::workspace::B")?.tabs.map((t) => t.id),
    ).toEqual(["b1"]);
  });

  it("clears a stale landing override when restoring an active tab", () => {
    const tabA = agentTab("a1", "P", "/P/A");
    const h = makeHarness({
      tabs: [],
      activeTabId: undefined,
      landing: { kind: "workspace", workspaceId: "B" },
      messages: [{ id: "stale", role: "user", text: "stale landing" }],
      draft: "stale draft",
    });
    h.tabBucketsRef.current.set("P::workspace::A", {
      tabs: [tabA],
      activeTabId: "a1",
    });

    const restored = switchProjectBucket(
      h.deps,
      "P::workspace::B",
      "P::workspace::A",
    );

    expect(restored).toBe("a1");
    expect(h.get().activeTabId).toBe("a1");
    expect(h.get().landing).toBeNull();
    expect(h.get().messages).toEqual(tabA.messages);
    expect(h.get().draft).toBe(tabA.draft);
  });

  it("clears completed-turn attention when restoring a stashed active tab", () => {
    const tabA = agentTab("a1", "P", "/P/A");
    const h = makeHarness({
      tabs: [],
      activeTabId: undefined,
      agentAttentionTabs: { a1: true, other: true },
    });
    h.tabBucketsRef.current.set("P::workspace::A", {
      tabs: [tabA],
      activeTabId: "a1",
    });

    switchProjectBucket(h.deps, "P::workspace::B", "P::workspace::A");

    expect(h.get().activeTabId).toBe("a1");
    expect(h.get().agentAttentionTabs).toEqual({ other: true });
  });

  it("preserves landing when switching to an empty workspace", () => {
    const h = makeHarness({
      tabs: [],
      activeTabId: undefined,
      landing: { kind: "workspace", workspaceId: "B" },
    });

    switchProjectBucket(h.deps, "P::workspace::B", "P::workspace::A");

    expect(h.get().activeTabId).toBeUndefined();
    expect(h.get().tabs).toEqual([]);
    expect(h.get().landing).toEqual({ kind: "workspace", workspaceId: "B" });
  });

  it("mirrors non-active buckets into state.persistedTabBuckets for persistence", () => {
    const tabP = agentTab("p-main", "P", "/P");
    const h = makeHarness({ tabs: [tabP], activeTabId: "p-main" });

    switchProjectBucket(h.deps, "P", "P::workspace::A");
    const tabA = agentTab("a1", "P", "/P/A");
    h.deps.setState((prev) => ({ ...prev, tabs: [tabA], activeTabId: "a1" }));
    switchProjectBucket(h.deps, "P::workspace::A", "P");

    // Active workspace ("P") lives in state.tabs, so it's excluded from the
    // mirror; the backgrounded workspace A is included with its active tab.
    const mirror = h.get().persistedTabBuckets as Record<
      string,
      { tabs: Tab[]; activeTabId?: string }
    >;
    expect(Object.keys(mirror)).toEqual(["P::workspace::A"]);
    expect(mirror["P::workspace::A"].activeTabId).toBe("a1");
    expect(mirror["P::workspace::A"].tabs.map((t) => t.id)).toEqual(["a1"]);
  });

  it("redistributes visible sibling-workspace tabs before switching buckets", () => {
    const tabA = agentTab("a1", "P", "/P/A");
    const tabB = agentTab("b1", "P", "/P/B");
    const h = makeHarness({
      tabs: [tabA, tabB],
      activeTabId: "a1",
    });

    const restored = switchProjectBucket(
      h.deps,
      "P::workspace::B",
      "P::workspace::A",
    );

    expect(restored).toBe("a1");
    expect((h.get().tabs as Tab[]).map((t) => t.id)).toEqual(["a1"]);
    expect(h.get().activeTabId).toBe("a1");
    expect(
      h.tabBucketsRef.current.get("P::workspace::B")?.tabs.map((t) => t.id),
    ).toEqual(["b1"]);
    expect(
      h.tabBucketsRef.current.get("P::workspace::A")?.tabs.map((t) => t.id),
    ).toEqual(["a1"]);
  });

  it("prefers an agent tab over a shell when choosing a bucket fallback active tab", () => {
    const tabA = agentTab("a1", "P", "/P/A");
    const shellB = shellTab("shell-b", "P", "/P/B");
    const tabB = agentTab("b1", "P", "/P/B");
    const h = makeHarness({
      tabs: [tabA, shellB, tabB],
      activeTabId: "a1",
    });

    switchProjectBucket(h.deps, "P::workspace::A", "P::workspace::B");

    expect(h.get().activeTabId).toBe("b1");
    expect((h.get().tabs as Tab[]).map((t) => t.id)).toEqual(["shell-b", "b1"]);
  });

  it("keeps the overview model when restoring a shell-only project bucket", () => {
    const shellMain = {
      ...shellTab("shell-main", "P", "/P"),
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    };
    const h = makeHarness({
      tabs: [],
      activeTabId: "a1",
      project: { id: "P" },
      defaultModel: "openai-codex/gpt-5.5",
      piDefaultModel: "openai-codex/gpt-5.5",
      defaultThinkingLevel: "medium",
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "medium",
    });
    h.tabBucketsRef.current.set("P", {
      tabs: [shellMain],
      activeTabId: "shell-main",
    });

    const restored = switchProjectBucket(h.deps, "P::workspace::A", "P");

    expect(restored).toBe("shell-main");
    expect(h.get().activeTabId).toBe("shell-main");
    expect(h.get().kind).toBe("shell");
    expect(h.get().model).toBe("openai-codex/gpt-5.5");
    expect(h.get().thinkingLevel).toBe("medium");
  });
});
