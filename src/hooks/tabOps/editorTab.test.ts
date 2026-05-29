import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { useEditorTabActions } from "./editorTab";
import type { Tab } from "../../types/tab";
import type { ProjectsState } from "../../projects";

// useEditorTabActions calls no React hooks — it just closes over its deps
// and returns plain functions — so it's safe to invoke directly in a test
// without a renderer.
function makeActions(initialTabs: Tab[], activeTabId: string) {
  const state: Record<string, unknown> = { tabs: initialTabs, activeTabId };
  const stateRef = { current: state } as MutableRefObject<
    Record<string, unknown>
  >;
  // updateTab applies the mutator (which contains updateEditorMeta's no-op
  // guard) and writes the result back into stateRef so a follow-up toggle
  // reads the new previewMode — exactly the contract App's mutations honor.
  const updateTab = (tabId: string, mutator: (tab: Tab) => Tab) => {
    const tabs = (stateRef.current.tabs as Tab[]).map((t) =>
      t.id === tabId ? mutator(t) : t,
    );
    stateRef.current = { ...stateRef.current, tabs };
  };
  // useEditorTabActions calls no React hooks internally (see the note
  // above) — it's a plain factory, safe to call outside a component.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const actions = useEditorTabActions({
    setState: vi.fn(),
    stateRef,
    projectsRef: {
      current: { activeId: "p1" },
    } as unknown as MutableRefObject<ProjectsState>,
    setActiveTab: vi.fn(),
    updateTab,
  });
  const tabOf = (id: string) =>
    (stateRef.current.tabs as Tab[]).find((t) => t.id === id)!;
  return { actions, tabOf };
}

function mdTab(id: string): Tab {
  return {
    id,
    kind: "editor",
    label: "README.md",
    editor: { filePath: "/r/README.md", language: "markdown", isDirty: false },
  } as unknown as Tab;
}

describe("toggleEditorPreview", () => {
  it("flips previewMode on a markdown tab and bumps the refresh key", () => {
    const { actions, tabOf } = makeActions([mdTab("t1")], "t1");

    actions.toggleEditorPreview();
    expect(tabOf("t1").editor?.previewMode).toBe(true);
    expect(tabOf("t1").editor?.previewRefreshKey).toBe(1);

    // Regression guard: a second toggle must actually flip back. The
    // updateEditorMeta no-op guard once omitted previewMode and silently
    // swallowed this, breaking Cmd+Shift+V.
    actions.toggleEditorPreview();
    expect(tabOf("t1").editor?.previewMode).toBe(false);
    expect(tabOf("t1").editor?.previewRefreshKey).toBe(2);
  });

  it("is a no-op for non-markdown editor tabs", () => {
    const rs = {
      id: "t2",
      kind: "editor",
      label: "main.rs",
      editor: { filePath: "/r/main.rs", language: "rust", isDirty: false },
    } as unknown as Tab;
    const { actions, tabOf } = makeActions([rs], "t2");
    actions.toggleEditorPreview();
    expect(tabOf("t2").editor?.previewMode).toBeUndefined();
  });
});
