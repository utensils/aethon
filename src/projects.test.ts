import { describe, expect, it } from "vitest";
import {
  emptyProjectsState,
  DEFAULT_WORKSPACE_BASE_BRANCH,
  migrateProjects,
  removeProject,
  setActiveWorkspace,
  setProjectWorkspaceBaseBranch,
  setProjectWorkspaceSortMode,
  setProjectUiExpanded,
  setProjectWorkspaces,
  upsertProject,
  type ProjectsState,
} from "./projects";

function stateWithProjects(): ProjectsState {
  const first = upsertProject(emptyProjectsState(), "/Users/example/aethon").state;
  return upsertProject(first, "/Users/example/latentforge").state;
}

describe("removeProject", () => {
  it("removes only the project metadata record", () => {
    const state = stateWithProjects();
    const target = state.projects.find((p) => p.label === "aethon");

    const result = removeProject(state, target!.id);

    expect(result.removed?.path).toBe("/Users/example/aethon");
    expect(result.state.projects.map((p) => p.path)).toEqual([
      "/Users/example/latentforge",
    ]);
  });

  it("clears activeId when removing the active project", () => {
    const state = stateWithProjects();

    const result = removeProject(state, state.activeId!);

    expect(result.state.activeId).toBeNull();
  });

  it("preserves activeId when removing an inactive project", () => {
    const state = stateWithProjects();
    const activeId = state.activeId!;
    const inactive = state.projects.find((p) => p.id !== activeId)!;

    const result = removeProject(state, inactive.id);

    expect(result.state.activeId).toBe(activeId);
  });

  it("drops the project's workspaces + clears activeWorkspaceId when removing", () => {
    let state = stateWithProjects();
    const target = state.projects[0];
    state = setProjectWorkspaces(state, target.id, [
      {
        id: "wt-x",
        projectId: target.id,
        path: "/Users/example/aethon",
        branch: "main",
        isMain: true,
      },
    ]);
    state = setActiveWorkspace(state, "wt-x");
    const result = removeProject(state, target.id);
    expect(result.state.workspacesByProject[target.id]).toBeUndefined();
    expect(result.state.activeWorkspaceId).toBeNull();
  });
});

describe("migrateProjects", () => {
  it("upgrades a v1 file (no schemaVersion, no workspacesByProject)", () => {
    const v1 = {
      projects: [
        {
          id: "a",
          label: "aethon",
          path: "/Users/example/aethon",
          lastUsed: 1,
        },
      ],
      activeId: "a",
    };
    const out = migrateProjects(v1);
    expect(out.projects).toHaveLength(1);
    expect(out.activeId).toBe("a");
    expect(out.activeWorkspaceId).toBeNull();
    expect(out.workspacesByProject).toEqual({});
    expect(out.projects[0].workspaceSortMode).toBe("newest");
  });

  it("preserves manual workspace sort mode", () => {
    const v4 = {
      schemaVersion: 4,
      projects: [
        {
          id: "a",
          label: "aethon",
          path: "/Users/example/aethon",
          lastUsed: 1,
          workspaceSortMode: "manual" as const,
        },
      ],
      activeId: "a",
      activeWorkspaceId: null,
      workspacesByProject: {},
    };
    const out = migrateProjects(v4);
    expect(out.projects[0].workspaceSortMode).toBe("manual");
  });

  it("stamps localHostId onto v2 entries during v2->v3 migration", () => {
    const v2 = {
      schemaVersion: 2,
      projects: [
        {
          id: "a",
          label: "aethon",
          path: "/Users/example/aethon",
          lastUsed: 1,
        },
      ],
      activeId: "a",
      activeWorkspaceId: "wt-1",
      workspacesByProject: {
        a: [{ id: "wt-1", projectId: "a", path: "/a", branch: "main", isMain: true }],
      },
    };
    const out = migrateProjects(v2, "local:abc123");
    expect(out.projects[0].hostId).toBe("local:abc123");
    expect(out.activeHostId).toBe("local:abc123");
    expect(out.activeWorkspaceId).toBe("wt-1");
    expect(out.workspacesByProject.a).toHaveLength(1);
  });

  it("preserves an explicit v3 hostId + activeHostId", () => {
    const v3 = {
      schemaVersion: 3,
      projects: [
        {
          id: "a",
          label: "aethon",
          path: "/Users/example/aethon",
          lastUsed: 1,
          hostId: "remote:peer",
        },
      ],
      activeId: "a",
      activeWorkspaceId: null,
      activeHostId: "remote:peer",
      workspacesByProject: {},
    };
    const out = migrateProjects(v3, "local:abc123");
    expect(out.projects[0].hostId).toBe("remote:peer");
    expect(out.activeHostId).toBe("remote:peer");
  });

  it("preserves non-default per-project workspace base branches", () => {
    const out = migrateProjects({
      schemaVersion: 3,
      projects: [
        {
          id: "a",
          label: "aethon",
          path: "/Users/example/aethon",
          lastUsed: 1,
          workspaceBaseBranch: "upstream/trunk",
        },
      ],
      activeId: "a",
      activeWorkspaceId: null,
      activeHostId: "local:abc123",
      workspacesByProject: {},
    });

    expect(out.projects[0].workspaceBaseBranch).toBe("upstream/trunk");
  });

  it("drops invalid workspace entries", () => {
    const out = migrateProjects({
      schemaVersion: 2,
      projects: [{ id: "a", label: "a", path: "/a", lastUsed: 1 }],
      activeId: "a",
      activeWorkspaceId: null,
      workspacesByProject: {
        a: [
          { id: "wt-1", projectId: "a", path: "/a", branch: "main", isMain: true },
          // Junk entries — missing id / path / projectId.
          { branch: "x" } as never,
        ],
      },
    });
    expect(out.workspacesByProject.a).toHaveLength(1);
  });

  it("clears activeWorkspaceId when it points to a workspace no longer in workspacesByProject", () => {
    const out = migrateProjects({
      schemaVersion: 3,
      projects: [{ id: "a", label: "a", path: "/a", lastUsed: 1 }],
      activeId: "a",
      activeWorkspaceId: "wt-ghost",
      activeHostId: "local:abc",
      workspacesByProject: {
        a: [{ id: "wt-main", projectId: "a", path: "/a", branch: "main", isMain: true }],
      },
    });
    expect(out.activeWorkspaceId).toBeNull();
    // Row stays visible so the user can see and remove it via the
    // orphan delete flow. The dangling *active id* is the part that
    // freezes the UI; the row itself is informational.
    expect(out.workspacesByProject.a).toHaveLength(1);
  });

  it("keeps activeWorkspaceId when it resolves to a loaded workspace", () => {
    const out = migrateProjects({
      schemaVersion: 3,
      projects: [{ id: "a", label: "a", path: "/a", lastUsed: 1 }],
      activeId: "a",
      activeWorkspaceId: "wt-2",
      activeHostId: "local:abc",
      workspacesByProject: {
        a: [
          { id: "wt-1", projectId: "a", path: "/a", branch: "main", isMain: true },
          { id: "wt-2", projectId: "a", path: "/a-wt", branch: "feat", isMain: false },
        ],
      },
    });
    expect(out.activeWorkspaceId).toBe("wt-2");
  });

  it("migrates a v4 file's worktree-era keys to workspace terminology", () => {
    // Exact shape a pre-rename (schemaVersion 4) projects.json used.
    const v4 = {
      schemaVersion: 4,
      projects: [
        {
          id: "a",
          label: "a",
          path: "/a",
          lastUsed: 1,
          hostId: "local:abc",
          worktreeBaseBranch: "origin/develop",
          worktreeSortMode: "manual",
        },
      ],
      activeId: "a",
      activeWorktreeId: "wt-2",
      activeHostId: "local:abc",
      worktreesByProject: {
        a: [
          { id: "wt-1", projectId: "a", path: "/a", branch: "main", isMain: true },
          { id: "wt-2", projectId: "a", path: "/a-wt", branch: "feat", isMain: false },
        ],
      },
    };
    const out = migrateProjects(v4 as Parameters<typeof migrateProjects>[0]);

    expect(out.activeWorkspaceId).toBe("wt-2");
    expect(out.workspacesByProject.a).toHaveLength(2);
    expect(out.projects[0].workspaceBaseBranch).toBe("origin/develop");
    expect(out.projects[0].workspaceSortMode).toBe("manual");
    // Legacy spellings must not survive into the in-memory record (they
    // would re-persist forever).
    expect("worktreeBaseBranch" in out.projects[0]).toBe(false);
    expect("worktreeSortMode" in out.projects[0]).toBe(false);
  });

  it("is idempotent over an already-migrated v5 shape", () => {
    const v5 = {
      schemaVersion: 5,
      projects: [
        {
          id: "a",
          label: "a",
          path: "/a",
          lastUsed: 1,
          hostId: "local:abc",
          workspaceBaseBranch: "origin/develop",
          workspaceSortMode: "manual" as const,
        },
      ],
      activeId: "a",
      activeWorkspaceId: "wt-1",
      activeHostId: "local:abc",
      workspacesByProject: {
        a: [{ id: "wt-1", projectId: "a", path: "/a-wt", branch: "feat", isMain: false }],
      },
    };
    const once = migrateProjects(v5);
    const twice = migrateProjects({ ...v5, ...once });
    expect(twice).toEqual(once);
  });
});

describe("setProjectUiExpanded", () => {
  it("toggles uiExpanded on the target project only", () => {
    const state = stateWithProjects();
    const target = state.projects[0];
    const next = setProjectUiExpanded(state, target.id, true);
    expect(next.projects.find((p) => p.id === target.id)?.uiExpanded).toBe(true);
    expect(next.projects.find((p) => p.id !== target.id)?.uiExpanded).toBeUndefined();
  });
});

describe("setProjectWorkspaceBaseBranch", () => {
  it("stores non-default project workspace bases", () => {
    const state = stateWithProjects();
    const target = state.projects[0];
    const next = setProjectWorkspaceBaseBranch(
      state,
      target.id,
      "upstream/trunk",
    );
    expect(next.projects.find((p) => p.id === target.id)?.workspaceBaseBranch).toBe(
      "upstream/trunk",
    );
  });

  it("clears blank or default values so origin/main remains implicit", () => {
    let state = stateWithProjects();
    const target = state.projects[0];
    state = setProjectWorkspaceBaseBranch(state, target.id, "upstream/trunk");

    const cleared = setProjectWorkspaceBaseBranch(
      state,
      target.id,
      DEFAULT_WORKSPACE_BASE_BRANCH,
    );
    expect(
      cleared.projects.find((p) => p.id === target.id)?.workspaceBaseBranch,
    ).toBeUndefined();

    const blank = setProjectWorkspaceBaseBranch(state, target.id, " ");
    expect(blank.projects.find((p) => p.id === target.id)?.workspaceBaseBranch).toBeUndefined();
  });
});

describe("setProjectWorkspaceSortMode", () => {
  it("stores the requested workspace sort mode", () => {
    const state = stateWithProjects();
    const project = state.projects[0];
    const next = setProjectWorkspaceSortMode(state, project.id, "manual");
    expect(next.projects[0].workspaceSortMode).toBe("manual");
  });
});
