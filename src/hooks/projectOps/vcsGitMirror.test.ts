import { describe, expect, it } from "vitest";
import type { ProjectsState } from "../../projects";
import { applyActiveVcsGitStatusToProjects } from "./vcsGitMirror";

function projectsState(overrides: Partial<ProjectsState> = {}): ProjectsState {
  return {
    projects: [{ id: "project-1", label: "aethon", path: "/repo", lastUsed: 1 }],
    activeId: "project-1",
    activeWorkspaceId: null,
    activeHostId: null,
    workspacesByProject: {},
    ...overrides,
  };
}

describe("applyActiveVcsGitStatusToProjects", () => {
  it("updates the project git cache for the active root", () => {
    const gitStatuses = new Map([
      ["/repo", { branch: "old", ahead: 0, behind: 0, dirty: false }],
    ]);

    const result = applyActiveVcsGitStatusToProjects({
      projects: projectsState(),
      gitStatuses,
      root: "/repo",
      status: { branch: "main", ahead: 6, behind: 1, dirty: false },
    });

    expect(result.changed).toBe(true);
    expect(gitStatuses.get("/repo")).toEqual({
      branch: "main",
      ahead: 6,
      behind: 1,
      dirty: false,
    });
  });

  it("updates the matching workspace branch and clears labels that tracked the old branch", () => {
    const state = projectsState({
      activeWorkspaceId: "main-wt",
      workspacesByProject: {
        "project-1": [
          {
            id: "main-wt",
            projectId: "project-1",
            path: "/repo",
            branch: "fix/old",
            label: "fix/old",
            isMain: true,
          },
          {
            id: "manual-label",
            projectId: "project-1",
            path: "/repo-linked",
            branch: "fix/old",
            label: "Release work",
            isMain: false,
          },
        ],
      },
    });

    const result = applyActiveVcsGitStatusToProjects({
      projects: state,
      gitStatuses: new Map(),
      root: "/repo",
      status: { branch: "main", ahead: 0, behind: 0, dirty: false },
    });

    expect(result.changed).toBe(true);
    expect(result.projects.workspacesByProject["project-1"]?.[0]).toMatchObject({
      branch: "main",
      label: undefined,
    });
    expect(result.projects.workspacesByProject["project-1"]?.[1]).toMatchObject({
      branch: "fix/old",
      label: "Release work",
    });
  });

  it("preserves detached workspace branch state when git_status reports a display SHA", () => {
    const state = projectsState({
      activeWorkspaceId: "main-wt",
      workspacesByProject: {
        "project-1": [
          {
            id: "main-wt",
            projectId: "project-1",
            path: "/repo",
            branch: "fix/old",
            label: "fix/old",
            isMain: true,
          },
        ],
      },
    });
    const gitStatuses = new Map();

    const result = applyActiveVcsGitStatusToProjects({
      projects: state,
      gitStatuses,
      root: "/repo",
      status: { branch: "aace34f", ahead: 0, behind: 0, dirty: false },
    });

    expect(gitStatuses.get("/repo")?.branch).toBe("aace34f");
    expect(result.projects.workspacesByProject["project-1"]?.[0]).toMatchObject({
      branch: null,
      label: undefined,
    });
  });

  it("reports no change when the cache and workspace branch already match", () => {
    const gitStatuses = new Map([
      ["/repo", { branch: "main", ahead: 0, behind: 0, dirty: false }],
    ]);
    const state = projectsState({
      workspacesByProject: {
        "project-1": [
          {
            id: "main-wt",
            projectId: "project-1",
            path: "/repo",
            branch: "main",
            isMain: true,
          },
        ],
      },
    });

    const result = applyActiveVcsGitStatusToProjects({
      projects: state,
      gitStatuses,
      root: "/repo",
      status: { branch: "main", ahead: 0, behind: 0, dirty: false },
    });

    expect(result).toEqual({ projects: state, changed: false });
  });
});
