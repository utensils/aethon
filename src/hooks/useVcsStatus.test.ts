// @vitest-environment jsdom
/**
 * useVcsStatus assembles the `/vcs` slice from git_status + git_file_status
 * (Tauri) and the PR/CI caches. These tests mock all four sources and assert
 * the shape the surfaces read: change breakdown, PR pick, CI gating, and the
 * null-root collapse.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { invokeMock, remoteInvokeMock, branchMock, checksMock, listenMock, gitEventHandlers } =
  vi.hoisted(() => {
    const gitEventHandlers: Array<(e: { payload: unknown }) => void> = [];
    return {
      invokeMock: vi.fn(),
      remoteInvokeMock: vi.fn(),
      branchMock: vi.fn(),
      checksMock: vi.fn(),
      gitEventHandlers,
      listenMock: vi.fn(
        (event: string, handler: (e: { payload: unknown }) => void) => {
          if (event === "git-state-changed") gitEventHandlers.push(handler);
          return Promise.resolve(() => {});
        },
      ),
    };
  });

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../services/remote", () => ({ remoteHostInvoke: remoteInvokeMock }));
vi.mock("../ghBranchStatusCache", () => ({ getGhBranchStatus: branchMock }));
vi.mock("../ghChecksCache", () => ({ getGhChecks: checksMock }));

/** Fire a `git-state-changed` event at every handler the hook registered. */
function emitGitStateChanged(root: string) {
  for (const h of gitEventHandlers) h({ payload: { root } });
}

import { useVcsStatus, type VcsSlice } from "./useVcsStatus";
import { __TEST__ as vcsCacheTest } from "../vcsSliceCache";

/** A setState double that applies the functional-update form and records
 *  the latest `/vcs` slice the hook wrote. */
function makeSetState(opts: { replayFunctionalUpdaters?: boolean } = {}) {
  let store: Record<string, unknown> = {};
  const setState = (
    u:
      | Record<string, unknown>
      | ((s: Record<string, unknown>) => Record<string, unknown>),
  ) => {
    if (typeof u !== "function") {
      store = u;
      return;
    }
    if (opts.replayFunctionalUpdaters) {
      u(store);
    }
    store = u(store);
  };
  return {
    setState,
    state: () => store,
    vcs: () => store.vcs as VcsSlice | undefined,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  remoteInvokeMock.mockReset();
  branchMock.mockReset();
  checksMock.mockReset();
  listenMock.mockClear();
  gitEventHandlers.length = 0;
  vcsCacheTest.reset();
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
      workspaceBroken: false,
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

  it("routes git status commands through the remote host bridge for remote roots", async () => {
    branchMock.mockResolvedValue(null);
    checksMock.mockResolvedValue(null);
    remoteInvokeMock.mockImplementation((_hostId: string, cmd: string) => {
      if (cmd === "git_status")
        return Promise.resolve({ branch: "main", dirty: true });
      if (cmd === "git_file_status")
        return Promise.resolve([{ path: "remote.ts", status: "modified" }]);
      if (cmd === "git_diff_stat")
        return Promise.resolve({ insertions: 3, deletions: 1 });
      return Promise.resolve(null);
    });

    const h = makeSetState();
    renderHook(() =>
      useVcsStatus({
        activeRoot: "/remote/repo",
        activeHostId: "remote:fp",
        setState: h.setState,
      }),
    );

    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    expect(invokeMock).not.toHaveBeenCalledWith("git_status", expect.anything());
    expect(remoteInvokeMock).toHaveBeenCalledWith("remote:fp", "git_status", {
      path: "/remote/repo",
    });
    expect(remoteInvokeMock).toHaveBeenCalledWith(
      "remote:fp",
      "git_file_status",
      { root: "/remote/repo" },
    );
    expect(h.vcs()).toMatchObject({
      root: "/remote/repo",
      branch: "main",
      dirty: true,
      changes: { total: 1, insertions: 3, deletions: 1 },
    });
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

  it("commits active git status mirror with the settled /vcs slice", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "git_status") {
        return Promise.resolve({
          branch: "main",
          ahead: 6,
          behind: 1,
          dirty: false,
        });
      }
      if (cmd === "git_file_status") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    branchMock.mockResolvedValue(null);
    checksMock.mockResolvedValue(null);
    const mirror = vi.fn((_root, status) => () => ({
      sidebar: { projects: [{ id: "project-1", git: status }] },
    }));

    const h = makeSetState({ replayFunctionalUpdaters: true });
    renderHook(() =>
      useVcsStatus({
        activeRoot: "/repo",
        setState: h.setState,
        onGitStatusSettled: mirror,
      }),
    );

    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    expect(mirror).toHaveBeenLastCalledWith(
      "/repo",
      { branch: "main", ahead: 6, behind: 1, dirty: false },
    );
    expect(mirror.mock.results.at(-1)?.value).toEqual(expect.any(Function));
    expect(mirror.mock.results.at(-1)?.value(h.state())).toEqual(
      expect.objectContaining({
        sidebar: {
          projects: [
            {
              id: "project-1",
              git: { branch: "main", ahead: 6, behind: 1, dirty: false },
            },
          ],
        },
      }),
    );
    expect(h.state()).toMatchObject({
      vcs: { branch: "main", loading: false },
      sidebar: { projects: [{ id: "project-1", git: { branch: "main" } }] },
    });
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
      workspaceBroken: false,
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

  it("paints the cached slice instantly when switching back to a seen workspace", async () => {
    // Warm-switch regression: A -> B -> A must NOT reset /vcs to the empty
    // loading shell for A; the last settled slice paints (loading: true)
    // while the background tick reconciles.
    invokeMock.mockImplementation(
      (cmd: string, args: { path?: string; root?: string }) => {
        const root = args?.path ?? args?.root;
        if (cmd === "git_status") {
          return Promise.resolve({
            branch: root === "/a" ? "branch-a" : "branch-b",
            ahead: 0,
            behind: 0,
            dirty: false,
          });
        }
        if (cmd === "git_file_status") return Promise.resolve([]);
        return Promise.resolve(null);
      },
    );
    branchMock.mockResolvedValue({
      ghAvailable: false,
      repo: null,
      pushed: false,
      workspaceBroken: false,
      prs: [],
    });
    checksMock.mockResolvedValue(null);

    const h = makeSetState();
    const { rerender } = renderHook(
      ({ root }: { root: string }) =>
        useVcsStatus({ activeRoot: root, setState: h.setState }),
      { initialProps: { root: "/a" } },
    );
    await waitFor(() => expect(h.vcs()?.branch).toBe("branch-a"));

    rerender({ root: "/b" });
    await waitFor(() => expect(h.vcs()?.branch).toBe("branch-b"));

    // Make A's refresh hang so we can observe the synchronous warm paint.
    invokeMock.mockImplementation(() => new Promise(() => {}));
    rerender({ root: "/a" });

    const warm = h.vcs()!;
    expect(warm.root).toBe("/a");
    expect(warm.branch).toBe("branch-a"); // cached, not the empty shell
    expect(warm.loading).toBe(true); // reconcile in flight
  });

  it("preserves the current slice when a read-only git refresh sees index.lock", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_status"
        ? Promise.resolve({ branch: "main", ahead: 0, behind: 0, dirty: false })
        : Promise.resolve(cmd === "git_file_status" ? [] : null),
    );
    branchMock.mockResolvedValue(null);
    checksMock.mockResolvedValue(null);
    const h = makeSetState();
    renderHook(() =>
      useVcsStatus({ activeRoot: "/repo", setState: h.setState }),
    );
    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    expect(h.vcs()?.branch).toBe("main");

    invokeMock.mockRejectedValue(
      "git index locked; skipping read-only refresh",
    );
    emitGitStateChanged("/repo");
    await new Promise((r) => setTimeout(r, 30));

    expect(h.vcs()?.branch).toBe("main");
    expect(h.vcs()?.loading).toBe(false);
    expect(branchMock).toHaveBeenCalledTimes(1);
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
      workspaceBroken: false,
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

  it("re-ticks when a git-state-changed event fires for the active root", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_status"
        ? Promise.resolve({ branch: "main", ahead: 0, behind: 0, dirty: false })
        : Promise.resolve(cmd === "git_file_status" ? [] : null),
    );
    branchMock.mockResolvedValue(null);
    checksMock.mockResolvedValue(null);
    const h = makeSetState();
    renderHook(() =>
      useVcsStatus({ activeRoot: "/repo", setState: h.setState }),
    );
    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    const before = invokeMock.mock.calls.filter(
      (c) => c[0] === "git_status",
    ).length;

    // Simulate an external `git commit`: only `.git/` changed, so the
    // watcher emits git-state-changed and the hook must re-poll.
    emitGitStateChanged("/repo");
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter((c) => c[0] === "git_status").length,
      ).toBeGreaterThan(before),
    );
  });

  it("re-ticks after the in-flight poll when a git event arrives mid-poll", async () => {
    // Hold the first poll in-flight (awaiting gh) so the git-state-changed
    // event lands while `polling` is true — the dropped-event race.
    let releaseGh: () => void = () => {};
    const ghGate = new Promise<null>((res) => {
      releaseGh = () => res(null);
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_status"
        ? Promise.resolve({ branch: "main", ahead: 0, behind: 0, dirty: false })
        : Promise.resolve(cmd === "git_file_status" ? [] : null),
    );
    branchMock.mockReturnValueOnce(ghGate).mockResolvedValue(null);
    checksMock.mockResolvedValue(null);
    const h = makeSetState();
    renderHook(() =>
      useVcsStatus({ activeRoot: "/repo", setState: h.setState }),
    );
    // The first poll has read git status and is now awaiting gh.
    await waitFor(() => expect(branchMock).toHaveBeenCalledTimes(1));
    const before = invokeMock.mock.calls.filter(
      (c) => c[0] === "git_status",
    ).length;

    // External commit while the poll is mid-flight: the event must not be
    // swallowed by the in-flight guard.
    emitGitStateChanged("/repo");
    releaseGh();

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter((c) => c[0] === "git_status").length,
      ).toBeGreaterThan(before),
    );
  });

  it("ignores git-state-changed events for a different root", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "git_status"
        ? Promise.resolve({ branch: "main", ahead: 0, behind: 0, dirty: false })
        : Promise.resolve(cmd === "git_file_status" ? [] : null),
    );
    branchMock.mockResolvedValue(null);
    checksMock.mockResolvedValue(null);
    const h = makeSetState();
    renderHook(() =>
      useVcsStatus({ activeRoot: "/repo", setState: h.setState }),
    );
    await waitFor(() => expect(h.vcs()?.loading).toBe(false));
    const before = invokeMock.mock.calls.filter(
      (c) => c[0] === "git_status",
    ).length;

    emitGitStateChanged("/other-repo");
    // Give any erroneous tick a chance to fire before asserting no-op.
    await new Promise((r) => setTimeout(r, 30));
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "git_status").length,
    ).toBe(before);
  });
});
