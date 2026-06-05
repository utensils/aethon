/**
 * Sidebar — collapsible panel with named sections. Items can be inline
 * arrays or bound to state via a $ref.
 *
 * The render shell composes three units extracted from the original
 * god-file: `useSidebarContextMenu` owns the right-click menu state +
 * project/worktree/session/extension handlers; `useSidebarResize` owns
 * the drag handle; `composeSidebarSections` and `resolveSidebarItems`
 * own the section/items derivation (extension auto-injection, extra
 * sections, $ref resolution). `buildSidebarMenuItems` /
 * `extensionToggleState` live in `menuItems.ts` as pure data.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  BooleanValue,
  SidebarItem,
  SidebarSection,
  StringValue,
} from "../../../types/a2ui";
import { resolveBoolean, resolveString } from "../../../utils/dataBinding";
import { isMacOS } from "../../../utils/platform";
import { onWindowDragMouseDown } from "../../../utils/windowDrag";
import { ContextMenu } from "../../../components/primitives/context-menu";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { WorktreeRow, type WorktreeSidebarItem } from "./worktree-row";
import { AeWordmark } from "../layout";
import { HostGroup, type HostGroupItem } from "./host-group";
import { ItemRow } from "./item-row";
import { ToggleSwitch } from "../toggle-switch";
import {
  SearchableSidebarSection,
  type SidebarSectionExt,
} from "./searchable-section";
import { useSidebarContextMenu } from "./contextMenu";
import { useSidebarResize } from "./resize";
import { composeSidebarSections, resolveSidebarItems } from "./sections";
import { buildSidebarMenuItems, extensionToggleState } from "./menuItems";

// eslint-disable-next-line react-refresh/only-export-components -- pure helpers re-exported from sibling module
export { providerOf, filterItems } from "./filter";
export { ItemRow } from "./item-row";
export type { ItemRowProps } from "./item-row";
export { SearchableSidebarSection } from "./searchable-section";
export type {
  SidebarSectionExt,
  SearchableSidebarSectionProps,
} from "./searchable-section";

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
    /** When true, group the `projects` section under host node(s) — the
     *  top tier of the host → project → worktree hierarchy. Each host is
     *  a collapsible header; the active host owns the project list. The
     *  default workstation layout sets this; generic sidebars omit it and
     *  render `projects` as a plain top-level section. */
    hostGroups?: BooleanValue;
    /** Host list ($ref or inline) feeding the host group headers. */
    hosts?: SidebarItem[] | { $ref: string };
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
  const resolvedResizeEdge = props.resizeEdge
    ? resolveString(props.resizeEdge, state)
    : "right";
  const normalizedResizeEdge = resolvedResizeEdge.trim().toLowerCase();
  const resizeEdge: "left" | "right" =
    normalizedResizeEdge === "left" ? "left" : "right";
  const resizeFromLeft = resizeEdge === "left";

  const [renamingWorktreeId, setRenamingWorktreeId] = useState<string | null>(
    null,
  );
  const menu = useSidebarContextMenu({
    state,
    onEvent,
    beginWorktreeRename: setRenamingWorktreeId,
  });
  const handleRenameWorktreeEnd = useCallback((worktreeId: string) => {
    setRenamingWorktreeId((current) =>
      current === worktreeId ? null : current,
    );
  }, []);
  const { asideRef, onResizeStart } = useSidebarResize({
    onEvent,
    resizeFromLeft,
  });

  const title = props.title ? resolveString(props.title, state) : "";
  const version = props.version ? resolveString(props.version, state) : "";
  const showBrand = props.brandMark
    ? resolveBoolean(props.brandMark, state)
    : !!title;
  const useHostGroups = props.hostGroups
    ? resolveBoolean(props.hostGroups, state)
    : false;
  const hosts = useHostGroups
    ? (resolveSidebarItems(props.hosts, state) as unknown as HostGroupItem[])
    : [];

  // Per-host collapse state for the project list (local UI only — the
  // active host defaults to expanded). Keyed by host id.
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleHostCollapsed = (id: string) =>
    setCollapsedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSections = composeSidebarSections({
    sections: props.sections,
    extraSectionsRaw: props.extraSections,
    state,
  });
  // When host groups are on, the projects section is rendered nested
  // inside the active host's group; everything else stays top-level.
  const groupHosts = useHostGroups && hosts.length > 0;
  const projectsSection = groupHosts
    ? allSections.find((s) => s.id === "projects")
    : undefined;
  const topLevelSections = projectsSection
    ? allSections.filter((s) => s.id !== "projects")
    : allSections;

  const renderSection = (section: SidebarSectionExt) => {
    const items = resolveSidebarItems(section.items, state);
    if (section.hideWhenEmpty === true && items.length === 0) {
      return null;
    }
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
          onItemContextMenu={menu.openItemContextMenu}
          renderChildWithState={renderChildWithState}
        />
      );
    }
    return (
      <SidebarSectionBlock
        key={section.id}
        section={section}
        items={items}
        monoItems={monoItems}
        componentId={component.id}
        state={state}
        onEvent={onEvent}
        renderChildWithState={renderChildWithState}
        openItemContextMenu={menu.openItemContextMenu}
        openWorktreeContextMenu={menu.openWorktreeContextMenu}
        renamingWorktreeId={renamingWorktreeId}
        onRenameWorktreeEnd={handleRenameWorktreeEnd}
      />
    );
  };

  return (
    <aside
      ref={asideRef}
      className={`a2ui-sidebar ${resizeFromLeft ? "a2ui-sidebar-resize-left" : ""}`}
    >
      {(showBrand || title || version) && (
        // Brand strip — also the macOS overlay-titlebar drag region. On
        // mac it reserves the top-left for the traffic lights (see the
        // [data-platform="mac"] rule in chrome.css); the host hierarchy
        // lives in the body below, not here. `"deep"` + the explicit
        // mousedown handler make the whole strip (logo + version) drag the
        // window, matching the header. Emitted only on mac so Linux/Windows
        // native-titlebar dragging is unchanged.
        <div
          className="a2ui-sidebar-title"
          {...(isMacOS()
            ? {
                "data-tauri-drag-region": "deep",
                onMouseDown: onWindowDragMouseDown,
              }
            : {})}
        >
          {showBrand ? (
            // Full wordmark replaces the monogram + plain "aethon" text so
            // the bare Æ stays unique to the overview tab / dashboard hero.
            <AeWordmark height={20} />
          ) : (
            title && <span>{title}</span>
          )}
          {version && (
            <span className="a2ui-sidebar-title-version">{version}</span>
          )}
        </div>
      )}
      <div className="a2ui-sidebar-sections">
        {groupHosts
          ? hosts.map((host) => {
              const collapsed = collapsedHosts.has(host.id);
              // Only the active host shows its projects today; selecting
              // another host switches the active one (then its projects
              // show). Designed to scale to per-host project lists.
              const showsProjects = host.active && !!projectsSection;
              return (
                <HostGroup
                  key={host.id}
                  host={host}
                  collapsible={showsProjects}
                  expanded={showsProjects && !collapsed}
                  onToggleExpand={() => toggleHostCollapsed(host.id)}
                  onSelectHost={() =>
                    onEvent(
                      "select",
                      { sectionId: "hosts", itemId: host.id },
                      host.id,
                    )
                  }
                >
                  {showsProjects && projectsSection
                    ? renderSection(projectsSection)
                    : null}
                </HostGroup>
              );
            })
          : null}
        {topLevelSections.map((section) => renderSection(section))}
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
      <ContextMenu
        open={!!menu.contextMenu}
        x={menu.contextMenu?.x ?? 0}
        y={menu.contextMenu?.y ?? 0}
        items={
          menu.contextMenu
            ? buildSidebarMenuItems(menu.contextMenu, menu.handlers)
            : []
        }
        onClose={menu.close}
        ariaLabel={`${menu.contextMenu?.kind ?? ""} menu`}
        className="a2ui-sidebar-context-menu"
      />
    </aside>
  );
}

interface SidebarSectionBlockProps {
  section: SidebarSectionExt;
  items: SidebarItem[];
  monoItems: boolean;
  componentId: string;
  state: Record<string, unknown>;
  onEvent: BuiltinComponentProps["onEvent"];
  renderChildWithState: BuiltinComponentProps["renderChildWithState"];
  openItemContextMenu: ReturnType<
    typeof useSidebarContextMenu
  >["openItemContextMenu"];
  openWorktreeContextMenu: ReturnType<
    typeof useSidebarContextMenu
  >["openWorktreeContextMenu"];
  renamingWorktreeId: string | null;
  onRenameWorktreeEnd: (worktreeId: string) => void;
}

/** Plain (non-searchable) section block. Renders the title, the row
 *  list (with extension toggle / worktree disclosure / projects-slot
 *  alignment), and the trailing action row. Pulled out of Sidebar so
 *  the map callback stays at one screen. */
function SidebarSectionBlock({
  section,
  items,
  monoItems,
  componentId,
  state,
  onEvent,
  renderChildWithState,
  openItemContextMenu,
  openWorktreeContextMenu,
  renamingWorktreeId,
  onRenameWorktreeEnd,
}: SidebarSectionBlockProps) {
  const [draggingWorktreeId, setDraggingWorktreeId] = useState<string | null>(
    null,
  );
  const [dropIndicator, setDropIndicator] = useState<{
    worktreeId: string;
    side: "before" | "after";
  } | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const pendingPointerDragRef = useRef<{
    projectId: string;
    worktreeId: string;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressionClearTimerRef = useRef<number | null>(null);
  const actions = section.actions ?? [];
  const isProjects = section.id === "projects";
  const isExtensionsSection =
    section.id === "extensions" || section.id === "extensions-user";

  const finishWorktreeDrag = () => {
    setDraggingWorktreeId(null);
    setDropIndicator(null);
    setDragOffsetY(0);
  };

  const worktreeElementsForDrop = (
    root: HTMLElement,
    projectId: string,
    draggedWorktreeId: string,
  ) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(".ae-worktree-row[data-worktree-id]"),
    ).filter(
      (el) =>
        el.dataset.projectId === projectId &&
        el.dataset.worktreeId !== draggedWorktreeId,
    );

  const insertionIndexForWorktreeDrop = (
    root: HTMLElement,
    projectId: string,
    draggedWorktreeId: string,
    clientY: number,
  ) => {
    const rows = worktreeElementsForDrop(root, projectId, draggedWorktreeId);
    for (let index = 0; index < rows.length; index += 1) {
      const rect = rows[index].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return rows.length;
  };

  const showWorktreeDropIndicator = (
    root: HTMLElement,
    projectId: string,
    draggedWorktreeId: string,
    clientY: number,
  ) => {
    const rows = worktreeElementsForDrop(root, projectId, draggedWorktreeId);
    if (rows.length === 0) {
      setDropIndicator(null);
      return;
    }
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        const worktreeId = row.dataset.worktreeId;
        if (worktreeId) setDropIndicator({ worktreeId, side: "before" });
        return;
      }
    }
    const worktreeId = rows[rows.length - 1].dataset.worktreeId;
    if (worktreeId) setDropIndicator({ worktreeId, side: "after" });
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

  const startWorktreeDrag = (
    event: React.PointerEvent<HTMLElement>,
    item: WorktreeSidebarItem,
  ) => {
    if (!isProjects || item.isMain || event.button !== 0) return;
    if (!item.projectId) return;
    const target = event.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest(".ae-worktree-rename-input")
    ) {
      return;
    }
    const root = event.currentTarget.closest(".a2ui-sidebar-list");
    if (!(root instanceof HTMLElement)) return;
    pointerCleanupRef.current?.();
    pendingPointerDragRef.current = {
      projectId: item.projectId,
      worktreeId: item.id,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };

    const onMove = (moveEvent: PointerEvent) => {
      const pending = pendingPointerDragRef.current;
      if (!pending) return;
      const dx = moveEvent.clientX - pending.startX;
      const dy = moveEvent.clientY - pending.startY;
      if (!pending.dragging && Math.hypot(dx, dy) < 4) return;
      if (!pending.dragging) {
        pending.dragging = true;
        suppressNextClickRef.current = true;
        setDraggingWorktreeId(pending.worktreeId);
      }
      moveEvent.preventDefault();
      setDragOffsetY(dy);
      showWorktreeDropIndicator(
        root,
        pending.projectId,
        pending.worktreeId,
        moveEvent.clientY,
      );
    };

    const onUp = (upEvent: PointerEvent) => {
      const pending = pendingPointerDragRef.current;
      const wasDragging = pending?.dragging;
      if (pending && wasDragging) {
        upEvent.preventDefault();
        const toIndex = insertionIndexForWorktreeDrop(
          root,
          pending.projectId,
          pending.worktreeId,
          upEvent.clientY,
        );
        onEvent("reorder-worktree", {
          sectionId: section.id,
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          toIndex,
        });
      }
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      pendingPointerDragRef.current = null;
      if (wasDragging) clearSuppressionSoon();
      finishWorktreeDrag();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    pointerCleanupRef.current = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  };

  const consumeSuppressedWorktreeClick = () => {
    if (!suppressNextClickRef.current) return false;
    suppressNextClickRef.current = false;
    return true;
  };
  return (
    <div
      className={[
        "a2ui-sidebar-section",
        section.title ? "" : "a2ui-sidebar-section-no-title",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {section.title && (
        <div className="a2ui-sidebar-section-title">{section.title}</div>
      )}
      {items.length === 0 ? (
        <div className="a2ui-sidebar-empty">empty</div>
      ) : (
        <ul className="a2ui-sidebar-list">
          {items.map((item, idx) => {
            const projectItem = isProjects
              ? (item as unknown as {
                  worktrees?: WorktreeSidebarItem[];
                  expanded?: boolean;
                })
              : null;
            const worktrees = projectItem?.worktrees;
            const expanded = projectItem?.expanded === true;
            // Inline toggle for extension rows — quick on/off without
            // diving into the right-click menu. The context menu stays
            // as a secondary affordance. Match both auto-injected
            // sub-sections (project / user) so the toggle shows on
            // every extension row regardless of bucket.
            const extState = isExtensionsSection
              ? extensionToggleState(item)
              : null;
            const trailingControl = extState ? (
              <ToggleSwitch
                checked={extState.checked}
                disabled={extState.failed}
                ariaLabel={`${extState.checked ? "Disable" : "Enable"} extension ${extState.name}`}
                title={
                  extState.failed
                    ? "Extension failed to load — fix the error and reload to re-enable"
                    : extState.checked
                      ? `Disable ${extState.name}`
                      : `Enable ${extState.name}`
                }
                onChange={(next) => {
                  onEvent(
                    "toggle-extension",
                    {
                      sectionId: section.id,
                      itemId: item.id,
                      name: extState.name,
                      disabled: !next,
                    },
                    item.id,
                  );
                }}
              />
            ) : undefined;
            // Only show the disclosure when there are EXTRA worktrees
            // beyond the main one — every git repo returns ≥1 entry
            // (the project's primary checkout), so a 1-element list is
            // "no extra worktrees" and the chevron is meaningless.
            // Surface the chevron only when worktrees.length > 1.
            const hasExtraWorktrees = !!worktrees && worktrees.length > 1;
            const extraWorktrees = hasExtraWorktrees
              ? worktrees.filter((w) => !w.isMain)
              : [];
            return (
              <Fragment key={item.id}>
                <ItemRow
                  item={
                    hasExtraWorktrees
                      ? {
                          ...item,
                          componentType: undefined,
                        }
                      : item
                  }
                  index={idx}
                  monoItems={monoItems}
                  sectionId={section.id}
                  componentId={componentId}
                  onEvent={onEvent}
                  onItemContextMenu={openItemContextMenu}
                  renderChildWithState={renderChildWithState}
                  state={state}
                  disclosure={
                    hasExtraWorktrees
                      ? expanded
                        ? "expanded"
                        : "collapsed"
                      : undefined
                  }
                  onToggleDisclosure={
                    hasExtraWorktrees
                      ? () =>
                          onEvent(
                            "toggle-project-expand",
                            { sectionId: section.id, itemId: item.id },
                            item.id,
                          )
                      : undefined
                  }
                  // Reserve chevron + dirty-dot slots across every row in
                  // the projects section so labels align regardless of
                  // which rows happen to have worktrees or uncommitted
                  // changes.
                  alignSlots={isProjects}
                  // Projects render as two-line cards (name over a git
                  // meta line) so the branch never squeezes out the name.
                  stacked={isProjects}
                  trailingControl={trailingControl}
                />
                {hasExtraWorktrees && expanded
                  ? extraWorktrees.map((wt) => (
                      <WorktreeRow
                        key={wt.id}
                        item={wt}
                        sectionId={section.id}
                        onEvent={onEvent}
                        onItemContextMenu={openWorktreeContextMenu}
                        renaming={renamingWorktreeId === wt.id}
                        onRenameEnd={onRenameWorktreeEnd}
                        dragging={draggingWorktreeId === wt.id}
                        dropSide={
                          dropIndicator?.worktreeId === wt.id
                            ? dropIndicator.side
                            : undefined
                        }
                        dragOffsetY={dragOffsetY}
                        onPointerDragStart={startWorktreeDrag}
                        consumeSuppressedClick={consumeSuppressedWorktreeClick}
                      />
                    ))
                  : null}
              </Fragment>
            );
          })}
        </ul>
      )}
      {actions.length > 0 && (
        <ul className="a2ui-sidebar-actions">
          {actions.map((a) => (
            <li
              key={a.id}
              className="a2ui-sidebar-action"
              onClick={() =>
                onEvent("select", { sectionId: section.id, itemId: a.id }, a.id)
              }
            >
              {a.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
