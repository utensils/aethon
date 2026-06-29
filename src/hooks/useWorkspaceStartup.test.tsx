// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, useState } from "react";
import { clearTauriMocks, installTauriMocks } from "../test/tauriMocks";
import { useWorkspaceStartup } from "./useWorkspaceStartup";

function useHarness(initial: Record<string, unknown>) {
  const [state, setState] = useState<Record<string, unknown>>(initial);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const startup = useWorkspaceStartup({ state, setState, stateRef });
  return { state, startup };
}

describe("useWorkspaceStartup", () => {
  let tauri: ReturnType<typeof installTauriMocks>;

  beforeEach(() => {
    tauri = installTauriMocks();
  });

  afterEach(() => {
    clearTauriMocks();
  });

  it("clears the visible active root when a prepare status becomes ready", async () => {
    tauri.invoke.mockResolvedValue({
      root: "/repo",
      fingerprint: "abc",
      state: "ready",
      approved: true,
      commands: [
        {
          id: "aethon-devshell",
          label: "Prepare environment",
          required: false,
          state: "ready",
        },
      ],
    });
    const { result } = renderHook(() =>
      useHarness({
        workspaceStartup: {
          activeRoot: "/repo",
          entries: {
            "/repo": {
              root: "/repo",
              fingerprint: "abc",
              state: "running",
              approved: true,
              commands: [],
            },
          },
        },
      }),
    );

    await act(async () => {
      await result.current.startup.prepareWorkspaceStartup("/repo");
    });

    expect(result.current.state.workspaceStartup).toMatchObject({
      activeRoot: null,
      entries: {
        "/repo": expect.objectContaining({ state: "ready" }),
      },
    });
    expect(result.current.startup.view.entry).toBeNull();
  });

  it("clears the visible active root when a status event becomes ready", async () => {
    const { result } = renderHook(() =>
      useHarness({
        workspaceStartup: {
          activeRoot: "/repo",
          entries: {
            "/repo": {
              root: "/repo",
              fingerprint: "abc",
              state: "running",
              approved: true,
              commands: [],
            },
          },
        },
      }),
    );
    await vi.waitFor(() =>
      expect(tauri.handlers.has("workspace-startup-status")).toBe(true),
    );

    act(() => {
      tauri.fireEvent("workspace-startup-status", {
        root: "/repo",
        fingerprint: "abc",
        state: "ready",
        taskId: "aethon-devshell",
        taskLabel: "Prepare environment",
        required: false,
      });
    });

    expect(result.current.state.workspaceStartup).toMatchObject({
      activeRoot: null,
      entries: {
        "/repo": expect.objectContaining({ state: "ready" }),
      },
    });
    expect(result.current.startup.view.entry).toBeNull();
  });
});
