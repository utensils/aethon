/**
 * FileTreePanel — sidebar section that browses the active project's
 * working directory tree and opens files in editor tabs.
 *
 * Design:
 *
 *   - Lazy: a folder's children are only fetched the first time the user
 *     expands it. The render is a flat list of currently-visible nodes
 *     (recursive flattening from the in-memory tree) so the DOM stays
 *     small even on huge repos.
 *   - State-local: expand-state lives in this component and is persisted
 *     to `~/.aethon/file-tree.json` per-project so reopening Aethon
 *     restores the prior view.
 *   - Single-click on a file fires a `file-tree-open` event with the
 *     absolute file path. The eventRoutes/editor handler opens (or
 *     focuses) an editor tab for that path.
 *   - Right-click is reserved for the context menu landed in phase 5.
 *
 * Why not lean on the existing Sidebar section system: the sidebar's
 * flat-item model can't express hierarchy + expand/collapse + lazy
 * loading without contorting `SidebarItem`. A dedicated composite is
 * smaller surface and easier to swap out via `aethon.registerComponent`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readState, writeState } from "../../../persist";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";

interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
}

/** A node in the in-memory tree. `children` is undefined until the
 *  folder has been loaded; null means "load attempted, no children". */
interface TreeNode {
  entry: FsEntry;
  depth: number;
  children?: TreeNode[] | null;
  loading?: boolean;
  loadError?: string;
}

/** Persisted expand-state. Each project keeps its own set of expanded
 *  absolute paths so reopening lands on the prior view. Capped per
 *  project to bound the persisted file's size. */
interface ExpandedStore {
  byProject: Record<string, string[]>;
}

const EXPAND_STATE_FILE = "file-tree.json";
const EXPANDED_CAP_PER_PROJECT = 200;

/** Parse the persisted store; tolerate corruption by returning empty. */
function parseExpandedStore(raw: string): ExpandedStore {
  if (!raw) return { byProject: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "byProject" in parsed &&
      typeof (parsed as { byProject: unknown }).byProject === "object"
    ) {
      const map = (parsed as { byProject: Record<string, unknown> }).byProject;
      const cleaned: Record<string, string[]> = {};
      for (const [projectPath, list] of Object.entries(map)) {
        if (Array.isArray(list)) {
          cleaned[projectPath] = list.filter(
            (p): p is string => typeof p === "string",
          );
        }
      }
      return { byProject: cleaned };
    }
  } catch {
    /* fall through */
  }
  return { byProject: {} };
}

interface ProjectShape {
  path?: string;
  name?: string;
}

export function FileTreePanel({ component, state, onEvent }: BuiltinComponentProps) {
  void component;
  const project = state["project"] as ProjectShape | undefined;
  const projectPath = project?.path ?? "";

  // Root node represents the project's working directory. Children are
  // loaded eagerly on mount; switching projects swaps roots.
  const [root, setRoot] = useState<TreeNode | null>(null);
  // Set of expanded absolute paths. Driving render, mirror-saved to disk.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>("");
  const expandedStoreRef = useRef<ExpandedStore>({ byProject: {} });
  const projectPathRef = useRef<string>(projectPath);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  // Hydrate the persisted expand-state once on mount. Tauri's read_state
  // returns "" when the file doesn't exist (clean first-run).
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

  // Schedule a debounced persist whenever the active project's expand
  // set changes. Debounce avoids hammering disk during rapid expand/collapse.
  const schedulePersist = useCallback((next: Set<string>) => {
    if (!projectPathRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const list = [...next].slice(0, EXPANDED_CAP_PER_PROJECT);
      expandedStoreRef.current.byProject[projectPathRef.current] = list;
      void writeState(
        EXPAND_STATE_FILE,
        JSON.stringify(expandedStoreRef.current),
      );
    }, 250);
  }, []);

  // Fetch the root directory listing whenever the active project changes.
  useEffect(() => {
    setRoot(null);
    setError("");
    if (!projectPath) return;
    let cancelled = false;
    void invoke<FsEntry[]>("fs_list_dir", {
      root: projectPath,
      path: projectPath,
    })
      .then((entries) => {
        if (cancelled) return;
        const rootNode: TreeNode = {
          entry: {
            name: project?.name ?? projectPath.split("/").filter(Boolean).pop() ?? projectPath,
            path: projectPath,
            kind: "dir",
          },
          depth: 0,
          children: entries.map((e) => ({ entry: e, depth: 1 })),
        };
        setRoot(rootNode);
        // Restore prior expand state for this project (already in `expanded`
        // from the hydrate effect). Walk through the expanded set and trigger
        // a fetch for each open folder.
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, project?.name]);

  // Load a folder's children on demand. No-op if already loaded.
  const loadFolderChildren = useCallback(
    async (node: TreeNode): Promise<TreeNode[] | null> => {
      if (!projectPathRef.current) return null;
      try {
        const entries = await invoke<FsEntry[]>("fs_list_dir", {
          root: projectPathRef.current,
          path: node.entry.path,
        });
        return entries.map((e) => ({ entry: e, depth: node.depth + 1 }));
      } catch (err) {
        node.loadError = String(err);
        return null;
      }
    },
    [],
  );

  // Toggle expand/collapse. Loading is fire-and-forget — the click
  // returns immediately and the tree re-renders when children arrive.
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
            // Trigger lazy load. Mutating the existing root in place is
            // fine here because the new Set() above is what React reacts
            // to; the tree mutation just amends the in-memory cache.
            node.loading = true;
            void loadFolderChildren(node).then((kids) => {
              node.children = kids;
              node.loading = false;
              // Bump the root reference so React notices the mutation.
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

  // Flatten the tree into a render list of currently-visible nodes.
  const visibleNodes = useMemo(() => {
    if (!root) return [];
    const out: TreeNode[] = [];
    const walk = (node: TreeNode) => {
      out.push(node);
      if (node.entry.kind !== "dir") return;
      if (!expanded.has(node.entry.path)) return;
      if (!node.children) return;
      for (const child of node.children) walk(child);
    };
    if (root.children) {
      for (const child of root.children) walk(child);
    }
    return out;
  }, [root, expanded]);

  const onItemClick = (node: TreeNode) => {
    if (node.entry.kind === "dir") {
      toggleFolder(node);
      return;
    }
    onEvent("file-tree-open", { filePath: node.entry.path });
  };

  if (!projectPath) {
    return (
      <div className="ae-file-tree ae-file-tree-empty">
        <div className="a2ui-sidebar-empty">no project</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="ae-file-tree">
        <div className="ae-file-tree-error">{error}</div>
      </div>
    );
  }
  if (!root) {
    return (
      <div className="ae-file-tree">
        <div className="a2ui-sidebar-empty">loading…</div>
      </div>
    );
  }
  return (
    <div className="ae-file-tree" role="tree" aria-label="Project files">
      <div className="ae-file-tree-title">files</div>
      <ul className="ae-file-tree-list">
        {visibleNodes.map((node) => (
          <FileTreeRow
            key={node.entry.path}
            node={node}
            expanded={expanded.has(node.entry.path)}
            onClick={() => onItemClick(node)}
          />
        ))}
      </ul>
    </div>
  );
}

interface FileTreeRowProps {
  node: TreeNode;
  expanded: boolean;
  onClick: () => void;
}

function FileTreeRow({ node, expanded, onClick }: FileTreeRowProps) {
  const indent = (node.depth - 1) * 12;
  const isDir = node.entry.kind === "dir";
  const icon = isDir ? (expanded ? "▾" : "▸") : "  ";
  return (
    <li
      role="treeitem"
      aria-level={node.depth}
      aria-expanded={isDir ? expanded : undefined}
      className={`ae-file-tree-row ${isDir ? "is-dir" : "is-file"}`}
      style={{ paddingLeft: indent }}
      onClick={onClick}
      title={node.entry.path}
    >
      <span className="ae-file-tree-icon" aria-hidden="true">{icon}</span>
      <span className="ae-file-tree-label">{node.entry.name}</span>
      {node.loading && <span className="ae-file-tree-loading" aria-hidden="true">…</span>}
    </li>
  );
}
