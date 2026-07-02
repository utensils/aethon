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
});
