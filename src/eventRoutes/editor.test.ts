import { describe, expect, it } from "vitest";
import { handleEditorCanvas, handleFileTree } from "./editor";
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
    expect((next.layout as { columns: string; lastRightWidth: string }).columns)
      .toBe("220px minmax(0,1fr) 640px");
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
