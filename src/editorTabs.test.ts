import { describe, expect, it } from "vitest";
import {
  editorTabsFromTabs,
  parseEditorTabsStore,
  toPersistedEditorTab,
} from "./editorTabs";
import type { Tab } from "./types/tab";

function editorTab(id: string, filePath: string, extra: object = {}): Tab {
  return {
    id,
    kind: "editor",
    label: filePath.split("/").pop() ?? filePath,
    editor: { filePath, language: "typescript", isDirty: false, ...extra },
  } as unknown as Tab;
}

describe("editorTabsFromTabs", () => {
  it("collects editor tabs, records the active one, dedupes, skips others", () => {
    const tabs: Tab[] = [
      { id: "a1", kind: "agent" } as unknown as Tab,
      editorTab("e1", "/r/src/App.tsx", { cursorLine: 4, cursorColumn: 2 }),
      editorTab("e2", "/r/src/App.tsx", { diff: true }), // diff variant kept
      editorTab("e3", "/r/src/App.tsx"), // dup of e1 (same path, not diff)
      { id: "s1", kind: "shell" } as unknown as Tab,
    ];
    const result = editorTabsFromTabs(tabs, "e1");
    expect(result.tabs.map((t) => `${t.filePath}:${t.diff ? "d" : "e"}`)).toEqual([
      "/r/src/App.tsx:e",
      "/r/src/App.tsx:d",
    ]);
    expect(result.tabs[0].cursorLine).toBe(4);
    expect(result.activeFilePath).toBe("/r/src/App.tsx");
  });

  it("omits activeFilePath when the active tab is a diff or non-editor", () => {
    const tabs = [editorTab("e2", "/r/x.ts", { diff: true })];
    expect(editorTabsFromTabs(tabs, "e2").activeFilePath).toBeUndefined();
  });
});

describe("toPersistedEditorTab", () => {
  it("returns null for non-editor tabs", () => {
    expect(toPersistedEditorTab({ id: "a", kind: "agent" } as unknown as Tab)).toBeNull();
  });
});

describe("parseEditorTabsStore", () => {
  it("tolerates empty / corrupt input", () => {
    expect(parseEditorTabsStore("")).toEqual({ version: 1, byProject: {} });
    expect(parseEditorTabsStore("not json")).toEqual({ version: 1, byProject: {} });
    expect(parseEditorTabsStore("[]")).toEqual({ version: 1, byProject: {} });
  });

  it("keeps well-formed entries and drops malformed tabs", () => {
    const raw = JSON.stringify({
      byProject: {
        p1: {
          activeFilePath: "/r/a.ts",
          tabs: [
            { filePath: "/r/a.ts", language: "typescript" },
            { filePath: 123, language: "x" }, // bad path → dropped
            { language: "x" }, // no path → dropped
          ],
        },
        p2: { tabs: [] }, // empty → dropped entirely
      },
    });
    expect(parseEditorTabsStore(raw)).toEqual({
      version: 1,
      byProject: {
        p1: {
          activeFilePath: "/r/a.ts",
          tabs: [{ filePath: "/r/a.ts", language: "typescript" }],
        },
      },
    });
  });
});
