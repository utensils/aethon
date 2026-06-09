// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const {
  invokeMock,
  loadCachedStatusesMock,
  persistStatusesDebouncedMock,
  loadGitFetchAttemptsMock,
  persistGitFetchAttemptsDebouncedMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  loadCachedStatusesMock: vi.fn(),
  persistStatusesDebouncedMock: vi.fn(),
  loadGitFetchAttemptsMock: vi.fn(),
  persistGitFetchAttemptsDebouncedMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../gitStatusCache", () => ({
  loadCachedStatuses: loadCachedStatusesMock,
  persistStatusesDebounced: persistStatusesDebouncedMock,
}));
vi.mock("../gitFetchCache", () => ({
  loadGitFetchAttempts: loadGitFetchAttemptsMock,
  persistGitFetchAttemptsDebounced: persistGitFetchAttemptsDebouncedMock,
}));

import { gitStatusEquals, useProjects } from "./useProjects";

beforeEach(() => {
  invokeMock.mockReset();
  loadCachedStatusesMock.mockReset().mockResolvedValue(new Map());
  persistStatusesDebouncedMock.mockReset();
  loadGitFetchAttemptsMock.mockReset().mockResolvedValue(new Map());
  persistGitFetchAttemptsDebouncedMock.mockReset();
});

describe("useProjects", () => {
  it("fetches known project remotes once on startup and refreshes status after success", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "git_fetch_all") return Promise.resolve(true);
      if (cmd === "git_status") {
        return Promise.resolve({ branch: "main", dirty: false, ahead: 0, behind: 1 });
      }
      return Promise.resolve(null);
    });
    const onGitStatusChanged = vi.fn();

    const { unmount } = renderHook(() =>
      useProjects({
        getProjectPaths: () => ["/repo", "/repo"],
        onGitStatusChanged,
      }),
    );

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("git_fetch_all", { projectPath: "/repo" }));
    expect(invokeMock.mock.calls.filter((c) => c[0] === "git_fetch_all")).toHaveLength(1);

    await waitFor(() =>
      expect(invokeMock.mock.calls.filter((c) => c[0] === "git_status").length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(onGitStatusChanged).toHaveBeenCalled());
    expect(persistGitFetchAttemptsDebouncedMock).toHaveBeenCalled();

    unmount();
  });

  it("does not refetch on focus before the persisted cadence expires", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "git_fetch_all"
          ? true
          : { branch: "main", dirty: false, ahead: 0, behind: 0 },
      ),
    );

    const { unmount } = renderHook(() =>
      useProjects({
        getProjectPaths: () => ["/repo"],
        onGitStatusChanged: vi.fn(),
      }),
    );

    await waitFor(() => expect(invokeMock.mock.calls.filter((c) => c[0] === "git_fetch_all")).toHaveLength(1));
    window.dispatchEvent(new FocusEvent("focus"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(invokeMock.mock.calls.filter((c) => c[0] === "git_fetch_all")).toHaveLength(1);
    unmount();
  });

  it("notifies once per changed batch and not at all when nothing changed", async () => {
    const status = { branch: "main", dirty: false, ahead: 0, behind: 0 };
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "git_status" ? { ...status } : false),
    );
    const onGitStatusChanged = vi.fn();

    const { result, unmount } = renderHook(() =>
      useProjects({
        getProjectPaths: () => ["/a", "/b", "/c"],
        onGitStatusChanged,
      }),
    );

    // First batch: all three paths are new entries -> exactly one notify.
    await waitFor(() => expect(onGitStatusChanged).toHaveBeenCalledTimes(1));

    // Second batch with identical statuses -> no further notify.
    await result.current.refreshAllGitStatus();
    expect(onGitStatusChanged).toHaveBeenCalledTimes(1);

    // A real change notifies again.
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "git_status" ? { ...status, dirty: true } : false,
      ),
    );
    await result.current.refreshAllGitStatus();
    expect(onGitStatusChanged).toHaveBeenCalledTimes(2);

    unmount();
  });
});

describe("gitStatusEquals", () => {
  it("compares field-wise and treats both-missing as equal", () => {
    const a = { branch: "main", dirty: false, ahead: 1, behind: 0 };
    expect(gitStatusEquals(a, { ...a })).toBe(true);
    expect(gitStatusEquals(a, { ...a, behind: 2 })).toBe(false);
    expect(gitStatusEquals(undefined, undefined)).toBe(true);
    expect(gitStatusEquals(a, undefined)).toBe(false);
    expect(gitStatusEquals(undefined, a)).toBe(false);
  });
});
