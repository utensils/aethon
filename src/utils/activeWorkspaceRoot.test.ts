import { describe, expect, it } from "vitest";
import { activeWorkspaceCwd } from "./activeWorkspaceRoot";

describe("activeWorkspaceCwd", () => {
  it("prefers the selected workspace path over the parent project path", () => {
    expect(
      activeWorkspaceCwd({
        activeWorkspaceId: "wt-2",
        project: { path: "/projects/nyc-real-estate" },
        sidebar: {
          projects: [
            {
              workspaces: [
                { id: "wt-1", path: "/workspaces/other" },
                { id: "wt-2", path: "/workspaces/nyc-real-estate/feature" },
              ],
            },
          ],
        },
      }),
    ).toBe("/workspaces/nyc-real-estate/feature");
  });

  it("falls back to the active project path", () => {
    expect(activeWorkspaceCwd({ project: { path: "/projects/aethon" } })).toBe(
      "/projects/aethon",
    );
  });

  it("uses the active editor root only when no project/workspace is active", () => {
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
