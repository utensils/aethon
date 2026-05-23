import { describe, expect, it } from "vitest";
import {
  emptyProjectsState,
  migrateProjects,
  removeProject,
  setActiveWorktree,
  setProjectUiExpanded,
  setProjectWorktrees,
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

  it("drops the project's worktrees + clears activeWorktreeId when removing", () => {
    let state = stateWithProjects();
    const target = state.projects[0];
    state = setProjectWorktrees(state, target.id, [
      {
        id: "wt-x",
        projectId: target.id,
        path: "/Users/example/aethon",
        branch: "main",
        isMain: true,
      },
    ]);
    state = setActiveWorktree(state, "wt-x");
    const result = removeProject(state, target.id);
    expect(result.state.worktreesByProject[target.id]).toBeUndefined();
    expect(result.state.activeWorktreeId).toBeNull();
  });
});

describe("migrateProjects", () => {
  it("upgrades a v1 file (no schemaVersion, no worktreesByProject)", () => {
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
    expect(out.activeWorktreeId).toBeNull();
    expect(out.worktreesByProject).toEqual({});
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
      activeWorktreeId: "wt-1",
      worktreesByProject: {
        a: [{ id: "wt-1", projectId: "a", path: "/a", branch: "main", isMain: true }],
      },
    };
    const out = migrateProjects(v2, "local:abc123");
    expect(out.projects[0].hostId).toBe("local:abc123");
    expect(out.activeHostId).toBe("local:abc123");
    expect(out.activeWorktreeId).toBe("wt-1");
    expect(out.worktreesByProject.a).toHaveLength(1);
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
      activeWorktreeId: null,
      activeHostId: "remote:peer",
      worktreesByProject: {},
    };
    const out = migrateProjects(v3, "local:abc123");
    expect(out.projects[0].hostId).toBe("remote:peer");
    expect(out.activeHostId).toBe("remote:peer");
  });

  it("drops invalid worktree entries", () => {
    const out = migrateProjects({
      schemaVersion: 2,
      projects: [{ id: "a", label: "a", path: "/a", lastUsed: 1 }],
      activeId: "a",
      activeWorktreeId: null,
      worktreesByProject: {
        a: [
          { id: "wt-1", projectId: "a", path: "/a", branch: "main", isMain: true },
          // Junk entries — missing id / path / projectId.
          { branch: "x" } as never,
        ],
      },
    });
    expect(out.worktreesByProject.a).toHaveLength(1);
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
