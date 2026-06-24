// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../types/tab";
import { useRootChromeActions } from "./useRootChromeActions";

const agentTab = (patch: Partial<Tab> = {}): Tab =>
  ({ id: "agent-1", kind: "agent", label: "Agent", messages: [], draft: "", ...patch }) as Tab;
const shellTab = (): Tab =>
  ({ id: "shell-1", kind: "shell", label: "Shell", shell: {} }) as Tab;

function statefulSetState(seed: Record<string, unknown>) {
  let state = seed;
  const setState = vi.fn((updater: unknown) => {
    state =
      typeof updater === "function"
        ? (updater as (prev: Record<string, unknown>) => Record<string, unknown>)(
            state,
          )
        : (updater as Record<string, unknown>);
  });
  return { setState, getState: () => state };
}

describe("useRootChromeActions", () => {
  it("toggles plan mode only for the active agent tab and emits the existing notification", () => {
    const stateRef = { current: { activeTabId: "agent-1", tabs: [agentTab()] } };
    const updateActiveTab = vi.fn();
    const pushNotification = vi.fn();
    const { setState } = statefulSetState({});
    const { result } = renderHook(() =>
      useRootChromeActions({
        setState,
        stateRef,
        updateActiveTab,
        pushNotification,
      }),
    );

    act(() => result.current.togglePlanMode());

    expect(updateActiveTab).toHaveBeenCalledTimes(1);
    const mutator = updateActiveTab.mock.calls[0][0] as (tab: Tab) => Tab;
    expect(mutator(agentTab()).planMode).toBe(true);
    expect(pushNotification).toHaveBeenCalledWith({
      title: "Plan mode on",
      message: "New prompts will ask for a plan before code changes.",
      kind: "success",
      durationMs: 1600,
    });
  });

  it("ignores plan mode toggles when the active tab is not an agent", () => {
    const stateRef = { current: { activeTabId: "shell-1", tabs: [shellTab()] } };
    const updateActiveTab = vi.fn();
    const pushNotification = vi.fn();
    const { setState } = statefulSetState({});
    const { result } = renderHook(() =>
      useRootChromeActions({
        setState,
        stateRef,
        updateActiveTab,
        pushNotification,
      }),
    );

    act(() => result.current.togglePlanMode());

    expect(updateActiveTab).not.toHaveBeenCalled();
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it("scheduled-task open and close mutate only scheduledTasks.open", () => {
    const store = statefulSetState({
      keep: true,
      scheduledTasks: { tasks: [{ id: "t1" }], open: false },
    });
    const { result } = renderHook(() =>
      useRootChromeActions({
        setState: store.setState,
        stateRef: { current: {} },
        updateActiveTab: vi.fn(),
        pushNotification: vi.fn(),
      }),
    );

    act(() => result.current.openScheduledTasks());
    expect(store.getState()).toEqual({
      keep: true,
      scheduledTasks: { tasks: [{ id: "t1" }], open: true },
    });

    act(() => result.current.closeScheduledTasks());
    expect(store.getState()).toEqual({
      keep: true,
      scheduledTasks: { tasks: [{ id: "t1" }], open: false },
    });
  });

  it("account modal toggle preserves existing auth modal state", () => {
    const store = statefulSetState({
      authProfiles: {
        activeId: "work",
        modal: { open: false, provider: "openai", step: "choose" },
      },
    });
    const { result } = renderHook(() =>
      useRootChromeActions({
        setState: store.setState,
        stateRef: { current: {} },
        updateActiveTab: vi.fn(),
        pushNotification: vi.fn(),
      }),
    );

    act(() => result.current.toggleAccounts());

    expect(store.getState()).toEqual({
      authProfiles: {
        activeId: "work",
        modal: { open: true, provider: "openai", step: "choose" },
      },
    });
  });
});
