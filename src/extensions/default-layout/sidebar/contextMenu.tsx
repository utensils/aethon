/**
 * Sidebar context-menu controller. Owns the open/close state plus every
 * handler the menu invokes — project, worktree, session, and extension
 * verbs. Returns an opaque controller the Sidebar wires into the
 * ItemRow / WorktreeRow `onContextMenu` callbacks and into the
 * ContextMenu primitive.
 *
 * Handlers fire app-level events via `onEvent`; the App-side route
 * table picks them up via `type:sidebar`. The component stays
 * surface-only — git / clipboard / dialog work happens elsewhere.
 */

import { useState } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { SidebarItem } from "../../../types/a2ui";
import { canDeleteHistoryItem, extractSessionId } from "../../../utils/sidebarHistory";
import { DEFAULT_WORKTREE_BASE_BRANCH } from "../../../projects";
import type { ItemRowProps } from "./item-row";
import type { WorktreeSidebarItem } from "./worktree-row";
import {
  canRenameWorktree,
  type SidebarContextMenuState,
  type SidebarMenuHandlers,
} from "./menuItems";

export interface SidebarContextMenuController {
  contextMenu: SidebarContextMenuState | null;
  close: () => void;
  openItemContextMenu: ItemRowProps["onItemContextMenu"];
  openWorktreeContextMenu: (
    e: React.MouseEvent<HTMLElement>,
    item: WorktreeSidebarItem,
    sectionId: string,
  ) => void;
  handlers: SidebarMenuHandlers;
}

export interface UseSidebarContextMenuDeps {
  state: Record<string, unknown>;
  onEvent: BuiltinComponentProps["onEvent"];
  beginWorktreeRename: (worktreeId: string) => void;
}

export function useSidebarContextMenu(
  deps: UseSidebarContextMenuDeps,
): SidebarContextMenuController {
  const { state, onEvent, beginWorktreeRename } = deps;
  const [contextMenu, setContextMenu] =
    useState<SidebarContextMenuState | null>(null);

  const close = () => setContextMenu(null);

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
    const kind = classifyMenuKind(item, sectionId);
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
      kind: kind.kind,
      extensionName: kind.extensionName,
      hasExtraWorktrees:
        kind.kind === "project" &&
        Array.isArray((item as { worktrees?: unknown }).worktrees) &&
        ((item as { worktrees?: unknown[] }).worktrees ?? []).filter(
          (w) => !(w as { isMain?: boolean } | null)?.isMain,
        ).length > 0,
    });
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

  const removeContextProject = () => {
    if (!contextMenu) return;
    onEvent("remove-project", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
      label: contextMenu.label,
    });
    close();
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
    close();
  };

  const renameContextSession = () => {
    if (!contextMenu) return;
    // Native prompt is intentionally lo-fi — keeps the surface tiny and
    // matches the existing browser-prompt fallbacks elsewhere
    // (delete confirmation, project picker errors). A richer modal can
    // come later without changing the wire format.
    const next = window.prompt("Rename session", contextMenu.label);
    if (next === null) {
      close();
      return;
    }
    onEvent("rename-session", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      sessionId: extractSessionId(contextMenu.itemId),
      label: next,
    });
    close();
  };

  const toggleContextExtension = (disabled: boolean) => {
    if (!contextMenu || !contextMenu.extensionName) return;
    onEvent("toggle-extension", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      name: contextMenu.extensionName,
      disabled,
    });
    close();
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
    close();
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
    close();
  };
  const sortContextProjectWorktreesNewest = () => {
    if (!contextMenu) return;
    onEvent("sort-project-worktrees", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
    });
    close();
  };
  const openContextProjectInFinder = () => {
    if (!contextMenu) return;
    onEvent("open-project-in-finder", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
    });
    close();
  };
  const copyContextProjectPath = () => {
    if (!contextMenu) return;
    onEvent("copy-project-path", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
    });
    close();
  };
  const renameContextProject = () => {
    if (!contextMenu) return;
    const next = window.prompt("Rename project", contextMenu.label);
    if (next === null) {
      close();
      return;
    }
    onEvent("rename-project", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      projectId: contextMenu.itemId,
      label: next,
    });
    close();
  };
  const openContextWorktreeInFinder = () => {
    if (!contextMenu?.worktree) return;
    onEvent("open-worktree-in-finder", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      worktreeId: contextMenu.worktree.id,
      path: contextMenu.worktree.path,
    });
    close();
  };
  const copyContextWorktreePath = () => {
    if (!contextMenu?.worktree) return;
    onEvent("copy-worktree-path", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      worktreeId: contextMenu.worktree.id,
      path: contextMenu.worktree.path,
    });
    close();
  };
  const renameContextWorktree = () => {
    if (!contextMenu?.worktree) return;
    if (canRenameWorktree(contextMenu.worktree)) {
      beginWorktreeRename(contextMenu.worktree.id);
    }
    close();
  };
  const removeContextWorktree = () => {
    if (!contextMenu?.worktree) return;
    onEvent("remove-worktree", {
      sectionId: contextMenu.sectionId,
      itemId: contextMenu.itemId,
      worktreeId: contextMenu.worktree.id,
      path: contextMenu.worktree.path,
    });
    close();
  };

  return {
    contextMenu,
    close,
    openItemContextMenu,
    openWorktreeContextMenu,
    handlers: {
      createWorktreeForContextProject,
      editContextProjectWorktreeBase,
      submitContextProjectWorktreeBase,
      sortContextProjectWorktreesNewest,
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
    },
  };
}

/** Map a clicked sidebar item to the menu kind and (for extensions) the
 *  display name. Returns null when no menu applies — e.g. layout items
 *  in the projects section that aren't projects, or hard-coded
 *  built-ins under extensions. */
function classifyMenuKind(
  item: SidebarItem,
  sectionId: string,
):
  | { kind: SidebarContextMenuState["kind"]; extensionName?: string }
  | null {
  if (sectionId === "projects") {
    return { kind: "project" };
  }
  if (sectionId === "history" && canDeleteHistoryItem(item.id)) {
    return { kind: "session" };
  }
  if (sectionId === "extensions" || sectionId === "extensions-user") {
    if (item.id.startsWith("ext:")) {
      return {
        kind: "extension-enabled",
        extensionName: item.id.slice("ext:".length),
      };
    }
    if (item.id.startsWith("ext-failed:")) {
      return {
        kind: "extension-enabled",
        extensionName: item.id.slice("ext-failed:".length),
      };
    }
    if (item.id.startsWith("ext-disabled:")) {
      return {
        kind: "extension-disabled",
        extensionName: item.id.slice("ext-disabled:".length),
      };
    }
    // Hard-coded built-ins (default-layout) have id "extension-layout"
    // and no toggle — the sidebar core lives in the binary.
  }
  return null;
}
