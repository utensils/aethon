import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ContextMenuItem } from "../../../components/primitives/context-menu";
import {
  parentDirOf,
  type ContextMenuState,
  type TreeNode,
} from "./fileTreeModel";

interface UseFileTreeActionsArgs {
  onEvent: (eventType: string, payload?: unknown) => void;
  projectPath: string;
  projectPathRef: RefObject<string>;
  refreshFolder: (folderPath: string) => Promise<void>;
  expandAll: (startPath?: string) => void;
  collapseUnder: (path: string) => void;
}

function useFileTreeActions({
  onEvent,
  projectPath,
  projectPathRef,
  refreshFolder,
  expandAll,
  collapseUnder,
}: UseFileTreeActionsArgs) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingTarget, setRenamingTarget] = useState<{
    rootPath: string;
    node: TreeNode;
  } | null>(null);
  const activeContextMenu =
    contextMenu?.rootPath === projectPath ? contextMenu : null;
  const activeRenamingNode =
    renamingTarget?.rootPath === projectPath ? renamingTarget.node : null;
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const openContextMenu = useCallback(
    (e: MouseEvent, node: TreeNode) => {
      e.preventDefault();
      e.stopPropagation();
      // Raw client coords; the ContextMenu primitive clamps + corrects
      // for WebKit zoom-frame drift before positioning.
      setContextMenu({
        rootPath: projectPath,
        x: e.clientX,
        y: e.clientY,
        node,
      });
    },
    [projectPath],
  );

  // Create a file/folder under `parentPath`, prompting for the name. Shared by
  // the right-click menu (anchored at the clicked node) and the header toolbar
  // icons (anchored at the project root).
  const createEntry = useCallback(
    async (parentPath: string, kind: "file" | "dir") => {
      const label = kind === "file" ? "file" : "folder";
      const name = window.prompt(`New ${label} name`);
      if (!name) return;
      const target = `${parentPath.replace(/\/$/, "")}/${name}`;
      try {
        await invoke(kind === "file" ? "fs_create_file" : "fs_create_dir", {
          root: projectPathRef.current,
          path: target,
        });
        await refreshFolder(parentPath);
        if (kind === "file") {
          onEvent("file-tree-open", {
            filePath: target,
            rootPath: projectPathRef.current,
          });
        }
      } catch (err) {
        window.alert(`Failed to create ${label}: ${String(err)}`);
      }
    },
    [onEvent, projectPathRef, refreshFolder],
  );

  const onContextNewFile = useCallback(async () => {
    if (!activeContextMenu) return;
    const parentPath = parentDirOf(activeContextMenu.node);
    closeContextMenu();
    await createEntry(parentPath, "file");
  }, [activeContextMenu, closeContextMenu, createEntry]);

  const onContextNewFolder = useCallback(async () => {
    if (!activeContextMenu) return;
    const parentPath = parentDirOf(activeContextMenu.node);
    closeContextMenu();
    await createEntry(parentPath, "dir");
  }, [activeContextMenu, closeContextMenu, createEntry]);

  const onContextRename = useCallback(() => {
    if (!activeContextMenu) return;
    setRenamingTarget({
      rootPath: activeContextMenu.rootPath,
      node: activeContextMenu.node,
    });
    closeContextMenu();
  }, [activeContextMenu, closeContextMenu]);

  const cancelRename = useCallback(() => {
    setRenamingTarget(null);
  }, []);

  const commitRename = useCallback(
    async (node: TreeNode, name: string) => {
      setRenamingTarget(null);
      if (!name.trim() || name === node.entry.name) return;
      const dirIdx = Math.max(
        node.entry.path.lastIndexOf("/"),
        node.entry.path.lastIndexOf("\\"),
      );
      const parentPath =
        dirIdx >= 0 ? node.entry.path.slice(0, dirIdx) : node.entry.path;
      const separator =
        node.entry.path.lastIndexOf("\\") > node.entry.path.lastIndexOf("/")
          ? "\\"
          : "/";
      const target = parentPath ? `${parentPath}${separator}${name}` : name;
      try {
        await invoke("fs_rename", {
          root: projectPathRef.current,
          from: node.entry.path,
          to: target,
        });
        onEvent("file-tree-rename", {
          from: node.entry.path,
          to: target,
          kind: node.entry.kind,
        });
        await refreshFolder(parentPath);
      } catch (err) {
        window.alert(`Rename failed: ${String(err)}`);
      }
    },
    [onEvent, projectPathRef, refreshFolder],
  );

  const onContextDelete = useCallback(async () => {
    if (!activeContextMenu) return;
    const node = activeContextMenu.node;
    closeContextMenu();
    if (!window.confirm(`Move "${node.entry.name}" to the trash?`)) return;
    const dirIdx = Math.max(
      node.entry.path.lastIndexOf("/"),
      node.entry.path.lastIndexOf("\\"),
    );
    const parentPath =
      dirIdx >= 0 ? node.entry.path.slice(0, dirIdx) : node.entry.path;
    try {
      await invoke("fs_delete", {
        root: projectPathRef.current,
        path: node.entry.path,
      });
      onEvent("file-tree-delete", {
        path: node.entry.path,
        kind: node.entry.kind,
      });
      await refreshFolder(parentPath);
    } catch (err) {
      window.alert(`Delete failed: ${String(err)}`);
    }
  }, [
    activeContextMenu,
    closeContextMenu,
    onEvent,
    projectPathRef,
    refreshFolder,
  ]);

  const onContextCopyPath = useCallback(async () => {
    if (!activeContextMenu) return;
    const path = activeContextMenu.node.entry.path;
    closeContextMenu();
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      window.alert(path);
    }
  }, [activeContextMenu, closeContextMenu]);

  const onContextCopyRelativePath = useCallback(async () => {
    if (!activeContextMenu) return;
    const root = projectPathRef.current.replace(/\/+$/, "");
    const path = activeContextMenu.node.entry.path;
    const rel = path.startsWith(root + "/")
      ? path.slice(root.length + 1)
      : path;
    closeContextMenu();
    try {
      await navigator.clipboard.writeText(rel);
    } catch {
      window.alert(rel);
    }
  }, [activeContextMenu, closeContextMenu, projectPathRef]);

  const onContextRevealInFinder = useCallback(async () => {
    if (!activeContextMenu) return;
    const path = activeContextMenu.node.entry.path;
    closeContextMenu();
    try {
      await invoke("fs_reveal_in_file_manager", {
        root: projectPath,
        path,
      });
    } catch (err) {
      window.alert(`Reveal failed: ${String(err)}`);
    }
  }, [activeContextMenu, closeContextMenu, projectPath]);

  const onContextOpenWithDefault = useCallback(async () => {
    if (!activeContextMenu) return;
    const path = activeContextMenu.node.entry.path;
    closeContextMenu();
    try {
      await invoke("fs_open_in_default_app", {
        root: projectPath,
        path,
      });
    } catch (err) {
      window.alert(`Open failed: ${String(err)}`);
    }
  }, [activeContextMenu, closeContextMenu, projectPath]);

  const onContextExpandAll = useCallback(() => {
    const node = activeContextMenu?.node;
    closeContextMenu();
    if (node) expandAll(node.entry.path);
  }, [activeContextMenu, closeContextMenu, expandAll]);

  const onContextCollapse = useCallback(() => {
    const node = activeContextMenu?.node;
    closeContextMenu();
    if (node) collapseUnder(node.entry.path);
  }, [activeContextMenu, closeContextMenu, collapseUnder]);

  const fileTreeMenuItems: ContextMenuItem[] = useMemo(
    () =>
      activeContextMenu
        ? [
            ...(activeContextMenu.node.entry.kind === "dir"
              ? ([
                  {
                    id: "expand-all",
                    label: "Expand All",
                    onSelect: onContextExpandAll,
                  },
                  {
                    id: "collapse-all",
                    label: "Collapse",
                    onSelect: onContextCollapse,
                  },
                  { type: "separator" },
                ] satisfies ContextMenuItem[])
              : []),
            {
              id: "new-file",
              label: "New File…",
              onSelect: onContextNewFile,
            },
            {
              id: "new-folder",
              label: "New Folder…",
              onSelect: onContextNewFolder,
            },
            { type: "separator" },
            {
              id: "reveal-in-finder",
              label: "Reveal in File Manager",
              onSelect: onContextRevealInFinder,
            },
            {
              id: "open-with-default",
              label: "Open with default app",
              disabled: activeContextMenu.node.entry.kind !== "file",
              onSelect: onContextOpenWithDefault,
            },
            { type: "separator" },
            { id: "rename", label: "Rename…", onSelect: onContextRename },
            {
              id: "delete",
              label: "Move to Trash…",
              danger: true,
              onSelect: onContextDelete,
            },
            { type: "separator" },
            {
              id: "copy-path",
              label: "Copy Path",
              onSelect: onContextCopyPath,
            },
            {
              id: "copy-rel",
              label: "Copy Relative Path",
              onSelect: onContextCopyRelativePath,
            },
          ]
        : [],
    [
      activeContextMenu,
      onContextCollapse,
      onContextCopyPath,
      onContextCopyRelativePath,
      onContextDelete,
      onContextExpandAll,
      onContextNewFile,
      onContextNewFolder,
      onContextOpenWithDefault,
      onContextRename,
      onContextRevealInFinder,
    ],
  );

  return {
    cancelRename,
    commitRename,
    contextMenu: activeContextMenu,
    createEntry,
    fileTreeMenuItems,
    openContextMenu,
    renamingPath: activeRenamingNode?.entry.path ?? null,
    setContextMenu,
  };
}

export { useFileTreeActions };
