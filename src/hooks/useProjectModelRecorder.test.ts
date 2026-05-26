// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useProjectModelRecorder } from "./useProjectModelRecorder";
import { makeEmptyTab } from "../types/tab";

describe("useProjectModelRecorder", () => {
  it("records the active tab model under its project id", () => {
    let state: Record<string, unknown> = {
      activeTabId: "tab-1",
      tabs: [
        {
          ...makeEmptyTab("tab-1", "Aethon"),
          projectId: "project-1",
        },
      ],
      projectModels: {},
    };
    const setState = (
      next: typeof state | ((prev: typeof state) => typeof state),
    ) => {
      state = typeof next === "function" ? next(state) : next;
    };
    const { result } = renderHook(() => useProjectModelRecorder(setState));

    act(() => {
      result.current("gpt-5.1");
    });

    expect(state.projectModels).toEqual({ "project-1": "gpt-5.1" });
  });

  it("ignores blank models and tabs without projects", () => {
    let state: Record<string, unknown> = {
      activeTabId: "tab-1",
      tabs: [
        {
          ...makeEmptyTab("tab-1", "No project"),
          projectId: null,
        },
      ],
      projectModels: {},
    };
    const setState = (
      next: typeof state | ((prev: typeof state) => typeof state),
    ) => {
      state = typeof next === "function" ? next(state) : next;
    };
    const { result } = renderHook(() => useProjectModelRecorder(setState));

    act(() => {
      result.current("   ");
      result.current("gpt-5.1");
    });

    expect(state.projectModels).toEqual({});
  });
});
