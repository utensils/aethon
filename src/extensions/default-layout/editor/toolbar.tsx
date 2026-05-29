/**
 * EditorToolbar — a slim action strip across the top of the editor pane
 * (above the Monaco surface), so file operations read as "inside the editor
 * window" rather than living only on the global tab strip or the native
 * menu bar. A "File" menu plus quick Save / Revert buttons, and a markdown
 * Preview/Edit toggle on the right.
 *
 * Save / Revert / New File dispatch the same `aethon:*` window events the
 * native menu uses, so there's a single code path the editor canvas already
 * listens for — no duplicated save logic here.
 */
import { useState } from "react";

import {
  ContextMenu,
  type ContextMenuItem,
} from "../../../components/primitives/context-menu";
import { Chevron } from "../sidebar/chevron";

const emit = (name: string) => window.dispatchEvent(new Event(name));

export interface EditorToolbarProps {
  /** True for markdown files — reveals the Preview/Edit toggle. */
  canPreview: boolean;
  /** Whether the markdown preview is currently showing (toggle label flips). */
  previewActive: boolean;
  /** Toggle markdown preview; undefined when there's no bound tab. */
  onTogglePreview?: () => void;
}

export function EditorToolbar({
  canPreview,
  previewActive,
  onTogglePreview,
}: EditorToolbarProps) {
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  const fileMenuItems: ContextMenuItem[] = [
    {
      id: "file-new",
      label: "New File…",
      hint: "⌘N",
      onSelect: () => emit("aethon:new-file"),
    },
    {
      id: "file-save",
      label: "Save",
      hint: "⌘S",
      onSelect: () => emit("aethon:editor-save"),
    },
    {
      id: "file-revert",
      label: "Revert File",
      onSelect: () => emit("aethon:editor-revert"),
    },
  ];

  return (
    <div className="ae-editor-toolbar" role="toolbar" aria-label="Editor actions">
      <button
        type="button"
        className="ae-editor-toolbar-menu"
        aria-haspopup="menu"
        aria-expanded={!!fileMenu}
        title="File actions"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setFileMenu({ x: Math.round(r.left), y: Math.round(r.bottom) });
        }}
      >
        File
        <span className="ae-editor-toolbar-caret" aria-hidden="true">
          <Chevron expanded />
        </span>
      </button>
      <button
        type="button"
        className="ae-editor-toolbar-action"
        title="Save (⌘S)"
        aria-label="Save"
        onClick={() => emit("aethon:editor-save")}
      >
        Save
      </button>
      <button
        type="button"
        className="ae-editor-toolbar-action"
        title="Revert file to last saved"
        aria-label="Revert file"
        onClick={() => emit("aethon:editor-revert")}
      >
        Revert
      </button>
      <span className="ae-editor-toolbar-spacer" />
      {canPreview && onTogglePreview ? (
        <button
          type="button"
          className="ae-editor-toolbar-action"
          aria-pressed={previewActive}
          title="Markdown preview (⌘⇧V)"
          onClick={onTogglePreview}
        >
          {previewActive ? "Edit" : "Preview"}
        </button>
      ) : null}
      <ContextMenu
        open={!!fileMenu}
        x={fileMenu?.x ?? 0}
        y={fileMenu?.y ?? 0}
        items={fileMenuItems}
        onClose={() => setFileMenu(null)}
        ariaLabel="File menu"
        estimatedWidth={200}
        estimatedHeight={120}
      />
    </div>
  );
}
