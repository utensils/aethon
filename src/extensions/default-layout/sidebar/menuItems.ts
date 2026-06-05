/**
 * Sidebar context-menu item builders. Pure: takes the current menu
 * state + a bag of action callbacks and returns ContextMenu primitive
 * items. No React, no event side effects — see contextMenu.tsx for the
 * stateful glue.
 */

import type { ContextMenuItem } from "../../../components/primitives/context-menu";
import type { SidebarItem } from "../../../types/a2ui";
import { DEFAULT_WORKTREE_BASE_BRANCH } from "../../../projects";
import type { WorktreeSidebarItem } from "./worktree-row";

export interface SidebarContextMenuState {
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
  hasExtraWorktrees?: boolean;
  /** For `worktree` kind: the full worktree shape so menu actions can
   *  surface path + branch + main-flag context without re-resolving. */
  worktree?: WorktreeSidebarItem;
}

export function canRenameWorktree(
  item: WorktreeSidebarItem | undefined,
): boolean {
  if (!item) return false;
  const pending = item.pendingState;
  return !pending || pending === "succeeded";
}

export function canRemoveWorktree(
  item: WorktreeSidebarItem | undefined,
): boolean {
  if (!item || item.isMain) return false;
  const pending = item.pendingState;
  return !pending || pending === "succeeded";
}

export interface SidebarMenuHandlers {
  // Project actions — clicking a row switches; menu only surfaces
  // verbs that aren't reachable from a plain click.
  createWorktreeForContextProject: () => void;
  editContextProjectWorktreeBase: () => void;
  submitContextProjectWorktreeBase: (baseBranch: string) => void;
  sortContextProjectWorktreesNewest: () => void;
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
export function extensionToggleState(item: SidebarItem): {
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

export function buildSidebarMenuItems(
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
        {
          id: "sort-worktrees",
          label: "Sort worktrees newest first",
          disabled: !state.hasExtraWorktrees,
          onSelect: h.sortContextProjectWorktreesNewest,
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
      const canRemove = canRemoveWorktree(state.worktree);
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
          disabled: !canRenameWorktree(state.worktree),
          onSelect: h.renameContextWorktree,
        },
        { type: "separator" },
        {
          id: "remove-worktree",
          label: "Remove worktree",
          danger: true,
          disabled: !canRemove,
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
