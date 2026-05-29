/**
 * EditorMenubar — VS Code-style File · Edit · View · Go menubar across the
 * top of the Monaco pane, so editor operations read as "inside the editor
 * window" rather than only on the global tab strip or native menu bar.
 *
 * Structure is built by the pure `buildEditorMenus` config; this component
 * only owns which menu is open and renders the shared `ContextMenu`
 * primitive plus a right-aligned cluster (dirty dot, external-change
 * reload, markdown Preview/Edit toggle).
 *
 * File ops dispatch the same `aethon:*` window events the native menu and
 * tab-strip use, so there's a single code path — no duplicated save logic.
 */
import { useState } from "react";

import { ContextMenu } from "../../../components/primitives/context-menu";
import { buildEditorMenus, type EditorMenuId } from "./menuConfig";
import type { EditorActions } from "./editorActions";
import type { EditorViewSettingsControls } from "./useEditorViewSettings";

const emit = (name: string) => window.dispatchEvent(new Event(name));

export interface EditorMenubarProps {
  /** Unsaved changes in the active buffer (drives the dirty dot + Save gate). */
  isDirty: boolean;
  /** Whether the surface accepts edits (false for preview / diff / viewer). */
  canMutate: boolean;
  /** True for markdown files — reveals the Preview/Edit toggle. */
  canPreview: boolean;
  /** Whether the markdown preview is currently showing. */
  previewActive: boolean;
  /** The file changed on disk under a dirty buffer — show a reload affordance. */
  externalChanged: boolean;
  /** Toggle markdown preview; undefined when there's no bound tab. */
  onTogglePreview?: () => void;
  /** Reload the buffer from disk, discarding the external-change warning. */
  onReloadExternal?: () => void;
  actions: EditorActions;
  view: EditorViewSettingsControls;
}

interface OpenMenu {
  id: EditorMenuId;
  x: number;
  y: number;
}

export function EditorMenubar({
  isDirty,
  canMutate,
  canPreview,
  previewActive,
  externalChanged,
  onTogglePreview,
  onReloadExternal,
  actions,
  view,
}: EditorMenubarProps) {
  const [open, setOpen] = useState<OpenMenu | null>(null);

  const menus = buildEditorMenus({
    isDirty,
    canMutate,
    actions,
    view,
    file: {
      newFile: () => emit("aethon:new-file"),
      save: () => emit("aethon:editor-save"),
      revert: () => emit("aethon:editor-revert"),
    },
  });

  const activeMenu = open ? menus.find((m) => m.id === open.id) : undefined;

  return (
    <div className="ae-editor-menubar" role="menubar" aria-label="Editor menu">
      {menus.map((menu) => (
        <button
          key={menu.id}
          type="button"
          role="menuitem"
          className="ae-editor-menubar-trigger"
          aria-haspopup="menu"
          aria-expanded={open?.id === menu.id}
          onClick={(e) => {
            if (open?.id === menu.id) {
              setOpen(null);
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            setOpen({ id: menu.id, x: Math.round(r.left), y: Math.round(r.bottom) });
          }}
        >
          {menu.label}
        </button>
      ))}

      <span className="ae-editor-menubar-spacer" />

      {isDirty ? (
        <span
          className="ae-editor-menubar-dirty"
          title="Unsaved changes"
          aria-label="Unsaved changes"
        >
          •
        </span>
      ) : null}

      {externalChanged && onReloadExternal ? (
        <button
          type="button"
          className="ae-editor-menubar-external"
          title="File changed on disk — click to reload"
          aria-label="File changed on disk; reload from disk"
          onClick={onReloadExternal}
        >
          <span className="ae-editor-menubar-external-dot" aria-hidden="true" />
          Reload
        </button>
      ) : null}

      {canPreview && onTogglePreview ? (
        <button
          type="button"
          className="ae-editor-menubar-action"
          aria-pressed={previewActive}
          title="Markdown preview (⌘⇧V)"
          onClick={onTogglePreview}
        >
          {previewActive ? "Edit" : "Preview"}
        </button>
      ) : null}

      <ContextMenu
        open={!!activeMenu}
        x={open?.x ?? 0}
        y={open?.y ?? 0}
        items={activeMenu?.items ?? []}
        onClose={() => setOpen(null)}
        ariaLabel={activeMenu ? `${activeMenu.label} menu` : "Editor menu"}
        estimatedWidth={240}
        estimatedHeight={260}
      />
    </div>
  );
}
