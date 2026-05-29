import { describe, expect, it, vi } from "vitest";

import { buildEditorMenus, type BuildEditorMenusArgs } from "./menuConfig";
import type { ContextMenuOption } from "../../../components/primitives/context-menu";
import type { EditorActions } from "./editorActions";
import type { EditorViewSettingsControls } from "./useEditorViewSettings";
import { DEFAULT_VIEW_SETTINGS } from "./viewSettings";

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

function stubView(
  overrides: Partial<EditorViewSettingsControls["settings"]> = {},
): EditorViewSettingsControls {
  return {
    settings: { ...DEFAULT_VIEW_SETTINGS, ...overrides },
    toggleWordWrap: vi.fn(),
    toggleMinimap: vi.fn(),
    toggleLineNumbers: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
  };
}

function build(overrides: Partial<BuildEditorMenusArgs> = {}) {
  const actions = stubActions();
  const view = overrides.view ?? stubView();
  const file = {
    newFile: vi.fn(),
    save: vi.fn(),
    revert: vi.fn(),
  };
  const menus = buildEditorMenus({
    isDirty: true,
    canMutate: true,
    actions,
    view,
    file,
    ...overrides,
  });
  return { menus, actions, view, file };
}

/** Find an option item by id across all menus. */
function option(
  menus: ReturnType<typeof buildEditorMenus>,
  id: string,
): ContextMenuOption {
  for (const menu of menus) {
    for (const item of menu.items) {
      if ("onSelect" in item && item.id === id) return item;
    }
  }
  throw new Error(`menu item ${id} not found`);
}

describe("buildEditorMenus", () => {
  it("produces File / Edit / View / Go in order", () => {
    const { menus } = build();
    expect(menus.map((m) => m.id)).toEqual(["file", "edit", "view", "go"]);
  });

  it("enables Save only when dirty and mutable", () => {
    expect(option(build({ isDirty: true, canMutate: true }).menus, "file-save").disabled).toBe(false);
    expect(option(build({ isDirty: false }).menus, "file-save").disabled).toBe(true);
    expect(option(build({ canMutate: false }).menus, "file-save").disabled).toBe(true);
  });

  it("disables Revert when not dirty", () => {
    expect(option(build({ isDirty: false }).menus, "file-revert").disabled).toBe(true);
    expect(option(build({ isDirty: true }).menus, "file-revert").disabled).toBe(false);
  });

  it("disables edit / format actions when not mutable", () => {
    const { menus } = build({ canMutate: false });
    expect(option(menus, "edit-undo").disabled).toBe(true);
    expect(option(menus, "edit-format").disabled).toBe(true);
    expect(option(menus, "edit-replace").disabled).toBe(true);
    // Find is read-only friendly — stays enabled.
    expect(option(menus, "edit-find").disabled).toBeFalsy();
  });

  it("reflects current view settings in the View labels", () => {
    const view = stubView({ wordWrap: true, minimap: false, fontZoom: 1.5 });
    const { menus } = build({ view });
    expect(option(menus, "view-word-wrap").label).toBe("Word Wrap: On");
    expect(option(menus, "view-minimap").label).toBe("Minimap: Off");
    expect(option(menus, "view-zoom-reset").label).toBe("Reset Zoom (150%)");
  });

  it("keeps View toggles open on select", () => {
    const { menus } = build();
    expect(option(menus, "view-word-wrap").keepOpenOnSelect).toBe(true);
    expect(option(menus, "view-zoom-in").keepOpenOnSelect).toBe(true);
  });

  it("wires items to the injected callbacks", () => {
    const { menus, actions, view, file } = build();
    option(menus, "file-new").onSelect();
    option(menus, "file-save").onSelect();
    option(menus, "edit-undo").onSelect();
    option(menus, "view-word-wrap").onSelect();
    option(menus, "go-file").onSelect();
    expect(file.newFile).toHaveBeenCalled();
    expect(file.save).toHaveBeenCalled();
    expect(actions.undo).toHaveBeenCalled();
    expect(view.toggleWordWrap).toHaveBeenCalled();
    expect(actions.gotoFile).toHaveBeenCalled();
  });
});
