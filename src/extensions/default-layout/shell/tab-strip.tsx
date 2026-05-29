/**
 * TabStrip — horizontal row of tab pills + a "+" button to create new ones.
 * Each tab shows its label; the active one is highlighted; non-default tabs
 * have a small "×" close button. A permanent, non-closable "Æ overview"
 * pill is pinned to the left of the strip — selecting it deselects any
 * active session tab so the host / project / worktree overview owns the
 * canvas, without closing the open sessions. All interactions go through
 * onEvent so App.tsx can route them to its tab helpers
 * (newTab / closeTab / switch).
 *
 * Props:
 *   tabs:        $ref to /tabs (array of { id, label }) — items to render
 *   activeId:    $ref to /activeTabId — which tab is highlighted
 *
 * Events:
 *   ("select",  { tabId })  click on a tab pill (overview emits its sentinel id)
 *   ("close",   { tabId })  click on a tab's close button
 *   ("new")                 click on the "+" button
 */

import { useMemo, useState, type MouseEvent } from "react";
import type { StringValue } from "../../../types/a2ui";
import { OVERVIEW_TAB_ID } from "../../../types/tab";
import { resolveString } from "../../../utils/dataBinding";
import { resolvePointer } from "../../../utils/jsonPointer";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { FileIcon } from "../../../components/file-icon";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../../../components/primitives/context-menu";

interface TabStripItem {
  id: string;
  label: string;
  /** True when an LLM turn is in flight on this tab. Drives the
   *  dirty-style dot prefix so the user sees which tabs are working
   *  even when they're not focused. */
  waiting?: boolean;
  /** Pending follow-up count behind the active prompt. Adds a small
   *  numeric chip after the label when > 0. */
  queueCount?: number;
  /** "agent" (chat session) or "shell" (interactive PTY). Shell tabs
   *  no longer render in the top tab strip — they live in the bottom
   *  terminal panel as sub-tabs alongside the read-only agent-bash
   *  view. The TabStrip composite filters them out so any layout that
   *  binds `/tabs` to TabStrip drops shells automatically. */
  kind?: "agent" | "shell" | "editor";
  /** Editor-tab metadata. The file path drives the file-type icon and
   *  the editor context menu (copy path / reveal); rootPath lets us
   *  compute a project-relative path. */
  editor?: { filePath?: string; rootPath?: string; diff?: boolean };
}

/** Best-effort clipboard write — Tauri's webview exposes the async
 *  Clipboard API; failures (denied permission, older webview) degrade
 *  silently rather than throwing into a click handler. */
function copyToClipboard(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
}

/** Strip the project/worktree root from an absolute path for a
 *  VS Code-style "Copy Relative Path". Falls back to the absolute path
 *  when the root isn't a prefix. */
function relativePath(filePath: string, root: string): string {
  if (!root) return filePath;
  const normRoot = root.replace(/[/\\]+$/, "");
  if (filePath === normRoot) return filePath;
  if (filePath.startsWith(`${normRoot}/`)) {
    return filePath.slice(normRoot.length + 1);
  }
  return filePath;
}

export function TabStrip({ component, state, onEvent }: BuiltinComponentProps) {
  const props = component.props as {
    tabs?: { $ref: string } | TabStripItem[];
    activeId?: StringValue;
  };
  const tabs: TabStripItem[] = useMemo(() => {
    if (!props.tabs) return [];
    const raw: TabStripItem[] = Array.isArray(props.tabs)
      ? props.tabs
      : (() => {
          const ref = props.tabs as { $ref?: string };
          if (typeof ref.$ref !== "string") return [];
          const v = resolvePointer(state, ref.$ref);
          return Array.isArray(v) ? (v as TabStripItem[]) : [];
        })();
    // Filter out shell tabs — they render in the bottom terminal panel
    // as sub-tabs (M6 restructure). Records without `kind` predate the
    // discriminator and are treated as agent.
    return raw.filter((t) => t.kind !== "shell");
  }, [props.tabs, state]);
  const activeId = props.activeId ? resolveString(props.activeId, state) : "";
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tab: TabStripItem;
  } | null>(null);
  const openTabMenu = (event: MouseEvent, tab: TabStripItem) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, tab });
  };

  const projectPath =
    (state["project"] as { path?: string } | undefined)?.path ?? "";

  const buildMenuItems = (): ContextMenuItem[] => {
    if (!contextMenu) return [];
    const tab = contextMenu.tab;
    const closeFamily: ContextMenuItem[] = [
      {
        id: "close-tab",
        label: "Close",
        onSelect: () => onEvent("close", { tabId: tab.id }),
      },
      {
        id: "close-others",
        label: "Close Others",
        onSelect: () => onEvent("close-others", { tabId: tab.id }),
      },
      {
        id: "close-all",
        label: "Close All",
        onSelect: () => onEvent("close-all", { tabId: tab.id }),
      },
    ];

    if (tab.kind === "editor" && tab.editor?.filePath) {
      const filePath = tab.editor.filePath;
      const root = tab.editor.rootPath ?? projectPath;
      const isActive = tab.id === activeId && !tab.editor.diff;
      return [
        ...(isActive
          ? ([
              {
                id: "save",
                label: "Save",
                onSelect: () =>
                  window.dispatchEvent(new Event("aethon:editor-save")),
              },
              {
                id: "revert",
                label: "Revert File",
                onSelect: () =>
                  window.dispatchEvent(new Event("aethon:editor-revert")),
              },
              { type: "separator" },
            ] as ContextMenuItem[])
          : []),
        {
          id: "copy-path",
          label: "Copy Path",
          onSelect: () => copyToClipboard(filePath),
        },
        {
          id: "copy-rel-path",
          label: "Copy Relative Path",
          onSelect: () => copyToClipboard(relativePath(filePath, root)),
        },
        { type: "separator" },
        ...closeFamily,
      ];
    }

    // Agent (and any other) tabs keep the rename + close menu.
    return [
      {
        type: "input",
        id: "rename-session",
        label: "Session name",
        defaultValue: tab.label,
        submitLabel: "Rename",
        onSubmit: (label) => onEvent("rename", { tabId: tab.id, label }),
      },
      { type: "separator" },
      ...closeFamily,
    ];
  };

  const menuItems: ContextMenuItem[] = buildMenuItems();

  const overviewActive =
    !activeId ||
    activeId === OVERVIEW_TAB_ID ||
    !tabs.some((t) => t.id === activeId);
  return (
    <div className="a2ui-tab-strip" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={overviewActive}
        className={
          overviewActive
            ? "a2ui-tab a2ui-tab-overview a2ui-tab-active"
            : "a2ui-tab a2ui-tab-overview"
        }
        title="Back to overview"
        aria-label="Back to overview"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          onEvent("select", { tabId: OVERVIEW_TAB_ID });
        }}
      >
        <span className="a2ui-tab-overview-glyph" aria-hidden="true">
          Æ
        </span>
        <span className="a2ui-tab-label">overview</span>
      </button>
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        // Every tab is closable now — when the list reaches zero the
        // layout swaps to the empty-state composite (registered by
        // default-layout, not hardcoded React in App.tsx).
        const canClose = true;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            className={
              isActive ? "a2ui-tab a2ui-tab-active" : "a2ui-tab"
            }
            onMouseDown={(e) => {
              // mousedown not click so focus doesn't shift away from the
              // chat input first (avoids a stray blur that could submit
              // a draft). The select handler swaps the active tab.
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest(".a2ui-tab-close")) return;
              e.preventDefault();
              onEvent("select", { tabId: t.id });
            }}
            onContextMenu={(e) => openTabMenu(e, t)}
          >
            {t.waiting ? (
              <span
                className="a2ui-tab-busy-dot"
                aria-hidden="true"
                title="Working…"
              />
            ) : t.kind === "editor" && t.editor?.filePath ? (
              <FileIcon
                path={t.editor.filePath}
                isDir={false}
                size={13}
                className="a2ui-tab-icon"
              />
            ) : null}
            <span className="a2ui-tab-label">{t.label}</span>
            {typeof t.queueCount === "number" && t.queueCount > 0 ? (
              <span
                className="a2ui-tab-queue"
                title={`${t.queueCount} queued`}
              >
                +{t.queueCount}
              </span>
            ) : null}
            {canClose && (
              <button
                type="button"
                className="a2ui-tab-close"
                aria-label={`Close ${t.label}`}
                title={`Close ${t.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onEvent("close", { tabId: t.id });
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="a2ui-tab-new"
        title="New tab (⌘T)"
        aria-label="New Tab"
        onClick={() => onEvent("new")}
      >
        +
      </button>
      <ContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={menuItems}
        onClose={() => setContextMenu(null)}
        ariaLabel="Tab actions"
        estimatedWidth={320}
        estimatedHeight={176}
      />
    </div>
  );
}
