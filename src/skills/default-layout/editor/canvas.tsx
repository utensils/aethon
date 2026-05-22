/**
 * EditorCanvas — Monaco-backed editor surface for editor tabs.
 *
 * Mirrors ShellCanvas in structure: read /tabs + /activeTabId, find the
 * editor tab the layout is showing, mount a Monaco instance keyed on
 * tabId so cursor + undo isolate per tab, render a status strip
 * underneath. Differences from ShellCanvas:
 *
 *  - File contents come from Tauri's fs_read_file rather than a Rust-
 *    side PTY. Reads happen on mount; subsequent edits stay in the
 *    Monaco model.
 *  - Cmd+S routes through the `editor:save` event so the App-level event
 *    table can dispatch fs_write_file via Tauri.
 *  - Theme switching uses `applyMonacoTheme(themeId)` which maps Aethon
 *    theme ids onto Monaco's built-in `vs` / `vs-dark`.
 *
 * The composite is dispatched by `type:editor-canvas` so a skill can
 * register a replacement via `aethon.registerComponent`.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";

import type { StringValue } from "../../../types/a2ui";
import { resolveString } from "../../../utils/dataBinding";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { applyMonacoTheme } from "../../../monaco/theme";

interface EditorTabLike {
  id: string;
  kind?: string;
  editor?: {
    filePath?: string;
    language?: string;
    isDirty?: boolean;
    cursorLine?: number;
    cursorColumn?: number;
  };
}

export function EditorCanvas({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    /** Tab id this canvas is bound to. The layout passes `/activeTabId`
     *  so the canvas tracks whichever editor tab the user is on. */
    tabId?: StringValue;
  };
  const tabId = props.tabId ? resolveString(props.tabId, state) : "";

  // Pull the bound tab's editor metadata so the status strip + initial
  // file load can read it. Read-only — mutations flow back through
  // `onEvent("editor-change", …)` / `onEvent("editor-save", …)`.
  const tabs = (state["tabs"] as EditorTabLike[] | undefined) ?? [];
  const boundTab = tabs.find((t) => t.id === tabId);
  const editorMeta = boundTab?.editor;

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const tabIdRef = useRef<string>(tabId);
  const filePathRef = useRef<string>(editorMeta?.filePath ?? "");
  const [loadError, setLoadError] = useState<string>("");
  const [cursorDisplay, setCursorDisplay] = useState<{ line: number; column: number }>({
    line: 1,
    column: 1,
  });

  useEffect(() => {
    tabIdRef.current = tabId;
  }, [tabId]);

  useEffect(() => {
    filePathRef.current = editorMeta?.filePath ?? "";
  }, [editorMeta?.filePath]);

  // Mount Monaco once per tabId — switching tabs unmounts the previous
  // instance and creates a fresh one, so per-tab cursor + undo state
  // doesn't bleed across tabs.
  useEffect(() => {
    if (!containerRef.current) return;
    if (!tabId) return;
    if (!editorMeta?.filePath) return;

    const container = containerRef.current;
    const filePath = editorMeta.filePath;
    const language = editorMeta.language || "plaintext";

    // Apply the current Aethon theme to Monaco's global theme registry
    // before the editor mounts so first paint is correct.
    applyMonacoTheme(document.documentElement.dataset.theme);

    const ed = monaco.editor.create(container, {
      value: "",
      language,
      automaticLayout: true,
      contextmenu: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: "off",
    });
    editorRef.current = ed;

    // Restore cursor position from the persisted meta. Monaco's
    // setPosition is 1-based.
    if (editorMeta.cursorLine && editorMeta.cursorColumn) {
      try {
        ed.setPosition({
          lineNumber: editorMeta.cursorLine,
          column: editorMeta.cursorColumn,
        });
      } catch {
        /* invalid position — fall through */
      }
    }

    // Track cursor moves so the status strip updates + the persisted
    // meta tracks the live position.
    const positionDisposable = ed.onDidChangeCursorPosition((e) => {
      setCursorDisplay({ line: e.position.lineNumber, column: e.position.column });
      onEvent("editor-cursor", {
        tabId: tabIdRef.current,
        line: e.position.lineNumber,
        column: e.position.column,
      });
    });

    // Mark dirty on the first content change after load. We avoid
    // flipping dirty during the initial setValue() by skipping the
    // first listener fire.
    let suppressInitial = true;
    const contentDisposable = ed.onDidChangeModelContent(() => {
      if (suppressInitial) return;
      onEvent("editor-change", { tabId: tabIdRef.current, isDirty: true });
    });

    // Cmd+S / Ctrl+S → editor:save. Monaco lets us bind a command via
    // KeyMod; we route to the App-level event so the same handler runs
    // whether the keybinding came from inside Monaco or from a menu /
    // sidebar action.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const model = ed.getModel();
      const content = model?.getValue() ?? "";
      onEvent("editor-save", {
        tabId: tabIdRef.current,
        filePath: filePathRef.current,
        content,
      });
    });

    // Load file content from disk.
    const root = (state["project"] as { path?: string } | undefined)?.path ?? "";
    void invoke<string>("fs_read_file", { root, path: filePath })
      .then((text) => {
        ed.setValue(text);
        suppressInitial = false;
        // Re-apply cursor after the model is populated; Monaco resets
        // the position to (1,1) when setValue replaces the buffer.
        if (editorMeta.cursorLine && editorMeta.cursorColumn) {
          try {
            ed.setPosition({
              lineNumber: editorMeta.cursorLine,
              column: editorMeta.cursorColumn,
            });
            ed.revealPositionInCenter({
              lineNumber: editorMeta.cursorLine,
              column: editorMeta.cursorColumn,
            });
          } catch {
            /* ignore */
          }
        }
        onEvent("editor-loaded", {
          tabId: tabIdRef.current,
          filePath,
        });
      })
      .catch((err: unknown) => {
        suppressInitial = false;
        setLoadError(String(err));
      });

    return () => {
      positionDisposable.dispose();
      contentDisposable.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    // Mount once per tabId; deps intentionally limited so editing the
    // file on disk doesn't tear down the buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // React to theme changes after mount (Monaco has its own global theme
  // registry; setTheme is cheap).
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => applyMonacoTheme(root.dataset.theme);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="ae-editor-canvas-wrap" style={{ gridArea: "canvas" }}>
      <div ref={containerRef} className="ae-editor-canvas-host" />
      {loadError && (
        <div className="ae-editor-canvas-error">Failed to load file: {loadError}</div>
      )}
      <EditorStatusBar
        filePath={editorMeta?.filePath ?? ""}
        language={editorMeta?.language ?? "plaintext"}
        isDirty={Boolean(editorMeta?.isDirty)}
        line={cursorDisplay.line}
        column={cursorDisplay.column}
      />
    </div>
  );
}

interface EditorStatusBarProps {
  filePath: string;
  language: string;
  isDirty: boolean;
  line: number;
  column: number;
}

function EditorStatusBar({
  filePath,
  language,
  isDirty,
  line,
  column,
}: EditorStatusBarProps) {
  const shortPath = compressPath(filePath);
  return (
    <div className="ae-editor-status-bar" role="status">
      <span className="ae-editor-status-path" title={filePath}>
        {shortPath}
      </span>
      {isDirty && (
        <span className="ae-editor-status-dirty" title="Unsaved changes" aria-label="Unsaved changes">
          •
        </span>
      )}
      <span className="ae-editor-status-spacer" />
      <span className="ae-editor-status-pos">
        Ln {line}, Col {column}
      </span>
      <span className="ae-editor-status-sep" aria-hidden="true">·</span>
      <span className="ae-editor-status-lang">{language}</span>
    </div>
  );
}

/** Show the last 2 path components — full path is in the title attribute. */
function compressPath(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join("/")}`;
}
