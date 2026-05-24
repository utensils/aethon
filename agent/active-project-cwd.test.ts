import { describe, expect, it } from "vitest";
import {
  activeProjectCwdFromJson,
  resolveStartupCwd,
} from "./active-project-cwd";

describe("activeProjectCwdFromJson", () => {
  it("uses the active project path when no worktree is active", () => {
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          activeId: "p1",
          projects: [{ id: "p1", path: "/repo/app" }],
        }),
      ),
    ).toBe("/repo/app");
  });

  it("prefers the active worktree path when present", () => {
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          activeId: "p1",
          activeWorktreeId: "wt1",
          projects: [{ id: "p1", path: "/repo/aethon" }],
          worktreesByProject: {
            p1: [{ id: "wt1", projectId: "p1", path: "/repo/aethon-fix" }],
          },
        }),
      ),
    ).toBe("/repo/aethon-fix");
  });

  it("falls back to the project path when the active worktree is stale", () => {
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          activeId: "p1",
          activeWorktreeId: "missing",
          projects: [{ id: "p1", path: "/repo/app" }],
          worktreesByProject: { p1: [] },
        }),
      ),
    ).toBe("/repo/app");
  });

  it("returns undefined for malformed project state", () => {
    expect(activeProjectCwdFromJson("{nope")).toBeUndefined();
  });
});

describe("resolveStartupCwd", () => {
  it("uses active project, then dev project root, then process cwd", () => {
    expect(resolveStartupCwd("/repo/project", "/repo/aethon", "/")).toBe(
      "/repo/project",
    );
    expect(resolveStartupCwd(undefined, "/repo/aethon", "/")).toBe(
      "/repo/aethon",
    );
    expect(resolveStartupCwd(undefined, undefined, "/")).toBe("/");
  });
});
