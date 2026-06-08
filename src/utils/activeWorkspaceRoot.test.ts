import { describe, expect, it } from "vitest";
import { activeWorkspaceCwd } from "./activeWorkspaceRoot";

describe("activeWorkspaceCwd", () => {
  it("prefers the selected worktree path over the parent project path", () => {
    expect(
      activeWorkspaceCwd({
        activeWorktreeId: "wt-2",
        project: { path: "/projects/nyc-real-estate" },
        sidebar: {
          projects: [
            {
              worktrees: [
                { id: "wt-1", path: "/worktrees/other" },
                { id: "wt-2", path: "/worktrees/nyc-real-estate/feature" },
              ],
            },
          ],
        },
      }),
    ).toBe("/worktrees/nyc-real-estate/feature");
  });

  it("falls back to the active project path", () => {
    expect(activeWorkspaceCwd({ project: { path: "/projects/aethon" } })).toBe(
      "/projects/aethon",
    );
  });

  it("uses the active editor root only when no project/worktree is active", () => {
    expect(
      activeWorkspaceCwd({
        activeTabId: "editor-1",
        tabs: [
          {
            id: "editor-1",
            kind: "editor",
            editor: { rootPath: "/tmp/editor-repo" },
          },
        ],
      }),
    ).toBe("/tmp/editor-repo");
  });
});
