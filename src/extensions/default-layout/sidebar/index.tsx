/**
 * Sidebar — collapsible panel with named sections. Items can be inline
 * arrays or bound to state via a $ref.
 *
 * The render shell composes three units extracted from the original
 * god-file: `useSidebarContextMenu` owns the right-click menu state +
 * project/workspace/session/extension handlers; `useSidebarResize` owns
 * the drag handle; `composeSidebarSections` and `resolveSidebarItems`
 * own the section/items derivation (extension auto-injection, extra
 * sections, $ref resolution). `buildSidebarMenuItems` /
 * `extensionToggleState` live in `menuItems.ts` as pure data.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { WorkspaceRow, type WorkspaceSidebarItem } from "./workspace-row";
import { AeWordmark } from "../layout";
import { HostGroup, type HostGroupItem } from "./host-group";
import { ItemRow } from "./item-row";
import { ToggleSwitch } from "../toggle-switch";
import {
  SearchableSidebarSection,
  type SidebarSectionExt,
} from "./searchable-section";
import { Chevron } from "./chevron";
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
     *  top tier of the host → project → workspace hierarchy. Each host is
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

  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(
    null,
  );
  const menu = useSidebarContextMenu({
    state,
    onEvent,
    beginWorkspaceRename: setRenamingWorkspaceId,
  });
  const handleRenameWorkspaceEnd = useCallback((workspaceId: string) => {
    setRenamingWorkspaceId((current) =>
      current === workspaceId ? null : current,
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
  const hosts = useMemo(
    () =>
      useHostGroups
        ? (resolveSidebarItems(
            props.hosts,
            state,
          ) as unknown as HostGroupItem[])
        : [],
    [props.hosts, state, useHostGroups],
  );

  // Per-host expansion state for project lists (local UI only). Seed the
  // current active host open once, then let each host stay independently
  // expanded/collapsed as the user switches around the mesh.
  const [hostExpansionOverrides, setHostExpansionOverrides] = useState<
    Record<string, boolean>
  >({});
  const preserveExpandedHosts = useCallback(() => {
    setHostExpansionOverrides((prev) => {
      let next: Record<string, boolean> | null = null;
      for (const host of hosts) {
        const expanded = prev[host.id] ?? host.active;
        if (!expanded || prev[host.id] === true) continue;
        next ??= { ...prev };
        next[host.id] = true;
      }
      return next ?? prev;
    });
  }, [hosts]);
  const toggleHostExpanded = (id: string, currentExpanded: boolean) =>
    setHostExpansionOverrides((prev) => {
      if (prev[id] === !currentExpanded) return prev;
      return {
        ...prev,
        [id]: !currentExpanded,
      };
    });

  const allSections = composeSidebarSections({
    sections: props.sections,
    extraSectionsRaw: props.extraSections,
    state,
  });
  // When host groups are on, the projects section is rendered nested
  // inside the active host's group; everything else stays top-level.
  const groupHosts = useHostGroups && hosts.length > 0;
  const hostWorkspaceSelected =
    groupHosts && (state.project === null || state.project === undefined);
  const projectsSection = groupHosts
    ? allSections.find((s) => s.id === "projects")
    : undefined;
  const topLevelSections = projectsSection
    ? allSections.filter((s) => s.id !== "projects")
    : allSections;

  const renderSection = (
    section: SidebarSectionExt,
    sectionState: Record<string, unknown> = state,
    eventHandler: BuiltinComponentProps["onEvent"] = onEvent,
  ) => {
    const items = resolveSidebarItems(section.items, sectionState);
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
          state={sectionState}
          onEvent={eventHandler}
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
        state={sectionState}
        onEvent={eventHandler}
        renderChildWithState={renderChildWithState}
        openItemContextMenu={menu.openItemContextMenu}
        openWorkspaceContextMenu={menu.openWorkspaceContextMenu}
        renamingWorkspaceId={renamingWorkspaceId}
        onRenameWorkspaceEnd={handleRenameWorkspaceEnd}
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
              const sidebarState =
                (state.sidebar as Record<string, unknown> | undefined) ?? {};
              const projectsByHost =
                (sidebarState.projectsByHost as
                  | Record<string, unknown>
                  | undefined) ?? {};
              const hostProjects = Array.isArray(projectsByHost[host.id])
                ? (projectsByHost[host.id] as SidebarItem[])
                : host.active && Array.isArray(sidebarState.projects)
                  ? (sidebarState.projects as SidebarItem[])
                  : [];
              const canRenderProjects =
                !!projectsSection &&
                (hostProjects.length > 0 ||
                  host.paired === true ||
                  (host.hint ?? "").toLowerCase() === "this mac");
              const expanded =
                canRenderProjects &&
                (hostExpansionOverrides[host.id] ?? host.active);
              const hostState = {
                ...state,
                sidebar: {
                  ...sidebarState,
                  projects: hostProjects,
                },
              };
              const hostOnEvent: BuiltinComponentProps["onEvent"] = (
                eventType,
                data,
                id,
              ) => {
                preserveExpandedHosts();
                return onEvent(eventType, data, id);
              };
              return (
                <HostGroup
                  key={host.id}
                  host={host}
                  selected={host.active && hostWorkspaceSelected}
                  collapsible={canRenderProjects}
                  expanded={expanded}
                  onToggleExpand={() => toggleHostExpanded(host.id, expanded)}
                  onSelectHost={() => {
                    preserveExpandedHosts();
                    onEvent(
                      "select",
                      { sectionId: "hosts", itemId: host.id },
                      host.id,
                    );
                  }}
                  onPairHost={(event) => menu.openHostPairMenu(event, host)}
                  onHostContextMenu={menu.openHostContextMenu}
                >
                  {expanded && projectsSection
                    ? renderSection(projectsSection, hostState, hostOnEvent)
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
  openWorkspaceContextMenu: ReturnType<
    typeof useSidebarContextMenu
  >["openWorkspaceContextMenu"];
  renamingWorkspaceId: string | null;
  onRenameWorkspaceEnd: (workspaceId: string) => void;
}

/** Per-section collapsed pref. Pure presentational state, so it lives in
 *  localStorage (synchronous → no expand-then-collapse flash on load)
 *  rather than the async disk-persist used for heavier state. */
const SECTION_COLLAPSE_KEY = "aethon.sidebar.section-collapsed.";

function readSectionCollapsed(id: string): boolean {
  try {
    return window.localStorage.getItem(SECTION_COLLAPSE_KEY + id) === "1";
  } catch {
    return false;
  }
}

function writeSectionCollapsed(id: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SECTION_COLLAPSE_KEY + id,
      collapsed ? "1" : "0",
    );
  } catch {
    /* private mode / unavailable — collapse just won't persist */
  }
}

/** Plain (non-searchable) section block. Renders the title, the row
 *  list (with extension toggle / workspace disclosure / projects-slot
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
  openWorkspaceContextMenu,
  renamingWorkspaceId,
  onRenameWorkspaceEnd,
}: SidebarSectionBlockProps) {
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(
    null,
  );
  const [dropIndicator, setDropIndicator] = useState<{
    workspaceId: string;
    side: "before" | "after";
  } | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const pendingPointerDragRef = useRef<{
    projectId: string;
    workspaceId: string;
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

  // Extension sections collapse to a single header row so a long list of
  // disabled extensions stops eating the sidebar's vertical budget.
  const collapsible = isExtensionsSection && Boolean(section.title);
  const [collapsed, setCollapsed] = useState(
    () => collapsible && readSectionCollapsed(section.id),
  );
  const toggleCollapsed = () =>
    setCollapsed((prev) => {
      const next = !prev;
      writeSectionCollapsed(section.id, next);
      return next;
    });

  const finishWorkspaceDrag = () => {
    setDraggingWorkspaceId(null);
    setDropIndicator(null);
    setDragOffsetY(0);
  };

  const workspaceElementsForDrop = (
    root: HTMLElement,
    projectId: string,
    draggedWorkspaceId: string,
  ) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        ".ae-workspace-row[data-workspace-id]",
      ),
    ).filter(
      (el) =>
        el.dataset.projectId === projectId &&
        el.dataset.workspaceId !== draggedWorkspaceId,
    );

  const insertionIndexForWorkspaceDrop = (
    root: HTMLElement,
    projectId: string,
    draggedWorkspaceId: string,
    clientY: number,
  ) => {
    const rows = workspaceElementsForDrop(root, projectId, draggedWorkspaceId);
    for (let index = 0; index < rows.length; index += 1) {
      const rect = rows[index].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return rows.length;
  };

  const showWorkspaceDropIndicator = (
    root: HTMLElement,
    projectId: string,
    draggedWorkspaceId: string,
    clientY: number,
  ) => {
    const rows = workspaceElementsForDrop(root, projectId, draggedWorkspaceId);
    if (rows.length === 0) {
      setDropIndicator(null);
      return;
    }
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        const workspaceId = row.dataset.workspaceId;
        if (workspaceId) setDropIndicator({ workspaceId, side: "before" });
        return;
      }
    }
    const workspaceId = rows[rows.length - 1].dataset.workspaceId;
    if (workspaceId) setDropIndicator({ workspaceId, side: "after" });
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

  const startWorkspaceDrag = (
    event: React.PointerEvent<HTMLElement>,
    item: WorkspaceSidebarItem,
  ) => {
    if (!isProjects || item.isMain || event.button !== 0) return;
    if (!item.projectId) return;
    const target = event.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest(".ae-workspace-rename-input")
    ) {
      return;
    }
    const root = event.currentTarget.closest(".a2ui-sidebar-list");
    if (!(root instanceof HTMLElement)) return;
    pointerCleanupRef.current?.();
    pendingPointerDragRef.current = {
      projectId: item.projectId,
      workspaceId: item.id,
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
        setDraggingWorkspaceId(pending.workspaceId);
      }
      moveEvent.preventDefault();
      setDragOffsetY(dy);
      showWorkspaceDropIndicator(
        root,
        pending.projectId,
        pending.workspaceId,
        moveEvent.clientY,
      );
    };

    const onUp = (upEvent: PointerEvent) => {
      const pending = pendingPointerDragRef.current;
      const wasDragging = pending?.dragging;
      if (pending && wasDragging) {
        upEvent.preventDefault();
        const toIndex = insertionIndexForWorkspaceDrop(
          root,
          pending.projectId,
          pending.workspaceId,
          upEvent.clientY,
        );
        onEvent("reorder-workspace", {
          sectionId: section.id,
          projectId: pending.projectId,
          workspaceId: pending.workspaceId,
          toIndex,
        });
      }
      pointerCleanupRef.current?.();
      pointerCleanupRef.current = null;
      pendingPointerDragRef.current = null;
      if (wasDragging) clearSuppressionSoon();
      finishWorkspaceDrag();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    pointerCleanupRef.current = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  };

  const consumeSuppressedWorkspaceClick = () => {
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
      {section.title &&
        (collapsible ? (
          <button
            type="button"
            className="a2ui-sidebar-section-title a2ui-sidebar-section-title-toggle"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
          >
            <span className="a2ui-sidebar-section-caret" aria-hidden="true">
              <Chevron expanded={!collapsed} />
            </span>
            <span className="a2ui-sidebar-section-title-text">
              {section.title}
            </span>
            <span className="a2ui-sidebar-section-count">{items.length}</span>
          </button>
        ) : (
          <div className="a2ui-sidebar-section-title">{section.title}</div>
        ))}
      {collapsed ? null : items.length === 0 ? (
        <div className="a2ui-sidebar-empty">empty</div>
      ) : (
        <ul className="a2ui-sidebar-list">
          {items.map((item, idx) => {
            const projectItem = isProjects
              ? (item as unknown as {
                  workspaces?: WorkspaceSidebarItem[];
                  expanded?: boolean;
                })
              : null;
            const workspaces = projectItem?.workspaces;
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
            // The project row represents the main checkout. Only render
            // nested rows for additional workspaces; otherwise the active
            // branch appears twice under the same project.
            const extraWorkspaces = workspaces?.filter((w) => !w.isMain) ?? [];
            const hasExtraWorkspaces = extraWorkspaces.length > 0;
            return (
              <Fragment key={item.id}>
                <ItemRow
                  item={
                    hasExtraWorkspaces
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
                    hasExtraWorkspaces
                      ? expanded
                        ? "expanded"
                        : "collapsed"
                      : undefined
                  }
                  onToggleDisclosure={
                    hasExtraWorkspaces
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
                  // which rows happen to have workspaces or uncommitted
                  // changes.
                  alignSlots={isProjects}
                  // Projects render as two-line cards (name over a git
                  // meta line) so the branch never squeezes out the name.
                  stacked={isProjects}
                  trailingControl={trailingControl}
                />
                {hasExtraWorkspaces && expanded
                  ? extraWorkspaces.map((wt) => (
                      <WorkspaceRow
                        key={wt.id}
                        item={wt}
                        sectionId={section.id}
                        onEvent={onEvent}
                        onItemContextMenu={openWorkspaceContextMenu}
                        renaming={renamingWorkspaceId === wt.id}
                        onRenameEnd={onRenameWorkspaceEnd}
                        dragging={draggingWorkspaceId === wt.id}
                        dropSide={
                          dropIndicator?.workspaceId === wt.id
                            ? dropIndicator.side
                            : undefined
                        }
                        dragOffsetY={dragOffsetY}
                        onPointerDragStart={startWorkspaceDrag}
                        consumeSuppressedClick={consumeSuppressedWorkspaceClick}
                      />
                    ))
                  : null}
              </Fragment>
            );
          })}
        </ul>
      )}
      {!collapsed && actions.length > 0 && (
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
