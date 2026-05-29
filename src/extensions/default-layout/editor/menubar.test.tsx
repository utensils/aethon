// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorMenubar, type EditorMenubarProps } from "./menubar";
import type { EditorActions } from "./editorActions";
import type { EditorViewSettingsControls } from "./useEditorViewSettings";
import { DEFAULT_VIEW_SETTINGS } from "./viewSettings";

afterEach(() => cleanup());

function stubActions(): EditorActions {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    find: vi.fn(),
    replace: vi.fn(),
    format: vi.fn(),
    gotoLine: vi.fn(),
    gotoSymbol: vi.fn(),
    gotoFile: vi.fn(),
    copyContents: vi.fn(),
    copyPath: vi.fn(),
    copyRelativePath: vi.fn(),
    revealInFiles: vi.fn(),
    revealInFinder: vi.fn(),
    closeFile: vi.fn(),
  };
}

function stubView(): EditorViewSettingsControls {
  return {
    settings: { ...DEFAULT_VIEW_SETTINGS },
    toggleWordWrap: vi.fn(),
    toggleMinimap: vi.fn(),
    toggleLineNumbers: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
  };
}

function renderMenubar(overrides: Partial<EditorMenubarProps> = {}) {
  const actions = overrides.actions ?? stubActions();
  const view = overrides.view ?? stubView();
  render(
    <EditorMenubar
      isDirty={false}
      canMutate
      canPreview={false}
      previewActive={false}
      externalChanged={false}
      actions={actions}
      view={view}
      {...overrides}
    />,
  );
  return { actions, view };
}

describe("EditorMenubar", () => {
  it("renders the four menu triggers", () => {
    renderMenubar();
    for (const label of ["File", "Edit", "View", "Go"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }
  });

  it("opens the File menu and dispatches the save window event", () => {
    const seen: string[] = [];
    const handler = (e: Event) => seen.push(e.type);
    window.addEventListener("aethon:editor-save", handler);
    renderMenubar({ isDirty: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Save/ }));
    window.removeEventListener("aethon:editor-save", handler);
    expect(seen).toContain("aethon:editor-save");
  });

  it("invokes injected actions from the Edit menu", () => {
    const { actions } = renderMenubar();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Format Document/ }));
    expect(actions.format).toHaveBeenCalledTimes(1);
  });

  it("toggles view settings without closing the View menu", () => {
    const { view } = renderMenubar();
    fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Word Wrap/ }));
    expect(view.toggleWordWrap).toHaveBeenCalledTimes(1);
    // keepOpenOnSelect → still open, so the item is still queryable.
    expect(screen.getByRole("menuitem", { name: /^Word Wrap/ })).toBeTruthy();
  });

  it("hides the Preview toggle for non-markdown files", () => {
    renderMenubar({ canPreview: false, onTogglePreview: vi.fn() });
    expect(screen.queryByRole("button", { name: /Preview|Edit/ })).toBeNull();
  });

  it("shows Preview for markdown and flips to Edit when active", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <EditorMenubar
        isDirty={false}
        canMutate
        canPreview
        previewActive={false}
        externalChanged={false}
        actions={stubActions()}
        view={stubView()}
        onTogglePreview={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <EditorMenubar
        isDirty={false}
        canMutate
        canPreview
        previewActive
        externalChanged={false}
        actions={stubActions()}
        view={stubView()}
        onTogglePreview={onToggle}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("shows the external-change reload button only when flagged", () => {
    const onReload = vi.fn();
    const { rerender } = render(
      <EditorMenubar
        isDirty
        canMutate
        canPreview={false}
        previewActive={false}
        externalChanged={false}
        actions={stubActions()}
        view={stubView()}
        onReloadExternal={onReload}
      />,
    );
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
    rerender(
      <EditorMenubar
        isDirty
        canMutate
        canPreview={false}
        previewActive={false}
        externalChanged
        actions={stubActions()}
        view={stubView()}
        onReloadExternal={onReload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("disables Save in the File menu when not dirty", () => {
    renderMenubar({ isDirty: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    const save = screen.getByRole("menuitem", { name: /^Save/ });
    expect(save).toHaveProperty("disabled", true);
  });
});
