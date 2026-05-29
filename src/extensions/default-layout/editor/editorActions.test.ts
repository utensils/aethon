// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEditorActions,
  GOTO_FILE_EVENT,
  REVEAL_IN_TREE_EVENT,
  type EditorActionsDeps,
} from "./editorActions";

afterEach(() => vi.restoreAllMocks());

/** A fake Monaco editor recording the action ids / commands it runs. */
function fakeEditor() {
  const ran: string[] = [];
  const triggered: string[] = [];
  let value = "file contents";
  return {
    ran,
    triggered,
    setValue: (v: string) => {
      value = v;
    },
    editor: {
      focus: vi.fn(),
      getModel: () => ({ getValue: () => value }),
      getAction: (id: string) => ({
        run: () => {
          ran.push(id);
          return Promise.resolve();
        },
      }),
      trigger: (_src: string, cmd: string) => {
        triggered.push(cmd);
      },
    },
  };
}

function makeDeps(overrides: Partial<EditorActionsDeps> = {}): {
  deps: EditorActionsDeps;
  clip: string[];
  events: string[];
  closed: string[];
  invoked: Array<{ cmd: string; args?: Record<string, unknown> }>;
} {
  const clip: string[] = [];
  const events: string[] = [];
  const closed: string[] = [];
  const invoked: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const deps: EditorActionsDeps = {
    getEditor: () => null,
    getFilePath: () => "/repo/src/App.tsx",
    getRoot: () => "/repo",
    getTabId: () => "ed-1",
    invoke: (cmd, args) => {
      invoked.push({ cmd, args });
      return Promise.resolve(null);
    },
    closeTab: (id) => closed.push(id),
    dispatchWindowEvent: (name) => events.push(name),
    writeClipboard: (text) => clip.push(text),
    ...overrides,
  };
  return { deps, clip, events, closed, invoked };
}

describe("createEditorActions — Monaco actions", () => {
  it("runs find / replace / format / gotoLine / gotoSymbol on the editor", () => {
    const ed = fakeEditor();
    const { deps } = makeDeps({ getEditor: () => ed.editor as never });
    const actions = createEditorActions(deps);
    actions.find();
    actions.replace();
    actions.format();
    actions.gotoLine();
    actions.gotoSymbol();
    expect(ed.ran).toEqual([
      "actions.find",
      "editor.action.startFindReplaceAction",
      "editor.action.formatDocument",
      "editor.action.gotoLine",
      "editor.action.quickOutline",
    ]);
    expect(ed.editor.focus).toHaveBeenCalled();
  });

  it("triggers undo / redo as Monaco commands", () => {
    const ed = fakeEditor();
    const { deps } = makeDeps({ getEditor: () => ed.editor as never });
    const actions = createEditorActions(deps);
    actions.undo();
    actions.redo();
    expect(ed.triggered).toEqual(["undo", "redo"]);
  });

  it("no-ops Monaco actions when no editor is mounted", () => {
    const { deps } = makeDeps({ getEditor: () => null });
    const actions = createEditorActions(deps);
    expect(() => {
      actions.undo();
      actions.find();
    }).not.toThrow();
  });
});

describe("createEditorActions — clipboard", () => {
  it("copies file contents, absolute path, and relative path", () => {
    const ed = fakeEditor();
    const { deps, clip } = makeDeps({ getEditor: () => ed.editor as never });
    const actions = createEditorActions(deps);
    actions.copyContents();
    actions.copyPath();
    actions.copyRelativePath();
    expect(clip).toEqual([
      "file contents",
      "/repo/src/App.tsx",
      "src/App.tsx",
    ]);
  });
});

describe("createEditorActions — fan-out", () => {
  it("gotoFile dispatches the quick-open window event", () => {
    const { deps, events } = makeDeps();
    createEditorActions(deps).gotoFile();
    expect(events).toContain(GOTO_FILE_EVENT);
  });

  it("revealInFiles dispatches a reveal-in-tree CustomEvent with the path", () => {
    const { deps } = makeDeps();
    const seen: Array<string | undefined> = [];
    const handler = (e: Event) =>
      seen.push((e as CustomEvent<{ filePath?: string }>).detail?.filePath);
    window.addEventListener(REVEAL_IN_TREE_EVENT, handler);
    createEditorActions(deps).revealInFiles();
    window.removeEventListener(REVEAL_IN_TREE_EVENT, handler);
    expect(seen).toEqual(["/repo/src/App.tsx"]);
  });

  it("revealInFinder invokes fs_reveal_in_file_manager with root + path", () => {
    const { deps, invoked } = makeDeps();
    createEditorActions(deps).revealInFinder();
    expect(invoked).toEqual([
      {
        cmd: "fs_reveal_in_file_manager",
        args: { root: "/repo", path: "/repo/src/App.tsx" },
      },
    ]);
  });

  it("closeFile routes through closeTab with the active tab id", () => {
    const { deps, closed } = makeDeps();
    createEditorActions(deps).closeFile();
    expect(closed).toEqual(["ed-1"]);
  });

  it("revealInFinder is a no-op without a file path", () => {
    const { deps, invoked } = makeDeps({ getFilePath: () => "" });
    createEditorActions(deps).revealInFinder();
    expect(invoked).toEqual([]);
  });
});
