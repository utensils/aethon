// Pi-tool wrapper tests for `buildEditorTools()`. The tool is a thin
// shim around `globalThis.aethon.editor.openFile`; the bridge handler
// owns filesystem validation and tab mutation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEditorTools } from "./editor-tools";

interface FakeEditor {
  openFile: ReturnType<typeof vi.fn>;
}

let fakeEditor: FakeEditor;
let originalAethon: unknown;

beforeEach(() => {
  fakeEditor = { openFile: vi.fn() };
  originalAethon = (globalThis as { aethon?: unknown }).aethon;
  (globalThis as { aethon?: { editor: FakeEditor } }).aethon = {
    editor: fakeEditor,
  };
});

afterEach(() => {
  (globalThis as { aethon?: unknown }).aethon = originalAethon;
});

function getTool() {
  const tools = buildEditorTools();
  const t = tools.find((tool) => tool.name === "openFileInEditor");
  if (!t) throw new Error("openFileInEditor not in catalogue");
  return t;
}

describe("buildEditorTools()", () => {
  it("registers exactly openFileInEditor", () => {
    const tools = buildEditorTools();
    expect(tools.map((t) => t.name)).toEqual(["openFileInEditor"]);
  });
});

describe("openFileInEditor tool", () => {
  it("forwards the path to aethon.editor.openFile", async () => {
    fakeEditor.openFile.mockResolvedValue({
      ok: true,
      data: { filePath: "/repo/src/App.tsx", rootPath: "/repo" },
    });

    const result = await getTool().execute("call-1", {
      path: "src/App.tsx",
    });

    expect(fakeEditor.openFile).toHaveBeenCalledWith({
      path: "src/App.tsx",
    });
    expect(result.details).toEqual({
      filePath: "/repo/src/App.tsx",
      rootPath: "/repo",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify(
        { filePath: "/repo/src/App.tsx", rootPath: "/repo" },
        null,
        2,
      ),
    });
  });

  it("forwards rootPath when provided", async () => {
    fakeEditor.openFile.mockResolvedValue({ ok: true, data: {} });

    await getTool().execute("call-2", {
      path: "config.toml",
      rootPath: "/Users/test/.aethon",
    });

    expect(fakeEditor.openFile).toHaveBeenCalledWith({
      path: "config.toml",
      rootPath: "/Users/test/.aethon",
    });
  });

  it("throws on ok=false so pi marks the tool result as an error", async () => {
    fakeEditor.openFile.mockResolvedValue({
      ok: false,
      error: "file not found or outside root: nope.ts",
    });

    await expect(
      getTool().execute("call-3", { path: "nope.ts" }),
    ).rejects.toThrow("file not found or outside root: nope.ts");
  });

  it("throws when the editor API is unavailable", async () => {
    (globalThis as { aethon?: unknown }).aethon = undefined;

    await expect(
      getTool().execute("call-4", { path: "README.md" }),
    ).rejects.toThrow(/aethon\.editor API unavailable/);
  });
});
