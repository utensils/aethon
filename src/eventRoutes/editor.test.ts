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
  it("opens an editor tab on file-tree-open", () => {
    const fx = buildRouteFixture();
    const claimed = handleFileTree(
      {
        component: { id: "file-tree", type: "file-tree" },
        eventType: "file-tree-open",
        data: { filePath: "/projects/aethon/src/App.tsx" },
      },
      fx.ctx,
    );
    expect(claimed).toBe(true);
    expect(fx.mocks.newEditorTab).toHaveBeenCalledWith(
      "/projects/aethon/src/App.tsx",
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
