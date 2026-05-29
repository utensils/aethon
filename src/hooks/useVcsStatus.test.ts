// @vitest-environment jsdom
/**
 * useVcsStatus assembles the `/vcs` slice from git_status + git_file_status
 * (Tauri) and the PR/CI caches. These tests mock all four sources and assert
 * the shape the surfaces read: change breakdown, PR pick, CI gating, and the
 * null-root collapse.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { invokeMock, branchMock, checksMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  branchMock: vi.fn(),
  checksMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../ghBranchStatusCache", () => ({ getGhBranchStatus: branchMock }));
vi.mock("../ghChecksCache", () => ({ getGhChecks: checksMock }));

import { useVcsStatus, type VcsSlice } from "./useVcsStatus";

/** A setState double that applies the functional-update form and records
 *  the latest `/vcs` slice the hook wrote. */
function makeSetState() {
  let store: Record<string, unknown> = {};
  const setState = (
    u:
      | Record<string, unknown>
      | ((s: Record<string, unknown>) => Record<string, unknown>),
  ) => {
    store = typeof u === "function" ? u(store) : u;
  };
  return { setState, vcs: () => store.vcs as VcsSlice | undefined };
}

beforeEach(() => {
  invokeMock.mockReset();
  branchMock.mockReset();
  checksMock.mockReset();
});

describe("useVcsStatus", () => {
  it("collapses to an empty slice when activeRoot is null", async () => {
    const h = makeSetState();
    renderHook(() => useVcsStatus({ activeRoot: null, setState: h.setState }));
    await waitFor(() => expect(h.vcs()).toBeTruthy());
    const vcs = h.vcs()!;
    expect(vcs.root).toBeNull();
    expect(vcs.branch).toBeNull();
    expect(vcs.loading).toBe(false);
    expect(vcs.changes.total).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("assembles branch, change breakdown, PR and CI for a git root", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "git_status")
        return Promise.resolve({ branch: "feat/x", ahead: 2, behind: 1, dirty: true });
      if (cmd === "git_file_status")
        return Promise.resolve([
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "added" },
          { path: "c.ts", status: "deleted" },
          { path: "d.ts", status: "modified" },
        ]);
      return Promise.resolve(null);
    });
    branchMock.mockResolvedValue({
      ghAvailable: true,
      repo: "owner/repo",
      pushed: true,
      worktreeBroken: false,
      prs: [
        {
          number: 9,
          state: "OPEN",
          title: "Feature X",
          url: "https://gh/pr/9",
          isDraft: false,
          merged: false,
          baseRefName: "main",
        },
      ],
    });
    checksMock.mockResolvedValue({
      ghAvailable: true,
      repo: "owner/repo",
      conclusion: "failure",
      total: 4,
      passed: 3,
      failed: 1,
      pending: 0,
      skipped: 0,
      checks: [{ name: "lint", status: "completed", conclusion: "failure", url: "u" }],
    });

    const h = makeSetState();
    renderHook(() =>
      useVcsStatus({ activeRoot: "/repo", setState: h.setState }),
    );

    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    const vcs = h.vcs()!;
    expect(vcs.root).toBe("/repo");
    expect(vcs.branch).toBe("feat/x");
    expect(vcs.ahead).toBe(2);
    expect(vcs.behind).toBe(1);
    expect(vcs.dirty).toBe(true);
    expect(vcs.changes).toMatchObject({ total: 4, modified: 2, added: 1, deleted: 1 });
    expect(vcs.changes.files).toHaveLength(4);
    expect(vcs.ghAvailable).toBe(true);
    expect(vcs.pr).toMatchObject({ number: 9, state: "OPEN" });
    expect(vcs.ci).toMatchObject({ conclusion: "failure", failed: 1, total: 4 });
    // git_status + git_file_status, PR/CI come from the (mocked) caches.
    expect(branchMock).toHaveBeenCalledWith("/repo", "feat/x");
    expect(checksMock).toHaveBeenCalledWith("/repo", "feat/x");
  });

  it("skips PR/CI lookups when there is no branch", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_file_status" ? Promise.resolve([]) : Promise.resolve(null),
    );
    const h = makeSetState();
    renderHook(() =>
      useVcsStatus({ activeRoot: "/not-a-repo", setState: h.setState }),
    );
    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    const vcs = h.vcs()!;
    expect(vcs.branch).toBeNull();
    expect(vcs.pr).toBeNull();
    expect(vcs.ci).toBeNull();
    expect(branchMock).not.toHaveBeenCalled();
    expect(checksMock).not.toHaveBeenCalled();
  });

  it("fetches a newly selected root even while the previous poll is in flight", async () => {
    // Regression: the in-flight guard must be effect-scoped, not a
    // component-wide ref. Root "/a"'s poll hangs forever; switching to "/b"
    // must still fetch immediately instead of bailing on a shared guard and
    // leaving "/b" stuck on the loading shell.
    invokeMock.mockImplementation((_cmd: string, args: { path?: string; root?: string }) => {
      const root = args?.path ?? args?.root;
      if (root === "/a") return new Promise(() => {}); // never resolves
      if (_cmd === "git_status")
        return Promise.resolve({ branch: "b-branch", ahead: 0, behind: 0, dirty: false });
      if (_cmd === "git_file_status") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    branchMock.mockResolvedValue({
      ghAvailable: false,
      repo: null,
      pushed: false,
      worktreeBroken: false,
      prs: [],
    });
    checksMock.mockResolvedValue({
      ghAvailable: false,
      repo: null,
      conclusion: null,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      checks: [],
    });

    const h = makeSetState();
    const { rerender } = renderHook(
      ({ root }: { root: string }) =>
        useVcsStatus({ activeRoot: root, setState: h.setState }),
      { initialProps: { root: "/a" } },
    );
    // "/a"'s poll is hanging; switch to "/b" mid-flight.
    rerender({ root: "/b" });
    await waitFor(() => expect(h.vcs()?.root).toBe("/b"));
    await waitFor(() => expect(h.vcs()?.branch).toBe("b-branch"));
    expect(h.vcs()?.loading).toBe(false);
  });

  it("treats a 'none' CI conclusion as no CI signal", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_status"
        ? Promise.resolve({ branch: "main", ahead: 0, behind: 0, dirty: false })
        : Promise.resolve(cmd === "git_file_status" ? [] : null),
    );
    branchMock.mockResolvedValue({
      ghAvailable: true,
      repo: "owner/repo",
      pushed: true,
      worktreeBroken: false,
      prs: [],
    });
    checksMock.mockResolvedValue({
      ghAvailable: true,
      repo: "owner/repo",
      conclusion: "none",
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      checks: [],
    });
    const h = makeSetState();
    renderHook(() => useVcsStatus({ activeRoot: "/repo", setState: h.setState }));
    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    const vcs = h.vcs()!;
    // gh is reachable (so ghAvailable stays true) but there are no checks.
    expect(vcs.ghAvailable).toBe(true);
    expect(vcs.ci).toBeNull();
  });
});
