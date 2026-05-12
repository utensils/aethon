/**
 * Sidebar — collapsible panel with named sections. Items can be inline
 * arrays or bound to state via a $ref.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  BooleanValue,
  SidebarItem,
  SidebarSection,
  StringValue,
} from "../../../types/a2ui";
import { resolveBoolean, resolveString } from "../../../utils/dataBinding";
import { resolvePointer } from "../../../utils/jsonPointer";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import {
  canDeleteHistoryItem,
  extractSessionId,
} from "../../../utils/sidebarHistory";
import { AeMarkInline } from "../layout";
import { ItemRow, type ItemRowProps } from "./item-row";
import {
  SearchableSidebarSection,
  type SidebarSectionExt,
} from "./searchable-section";

// eslint-disable-next-line react-refresh/only-export-components -- pure helpers re-exported from sibling module
export { providerOf, filterItems } from "./filter";
export { ItemRow } from "./item-row";
export type { ItemRowProps } from "./item-row";
export { SearchableSidebarSection } from "./searchable-section";
export type {
  SidebarSectionExt,
  SearchableSidebarSectionProps,
} from "./searchable-section";

interface SidebarContextMenuState {
  x: number;
  y: number;
  sectionId: string;
  itemId: string;
  label: string;
  // Discriminator so the rendered menu shows the right action. "project"
  // prompts for "Remove from Projects"; "session" prompts for
  // "Delete session". "extension-enabled" / "extension-disabled" prompt
  // for Disable / Enable. Set by `openItemContextMenu` based on the
  // section + item id.
  kind: "project" | "session" | "extension-enabled" | "extension-disabled";
  /** For `extension-*` kinds, the extension's display name (item id
   *  minus the `ext:` / `ext-failed:` / `ext-disabled:` prefix). */
  extensionName?: string;
}

export function Sidebar({
  component,
  state,
  onEvent,
  renderChildWithState,
}: BuiltinComponentProps) {
  const props = component.props as {
    title?: StringValue;
    /** Optional version chip rendered right-aligned in the title row
     *  (e.g. "v0.3"). Mono, dim. Mirrors the design's brand-mark row. */
    version?: StringValue;
    /** When true, render an inline AeMark monogram before the title. */
    brandMark?: BooleanValue;
    sections?: SidebarSectionExt[];
    // Optional list of extra sections appended after the inline `sections`.
    // Bound via $ref so extensions can push into a state path and have
    // their sections appear without modifying the layout payload.
    extraSections?: SidebarSection[] | { $ref: string };
    /** When false, hide the drag handle. Default true. */
    resizable?: BooleanValue;
    /** Which edge owns resize drag. Default right for the primary sidebar. */
    resizeEdge?: StringValue;
  };
  const resizable =
    props.resizable === undefined
      ? true
      : resolveBoolean(props.resizable, state);
  const resizeEdge = props.resizeEdge
    ? resolveString(props.resizeEdge, state)
    : "right";
  const resizeFromLeft = resizeEdge === "left";

  const asideRef = useRef<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] =
    useState<SidebarContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const openItemContextMenu: ItemRowProps["onItemContextMenu"] = (
    e,
    item,
    sectionId,
  ) => {
    // Projects → "Remove from Projects". History items prefixed
    // `session:` (closed) or `tab:` (currently open) → "Delete session".
    // For an open tab, the App-side handler closes the tab first, then
    // deletes the on-disk session — symmetric with the X close button +
    // explicit delete, just collapsed into one action. Extensions
    // (sidebar section "extensions", item ids `ext:` / `ext-failed:` /
    // `ext-disabled:`) → Disable / Enable.
    let kind: SidebarContextMenuState["kind"] | null = null;
    let extensionName: string | undefined;
    if (sectionId === "projects") {
      kind = "project";
    } else if (sectionId === "history" && canDeleteHistoryItem(item.id)) {
      kind = "session";
    } else if (sectionId === "extensions") {
      if (item.id.startsWith("ext:")) {
        kind = "extension-enabled";
        extensionName = item.id.slice("ext:".length);
      } else if (item.id.startsWith("ext-failed:")) {
        kind = "extension-enabled";
        extensionName = item.id.slice("ext-failed:".length);
      } else if (item.id.startsWith("ext-disabled:")) {
        kind = "extension-disabled";
        extensionName = item.id.slice("ext-disabled:".length);
      }
      // Hard-coded built-ins (default-layout) have id "extension-layout"
      // and no toggle — the sidebar core lives in the binary.
    }
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    setContextMenu({
      x: Math.min(e.clientX, Math.max(8, viewportWidth - 220)),
      y: Math.min(e.clientY, Math.max(8, viewportHeight - 96)),
      sectionId,
      itemId: item.id,
      label: item.label,
      kind,
      extensionName,
    });
  };

  const removeContextProject = () => {
    if (!contextMenu) return;
    onEvent("remove-project", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
      label: contextMenu.label,
    });
    setContextMenu(null);
  };

  const deleteContextSession = () => {
    if (!contextMenu) return;
    // itemId is `session:<tabId>` (closed) or `tab:<tabId>` (open) —
    // strip whichever prefix is present so App.tsx receives the raw
    // tabId the bridge / Tauri command both expect.
    onEvent("delete-session", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      sessionId: extractSessionId(contextMenu.itemId),
      label: contextMenu.label,
    });
    setContextMenu(null);
  };

  const renameContextSession = () => {
    if (!contextMenu) return;
    // Native prompt is intentionally lo-fi — keeps the surface tiny and
    // matches the existing browser-prompt fallbacks elsewhere
    // (delete confirmation, project picker errors). A richer modal can
    // come later without changing the wire format.
    const next = window.prompt("Rename session", contextMenu.label);
    if (next === null) {
      setContextMenu(null);
      return;
    }
    onEvent("rename-session", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      sessionId: extractSessionId(contextMenu.itemId),
      label: next,
    });
    setContextMenu(null);
  };

  const toggleContextExtension = (disabled: boolean) => {
    if (!contextMenu || !contextMenu.extensionName) return;
    onEvent("toggle-extension", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      name: contextMenu.extensionName,
      disabled,
    });
    setContextMenu(null);
  };

  // Drag handle. On mousedown we capture the pointer and start emitting
  // `resize` events with the new pixel width. App listens for those and
  // patches the active layout's grid columns. Cleanup on mouseup.
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const aside = asideRef.current;
    if (!aside) return;
    const startX = e.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const MIN = 180;
    const MAX = 540;
    document.body.classList.add("ae-resizing-sidebar");
    const onMove = (ev: MouseEvent) => {
      const dx = resizeFromLeft ? startX - ev.clientX : ev.clientX - startX;
      const next = Math.max(MIN, Math.min(MAX, Math.round(startWidth + dx)));
      onEvent("resize", { width: next });
    };
    const onUp = () => {
      document.body.classList.remove("ae-resizing-sidebar");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      onEvent("resize-end");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const title = props.title ? resolveString(props.title, state) : "";
  const version = props.version ? resolveString(props.version, state) : "";
  const showBrand = props.brandMark
    ? resolveBoolean(props.brandMark, state)
    : !!title;

  const resolveItems = (
    items: SidebarSection["items"] | undefined,
  ): SidebarItem[] => {
    if (!items) return [];
    if (Array.isArray(items)) return items;
    if (typeof items !== "object" || !("$ref" in items)) return [];
    const resolved = resolvePointer(state, items.$ref);
    return Array.isArray(resolved) ? (resolved as SidebarItem[]) : [];
  };

  // Resolve the extra-sections list (inline array or $ref). Both lists
  // share the same SidebarSection shape so they render with the same
  // section/item path.
  const extraSections: SidebarSection[] = (() => {
    const raw = props.extraSections;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    const resolved = resolvePointer(state, raw.$ref);
    return Array.isArray(resolved) ? (resolved as SidebarSection[]) : [];
  })();
  const allSections: SidebarSectionExt[] = [
    ...(props.sections ?? []),
    ...(extraSections as SidebarSectionExt[]),
  ];

  return (
    <aside
      ref={asideRef}
      className={`a2ui-sidebar ${resizeFromLeft ? "a2ui-sidebar-resize-left" : ""}`}
    >
      {(title || version) && (
        <div className="a2ui-sidebar-title">
          {showBrand && <AeMarkInline size={20} radius={4} />}
          {title && <span>{title}</span>}
          {version && (
            <span className="a2ui-sidebar-title-version">{version}</span>
          )}
        </div>
      )}
      <div className="a2ui-sidebar-sections">
        {allSections.map((section) => {
          const items = resolveItems(section.items);
          const monoItems = section.monoItems === true;
          if (section.searchable === true || section.groupByPrefix === true) {
            return (
              <SearchableSidebarSection
                key={section.id}
                section={section}
                items={items}
                componentId={component.id}
                state={state}
                onEvent={onEvent}
                onItemContextMenu={openItemContextMenu}
                renderChildWithState={renderChildWithState}
              />
            );
          }
          const actions = section.actions ?? [];
          return (
            <div key={section.id} className="a2ui-sidebar-section">
              <div className="a2ui-sidebar-section-title">{section.title}</div>
              {items.length === 0 ? (
                <div className="a2ui-sidebar-empty">empty</div>
              ) : (
                <ul className="a2ui-sidebar-list">
                  {items.map((item, idx) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      index={idx}
                      monoItems={monoItems}
                      sectionId={section.id}
                      componentId={component.id}
                      onEvent={onEvent}
                      onItemContextMenu={openItemContextMenu}
                      renderChildWithState={renderChildWithState}
                      state={state}
                    />
                  ))}
                </ul>
              )}
              {actions.length > 0 && (
                <ul className="a2ui-sidebar-actions">
                  {actions.map((a) => (
                    <li
                      key={a.id}
                      className="a2ui-sidebar-action"
                      onClick={() =>
                        onEvent(
                          "select",
                          { sectionId: section.id, itemId: a.id },
                          a.id,
                        )
                      }
                    >
                      {a.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {resizable && (
        <div
          className="a2ui-sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={onResizeStart}
        />
      )}
      {contextMenu &&
        createPortal(
          <div
            className="a2ui-sidebar-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {contextMenu.kind === "project" ? (
              <>
                <button
                  type="button"
                  className="a2ui-sidebar-context-menu-item"
                  role="menuitem"
                  onClick={removeContextProject}
                >
                  Remove from Projects
                </button>
                <div className="a2ui-sidebar-context-menu-note">
                  Keeps files on disk
                </div>
              </>
            ) : contextMenu.kind === "session" ? (
              <>
                <button
                  type="button"
                  className="a2ui-sidebar-context-menu-item"
                  role="menuitem"
                  onClick={renameContextSession}
                >
                  Rename session…
                </button>
                <button
                  type="button"
                  className="a2ui-sidebar-context-menu-item"
                  role="menuitem"
                  onClick={deleteContextSession}
                >
                  Delete session…
                </button>
                <div className="a2ui-sidebar-context-menu-note">
                  Delete removes the saved transcript
                </div>
              </>
            ) : contextMenu.kind === "extension-enabled" ? (
              <>
                <button
                  type="button"
                  className="a2ui-sidebar-context-menu-item"
                  role="menuitem"
                  onClick={() => toggleContextExtension(true)}
                >
                  Disable extension
                </button>
                <div className="a2ui-sidebar-context-menu-note">
                  Restart Aethon to fully unload
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="a2ui-sidebar-context-menu-item"
                  role="menuitem"
                  onClick={() => toggleContextExtension(false)}
                >
                  Enable extension
                </button>
                <div className="a2ui-sidebar-context-menu-note">
                  Restart Aethon (or /reload) to load
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </aside>
  );
}
