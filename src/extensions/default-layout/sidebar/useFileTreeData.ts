import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { readState, writeState } from "../../../persist";
import {
  EXPANDED_CAP_PER_PROJECT,
  EXPAND_STATE_FILE,
  ancestorDirsFor,
  buildIgnoreMatcher,
  deletedChildrenByParentFromStatuses,
  gitDecorationsFromStatuses,
  gitStatusesFromEntries,
  graftChildren,
  nodesFromEntries,
  parseExpandedStore,
  relativePathFor,
  visibleTreeNodes,
  watchedDirsFor,
  type ExpandedStore,
  type FsEntry,
  type GitFileStatusEntry,
  type TreeNode,
} from "./fileTreeModel";

/** Bound expand-all so a deep / huge tree can't fan out into thousands of
 *  fs_list_dir calls. Mirrors the persisted-expand cap. */
const EXPAND_ALL_MAX_DEPTH = 8;

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
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const [gitStatuses, setGitStatuses] = useState<
    Map<string, GitFileStatusEntry>
  >(new Map());
  const [ignoredPaths, setIgnoredPaths] = useState<string[]>([]);
  const [error, setError] = useState<string>("");
  const expandedStoreRef = useRef<ExpandedStore>({ byProject: {} });
  const projectPathRef = useRef<string>(projectPath);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitStatusRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const expandAllInFlightRef = useRef(false);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  // Mirror `expanded` into a ref so the sub-tree expand/collapse callbacks can
  // read the current set without re-subscribing on every toggle.
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

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
      setIgnoredPaths([]);
      return;
    }
    try {
      // Decorations + ignored set are fetched together so a single refresh
      // tick repaints both. `git_ignored_paths` is `--directory`-collapsed,
      // so this stays cheap even on trees with a huge node_modules.
      const [entries, ignored] = await Promise.all([
        invoke<GitFileStatusEntry[] | null>("git_file_status", {
          root: rootPath,
        }),
        invoke<string[] | null>("git_ignored_paths", { root: rootPath }),
      ]);
      if (projectPathRef.current !== rootPath) return;
      setGitStatuses(gitStatusesFromEntries(entries));
      setIgnoredPaths(Array.isArray(ignored) ? ignored : []);
    } catch {
      // Non-git directories, missing git binary, or transient status errors
      // should never block the file tree; just render without decorations.
      if (projectPathRef.current === rootPath) {
        setGitStatuses(new Map());
        setIgnoredPaths([]);
      }
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
            setRoot((r) =>
              r ? graftChildren(r, folderPath, childEntries) : r,
            );
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

  const ignoreMatcher = useMemo(
    () => buildIgnoreMatcher(ignoredPaths),
    [ignoredPaths],
  );

  const collapseAll = useCallback(() => {
    const empty = new Set<string>();
    setExpanded(empty);
    schedulePersist(empty);
  }, [schedulePersist]);

  // Collapse a single directory's subtree: drop the dir and every descendant
  // from the expanded set, leaving the rest of the tree as-is.
  const collapseUnder = useCallback(
    (path: string) => {
      const next = new Set(
        [...expandedRef.current].filter(
          (p) =>
            p !== path &&
            !p.startsWith(`${path}/`) &&
            !p.startsWith(`${path}\\`),
        ),
      );
      setExpanded(next);
      schedulePersist(next);
    },
    [schedulePersist],
  );

  // Bounded breadth-first expand: load each non-ignored directory's listing,
  // skipping gitignored trees (no node_modules fan-out) and stopping at the
  // persist cap / max depth so a huge repo can't lock up the UI. Children are
  // grafted into the tree in BFS order so each level's nodes exist before we
  // graft into them. With `startPath`, expands only that subtree and keeps the
  // rest of the tree's expansion intact.
  const expandAll = useCallback(
    async (startPath?: string) => {
      const projectKey = projectPathRef.current;
      if (!projectKey || expandAllInFlightRef.current) return;
      expandAllInFlightRef.current = true;
      try {
        const base = startPath ?? projectKey;
        const expand = startPath
          ? new Set(expandedRef.current)
          : new Set<string>();
        const loaded: { path: string; entries: FsEntry[] }[] = [];
        let frontier: { path: string; depth: number }[] = [
          { path: base, depth: 0 },
        ];
        while (frontier.length > 0 && expand.size < EXPANDED_CAP_PER_PROJECT) {
          const next: { path: string; depth: number }[] = [];
          for (const { path, depth } of frontier) {
            if (expand.size >= EXPANDED_CAP_PER_PROJECT) break;
            if (projectPathRef.current !== projectKey) return;
            let entries: FsEntry[];
            try {
              entries = await invoke<FsEntry[]>("fs_list_dir", {
                root: projectKey,
                path,
              });
            } catch {
              continue;
            }
            loaded.push({ path, entries });
            // The project root is implicitly expanded; only sub-dirs (incl. a
            // sub-tree's own base) go in the set.
            if (path !== projectKey) expand.add(path);
            if (depth >= EXPAND_ALL_MAX_DEPTH) continue;
            for (const entry of entries) {
              if (entry.kind !== "dir") continue;
              const rel = relativePathFor(projectKey, entry.path);
              if (rel != null && ignoreMatcher.isIgnored(rel)) continue;
              next.push({ path: entry.path, depth: depth + 1 });
            }
          }
          frontier = next;
        }
        if (projectPathRef.current !== projectKey) return;
        setRoot((r) => {
          if (!r) return r;
          let acc = r;
          for (const { path, entries } of loaded) {
            acc = graftChildren(acc, path, entries);
          }
          return acc;
        });
        setExpanded(expand);
        schedulePersist(expand);
      } finally {
        expandAllInFlightRef.current = false;
      }
    },
    [ignoreMatcher, schedulePersist],
  );

  const clearRevealTarget = useCallback(() => setRevealTarget(null), []);

  // Reveal a file: load + graft + expand every ancestor directory, then
  // mark the leaf as the reveal target so the row scrolls into view and
  // flashes. Used by the editor menubar's "Reveal in Files Panel".
  const revealPath = useCallback(
    async (filePath: string) => {
      const projectKey = projectPathRef.current;
      if (!projectKey || !filePath) return;
      const ancestors = ancestorDirsFor(projectKey, filePath);
      const expandNext = new Set(expandedRef.current);
      for (const dir of ancestors) {
        try {
          const entries = await invoke<FsEntry[]>("fs_list_dir", {
            root: projectKey,
            path: dir,
          });
          if (projectPathRef.current !== projectKey) return;
          setRoot((r) => (r ? graftChildren(r, dir, entries) : r));
          expandNext.add(dir);
        } catch {
          // Ancestor vanished — stop descending; reveal what we can.
          break;
        }
      }
      if (projectPathRef.current !== projectKey) return;
      setExpanded(expandNext);
      schedulePersist(expandNext);
      setRevealTarget(filePath);
    },
    [schedulePersist],
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
    collapseAll,
    collapseUnder,
    error,
    expandAll,
    expanded,
    gitDecorations,
    ignoreMatcher,
    projectPathRef,
    refreshFolder,
    revealPath,
    revealTarget,
    clearRevealTarget,
    root,
    toggleFolder,
    visibleNodes,
    watchedDirs,
  };
}

export { useFileTreeData };
