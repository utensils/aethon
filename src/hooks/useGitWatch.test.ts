// @vitest-environment jsdom
/**
 * useGitWatch owns the Rust git-state watcher lifecycle: it starts a watcher
 * for the active project/worktree root and tears it down when the root changes
 * or the hook unmounts. These tests assert the start/stop invoke contract.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useGitWatch } from "./useGitWatch";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("useGitWatch", () => {
  it("does nothing for a null root", () => {
    renderHook(() => useGitWatch(null));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("starts a watcher for the active root", async () => {
    renderHook(() => useGitWatch("/repo"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_watch_root", {
        root: "/repo",
      }),
    );
  });

  it("unwatches the prior root when the root changes", async () => {
    const { rerender } = renderHook(
      ({ root }: { root: string | null }) => useGitWatch(root),
      { initialProps: { root: "/repo-a" } },
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_watch_root", {
        root: "/repo-a",
      }),
    );
    rerender({ root: "/repo-b" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_unwatch_root", {
        root: "/repo-a",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_watch_root", {
        root: "/repo-b",
      }),
    );
  });

  it("unwatches on unmount", async () => {
    const { unmount } = renderHook(() => useGitWatch("/repo"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_watch_root", {
        root: "/repo",
      }),
    );
    unmount();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_unwatch_root", {
        root: "/repo",
      }),
    );
  });
});
