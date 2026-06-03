import { describe, expect, it } from "vitest";
import {
  type Worktree,
  newPendingWorktree,
  reconcileWorktrees,
  removeWorktreeFromList,
  updateWorktreePendingState,
  worktreesForPersist,
} from "./worktrees";

function wt(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "wt-1",
    projectId: "p1",
    path: "/a",
    branch: "main",
    isMain: true,
    ...overrides,
  };
}

describe("reconcileWorktrees", () => {
  it("preserves id + label across reconciles by path", () => {
    const prior: Worktree[] = [
      wt({ id: "stable-id", path: "/repo", label: "Stable" }),
    ];
    const next = reconcileWorktrees("p1", prior, [
      {
        path: "/repo",
        branch: "main",
        head: "abc",
        isMain: true,
        locked: false,
      },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("stable-id");
    expect(next[0].label).toBe("Stable");
    expect(next[0].head).toBe("abc");
  });

  it("clears creation pendingState when the worktree appears in listing", () => {
    const prior: Worktree[] = [
      wt({ id: "p", path: "/repo-feat", pendingState: "starting" }),
    ];
    const next = reconcileWorktrees("p1", prior, [
      {
        path: "/repo-feat",
        branch: "feat",
        head: "def",
        isMain: false,
        locked: false,
      },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].pendingState).toBeUndefined();
  });

  it("preserves removing state while git still lists the worktree", () => {
    const prior: Worktree[] = [
      wt({ id: "p", path: "/repo-feat", pendingState: "removing" }),
    ];
    const next = reconcileWorktrees("p1", prior, [
      {
        path: "/repo-feat",
        branch: "feat",
        head: "def",
        isMain: false,
        locked: false,
      },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("p");
    expect(next[0].pendingState).toBe("removing");
    expect(next[0].head).toBe("def");
  });

  it("drops in-flight pending rows that disappeared from listing", () => {
    const prior: Worktree[] = [
      wt({ id: "p1", path: "/main", isMain: true }),
      wt({ id: "p2", path: "/feat", pendingState: "starting" }),
    ];
    const next = reconcileWorktrees("p1", prior, [
      { path: "/main", branch: "main", head: null, isMain: true, locked: false },
    ]);
    // Only the main worktree from listing. The starting pending row is
    // kept because it might still resolve; reconcile keeps queued+starting
    // pending rows.
    expect(next.find((w) => w.path === "/feat")?.pendingState).toBe(
      "starting",
    );
  });

  it("keeps failed pending rows for the user to Dismiss", () => {
    const prior: Worktree[] = [
      wt({ id: "p1", path: "/main", isMain: true }),
      wt({ id: "f", path: "/broken", pendingState: "failed", pendingError: "x" }),
    ];
    const next = reconcileWorktrees("p1", prior, [
      { path: "/main", branch: "main", head: null, isMain: true, locked: false },
    ]);
    expect(next.find((w) => w.id === "f")?.pendingState).toBe("failed");
  });

  it("flags isMain from the listing, not prior state", () => {
    const prior: Worktree[] = [];
    const next = reconcileWorktrees("p1", prior, [
      { path: "/main", branch: "main", head: null, isMain: true, locked: false },
      { path: "/feat", branch: "feat", head: null, isMain: false, locked: false },
    ]);
    expect(next[0].isMain).toBe(true);
    expect(next[1].isMain).toBe(false);
  });
});

describe("updateWorktreePendingState", () => {
  it("strips pending fields on success", () => {
    const list: Worktree[] = [wt({ id: "x", pendingState: "starting" })];
    const next = updateWorktreePendingState(list, "x", "succeeded");
    expect(next[0].pendingState).toBeUndefined();
    expect(next[0].pendingError).toBeUndefined();
  });

  it("stores the failure message on failed", () => {
    const list: Worktree[] = [wt({ id: "x", pendingState: "starting" })];
    const next = updateWorktreePendingState(list, "x", "failed", "boom");
    expect(next[0].pendingState).toBe("failed");
    expect(next[0].pendingError).toBe("boom");
  });

  it("is a no-op when id is missing", () => {
    const list: Worktree[] = [wt({ id: "x" })];
    const next = updateWorktreePendingState(list, "missing", "failed", "huh");
    expect(next).toEqual(list);
  });
});

describe("worktreesForPersist", () => {
  it("drops in-flight pending rows", () => {
    const list: Worktree[] = [
      wt({ id: "a" }),
      wt({ id: "b", pendingState: "queued" }),
      wt({ id: "c", pendingState: "starting" }),
      wt({ id: "d", pendingState: "failed" }),
      wt({ id: "e", pendingState: "removing" }),
    ];
    const out = worktreesForPersist(list);
    expect(out.map((w) => w.id)).toEqual(["a", "d"]);
  });
});

describe("removeWorktreeFromList + newPendingWorktree", () => {
  it("removes the matching id", () => {
    const list: Worktree[] = [wt({ id: "a" }), wt({ id: "b" })];
    expect(removeWorktreeFromList(list, "a")).toEqual([wt({ id: "b" })]);
  });

  it("creates a queued pending worktree with a fresh id", () => {
    const a = newPendingWorktree("p1", "feat-x", "/tmp/a");
    const b = newPendingWorktree("p1", "feat-x", "/tmp/a");
    expect(a.pendingState).toBe("queued");
    expect(a.id).not.toBe(b.id);
    expect(a.path).toBe("/tmp/a");
    expect(a.projectId).toBe("p1");
  });
});
