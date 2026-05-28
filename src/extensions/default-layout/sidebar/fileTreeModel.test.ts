import { describe, expect, it } from "vitest";

import {
  deletedChildrenByParentFromStatuses,
  gitDecorationsFromStatuses,
  gitStatusesFromEntries,
  nodesFromEntries,
  parseExpandedStore,
  visibleTreeNodes,
  watchedDirsFor,
  type GitFileStatusEntry,
  type TreeNode,
} from "./fileTreeModel";

describe("fileTreeModel", () => {
  it("normalizes persisted expand-state and tolerates bad input", () => {
    expect(parseExpandedStore("not json")).toEqual({ byProject: {} });
    expect(
      parseExpandedStore(
        JSON.stringify({
          byProject: {
            "/repo": ["/repo/src", 123, "/repo/tests"],
          },
        }),
      ),
    ).toEqual({
      byProject: {
        "/repo": ["/repo/src", "/repo/tests"],
      },
    });
  });

  it("preserves loaded descendants when entries are refreshed", () => {
    const previous: TreeNode[] = [
      {
        entry: { name: "src", path: "/repo/src", kind: "dir" },
        depth: 1,
        children: [
          {
            entry: { name: "App.tsx", path: "/repo/src/App.tsx", kind: "file" },
            depth: 2,
          },
        ],
      },
    ];

    expect(
      nodesFromEntries(
        [{ name: "src", path: "/repo/src", kind: "dir" }],
        1,
        previous,
      )[0]?.children?.[0]?.entry.path,
    ).toBe("/repo/src/App.tsx");
  });

  it("derives direct and strongest descendant Git decorations", () => {
    const statuses = gitStatusesFromEntries([
      { path: "src/App.tsx", status: "modified" },
      { path: "src/conflict.ts", status: "conflicted" },
    ] satisfies GitFileStatusEntry[]);

    const decorations = gitDecorationsFromStatuses(statuses);

    expect(decorations.direct.get("src/App.tsx")).toBe("modified");
    expect(decorations.descendants.get("src")).toBe("conflicted");
  });

  it("adds synthetic deleted entries to visible expanded folders", () => {
    const root: TreeNode = {
      entry: { name: "repo", path: "/repo", kind: "dir" },
      depth: 0,
      children: [
        { entry: { name: "src", path: "/repo/src", kind: "dir" }, depth: 1 },
      ],
    };
    const statuses = gitStatusesFromEntries([
      { path: "src/old.ts", status: "deleted" },
    ] satisfies GitFileStatusEntry[]);
    const deletedChildrenByParent = deletedChildrenByParentFromStatuses(
      statuses,
      "/repo",
    );

    expect(
      visibleTreeNodes({
        deletedChildrenByParent,
        expanded: new Set(["/repo/src"]),
        projectPath: "/repo",
        root,
      }).map((node) => node.entry.path),
    ).toEqual(["/repo/src", "/repo/src/old.ts"]);
  });

  it("watches only visible roots and expanded folders", () => {
    expect(
      watchedDirsFor({
        expanded: new Set(["/repo/src"]),
        hidden: false,
        projectPath: "/repo",
      }),
    ).toEqual(["/repo", "/repo/src"]);
    expect(
      watchedDirsFor({
        expanded: new Set(["/repo/src"]),
        hidden: true,
        projectPath: "/repo",
      }),
    ).toEqual([]);
  });
});
