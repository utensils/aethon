/**
 * Editor menu configuration — pure data builder for the File / Edit /
 * View / Go menubar. Returns `ContextMenuItem[]` per menu so the menubar
 * component stays a thin renderer and the menu structure (labels, hints,
 * disabled gating, ordering) is unit-testable without React or Monaco.
 *
 * File ops are passed in as callbacks (the menubar wires them to the
 * shared `aethon:*` window events the native menu also uses); every other
 * item calls an injected `EditorActions` / view-settings control so there
 * is one code path per operation.
 */
import type { ContextMenuItem } from "../../../components/primitives/context-menu";
import type { EditorActions } from "./editorActions";
import type { EditorViewSettingsControls } from "./useEditorViewSettings";

export type EditorMenuId = "file" | "edit" | "view" | "go";

export interface EditorMenu {
  id: EditorMenuId;
  label: string;
  items: ContextMenuItem[];
}

export interface BuildEditorMenusArgs {
  /** Unsaved changes in the active buffer. */
  isDirty: boolean;
  /** Whether the surface accepts edits (false for preview / diff / viewer). */
  canMutate: boolean;
  actions: EditorActions;
  view: EditorViewSettingsControls;
  /** File ops — emit the shared window events so native-menu parity holds. */
  file: { newFile: () => void; save: () => void; revert: () => void };
}

function onOff(enabled: boolean): string {
  return enabled ? "On" : "Off";
}

export function buildEditorMenus({
  isDirty,
  canMutate,
  actions,
  view,
  file,
}: BuildEditorMenusArgs): EditorMenu[] {
  const { settings } = view;

  const fileMenu: EditorMenu = {
    id: "file",
    label: "File",
    items: [
      { id: "file-new", label: "New File…", hint: "⌘N", onSelect: file.newFile },
      {
        id: "file-save",
        label: "Save",
        hint: "⌘S",
        disabled: !canMutate || !isDirty,
        onSelect: file.save,
      },
      {
        id: "file-revert",
        label: "Revert to Saved",
        disabled: !isDirty,
        onSelect: file.revert,
      },
      { type: "separator" },
      {
        id: "file-reveal-tree",
        label: "Reveal in Files Panel",
        onSelect: actions.revealInFiles,
      },
      {
        id: "file-reveal-finder",
        label: "Reveal in File Manager",
        onSelect: actions.revealInFinder,
      },
      { type: "separator" },
      {
        id: "file-close",
        label: "Close File",
        hint: "⌘W",
        onSelect: actions.closeFile,
      },
    ],
  };

  const editMenu: EditorMenu = {
    id: "edit",
    label: "Edit",
    items: [
      {
        id: "edit-undo",
        label: "Undo",
        hint: "⌘Z",
        disabled: !canMutate,
        onSelect: actions.undo,
      },
      {
        id: "edit-redo",
        label: "Redo",
        hint: "⇧⌘Z",
        disabled: !canMutate,
        onSelect: actions.redo,
      },
      { type: "separator" },
      { id: "edit-find", label: "Find…", hint: "⌘F", onSelect: actions.find },
      {
        id: "edit-replace",
        label: "Find and Replace…",
        hint: "⌥⌘F",
        disabled: !canMutate,
        onSelect: actions.replace,
      },
      {
        id: "edit-format",
        label: "Format Document",
        hint: "⇧⌥F",
        disabled: !canMutate,
        onSelect: actions.format,
      },
      { type: "separator" },
      {
        id: "edit-copy-contents",
        label: "Copy File Contents",
        onSelect: actions.copyContents,
      },
      { id: "edit-copy-path", label: "Copy Path", onSelect: actions.copyPath },
      {
        id: "edit-copy-rel-path",
        label: "Copy Relative Path",
        onSelect: actions.copyRelativePath,
      },
    ],
  };

  const viewMenu: EditorMenu = {
    id: "view",
    label: "View",
    items: [
      {
        id: "view-word-wrap",
        label: `Word Wrap: ${onOff(settings.wordWrap)}`,
        keepOpenOnSelect: true,
        onSelect: view.toggleWordWrap,
      },
      {
        id: "view-minimap",
        label: `Minimap: ${onOff(settings.minimap)}`,
        keepOpenOnSelect: true,
        onSelect: view.toggleMinimap,
      },
      {
        id: "view-line-numbers",
        label: `Line Numbers: ${onOff(settings.lineNumbers)}`,
        keepOpenOnSelect: true,
        onSelect: view.toggleLineNumbers,
      },
      { type: "separator" },
      {
        id: "view-zoom-in",
        label: "Zoom In",
        hint: "⌘=",
        keepOpenOnSelect: true,
        onSelect: view.zoomIn,
      },
      {
        id: "view-zoom-out",
        label: "Zoom Out",
        hint: "⌘-",
        keepOpenOnSelect: true,
        onSelect: view.zoomOut,
      },
      {
        id: "view-zoom-reset",
        label: `Reset Zoom (${Math.round(settings.fontZoom * 100)}%)`,
        hint: "⌘0",
        keepOpenOnSelect: true,
        onSelect: view.resetZoom,
      },
    ],
  };

  const goMenu: EditorMenu = {
    id: "go",
    label: "Go",
    items: [
      {
        id: "go-file",
        label: "Go to File…",
        hint: "⌘P",
        onSelect: actions.gotoFile,
      },
      {
        id: "go-line",
        label: "Go to Line…",
        hint: "⌃G",
        onSelect: actions.gotoLine,
      },
      {
        id: "go-symbol",
        label: "Go to Symbol…",
        hint: "⇧⌘O",
        onSelect: actions.gotoSymbol,
      },
    ],
  };

  return [fileMenu, editMenu, viewMenu, goMenu];
}
