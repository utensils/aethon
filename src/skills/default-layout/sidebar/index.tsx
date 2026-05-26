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

import { Fragment } from "react";
import type {
  BooleanValue,
  SidebarItem,
  SidebarSection,
  StringValue,
} from "../../../types/a2ui";
import { resolveBoolean, resolveString } from "../../../utils/dataBinding";
import { ContextMenu } from "../../../components/primitives/context-menu";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { WorktreeRow, type WorktreeSidebarItem } from "./worktree-row";
import { AeMarkInline } from "../layout";
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

  const menu = useSidebarContextMenu({ state, onEvent });
  const { asideRef, onResizeStart } = useSidebarResize({
    onEvent,
    resizeFromLeft,
  });

  const title = props.title ? resolveString(props.title, state) : "";
  const version = props.version ? resolveString(props.version, state) : "";
  const showBrand = props.brandMark
    ? resolveBoolean(props.brandMark, state)
    : !!title;

  const allSections = composeSidebarSections({
    sections: props.sections,
    extraSectionsRaw: props.extraSections,
    state,
  });

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
            />
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
}: SidebarSectionBlockProps) {
  const actions = section.actions ?? [];
  const isProjects = section.id === "projects";
  const isExtensionsSection =
    section.id === "extensions" || section.id === "extensions-user";
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
