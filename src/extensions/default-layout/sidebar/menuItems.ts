/**
 * Sidebar context-menu item builders. Pure: takes the current menu
 * state + a bag of action callbacks and returns ContextMenu primitive
 * items. No React, no event side effects — see contextMenu.tsx for the
 * stateful glue.
 */

import type { ContextMenuItem } from "../../../components/primitives/context-menu";
import type { SidebarItem } from "../../../types/a2ui";
import { DEFAULT_WORKSPACE_BASE_BRANCH } from "../../../projects";
import type { HostGroupItem } from "./host-group";
import type { WorkspaceSidebarItem } from "./workspace-row";

export interface SidebarContextMenuState {
  x: number;
  y: number;
  sectionId: string;
  itemId: string;
  label: string;
  // Discriminator so the rendered menu shows the right action. "project"
  // prompts for project actions; "workspace" for nested workspace rows;
  // "session" for chat-history rows; "extension-*" for the extension
  // toggle. Set by openItemContextMenu / openWorkspaceContextMenu based
  // on the section + item id.
  kind:
    | "project"
    | "project-base"
    | "host"
    | "host-rename"
    | "host-forget"
    | "workspace"
    | "mobile-device"
    | "mobile-device-rename"
    | "mobile-device-unpair"
    | "session"
    | "extension-enabled"
    | "extension-disabled";
  /** For `extension-*` kinds, the extension's display name (item id
   *  minus the `ext:` / `ext-failed:` / `ext-disabled:` prefix). */
  extensionName?: string;
  baseBranch?: string;
  hasExtraWorkspaces?: boolean;
  /** For `workspace` kind: the full workspace shape so menu actions can
   *  surface path + branch + main-flag context without re-resolving. */
  workspace?: WorkspaceSidebarItem;
  host?: HostGroupItem;
}

function isLocalHost(item: HostGroupItem | undefined): boolean {
  return (item?.hint ?? "").toLowerCase() === "this mac";
}

function canPairHost(item: HostGroupItem | undefined): boolean {
  return !isLocalHost(item) && item?.paired !== true && item?.discovered === true;
}

function canManageHost(item: HostGroupItem | undefined): boolean {
  return !isLocalHost(item) && item?.paired === true;
}

export function canRenameWorkspace(
  item: WorkspaceSidebarItem | undefined,
): boolean {
  if (!item) return false;
  const pending = item.pendingState;
  return !pending || pending === "succeeded";
}

export function canRemoveWorkspace(
  item: WorkspaceSidebarItem | undefined,
): boolean {
  if (!item || item.isMain) return false;
  const pending = item.pendingState;
  return !pending || pending === "succeeded";
}

export interface SidebarMenuHandlers {
  // Project actions — clicking a row switches; menu only surfaces
  // verbs that aren't reachable from a plain click.
  createWorkspaceForContextProject: () => void;
  editContextProjectWorkspaceBase: () => void;
  submitContextProjectWorkspaceBase: (baseBranch: string) => void;
  sortContextProjectWorkspacesNewest: () => void;
  openContextProjectInFinder: () => void;
  copyContextProjectPath: () => void;
  renameContextProject: () => void;
  removeContextProject: () => void;
  // Host actions — row click selects the host; menu handles auth and
  // paired-host maintenance.
  pairContextRemoteHost: () => void;
  reconnectContextRemoteHost: () => void;
  renameContextRemoteHost: () => void;
  submitContextRemoteHostRename: (name: string) => void;
  confirmContextRemoteHostForget: () => void;
  forgetContextRemoteHost: () => void;
  // Workspace actions — same convention as projects: row click handles
  // activation/landing; menu omits a redundant "Switch to workspace".
  openContextWorkspaceInFinder: () => void;
  copyContextWorkspacePath: () => void;
  renameContextWorkspace: () => void;
  removeContextWorkspace: () => void;
  // Session + extension (unchanged)
  closeContextMenu: () => void;
  renameContextMobileDevice: () => void;
  confirmContextMobileDeviceUnpair: () => void;
  submitContextMobileDeviceRename: (name: string) => void;
  unpairContextMobileDevice: () => void;
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
          id: "create-workspace",
          label: "Create workspace…",
          onSelect: h.createWorkspaceForContextProject,
        },
        {
          id: "set-workspace-base",
          label: "Set workspace base…",
          keepOpenOnSelect: true,
          onSelect: h.editContextProjectWorkspaceBase,
        },
        {
          id: "sort-workspaces",
          label: "Sort workspaces newest first",
          disabled: !state.hasExtraWorkspaces,
          onSelect: h.sortContextProjectWorkspacesNewest,
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
        { type: "header", label: "Workspace base" },
        {
          type: "input",
          id: "workspace-base-input",
          label: "Base branch",
          defaultValue: state.baseBranch ?? DEFAULT_WORKSPACE_BASE_BRANCH,
          placeholder: DEFAULT_WORKSPACE_BASE_BRANCH,
          submitLabel: "Save",
          onSubmit: h.submitContextProjectWorkspaceBase,
        },
        {
          type: "note",
          label: "Blank or origin/main uses the default",
        },
      ];
    case "host": {
      const local = isLocalHost(state.host);
      const pairable = canPairHost(state.host);
      const manageable = canManageHost(state.host);
      if (local) {
        return [
          { type: "header", label: state.label },
          { type: "note", label: "This is the local host" },
        ];
      }
      return [
        {
          id: "pair-remote-host",
          label: "Pair host…",
          disabled: !pairable,
          onSelect: h.pairContextRemoteHost,
        },
        {
          id: "reconnect-remote-host",
          label: "Reconnect",
          disabled: !manageable,
          onSelect: h.reconnectContextRemoteHost,
        },
        {
          id: "rename-remote-host",
          label: "Rename host…",
          disabled: !manageable,
          keepOpenOnSelect: true,
          onSelect: h.renameContextRemoteHost,
        },
        { type: "separator" },
        {
          id: "forget-remote-host",
          label: "Forget host…",
          danger: true,
          disabled: !manageable,
          keepOpenOnSelect: true,
          onSelect: h.confirmContextRemoteHostForget,
        },
        pairable
          ? { type: "note", label: "Uses the pairing code shown on that host" }
          : { type: "note", label: "Pair before remote projects can load" },
      ];
    }
    case "host-rename":
      return [
        { type: "header", label: "Rename host" },
        {
          type: "input",
          id: "remote-host-name-input",
          label: "Host name",
          defaultValue: state.label,
          placeholder: "bender",
          submitLabel: "Rename",
          onSubmit: h.submitContextRemoteHostRename,
        },
      ];
    case "host-forget":
      return [
        { type: "header", label: "Forget host?" },
        {
          type: "note",
          label: "Removes this host's saved token. Pair again to reconnect.",
        },
        {
          id: "confirm-forget-remote-host",
          label: "Confirm forget",
          danger: true,
          onSelect: h.forgetContextRemoteHost,
        },
        {
          id: "cancel-forget-remote-host",
          label: "Cancel",
          onSelect: h.closeContextMenu,
        },
      ];
    case "workspace": {
      const isMain = state.workspace?.isMain === true;
      const canRemove = canRemoveWorkspace(state.workspace);
      return [
        {
          id: "open-finder",
          label: "Open in Finder",
          onSelect: h.openContextWorkspaceInFinder,
        },
        {
          id: "copy-path",
          label: "Copy path",
          onSelect: h.copyContextWorkspacePath,
        },
        {
          id: "rename-workspace",
          label: "Rename workspace…",
          disabled: !canRenameWorkspace(state.workspace),
          onSelect: h.renameContextWorkspace,
        },
        { type: "separator" },
        {
          id: "remove-workspace",
          label: "Remove workspace",
          danger: true,
          disabled: !canRemove,
          onSelect: h.removeContextWorkspace,
        },
        isMain
          ? { type: "note", label: "Can't remove the main workspace" }
          : { type: "note", label: "git worktree remove" },
      ];
    }
    case "mobile-device":
      return [
        {
          id: "rename-mobile-device",
          label: "Rename device…",
          keepOpenOnSelect: true,
          onSelect: h.renameContextMobileDevice,
        },
        { type: "separator" },
        {
          id: "unpair-mobile-device",
          label: "Unpair device…",
          danger: true,
          keepOpenOnSelect: true,
          onSelect: h.confirmContextMobileDeviceUnpair,
        },
        { type: "note", label: "Revokes this client's token" },
      ];
    case "mobile-device-rename":
      return [
        { type: "header", label: "Rename device" },
        {
          type: "input",
          id: "mobile-device-name-input",
          label: "Device name",
          defaultValue: state.label,
          placeholder: "iPhone",
          submitLabel: "Rename",
          onSubmit: h.submitContextMobileDeviceRename,
        },
      ];
    case "mobile-device-unpair":
      return [
        { type: "header", label: "Unpair device?" },
        {
          type: "note",
          label: "Revokes this client's token. The device must pair again.",
        },
        {
          id: "confirm-unpair-mobile-device",
          label: "Confirm unpair",
          danger: true,
          onSelect: h.unpairContextMobileDevice,
        },
        {
          id: "cancel-unpair-mobile-device",
          label: "Cancel",
          onSelect: h.closeContextMenu,
        },
      ];
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
