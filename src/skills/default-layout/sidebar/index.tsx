/**
 * Sidebar — collapsible panel with named sections. Items can be inline
 * arrays or bound to state via a $ref.
 */

import { Fragment, useRef, useState } from "react";
import type {
  BooleanValue,
  SidebarItem,
  SidebarSection,
  StringValue,
} from "../../../types/a2ui";
import { resolveBoolean, resolveString } from "../../../utils/dataBinding";
import { resolvePointer } from "../../../utils/jsonPointer";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../../../components/primitives/context-menu";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { WorktreeRow, type WorktreeSidebarItem } from "./worktree-row";
import {
  canDeleteHistoryItem,
  extractSessionId,
} from "../../../utils/sidebarHistory";
import { AeMarkInline } from "../layout";
import { ItemRow, type ItemRowProps } from "./item-row";
import { ToggleSwitch } from "../toggle-switch";
import {
  SearchableSidebarSection,
  type SidebarSectionExt,
} from "./searchable-section";
import { DEFAULT_WORKTREE_BASE_BRANCH } from "../../../projects";

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
  // prompts for project actions; "worktree" for nested worktree rows;
  // "session" for chat-history rows; "extension-*" for the extension
  // toggle. Set by openItemContextMenu / openWorktreeContextMenu based
  // on the section + item id.
  kind:
    | "project"
    | "project-base"
    | "worktree"
    | "session"
    | "extension-enabled"
    | "extension-disabled";
  /** For `extension-*` kinds, the extension's display name (item id
   *  minus the `ext:` / `ext-failed:` / `ext-disabled:` prefix). */
  extensionName?: string;
  baseBranch?: string;
  /** For `worktree` kind: the full worktree shape so menu actions can
   *  surface path + branch + main-flag context without re-resolving. */
  worktree?: WorktreeSidebarItem;
}

interface SidebarMenuHandlers {
  // Project actions — clicking a row switches; menu only surfaces
  // verbs that aren't reachable from a plain click.
  createWorktreeForContextProject: () => void;
  editContextProjectWorktreeBase: () => void;
  submitContextProjectWorktreeBase: (baseBranch: string) => void;
  openContextProjectInFinder: () => void;
  copyContextProjectPath: () => void;
  renameContextProject: () => void;
  removeContextProject: () => void;
  // Worktree actions — same convention as projects: row click handles
  // activation/landing; menu omits a redundant "Switch to worktree".
  openContextWorktreeInFinder: () => void;
  copyContextWorktreePath: () => void;
  renameContextWorktree: () => void;
  removeContextWorktree: () => void;
  // Session + extension (unchanged)
  renameContextSession: () => void;
  deleteContextSession: () => void;
  toggleContextExtension: (disabled: boolean) => void;
}

/** Classify an extension item by its id prefix. The bridge encodes the
 *  state in the id (`ext:` = enabled, `ext-disabled:` = disabled,
 *  `ext-failed:` = load failed) so the toggle has to invert that to
 *  drive the switch. Returns null for non-extension items so the caller
 *  can skip rendering the trailing toggle slot entirely. */
function extensionToggleState(item: SidebarItem): {
  name: string;
  checked: boolean;
  failed: boolean;
} | null {
  if (item.id.startsWith("ext:")) {
    return { name: item.id.slice("ext:".length), checked: true, failed: false };
  }
  if (item.id.startsWith("ext-disabled:")) {
    return {
      name: item.id.slice("ext-disabled:".length),
      checked: false,
      failed: false,
    };
  }
  if (item.id.startsWith("ext-failed:")) {
    return {
      name: item.id.slice("ext-failed:".length),
      checked: false,
      failed: true,
    };
  }
  return null;
}

function buildSidebarMenuItems(
  state: SidebarContextMenuState,
  h: SidebarMenuHandlers,
): ContextMenuItem[] {
  switch (state.kind) {
    case "project":
      return [
        {
          id: "create-worktree",
          label: "Create worktree…",
          onSelect: h.createWorktreeForContextProject,
        },
        {
          id: "set-worktree-base",
          label: "Set worktree base…",
          keepOpenOnSelect: true,
          onSelect: h.editContextProjectWorktreeBase,
        },
        { type: "separator" },
        {
          id: "open-finder",
          label: "Open in Finder",
          onSelect: h.openContextProjectInFinder,
        },
        {
          id: "copy-path",
          label: "Copy path",
          onSelect: h.copyContextProjectPath,
        },
        {
          id: "rename-project",
          label: "Rename project…",
          onSelect: h.renameContextProject,
        },
        { type: "separator" },
        {
          id: "remove-project",
          label: "Remove from Projects",
          danger: true,
          onSelect: h.removeContextProject,
        },
        { type: "note", label: "Keeps files on disk" },
      ];
    case "project-base":
      return [
        { type: "header", label: "Worktree base" },
        {
          type: "input",
          id: "worktree-base-input",
          label: "Base branch",
          defaultValue: state.baseBranch ?? DEFAULT_WORKTREE_BASE_BRANCH,
          placeholder: DEFAULT_WORKTREE_BASE_BRANCH,
          submitLabel: "Save",
          onSubmit: h.submitContextProjectWorktreeBase,
        },
        {
          type: "note",
          label: "Blank or origin/main uses the default",
        },
      ];
    case "worktree": {
      const isMain = state.worktree?.isMain === true;
      return [
        {
          id: "open-finder",
          label: "Open in Finder",
          onSelect: h.openContextWorktreeInFinder,
        },
        {
          id: "copy-path",
          label: "Copy path",
          onSelect: h.copyContextWorktreePath,
        },
        {
          id: "rename-worktree",
          label: "Rename worktree…",
          onSelect: h.renameContextWorktree,
        },
        { type: "separator" },
        {
          id: "remove-worktree",
          label: "Remove worktree",
          danger: true,
          disabled: isMain,
          onSelect: h.removeContextWorktree,
        },
        isMain
          ? { type: "note", label: "Can't remove the main worktree" }
          : { type: "note", label: "git worktree remove" },
      ];
    }
    case "session":
      return [
        { id: "rename-session", label: "Rename session…", onSelect: h.renameContextSession },
        {
          id: "delete-session",
          label: "Delete session…",
          danger: true,
          onSelect: h.deleteContextSession,
        },
        { type: "note", label: "Delete removes the saved transcript" },
      ];
    case "extension-enabled":
      return [
        {
          id: "disable-ext",
          label: "Disable extension",
          onSelect: () => h.toggleContextExtension(true),
        },
        { type: "note", label: "Restart Aethon to fully unload" },
      ];
    case "extension-disabled":
      return [
        {
          id: "enable-ext",
          label: "Enable extension",
          onSelect: () => h.toggleContextExtension(false),
        },
        { type: "note", label: "Restart Aethon (or /reload) to load" },
      ];
  }
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
  const resolvedResizeEdge = props.resizeEdge
    ? resolveString(props.resizeEdge, state)
    : "right";
  const normalizedResizeEdge = resolvedResizeEdge.trim().toLowerCase();
  const resizeEdge: "left" | "right" =
    normalizedResizeEdge === "left" ? "left" : "right";
  const resizeFromLeft = resizeEdge === "left";

  const asideRef = useRef<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] =
    useState<SidebarContextMenuState | null>(null);

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
    // Raw clientX/clientY here; the ContextMenu primitive clamps via
    // clampFixedOverlay so the menu lands at the cursor at any UI scale.
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
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

  // Project + worktree context-menu handlers. Each fires an event the
  // App-side route table picks up via `type:sidebar`; the App handles
  // the actual git / clipboard / dialog work so this component stays
  // surface-only. The "Switch to project / worktree" entries were
  // dropped — clicking the row already switches, so the menu only
  // lists verbs that aren't reachable from a plain click.
  const createWorktreeForContextProject = () => {
    if (!contextMenu) return;
    onEvent("create-worktree", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
    });
    setContextMenu(null);
  };
  const editContextProjectWorktreeBase = () => {
    if (!contextMenu) return;
    const projects =
      (state.projects as
        | { id: string; worktreeBaseBranch?: string }[]
        | undefined) ?? [];
    const project = projects.find((p) => p.id === contextMenu.itemId);
    setContextMenu({
      ...contextMenu,
      kind: "project-base",
      baseBranch: project?.worktreeBaseBranch ?? DEFAULT_WORKTREE_BASE_BRANCH,
    });
  };
  const submitContextProjectWorktreeBase = (baseBranch: string) => {
    if (!contextMenu) return;
    onEvent("set-project-worktree-base", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
      baseBranch,
    });
    setContextMenu(null);
  };
  const openContextProjectInFinder = () => {
    if (!contextMenu) return;
    onEvent("open-project-in-finder", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
    });
    setContextMenu(null);
  };
  const copyContextProjectPath = () => {
    if (!contextMenu) return;
    onEvent("copy-project-path", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
    });
    setContextMenu(null);
  };
  const renameContextProject = () => {
    if (!contextMenu) return;
    const next = window.prompt("Rename project", contextMenu.label);
    if (next === null) {
      setContextMenu(null);
      return;
    }
    onEvent("rename-project", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
      label: next,
    });
    setContextMenu(null);
  };
  const openContextWorktreeInFinder = () => {
    if (!contextMenu?.worktree) return;
    onEvent("open-worktree-in-finder", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      worktreeId: contextMenu.worktree.id,
      path: contextMenu.worktree.path,
    });
    setContextMenu(null);
  };
  const copyContextWorktreePath = () => {
    if (!contextMenu?.worktree) return;
    onEvent("copy-worktree-path", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      worktreeId: contextMenu.worktree.id,
      path: contextMenu.worktree.path,
    });
    setContextMenu(null);
  };
  const renameContextWorktree = () => {
    if (!contextMenu?.worktree) return;
    const next = window.prompt(
      "Rename worktree",
      contextMenu.worktree.label || contextMenu.worktree.branch || "",
    );
    if (next === null) {
      setContextMenu(null);
      return;
    }
    onEvent("rename-worktree", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      worktreeId: contextMenu.worktree.id,
      label: next,
    });
    setContextMenu(null);
  };
  const removeContextWorktree = () => {
    if (!contextMenu?.worktree) return;
    onEvent("remove-worktree", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      worktreeId: contextMenu.worktree.id,
      path: contextMenu.worktree.path,
    });
    setContextMenu(null);
  };

  const openWorktreeContextMenu = (
    e: React.MouseEvent<HTMLElement>,
    item: WorktreeSidebarItem,
    sectionId: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sectionId,
      itemId: item.id,
      label: item.label || item.branch || "worktree",
      kind: "worktree",
      worktree: item,
    });
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
  const extensionItems = (() => {
    const sidebar = (state.sidebar as Record<string, unknown> | undefined) ?? {};
    const raw = sidebar.extensions;
    return Array.isArray(raw) ? (raw as SidebarItem[]) : [];
  })();
  const hasExplicitExtensionSection = [
    ...(props.sections ?? []),
    ...(extraSections as SidebarSectionExt[]),
  ].some((section) => section.id === "extensions");
  const extensionSections: SidebarSectionExt[] =
    extensionItems.length > 0 && !hasExplicitExtensionSection
      ? [
          {
            id: "extensions",
            title: "extensions",
            items: extensionItems,
          },
        ]
      : [];
  const allSections: SidebarSectionExt[] = [
    ...(props.sections ?? []),
    ...extensionSections,
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
                onItemContextMenu={openItemContextMenu}
                renderChildWithState={renderChildWithState}
              />
            );
          }
          const actions = section.actions ?? [];
          const isProjects = section.id === "projects";
          return (
            <div
              key={section.id}
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
                    // Inline toggle for extension rows — quick on/off
                    // without diving into the right-click menu. The
                    // context menu stays as a secondary affordance.
                    const extState =
                      section.id === "extensions"
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
                    // (the project's primary checkout), so a 1-element list
                    // is "no extra worktrees" and the chevron is meaningless.
                    // Surface the chevron only when worktrees.length > 1.
                    const hasExtraWorktrees =
                      !!worktrees && worktrees.length > 1;
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
                          componentId={component.id}
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
                          // Reserve chevron + dirty-dot slots across every
                          // row in the projects section so labels align
                          // regardless of which rows happen to have
                          // worktrees or uncommitted changes.
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
      <ContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={
          contextMenu
            ? buildSidebarMenuItems(contextMenu, {
        createWorktreeForContextProject,
        editContextProjectWorktreeBase,
        submitContextProjectWorktreeBase,
        openContextProjectInFinder,
                copyContextProjectPath,
                renameContextProject,
                removeContextProject,
                openContextWorktreeInFinder,
                copyContextWorktreePath,
                renameContextWorktree,
                removeContextWorktree,
                renameContextSession,
                deleteContextSession,
                toggleContextExtension,
              })
            : []
        }
        onClose={() => setContextMenu(null)}
        ariaLabel={`${contextMenu?.kind ?? ""} menu`}
        className="a2ui-sidebar-context-menu"
      />
    </aside>
  );
}
