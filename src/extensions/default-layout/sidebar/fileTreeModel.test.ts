import { describe, expect, it } from "vitest";

import {
  ancestorDirsFor,
  buildIgnoreMatcher,
  deletedChildrenByParentFromStatuses,
  gitDecorationsFromStatuses,
  gitStatusesFromEntries,
  graftChildren,
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

describe("ancestorDirsFor", () => {
  it("lists each ancestor dir in root → leaf order", () => {
    expect(ancestorDirsFor("/repo", "/repo/src/a/b/App.tsx")).toEqual([
      "/repo/src",
      "/repo/src/a",
      "/repo/src/a/b",
    ]);
  });
  it("is empty for a file directly under the root", () => {
    expect(ancestorDirsFor("/repo", "/repo/App.tsx")).toEqual([]);
  });
  it("is empty for a file outside the root", () => {
    expect(ancestorDirsFor("/repo", "/other/App.tsx")).toEqual([]);
  });
  it("uses the root separator on Windows backslash roots", () => {
    expect(ancestorDirsFor("C:\\repo", "C:\\repo\\src\\App.tsx")).toEqual([
      "C:\\repo\\src",
    ]);
  });
  it("tolerates a trailing slash on the root", () => {
    expect(ancestorDirsFor("/repo/", "/repo/src/App.tsx")).toEqual([
      "/repo/src",
    ]);
  });
});

describe("graftChildren", () => {
  it("inserts children at the target path, leaving siblings untouched", () => {
    const root: TreeNode = {
      entry: { name: "root", path: "/r", kind: "dir" },
      depth: 0,
      children: [
        { entry: { name: "a", path: "/r/a", kind: "dir" }, depth: 1 },
        { entry: { name: "b", path: "/r/b", kind: "dir" }, depth: 1 },
      ],
    };
    const next = graftChildren(root, "/r/a", [
      { name: "x.ts", path: "/r/a/x.ts", kind: "file" },
    ]);
    const a = next.children?.find((c) => c.entry.path === "/r/a");
    const b = next.children?.find((c) => c.entry.path === "/r/b");
    expect(a?.children?.map((c) => c.entry.path)).toEqual(["/r/a/x.ts"]);
    expect(a?.children?.[0].depth).toBe(2);
    // sibling is left exactly as it was (children still unloaded)
    expect(b?.children).toBeUndefined();
  });
});

describe("buildIgnoreMatcher", () => {
  it("matches exact ignored files", () => {
    const m = buildIgnoreMatcher([".env", "dist/bundle.js"]);
    expect(m.isIgnored(".env")).toBe(true);
    expect(m.isIgnored("dist/bundle.js")).toBe(true);
    expect(m.isIgnored("src/app.ts")).toBe(false);
  });

  it("dims the whole subtree of a collapsed ignored directory", () => {
    const m = buildIgnoreMatcher(["node_modules/"]);
    // the dir node itself…
    expect(m.isIgnored("node_modules")).toBe(true);
    // …and any descendant, even though git collapsed it to one entry.
    expect(m.isIgnored("node_modules/react/index.js")).toBe(true);
    // a sibling that merely shares the prefix is NOT ignored.
    expect(m.isIgnored("node_modules_keep/file.ts")).toBe(false);
  });

  it("treats an ignored active root ('./') as matching everything under it", () => {
    // git ls-files --directory reports `./` when the cwd itself is ignored.
    const m = buildIgnoreMatcher(["./"]);
    expect(m.isIgnored("anything")).toBe(true);
    expect(m.isIgnored("nested/deep/file.ts")).toBe(true);
    expect(buildIgnoreMatcher(["."]).isIgnored("x")).toBe(true);
  });

  it("normalizes separators and tolerates non-array input", () => {
    const m = buildIgnoreMatcher(["build\\cache/"]);
    expect(m.isIgnored("build/cache/out.o")).toBe(true);
    expect(buildIgnoreMatcher(null).isIgnored("anything")).toBe(false);
    expect(
      buildIgnoreMatcher(undefined as unknown as string[]).isIgnored("x"),
    ).toBe(false);
  });
});
