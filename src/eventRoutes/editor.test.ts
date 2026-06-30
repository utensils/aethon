import { describe, expect, it } from "vitest";
import { handleEditorCanvas, handleFileTree, handleToolCardFile } from "./editor";
import { buildRouteFixture } from "./testFixtures";

const editorEvent = (eventType: string, data: unknown) => ({
  component: { id: "editor-canvas", type: "editor-canvas" },
  eventType,
  data,
});

describe("handleEditorCanvas", () => {
  it("flips dirty on editor-change", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("editor-change", { tabId: "tab-1", isDirty: true }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.updateEditorMeta).toHaveBeenCalledWith("tab-1", {
      isDirty: true,
    });
  });

  it("clears dirty on editor-loaded", async () => {
    const fx = buildRouteFixture();
    await handleEditorCanvas(
      editorEvent("editor-loaded", { tabId: "tab-1", filePath: "/x/y.ts" }),
      fx.ctx,
    );
    expect(fx.mocks.updateEditorMeta).toHaveBeenCalledWith("tab-1", {
      isDirty: false,
    });
  });

  it("mirrors cursor on editor-cursor", async () => {
    const fx = buildRouteFixture();
    await handleEditorCanvas(
      editorEvent("editor-cursor", { tabId: "tab-1", line: 12, column: 4 }),
      fx.ctx,
    );
    expect(fx.mocks.updateEditorMeta).toHaveBeenCalledWith("tab-1", {
      cursorLine: 12,
      cursorColumn: 4,
    });
  });

  it("routes editor-close through closeTab (honours dirty confirm)", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("editor-close", { tabId: "tab-1" }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.closeTab).toHaveBeenCalledWith("tab-1");
  });

  it("toggles markdown preview on editor-preview-toggle", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("editor-preview-toggle", { tabId: "tab-1" }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.toggleEditorPreview).toHaveBeenCalledTimes(1);
  });

  it("drops the diff flag on editor-diff-to-edit", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("editor-diff-to-edit", { tabId: "tab-1" }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.updateEditorMeta).toHaveBeenCalledWith("tab-1", {
      diff: false,
      diffSnapshot: undefined,
    });
  });

  it("opens markdown preview file links in an editor tab", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("markdown-link-open", {
        tabId: "tab-1",
        filePath: "/projects/aethon/docs/api.md",
        rootPath: "/projects/aethon",
      }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).toHaveBeenCalledWith(
      "/projects/aethon/docs/api.md",
      { rootPath: "/projects/aethon" },
    );
  });

  it("claims empty markdown link events without opening a tab", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("markdown-link-open", {
        tabId: "tab-1",
        rootPath: "/projects/aethon",
      }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).not.toHaveBeenCalled();
  });

  it("invokes fs_write_file on editor-save and clears dirty", async () => {
    const fx = buildRouteFixture({
      state: { project: { path: "/projects/aethon" } },
    });
    fx.mocks.invoke.mockResolvedValueOnce(undefined);
    const claimed = await handleEditorCanvas(
      editorEvent("editor-save", {
        tabId: "tab-1",
        filePath: "/projects/aethon/src/App.tsx",
        content: "// hi",
      }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.invoke).toHaveBeenCalledWith("fs_write_file", {
      root: "/projects/aethon",
      path: "/projects/aethon/src/App.tsx",
      content: "// hi",
    });
    expect(fx.mocks.updateEditorMeta).toHaveBeenCalledWith("tab-1", {
      isDirty: false,
    });
    expect(fx.mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "success" }),
    );
  });

  it("uses an editor tab root override when saving user-dir files", async () => {
    const fx = buildRouteFixture({
      state: {
        project: { path: "/projects/aethon" },
        tabs: [
          {
            id: "tab-1",
            kind: "editor",
            editor: {
              filePath: "/Users/test/.aethon/system-prompt.md",
              rootPath: "/Users/test/.aethon",
            },
          },
        ],
      },
    });
    const claimed = await handleEditorCanvas(
      editorEvent("editor-save", {
        tabId: "tab-1",
        filePath: "/Users/test/.aethon/system-prompt.md",
        content: "You are Aethon.",
      }),
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.invoke).toHaveBeenCalledWith("fs_write_file", {
      root: "/Users/test/.aethon",
      path: "/Users/test/.aethon/system-prompt.md",
      content: "You are Aethon.",
    });
  });

  it("surfaces a notification when fs_write_file errors", async () => {
    const fx = buildRouteFixture({
      state: { project: { path: "/projects/aethon" } },
    });
    fx.mocks.invoke.mockRejectedValueOnce("disk full");
    await handleEditorCanvas(
      editorEvent("editor-save", {
        tabId: "tab-1",
        filePath: "/projects/aethon/src/App.tsx",
        content: "// hi",
      }),
      fx.ctx,
    );
    expect(fx.mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
    // dirty must NOT be cleared on failure
    expect(fx.mocks.updateEditorMeta).not.toHaveBeenCalled();
  });

  it("ignores unknown event types", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("nope", { tabId: "tab-1" }),
      fx.ctx,
    );
    expect(claimed).toBe(false);
  });

  it("ignores events without a tab id", async () => {
    const fx = buildRouteFixture();
    const claimed = await handleEditorCanvas(
      editorEvent("editor-change", {}),
      fx.ctx,
    );
    expect(claimed).toBe(false);
  });
});

describe("handleFileTree", () => {
  it("resizes the files sidebar column and remembers the width", () => {
    const fx = buildRouteFixture();
    const claimed = handleFileTree(
      {
        component: { id: "file-tree", type: "file-tree" },
        eventType: "resize",
        data: { width: 512 },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    const next = fx.applySetState({
      layout: { columns: "240px minmax(0,1fr) 360px" },
    });
    expect(next.layout).toEqual(
      expect.objectContaining({
        columns: "240px minmax(0,1fr) 512px",
        lastRightWidth: "512px",
      }),
    );
  });

  it("clamps files sidebar resize width", () => {
    const fx = buildRouteFixture();
    handleFileTree(
      {
        component: { id: "file-tree", type: "file-tree" },
        eventType: "resize",
        data: { width: 1200 },
      },
      fx.ctx,
    );
    const next = fx.applySetState({
      layout: { columns: "220px minmax(0,1fr) 360px" },
    });
    expect(
      (next.layout as { columns: string; lastRightWidth: string }).columns,
    ).toBe("220px minmax(0,1fr) 640px");
    expect((next.layout as { lastRightWidth: string }).lastRightWidth).toBe(
      "640px",
    );
  });

  it("handles files sidebar resize-end without a one-off write", () => {
    const fx = buildRouteFixture();
    const claimed = handleFileTree(
      {
        component: { id: "file-tree", type: "file-tree" },
        eventType: "resize-end",
        data: {},
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.writeState).not.toHaveBeenCalled();
  });

  it("opens an editor tab on file-tree-open", () => {
    const fx = buildRouteFixture();
    const claimed = handleFileTree(
      {
        component: { id: "file-tree", type: "file-tree" },
        eventType: "file-tree-open",
        data: {
          filePath: "/projects/aethon/src/App.tsx",
          rootPath: "/projects/aethon",
        },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).toHaveBeenCalledWith(
      "/projects/aethon/src/App.tsx",
      { rootPath: "/projects/aethon" },
    );
  });

  it("opens every file from file-tree-open-many", () => {
    const fx = buildRouteFixture();
    const claimed = handleFileTree(
      {
        component: { id: "vcs-status", type: "vcs-status" },
        eventType: "file-tree-open-many",
        data: {
          files: [
            {
              filePath: "/projects/aethon/src/App.tsx",
              rootPath: "/projects/aethon",
            },
            {
              filePath: "/projects/aethon/agent/main.ts",
              rootPath: "/projects/aethon",
            },
          ],
        },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).toHaveBeenCalledTimes(2);
    expect(fx.mocks.newEditorTab).toHaveBeenNthCalledWith(
      1,
      "/projects/aethon/src/App.tsx",
      { rootPath: "/projects/aethon" },
    );
    expect(fx.mocks.newEditorTab).toHaveBeenNthCalledWith(
      2,
      "/projects/aethon/agent/main.ts",
      { rootPath: "/projects/aethon" },
    );
  });

  it("opens a diff tab on file-tree-diff", () => {
    const fx = buildRouteFixture();
    const claimed = handleFileTree(
      {
        component: { id: "source-control-panel", type: "source-control-panel" },
        eventType: "file-tree-diff",
        data: {
          filePath: "/projects/aethon/src/App.tsx",
          rootPath: "/projects/aethon",
        },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).toHaveBeenCalledWith(
      "/projects/aethon/src/App.tsx",
      { diff: true, rootPath: "/projects/aethon" },
    );
  });

  it("declines unknown events", () => {
    const fx = buildRouteFixture();
    const claimed = handleFileTree(
      {
        component: { id: "file-tree", type: "file-tree" },
        eventType: "noop",
        data: {},
      },
      fx.ctx,
    );
    expect(claimed).toBe(false);
  });
});

describe("handleToolCardFile", () => {
  it("opens a tool-card file in an editor tab", () => {
    const fx = buildRouteFixture({
      state: { project: { path: "/projects/aethon" } },
    });
    const claimed = handleToolCardFile(
      {
        component: { id: "tool-1", type: "tool-card" },
        eventType: "tool-file-open",
        data: { filePath: "src/App.tsx" },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).toHaveBeenCalledWith(
      "/projects/aethon/src/App.tsx",
      { rootPath: "/projects/aethon" },
    );
  });

  it("opens a tool-card file in a snapshot-backed diff tab", () => {
    const fx = buildRouteFixture();
    const diffSnapshot = {
      format: "unified" as const,
      content: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@\n-old\n+new",
      additions: 1,
      deletions: 1,
      source: "tool-card" as const,
    };
    const claimed = handleToolCardFile(
      {
        component: { id: "tool-1", type: "tool-card" },
        eventType: "tool-file-diff",
        data: {
          filePath: "/projects/aethon/src/App.tsx",
          rootPath: "/projects/aethon",
          diffSnapshot,
        },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).toHaveBeenCalledWith(
      "/projects/aethon/src/App.tsx",
      { diff: true, rootPath: "/projects/aethon", diffSnapshot },
    );
  });

  it("warns instead of opening a live git diff for tool-card records without snapshots", () => {
    const fx = buildRouteFixture();
    const claimed = handleToolCardFile(
      {
        component: { id: "tool-1", type: "tool-card" },
        eventType: "tool-file-diff",
        data: {
          filePath: "/projects/aethon/src/App.tsx",
          rootPath: "/projects/aethon",
        },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).not.toHaveBeenCalled();
    expect(fx.mocks.pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Diff snapshot unavailable",
        kind: "warning",
      }),
    );
  });

  it("ignores unrelated tool-card events", () => {
    const fx = buildRouteFixture();
    expect(
      handleToolCardFile(
        {
          component: { id: "tool-1", type: "tool-card" },
          eventType: "tool-noop",
          data: {},
        },
        fx.ctx,
      ),
    ).toBe(false);
  });
});
