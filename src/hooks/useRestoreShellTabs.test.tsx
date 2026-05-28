// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { makeEmptyTab, type Tab } from "../types/tab";
import { useRestoreShellTabs } from "./useRestoreShellTabs";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function shellTab(overrides: Partial<Tab["shell"]> = {}): Tab {
  return {
    ...makeEmptyTab("shell-1", "Shell", null, "shell"),
    shell: {
      cwd: "/repo/app",
      command: "zsh",
      args: ["-l"],
      shareMode: "read",
      shellState: "starting",
      restartOnMount: true,
      ...overrides,
    },
  };
}

function renderRestoreHook(args?: {
  tabs?: Tab[];
  inheritEnv?: boolean;
  updateTab?: (tabId: string, mutator: (tab: Tab) => Tab) => void;
  appendSystem?: (text: string) => void;
}) {
  const updateTab =
    args?.updateTab ??
    vi.fn((_tabId: string, _mutator: (tab: Tab) => Tab) => undefined);
  const appendSystem = args?.appendSystem ?? vi.fn();
  const shellInheritEnvRef: MutableRefObject<boolean> = {
    current: args?.inheritEnv ?? true,
  };
  renderHook(() =>
    useRestoreShellTabs({
      tabs: args?.tabs ?? [shellTab()],
      updateTab,
      appendSystem,
      shellInheritEnvRef,
    }),
  );
  return { updateTab, appendSystem };
}

describe("useRestoreShellTabs", () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("reopens restored shell tabs with the original tab id and cwd", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const updateTab = vi.fn();

    renderRestoreHook({ updateTab });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("shell_open", {
        args: {
          tabId: "shell-1",
          command: "zsh",
          args: ["-l"],
          cwd: "/repo/app",
          shareMode: "read",
        },
      });
    });

    await waitFor(() => {
      expect(updateTab).toHaveBeenCalledWith("shell-1", expect.any(Function));
    });
    const restored = updateTab.mock.calls.at(-1)?.[1](shellTab());
    expect(restored.shell).toMatchObject({ shellState: "running" });
    expect(restored.shell?.restartOnMount).toBeUndefined();
  });

  it("treats an already-open Rust PTY as a successful webview reattach", async () => {
    vi.mocked(invoke).mockRejectedValue(
      new Error("shell already open for tab shell-1"),
    );
    const updateTab = vi.fn();
    const appendSystem = vi.fn();

    renderRestoreHook({ updateTab, appendSystem });

    await waitFor(() => {
      expect(updateTab).toHaveBeenCalledWith("shell-1", expect.any(Function));
    });
    expect(appendSystem).not.toHaveBeenCalled();
    const restored = updateTab.mock.calls.at(-1)?.[1](shellTab());
    expect(restored.shell).toMatchObject({ shellState: "running" });
    expect(restored.shell?.restartOnMount).toBeUndefined();
  });

  it("surfaces real restore failures and marks the tab exited", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("spawn failed"));
    const updateTab = vi.fn();
    const appendSystem = vi.fn();

    renderRestoreHook({ updateTab, appendSystem });

    await waitFor(() => {
      expect(appendSystem).toHaveBeenCalledWith(
        "Failed to restore shell tab: Error: spawn failed",
      );
    });
    const restored = updateTab.mock.calls.at(-1)?.[1](shellTab());
    expect(restored.shell).toMatchObject({
      shellState: "exited",
      exitCode: -1,
    });
    expect(restored.shell?.restartOnMount).toBeUndefined();
  });
});
