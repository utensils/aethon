// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProjectsState } from "../projects";
import type { Tab } from "../types/tab";
import type { TabBucket } from "./projectOps/types";
import { useRoutedTabHelpers } from "./useRoutedTabHelpers";

const ref = <T,>(value: T) => ({ current: value });

const agentTab = (id: string, projectId: string | null = null): Tab => ({
  id,
  kind: "agent",
  label: id,
  messages: [],
  draft: "",
  waiting: false,
  queueCount: 0,
  queuedMessages: [],
  canvas: null,
  model: "gpt",
  terminalBuffer: "",
  projectId,
});

function makeProjects(): ProjectsState {
  return {
    projects: [],
    activeId: "project-1",
    activeWorkspaceId: null,
    workspacesByProject: {},
    activeHostId: null,
  };
}

function makeHarness(seed: {
  state: Record<string, unknown>;
  buckets?: [string, TabBucket][];
  projects?: ProjectsState;
}) {
  let state = seed.state;
  const stateRef = ref(state);
  const setState = (
    next:
      | Record<string, unknown>
      | ((prev: Record<string, unknown>) => Record<string, unknown>),
  ) => {
    state = typeof next === "function" ? next(state) : next;
    stateRef.current = state;
  };
  return {
    get state() {
      return state;
    },
    setState,
    stateRef,
    projectsRef: ref(seed.projects ?? makeProjects()),
    tabBucketsRef: ref(new Map(seed.buckets ?? [])),
  };
}

describe("useRoutedTabHelpers", () => {
  it("updates and finds visible tabs while refreshing the active tab mirror", () => {
    const visible = agentTab("visible-tab");
    const ctx = makeHarness({
      state: {
        tabs: [visible],
        activeTabId: "visible-tab",
        draft: visible.draft,
      },
    });

    const { result } = renderHook(() => useRoutedTabHelpers(ctx));

    act(() => {
      result.current.updateTabRouted("visible-tab", (tab) => ({
        ...tab,
        draft: "Mirrored draft",
        label: "Renamed",
      }));
    });

    expect(result.current.findTabRouted("visible-tab")?.label).toBe("Renamed");
    expect(ctx.state.tabs).toMatchObject([{ id: "visible-tab", label: "Renamed" }]);
    expect(ctx.state.draft).toBe("Mirrored draft");
  });

  it("updates and finds hidden bucket tabs without replacing visible tabs", () => {
    const visible = agentTab("visible-tab");
    const hidden = agentTab("hidden-tab");
    const ctx = makeHarness({
      state: { tabs: [visible], activeTabId: "visible-tab" },
      buckets: [
        [
          "project-2",
          {
            tabs: [hidden],
            activeTabId: "hidden-tab",
          },
        ],
      ],
    });

    const { result } = renderHook(() => useRoutedTabHelpers(ctx));

    act(() => {
      result.current.updateTabRouted("hidden-tab", (tab) => ({
        ...tab,
        label: "Hidden renamed",
      }));
    });

    expect(ctx.state.tabs).toEqual([visible]);
    expect(result.current.findTabRouted("hidden-tab")?.label).toBe(
      "Hidden renamed",
    );
    expect(ctx.state.persistedTabBuckets).toMatchObject({
      "project-2": {
        tabs: [{ id: "hidden-tab", label: "Hidden renamed" }],
      },
    });
  });

  it("clears closed issue links from visible state and hidden buckets", () => {
    const visibleOpen = {
      ...agentTab("visible-open", "project-1"),
      sourceIssue: {
        kind: "github-issue" as const,
        projectId: "project-1",
        number: 101,
        url: "https://example.test/101",
        title: "Open",
        createdAt: 1,
      },
    };
    const visibleClosed = {
      ...agentTab("visible-closed", "project-1"),
      sourceIssue: {
        kind: "github-issue" as const,
        projectId: "project-1",
        number: 102,
        url: "https://example.test/102",
        title: "Closed",
        createdAt: 1,
      },
    };
    const hiddenClosed = {
      ...agentTab("hidden-closed", "project-1"),
      sourceIssue: {
        kind: "github-issue" as const,
        projectId: "project-1",
        number: 103,
        url: "https://example.test/103",
        title: "Closed hidden",
        createdAt: 1,
      },
    };
    const ctx = makeHarness({
      state: {
        tabs: [visibleOpen, visibleClosed],
        activeTabId: "visible-open",
      },
      buckets: [
        [
          "project-1::workspace::wt-1",
          { tabs: [hiddenClosed], activeTabId: "hidden-closed" },
        ],
      ],
    });

    const { result } = renderHook(() => useRoutedTabHelpers(ctx));

    act(() => {
      result.current.clearClosedIssueLinksForProject(
        "project-1",
        new Set([101]),
      );
    });

    const tabs = ctx.state.tabs as Tab[];
    expect(tabs[0].sourceIssue?.number).toBe(101);
    expect(tabs[1].sourceIssue).toBeUndefined();
    expect(
      ctx.tabBucketsRef.current.get("project-1::workspace::wt-1")?.tabs[0]
        .sourceIssue,
    ).toBeUndefined();
  });
});
