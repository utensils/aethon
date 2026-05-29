/**
 * Editor actions — the imperative operations the editor menubar invokes.
 *
 * Split out from the canvas so the menubar takes a plain interface (easy
 * to mock in tests) and the canvas stays a thin host. Monaco-native
 * actions run against the live editor instance; file-oriented actions
 * fan out to clipboard / Tauri IPC / window events that the canvas, file
 * tree, command palette, and tab close path already listen for. No new
 * IPC or duplicated save logic — this only wires existing channels.
 */
import type * as monaco from "monaco-editor";

import { copyToClipboard, relativePath } from "./path";

/** Window event that the file tree listens for to expand + select a path. */
export const REVEAL_IN_TREE_EVENT = "aethon:reveal-in-tree";
/** Window event that the command palette listens for to open quick-open. */
export const GOTO_FILE_EVENT = "aethon:goto-file";

export interface EditorActions {
  undo: () => void;
  redo: () => void;
  find: () => void;
  replace: () => void;
  format: () => void;
  gotoLine: () => void;
  gotoSymbol: () => void;
  /** Opens the fuzzy quick-open file palette (⌘P). */
  gotoFile: () => void;
  copyContents: () => void;
  copyPath: () => void;
  copyRelativePath: () => void;
  /** Expand the sidebar file tree to the current file and select it. */
  revealInFiles: () => void;
  /** Open the current file's folder in the OS file manager. */
  revealInFinder: () => void;
  /** Close the current editor tab (routes through the dirty-confirm path). */
  closeFile: () => void;
}

export interface EditorActionsDeps {
  /** Live Monaco instance accessor; null while no editor tab is mounted. */
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null;
  /** Current buffer's on-disk path (project-relative root anchor below). */
  getFilePath: () => string;
  /** Active project / worktree root for relative-path + reveal. */
  getRoot: () => string;
  /** Active editor tab id, for close routing. */
  getTabId: () => string;
  /** Tauri invoke (injected so tests can assert without a backend). */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Route a tab close through the app's close path (honours dirty confirm). */
  closeTab: (tabId: string) => void;
  /** Dispatch a bare window event by name (injected for tests). */
  dispatchWindowEvent?: (name: string) => void;
  /** Copy text to the clipboard (injected for tests). */
  writeClipboard?: (text: string) => void;
}

function defaultDispatch(name: string): void {
  window.dispatchEvent(new Event(name));
}

export function createEditorActions(deps: EditorActionsDeps): EditorActions {
  const dispatch = deps.dispatchWindowEvent ?? defaultDispatch;
  const clip = deps.writeClipboard ?? copyToClipboard;

  /** Run a registered Monaco action by id, focusing first so widgets that
   *  need editor focus (find, go-to-line) open reliably. */
  const runAction = (id: string) => {
    const ed = deps.getEditor();
    if (!ed) return;
    ed.focus();
    void ed.getAction(id)?.run();
  };

  /** Trigger a built-in Monaco command (undo/redo aren't exposed as
   *  getAction ids; `trigger` is the supported path). */
  const trigger = (command: string) => {
    const ed = deps.getEditor();
    if (!ed) return;
    ed.focus();
    ed.trigger("menubar", command, null);
  };

  return {
    undo: () => trigger("undo"),
    redo: () => trigger("redo"),
    find: () => runAction("actions.find"),
    replace: () => runAction("editor.action.startFindReplaceAction"),
    format: () => runAction("editor.action.formatDocument"),
    gotoLine: () => runAction("editor.action.gotoLine"),
    gotoSymbol: () => runAction("editor.action.quickOutline"),
    gotoFile: () => dispatch(GOTO_FILE_EVENT),
    copyContents: () => {
      const ed = deps.getEditor();
      clip(ed?.getModel()?.getValue() ?? "");
    },
    copyPath: () => clip(deps.getFilePath()),
    copyRelativePath: () =>
      clip(relativePath(deps.getFilePath(), deps.getRoot())),
    revealInFiles: () => {
      const filePath = deps.getFilePath();
      if (!filePath) return;
      window.dispatchEvent(
        new CustomEvent(REVEAL_IN_TREE_EVENT, { detail: { filePath } }),
      );
    },
    revealInFinder: () => {
      const root = deps.getRoot();
      const path = deps.getFilePath();
      if (!root || !path) return;
      void deps.invoke("fs_reveal_in_file_manager", { root, path }).catch(() => {
        /* best-effort — reveal failures are non-fatal */
      });
    },
    closeFile: () => {
      const tabId = deps.getTabId();
      if (tabId) deps.closeTab(tabId);
    },
  };
}
