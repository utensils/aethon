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
 *   ("reorder", { tabId, toIndex }) drag a visible top-strip tab
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import { copyToClipboard, relativePath } from "../editor/path";

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
  const [renamingTab, setRenamingTab] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    tabId: string;
    side: "before" | "after";
  } | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const draggedTabIdRef = useRef<string | null>(null);
  const pendingPointerDragRef = useRef<{
    tabId: string;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressionClearTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameEndingRef = useRef(false);
  const renamingTabId = renamingTab?.id;
  const openTabMenu = (event: MouseEvent, tab: TabStripItem) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, tab });
  };

  const openOverviewMenu = (event: MouseEvent) => {
    openTabMenu(event, { id: OVERVIEW_TAB_ID, label: "overview" });
  };

  useEffect(() => {
    if (!renamingTabId) return;
    renameEndingRef.current = false;
    const focus = () => {
      const input = renameInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.select();
    };
    focus();
    const first = window.setTimeout(focus, 0);
    return () => window.clearTimeout(first);
  }, [renamingTabId]);

  const beginRename = (tab: TabStripItem) => {
    setContextMenu(null);
    setRenamingTab({ id: tab.id, value: tab.label });
  };

  const finishRename = (tab: TabStripItem, mode: "save" | "cancel") => {
    if (!renamingTab || renamingTab.id !== tab.id) return;
    if (renameEndingRef.current) return;
    renameEndingRef.current = true;
    const label = renamingTab.value.trim();
    setRenamingTab(null);
    if (mode === "save" && label && label !== tab.label) {
      onEvent("rename", { tabId: tab.id, label });
    }
  };

  const onRenameKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    tab: TabStripItem,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishRename(tab, "save");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finishRename(tab, "cancel");
    }
  };

  const projectPath =
    (state["project"] as { path?: string } | undefined)?.path ?? "";

  const finishTabDrag = () => {
    draggedTabIdRef.current = null;
    setDraggingTabId(null);
    setDropIndicator(null);
    setDragOffsetX(0);
  };

  const tabElementsForDrop = (root: HTMLElement, draggedTabId: string) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(".a2ui-tab[data-tab-id]"),
    ).filter((el) => el.dataset.tabId !== draggedTabId);

  const insertionIndexForDrop = (
    root: HTMLElement,
    draggedTabId: string,
    clientX: number,
  ) => {
    const tabElements = tabElementsForDrop(root, draggedTabId);
    for (let index = 0; index < tabElements.length; index += 1) {
      const rect = tabElements[index].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return index;
    }
    return tabElements.length;
  };

  const showDropIndicator = (
    root: HTMLElement,
    draggedTabId: string,
    clientX: number,
  ) => {
    const tabElements = tabElementsForDrop(root, draggedTabId);
    if (tabElements.length === 0) {
      setDropIndicator(null);
      return;
    }
    for (let index = 0; index < tabElements.length; index += 1) {
      const el = tabElements[index];
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        const tabId = el.dataset.tabId;
        if (tabId) setDropIndicator({ tabId, side: "before" });
        return;
      }
    }
    const tabId = tabElements[tabElements.length - 1].dataset.tabId;
    if (tabId) setDropIndicator({ tabId, side: "after" });
  };

  const emitReorder = (tabId: string, toIndex: number) => {
    onEvent("reorder", { tabId, toIndex });
    finishTabDrag();
  };

  const clearSuppressionSoon = () => {
    if (suppressionClearTimerRef.current !== null) {
      window.clearTimeout(suppressionClearTimerRef.current);
    }
    suppressionClearTimerRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressionClearTimerRef.current = null;
    }, 0);
  };

  useEffect(
    () => () => {
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      if (suppressionClearTimerRef.current !== null) {
        window.clearTimeout(suppressionClearTimerRef.current);
        suppressionClearTimerRef.current = null;
      }
    },
    [],
  );

  const startPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    tab: TabStripItem,
  ) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (
      renamingTab?.id === tab.id ||
      target.closest(".a2ui-tab-close") ||
      target.closest(".ae-tab-rename-input")
    ) {
      return;
    }
    pointerCleanupRef.current?.();
    pendingPointerDragRef.current = {
      tabId: tab.id,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };

    const onMove = (moveEvent: PointerEvent) => {
      const pending = pendingPointerDragRef.current;
      const root = stripRef.current;
      if (!pending || !root) return;
      const dx = moveEvent.clientX - pending.startX;
      const dy = moveEvent.clientY - pending.startY;
      if (!pending.dragging && Math.hypot(dx, dy) < 4) return;
      if (!pending.dragging) {
        pending.dragging = true;
        suppressNextClickRef.current = true;
        draggedTabIdRef.current = pending.tabId;
        setDraggingTabId(pending.tabId);
      }
      moveEvent.preventDefault();
      setDragOffsetX(dx);
      showDropIndicator(root, pending.tabId, moveEvent.clientX);
    };

    const onUp = (upEvent: PointerEvent) => {
      const pending = pendingPointerDragRef.current;
      const root = stripRef.current;
      const wasDragging = pending?.dragging;
      if (pending && root && wasDragging) {
        upEvent.preventDefault();
        const toIndex = insertionIndexForDrop(
          root,
          pending.tabId,
          upEvent.clientX,
        );
        emitReorder(pending.tabId, toIndex);
      }
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      pendingPointerDragRef.current = null;
      if (wasDragging) clearSuppressionSoon();
      if (!wasDragging) finishTabDrag();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    pointerCleanupRef.current = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  };

  const buildMenuItems = (): ContextMenuItem[] => {
    if (!contextMenu) return [];
    const tab = contextMenu.tab;

    if (tab.id === OVERVIEW_TAB_ID) {
      const hasTopStripTabs = tabs.length > 0;
      return [
        {
          id: "new-tab",
          label: "New Tab",
          onSelect: () => onEvent("new"),
        },
        { type: "separator" },
        {
          id: "close-others",
          label: "Close Others",
          disabled: !hasTopStripTabs,
          onSelect: () => onEvent("close-others", { tabId: OVERVIEW_TAB_ID }),
        },
        {
          id: "close-all",
          label: "Close All Sessions",
          disabled: !hasTopStripTabs,
          onSelect: () => onEvent("close-all", { tabId: OVERVIEW_TAB_ID }),
        },
      ];
    }

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
        id: "rename-session",
        label: "Rename Session",
        onSelect: () => beginRename(tab),
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
    <div
      ref={stripRef}
      className={[
        "a2ui-tab-strip",
        draggingTabId ? "a2ui-tab-strip-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="tablist"
    >
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
        onContextMenu={openOverviewMenu}
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
            className={[
              "a2ui-tab",
              isActive ? "a2ui-tab-active" : "",
              draggingTabId === t.id ? "a2ui-tab-dragging" : "",
              dropIndicator?.tabId === t.id
                ? `a2ui-tab-drop-${dropIndicator.side}`
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-tab-id={t.id}
            draggable={false}
            style={
              draggingTabId === t.id
                ? ({ "--ae-tab-drag-x": `${dragOffsetX}px` } as CSSProperties)
                : undefined
            }
            onPointerDown={(e) => startPointerDrag(e, t)}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              if (
                (e.target as HTMLElement).closest(".a2ui-tab-close") ||
                (e.target as HTMLElement).closest(".ae-tab-rename-input")
              ) {
                e.preventDefault();
                return;
              }
            }}
            onClick={(e) => {
              if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              if (
                (e.target as HTMLElement).closest(".a2ui-tab-close") ||
                (e.target as HTMLElement).closest(".ae-tab-rename-input")
              ) {
                return;
              }
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
            {renamingTab?.id === t.id ? (
              <input
                ref={renameInputRef}
                className="ae-tab-rename-input"
                aria-label={`Rename session ${t.label}`}
                value={renamingTab.value}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setRenamingTab((current) =>
                    current?.id === t.id ? { ...current, value } : current,
                  );
                }}
                onKeyDown={(event) => onRenameKeyDown(event, t)}
                onBlur={() => finishRename(t, "save")}
              />
            ) : (
              <span className="a2ui-tab-label">{t.label}</span>
            )}
            {typeof t.queueCount === "number" && t.queueCount > 0 ? (
              <span className="a2ui-tab-queue" title={`${t.queueCount} queued`}>
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
        estimatedWidth={220}
        estimatedHeight={156}
      />
    </div>
  );
}
