import { describe, expect, it } from "vitest";
import { activeProjectCwdFromJson } from "./active-project-cwd";

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

  it("uses the active worktree path when one is selected", () => {
    expect(
      activeProjectCwdFromJson(
        JSON.stringify({
          activeId: "p1",
          activeWorktreeId: "wt-1",
          projects: [{ id: "p1", path: "/repo/app" }],
          worktreesByProject: {
            p1: [
              {
                id: "wt-1",
                projectId: "p1",
                path: "/repo/app-fix-session-restore",
              },
            ],
          },
        }),
      ),
    ).toBe("/repo/app-fix-session-restore");
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
