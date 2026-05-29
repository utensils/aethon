// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import type { ProjectsState } from "../projects";
import type { Tab } from "../types/tab";

const saveEditorTabsForProject = vi.fn(
  (_activeId: string | null, _tabs: unknown, _activeTabId: unknown) =>
    Promise.resolve(),
);
vi.mock("../editorTabs", () => ({
  saveEditorTabsForProject: (
    activeId: string | null,
    tabs: unknown,
    activeTabId: unknown,
  ) => saveEditorTabsForProject(activeId, tabs, activeTabId),
}));

import { usePersistEditorTabs } from "./usePersistEditorTabs";

function ref<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

function projects(activeId: string | null): ProjectsState {
  return { activeId } as unknown as ProjectsState;
}

function tab(id: string): Tab {
  return { id } as unknown as Tab;
}

beforeEach(() => {
  vi.useFakeTimers();
  saveEditorTabsForProject.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePersistEditorTabs", () => {
  it("does not persist until projects have loaded", () => {
    const stateRef = ref<Record<string, unknown>>({
      tabs: [tab("a")],
      activeTabId: "a",
    });
    renderHook(() =>
      usePersistEditorTabs({
        stateRef,
        projectsRef: ref(projects("projA")),
        projectsLoadedRef: ref(false),
        tabsSignal: stateRef.current.tabs,
        activeTabId: "a",
      }),
    );
    vi.advanceTimersByTime(5000);
    expect(saveEditorTabsForProject).not.toHaveBeenCalled();
  });

  it("debounces a save of the active project's tabs", () => {
    const stateRef = ref<Record<string, unknown>>({
      tabs: [tab("a")],
      activeTabId: "a",
    });
    renderHook(() =>
      usePersistEditorTabs({
        stateRef,
        projectsRef: ref(projects("projA")),
        projectsLoadedRef: ref(true),
        tabsSignal: stateRef.current.tabs,
        activeTabId: "a",
      }),
    );
    expect(saveEditorTabsForProject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(saveEditorTabsForProject).toHaveBeenCalledWith(
      "projA",
      [tab("a")],
      "a",
    );
  });

  it("flushes the outgoing project's tabs when the project switches mid-debounce", () => {
    const tabsA = [tab("a1"), tab("a2")];
    const tabsB = [tab("b1")];
    const stateRef = ref<Record<string, unknown>>({
      tabs: tabsA,
      activeTabId: "a1",
    });
    const projectsRef = ref(projects("projA"));

    const { rerender } = renderHook(
      (props: { tabsSignal: unknown; activeTabId: unknown }) =>
        usePersistEditorTabs({
          stateRef,
          projectsRef,
          projectsLoadedRef: ref(true),
          tabsSignal: props.tabsSignal,
          activeTabId: props.activeTabId,
        }),
      { initialProps: { tabsSignal: tabsA, activeTabId: "a1" } },
    );

    // Switch to project B before the debounce fires: state + active project
    // now reflect B, and the trigger props change.
    stateRef.current = { tabs: tabsB, activeTabId: "b1" };
    projectsRef.current = projects("projB");
    rerender({ tabsSignal: tabsB, activeTabId: "b1" });

    // The outgoing project's tabs (A's snapshot) must be flushed immediately,
    // not lost — using A's id and A's tabs, not B's.
    expect(saveEditorTabsForProject).toHaveBeenCalledWith("projA", tabsA, "a1");
  });

  it("does not flush on a same-project change (debounce cancels cleanly)", () => {
    const tabsA1 = [tab("a1")];
    const tabsA2 = [tab("a1"), tab("a2")];
    const stateRef = ref<Record<string, unknown>>({
      tabs: tabsA1,
      activeTabId: "a1",
    });
    const projectsRef = ref(projects("projA"));

    const { rerender } = renderHook(
      (props: { tabsSignal: unknown; activeTabId: unknown }) =>
        usePersistEditorTabs({
          stateRef,
          projectsRef,
          projectsLoadedRef: ref(true),
          tabsSignal: props.tabsSignal,
          activeTabId: props.activeTabId,
        }),
      { initialProps: { tabsSignal: tabsA1, activeTabId: "a1" } },
    );

    // A second change in the SAME project before the debounce fires.
    stateRef.current = { tabs: tabsA2, activeTabId: "a2" };
    rerender({ tabsSignal: tabsA2, activeTabId: "a2" });
    // No immediate flush — same project, the cleanup just cancels.
    expect(saveEditorTabsForProject).not.toHaveBeenCalled();

    // The surviving debounce persists the latest tabs once.
    vi.advanceTimersByTime(600);
    expect(saveEditorTabsForProject).toHaveBeenCalledTimes(1);
    expect(saveEditorTabsForProject).toHaveBeenCalledWith(
      "projA",
      tabsA2,
      "a2",
    );
  });
});
