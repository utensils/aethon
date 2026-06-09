import { describe, expect, it } from "vitest";
import {
  type Workspace,
  newPendingWorkspace,
  orderWorkspacesForDisplay,
  reconcileWorkspaces,
  removeWorkspaceFromList,
  reorderExtraWorkspaceToIndex,
  sortWorkspacesNewestFirst,
  updateWorkspacePendingState,
  workspacesForPersist,
} from "./workspaces";

function wt(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "wt-1",
    projectId: "p1",
    path: "/a",
    branch: "main",
    isMain: true,
    ...overrides,
  };
}

describe("reconcileWorkspaces", () => {
  it("preserves id + label across reconciles by path", () => {
    const prior: Workspace[] = [
      wt({ id: "stable-id", path: "/repo", label: "Stable", createdAt: 10 }),
    ];
    const next = reconcileWorkspaces("p1", prior, [
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
    expect(next[0].createdAt).toBe(10);
  });

  it("uses listing createdAt for new rows and first-seen time as fallback", () => {
    const next = reconcileWorkspaces(
      "p1",
      [],
      [
        {
          path: "/repo",
          branch: "main",
          head: "abc",
          isMain: true,
          locked: false,
          createdAt: 11,
        },
        {
          path: "/repo-feat",
          branch: "feat",
          head: "def",
          isMain: false,
          locked: false,
        },
      ],
      22,
    );
    expect(next.map((w) => w.createdAt)).toEqual([11, 22]);
  });

  it("clears creation pendingState when the workspace appears in listing", () => {
    const prior: Workspace[] = [
      wt({ id: "p", path: "/repo-feat", pendingState: "starting" }),
    ];
    const next = reconcileWorkspaces("p1", prior, [
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

  it("preserves removing state while git still lists the workspace", () => {
    const prior: Workspace[] = [
      wt({ id: "p", path: "/repo-feat", pendingState: "removing" }),
    ];
    const next = reconcileWorkspaces("p1", prior, [
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
    const prior: Workspace[] = [
      wt({ id: "p1", path: "/main", isMain: true }),
      wt({ id: "p2", path: "/feat", pendingState: "starting" }),
    ];
    const next = reconcileWorkspaces("p1", prior, [
      { path: "/main", branch: "main", head: null, isMain: true, locked: false },
    ]);
    // Only the main workspace from listing. The starting pending row is
    // kept because it might still resolve; reconcile keeps queued+starting
    // pending rows.
    expect(next.find((w) => w.path === "/feat")?.pendingState).toBe(
      "starting",
    );
  });

  it("keeps failed pending rows for the user to Dismiss", () => {
    const prior: Workspace[] = [
      wt({ id: "p1", path: "/main", isMain: true }),
      wt({ id: "f", path: "/broken", pendingState: "failed", pendingError: "x" }),
    ];
    const next = reconcileWorkspaces("p1", prior, [
      { path: "/main", branch: "main", head: null, isMain: true, locked: false },
    ]);
    expect(next.find((w) => w.id === "f")?.pendingState).toBe("failed");
  });

  it("flags isMain from the listing, not prior state", () => {
    const prior: Workspace[] = [];
    const next = reconcileWorkspaces("p1", prior, [
      { path: "/main", branch: "main", head: null, isMain: true, locked: false },
      { path: "/feat", branch: "feat", head: null, isMain: false, locked: false },
    ]);
    expect(next[0].isMain).toBe(true);
    expect(next[1].isMain).toBe(false);
  });
});

describe("workspace ordering", () => {
  it("sorts extra workspaces newest-first while keeping main first", () => {
    const list = [
      wt({ id: "main", path: "/repo", isMain: true, createdAt: 1 }),
      wt({ id: "old", path: "/old", isMain: false, createdAt: 10 }),
      wt({ id: "new", path: "/new", isMain: false, createdAt: 20 }),
    ];
    expect(sortWorkspacesNewestFirst(list).map((w) => w.id)).toEqual([
      "main",
      "new",
      "old",
    ]);
  });

  it("uses manual display order when requested", () => {
    const list = [
      wt({ id: "main", path: "/repo", isMain: true, createdAt: 1 }),
      wt({ id: "old", path: "/old", isMain: false, createdAt: 10 }),
      wt({ id: "new", path: "/new", isMain: false, createdAt: 20 }),
    ];
    expect(orderWorkspacesForDisplay(list, "manual").map((w) => w.id)).toEqual([
      "main",
      "old",
      "new",
    ]);
    expect(orderWorkspacesForDisplay(list, "newest").map((w) => w.id)).toEqual([
      "main",
      "new",
      "old",
    ]);
  });

  it("reorders only extra workspaces", () => {
    const list = [
      wt({ id: "main", path: "/repo", isMain: true }),
      wt({ id: "a", path: "/a", isMain: false }),
      wt({ id: "b", path: "/b", isMain: false }),
      wt({ id: "c", path: "/c", isMain: false }),
    ];
    const next = reorderExtraWorkspaceToIndex(list, "c", 0);
    expect(next?.map((w) => w.id)).toEqual(["main", "c", "a", "b"]);
  });
});

describe("updateWorkspacePendingState", () => {
  it("strips pending fields on success", () => {
    const list: Workspace[] = [wt({ id: "x", pendingState: "starting" })];
    const next = updateWorkspacePendingState(list, "x", "succeeded");
    expect(next[0].pendingState).toBeUndefined();
    expect(next[0].pendingError).toBeUndefined();
  });

  it("stores the failure message on failed", () => {
    const list: Workspace[] = [wt({ id: "x", pendingState: "starting" })];
    const next = updateWorkspacePendingState(list, "x", "failed", "boom");
    expect(next[0].pendingState).toBe("failed");
    expect(next[0].pendingError).toBe("boom");
  });

  it("is a no-op when id is missing", () => {
    const list: Workspace[] = [wt({ id: "x" })];
    const next = updateWorkspacePendingState(list, "missing", "failed", "huh");
    expect(next).toEqual(list);
  });
});

describe("workspacesForPersist", () => {
  it("drops in-flight pending rows", () => {
    const list: Workspace[] = [
      wt({ id: "a" }),
      wt({ id: "b", pendingState: "queued" }),
      wt({ id: "c", pendingState: "starting" }),
      wt({ id: "d", pendingState: "failed" }),
      wt({ id: "e", pendingState: "removing" }),
    ];
    const out = workspacesForPersist(list);
    expect(out.map((w) => w.id)).toEqual(["a", "d"]);
  });
});

describe("removeWorkspaceFromList + newPendingWorkspace", () => {
  it("removes the matching id", () => {
    const list: Workspace[] = [wt({ id: "a" }), wt({ id: "b" })];
    expect(removeWorkspaceFromList(list, "a")).toEqual([wt({ id: "b" })]);
  });

  it("creates a queued pending workspace with a fresh id", () => {
    const a = newPendingWorkspace("p1", "feat-x", "/tmp/a");
    const b = newPendingWorkspace("p1", "feat-x", "/tmp/a");
    expect(a.pendingState).toBe("queued");
    expect(a.id).not.toBe(b.id);
    expect(a.path).toBe("/tmp/a");
    expect(a.projectId).toBe("p1");
  });
});
