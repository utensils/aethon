import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { readState, writeState } from "../../../persist";
import {
  EXPANDED_CAP_PER_PROJECT,
  EXPAND_STATE_FILE,
  deletedChildrenByParentFromStatuses,
  gitDecorationsFromStatuses,
  gitStatusesFromEntries,
  nodesFromEntries,
  parseExpandedStore,
  visibleTreeNodes,
  watchedDirsFor,
  type ExpandedStore,
  type FsEntry,
  type GitFileStatusEntry,
  type TreeNode,
} from "./fileTreeModel";

interface UseFileTreeDataArgs {
  hidden: boolean;
  projectPath: string;
  rootLabel: string;
}

function useFileTreeData({
  hidden,
  projectPath,
  rootLabel,
}: UseFileTreeDataArgs) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [gitStatuses, setGitStatuses] = useState<
    Map<string, GitFileStatusEntry>
  >(new Map());
  const [error, setError] = useState<string>("");
  const expandedStoreRef = useRef<ExpandedStore>({ byProject: {} });
  const projectPathRef = useRef<string>(projectPath);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitStatusRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    void readState(EXPAND_STATE_FILE).then((raw) => {
      if (cancelled) return;
      const parsed = parseExpandedStore(raw);
      expandedStoreRef.current = parsed;
      if (projectPathRef.current) {
        const prior = parsed.byProject[projectPathRef.current];
        if (prior?.length) setExpanded(new Set(prior));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  const schedulePersist = useCallback((next: Set<string>) => {
    const projectKey = projectPathRef.current;
    if (!projectKey) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const list = [...next].slice(0, EXPANDED_CAP_PER_PROJECT);
      expandedStoreRef.current.byProject[projectKey] = list;
      void writeState(
        EXPAND_STATE_FILE,
        JSON.stringify(expandedStoreRef.current),
      );
    }, 250);
  }, []);

  const refreshGitStatuses = useCallback(async (rootPath: string) => {
    if (!rootPath) {
      setGitStatuses(new Map());
      return;
    }
    try {
      const entries = await invoke<GitFileStatusEntry[] | null>(
        "git_file_status",
        { root: rootPath },
      );
      if (projectPathRef.current !== rootPath) return;
      setGitStatuses(gitStatusesFromEntries(entries));
    } catch {
      // Non-git directories, missing git binary, or transient status errors
      // should never block the file tree; just render without decorations.
      if (projectPathRef.current === rootPath) setGitStatuses(new Map());
    }
  }, []);

  const scheduleGitStatusRefresh = useCallback(
    (rootPath = projectPathRef.current) => {
      if (gitStatusRefreshTimerRef.current) {
        clearTimeout(gitStatusRefreshTimerRef.current);
      }
      gitStatusRefreshTimerRef.current = setTimeout(() => {
        gitStatusRefreshTimerRef.current = null;
        void refreshGitStatuses(rootPath);
      }, 180);
    },
    [refreshGitStatuses],
  );

  // Fetch the root directory listing whenever the active project changes.
  useEffect(() => {
    if (gitStatusRefreshTimerRef.current) {
      clearTimeout(gitStatusRefreshTimerRef.current);
      gitStatusRefreshTimerRef.current = null;
    }
    // Reset the previous project's tree synchronously so stale rows never
    // render under the new root while the async listing loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoot(null);
    setGitStatuses(new Map());
    setError("");
    setExpanded(new Set(expandedStoreRef.current.byProject[projectPath] ?? []));
    if (!projectPath) return;
    let cancelled = false;
    void invoke<FsEntry[]>("fs_list_dir", {
      root: projectPath,
      path: projectPath,
    })
      .then(async (entries) => {
        if (cancelled) return;
        const rootNode: TreeNode = {
          entry: {
            name: rootLabel,
            path: projectPath,
            kind: "dir",
          },
          depth: 0,
          children: nodesFromEntries(entries, 1),
        };
        setRoot(rootNode);
        void refreshGitStatuses(projectPath);

        const expandedNow =
          expandedStoreRef.current.byProject[projectPath] ?? [];
        if (expandedNow.length === 0) return;
        const ordered = [...expandedNow].sort((a, b) => a.length - b.length);
        for (const folderPath of ordered) {
          if (cancelled) return;
          try {
            const childEntries = await invoke<FsEntry[]>("fs_list_dir", {
              root: projectPath,
              path: folderPath,
            });
            if (cancelled) return;
            setRoot((r) => {
              if (!r) return r;
              const walk = (node: TreeNode): TreeNode => {
                if (node.entry.path === folderPath) {
                  return {
                    ...node,
                    children: nodesFromEntries(
                      childEntries,
                      node.depth + 1,
                      node.children,
                    ),
                  };
                }
                if (!node.children) return node;
                return { ...node, children: node.children.map(walk) };
              };
              return { ...r, children: r.children?.map(walk) ?? undefined };
            });
          } catch {
            // Folder may have been deleted since last persist; skip it
            // silently — the user can re-expand if they want.
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, refreshGitStatuses, rootLabel]);

  const loadFolderChildren = useCallback(
    async (node: TreeNode): Promise<TreeNode[] | null> => {
      if (!projectPathRef.current) return null;
      try {
        const entries = await invoke<FsEntry[]>("fs_list_dir", {
          root: projectPathRef.current,
          path: node.entry.path,
        });
        return nodesFromEntries(entries, node.depth + 1, node.children);
      } catch (err) {
        node.loadError = String(err);
        return null;
      }
    },
    [],
  );

  const toggleFolder = useCallback(
    (node: TreeNode) => {
      const path = node.entry.path;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (node.children === undefined) {
            node.loading = true;
            void loadFolderChildren(node).then((kids) => {
              node.children = kids;
              node.loading = false;
              setRoot((r) => (r ? { ...r } : r));
            });
          }
        }
        schedulePersist(next);
        return next;
      });
    },
    [loadFolderChildren, schedulePersist],
  );

  const gitDecorations = useMemo(
    () => gitDecorationsFromStatuses(gitStatuses),
    [gitStatuses],
  );

  const deletedChildrenByParent = useMemo(
    () => deletedChildrenByParentFromStatuses(gitStatuses, projectPath),
    [gitStatuses, projectPath],
  );

  const visibleNodes = useMemo(
    () =>
      visibleTreeNodes({
        deletedChildrenByParent,
        expanded,
        projectPath,
        root,
      }),
    [deletedChildrenByParent, expanded, projectPath, root],
  );

  const watchedDirs = useMemo(
    () => watchedDirsFor({ expanded, hidden, projectPath }),
    [expanded, hidden, projectPath],
  );

  const invalidateFolder = useCallback((folderPath: string) => {
    setRoot((r) => {
      if (!r) return r;
      const next = { ...r };
      const walk = (node: TreeNode): TreeNode => {
        if (node.entry.path === folderPath) {
          return { ...node, children: undefined };
        }
        if (!node.children) return node;
        return {
          ...node,
          children: node.children.map(walk),
        };
      };
      next.children = next.children?.map(walk);
      return next;
    });
  }, []);

  const refreshFolder = useCallback(
    async (folderPath: string) => {
      if (!projectPathRef.current) return;
      try {
        const entries = await invoke<FsEntry[]>("fs_list_dir", {
          root: projectPathRef.current,
          path: folderPath,
        });
        setRoot((r) => {
          if (!r) return r;
          if (r.entry.path === folderPath) {
            return {
              ...r,
              children: nodesFromEntries(entries, 1, r.children),
            };
          }
          const walk = (node: TreeNode): TreeNode => {
            if (node.entry.path === folderPath) {
              return {
                ...node,
                children: nodesFromEntries(
                  entries,
                  node.depth + 1,
                  node.children,
                ),
              };
            }
            if (!node.children) return node;
            return { ...node, children: node.children.map(walk) };
          };
          return { ...r, children: r.children?.map(walk) ?? undefined };
        });
        scheduleGitStatusRefresh();
      } catch {
        invalidateFolder(folderPath);
        scheduleGitStatusRefresh();
      }
    },
    [invalidateFolder, scheduleGitStatusRefresh],
  );

  useEffect(() => {
    return () => {
      if (gitStatusRefreshTimerRef.current) {
        clearTimeout(gitStatusRefreshTimerRef.current);
      }
    };
  }, []);

  return {
    error,
    expanded,
    gitDecorations,
    projectPathRef,
    refreshFolder,
    root,
    toggleFolder,
    visibleNodes,
    watchedDirs,
  };
}

export { useFileTreeData };
