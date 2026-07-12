// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMocks, type TauriMockHarness } from "../test/tauriMocks";
import { useFrontendStateMirror } from "./useFrontendStateMirror";

describe("useFrontendStateMirror", () => {
  let harness: TauriMockHarness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = installTauriMocks();
    document.documentElement.dataset.theme = "brink";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mirrors the active theme in the remote control snapshot", async () => {
    renderHook(() =>
      useFrontendStateMirror({
        state: {
          connection: "connected",
          model: "gpt",
          sidebar: { models: [], themes: [] },
          tabs: [],
        },
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(harness.invoke).toHaveBeenCalledWith("control_update_state", {
      snapshot: expect.objectContaining({ theme: "brink" }),
    });
  });

  it("resends every watched slice immediately after the bridge reloads", async () => {
    renderHook(() =>
      useFrontendStateMirror({
        state: {
          connection: "connected",
          model: "gpt",
          sidebar: { models: [], themes: [] },
          tabs: [],
        },
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    const initialPatchCount = harness.invoke.mock.calls.filter(
      ([command]) => command === "agent_command",
    ).length;
    harness.invoke.mockClear();

    act(() => {
      expect(harness.fireEvent("agent-reloaded", "global")).toBe(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      harness.invoke.mock.calls.filter(([command]) => command === "agent_command"),
    ).toHaveLength(initialPatchCount);
    expect(harness.invoke).toHaveBeenCalledWith(
      "control_update_state",
      expect.objectContaining({
        snapshot: expect.objectContaining({ connection: "connected" }),
      }),
    );
  });

  it("retries a rejected slice patch without requiring another state change", async () => {
    let draftAttempts = 0;
    harness.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command !== "agent_command") return Promise.resolve(undefined);
      const payload = JSON.parse(
        (args as { payload: string }).payload,
      ) as { path: string };
      if (payload.path !== "/draft") return Promise.resolve(undefined);
      draftAttempts += 1;
      return draftAttempts === 1
        ? Promise.reject(new Error("bridge unavailable"))
        : Promise.resolve(undefined);
    });

    renderHook(() =>
      useFrontendStateMirror({
        state: {
          connection: "connected",
          draft: "keep me",
          sidebar: { models: [], themes: [] },
          tabs: [],
        },
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(draftAttempts).toBe(2);
  });
});
