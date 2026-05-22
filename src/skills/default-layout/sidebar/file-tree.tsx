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
import {
  ContextMenu,
  type ContextMenuItem,
} from "../../../components/primitives/context-menu";
import { FileIcon } from "../../../components/file-icon";
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

/** Return the directory of `node`'s entry: the node itself when it's a
 *  folder, the containing folder when it's a file. Used by the
 *  context menu's New File / New Folder actions to anchor at the
 *  right location regardless of which row the user right-clicked. */
function parentDirOf(node: TreeNode): string {
  if (node.entry.kind === "dir") return node.entry.path;
  const slash = Math.max(
    node.entry.path.lastIndexOf("/"),
    node.entry.path.lastIndexOf("\\"),
  );
  return slash >= 0 ? node.entry.path.slice(0, slash) : node.entry.path;
}

/** Parse the persisted store; tolerate corruption by returning empty. */
function parseExpandedStore(raw: string): ExpandedStore {
  if (!raw) return { byProject: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "byProject" in parsed &&
      typeof parsed.byProject === "object"
    ) {
      const map = parsed.byProject as Record<string, unknown>;
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

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNode;
}

const PANEL_PREFS_FILE = "file-tree-prefs.json";
const PANEL_HEIGHT_DEFAULT = 280;
const PANEL_HEIGHT_MIN = 120;
const PANEL_HEIGHT_MAX = 1200;

interface PanelPrefs {
  collapsed?: boolean;
  hidden?: boolean;
  height?: number;
}

function readPanelPrefs(raw: string): PanelPrefs {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return v as PanelPrefs;
  } catch {
    /* fall through */
  }
  return {};
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
  // Panel chrome state — collapsed header (just shows the "files" row,
  // hides the tree), hidden entirely (panel offscreen), and the panel
  // height when expanded (drag handle resizes; clamped to a sensible
  // range so it can't squeeze the rest of the sidebar). Persisted to
  // ~/.aethon/file-tree-prefs.json.
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [hidden, setHidden] = useState<boolean>(false);
  const [height, setHeight] = useState<number>(PANEL_HEIGHT_DEFAULT);
  const prefsHydrated = useRef<boolean>(false);
  const prefsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
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
    void readState(PANEL_PREFS_FILE).then((raw) => {
      if (cancelled) return;
      const prefs = readPanelPrefs(raw);
      if (typeof prefs.collapsed === "boolean") setCollapsed(prefs.collapsed);
      if (typeof prefs.hidden === "boolean") setHidden(prefs.hidden);
      if (
        typeof prefs.height === "number" &&
        prefs.height >= PANEL_HEIGHT_MIN &&
        prefs.height <= PANEL_HEIGHT_MAX
      ) {
        setHeight(prefs.height);
      }
      prefsHydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist panel prefs (collapsed / hidden / height) whenever they
  // change after the initial hydrate. Debounced because the drag
  // handle fires height updates on every mousemove.
  useEffect(() => {
    if (!prefsHydrated.current) return;
    if (prefsSaveTimerRef.current) clearTimeout(prefsSaveTimerRef.current);
    prefsSaveTimerRef.current = setTimeout(() => {
      void writeState(
        PANEL_PREFS_FILE,
        JSON.stringify({ collapsed, hidden, height }),
      );
    }, 200);
  }, [collapsed, hidden, height]);

  // Listen for the global `aethon:toggle-file-tree` event so the panels
  // sidebar item / a future keybinding can hide-and-show the panel from
  // the outside without prop drilling.
  useEffect(() => {
    const toggle = () => setHidden((h) => !h);
    window.addEventListener("aethon:toggle-file-tree", toggle);
    return () => window.removeEventListener("aethon:toggle-file-tree", toggle);
  }, []);

  // Schedule a debounced persist whenever the active project's expand
  // set changes. Debounce avoids hammering disk during rapid expand/collapse.
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

  // Fetch the root directory listing whenever the active project changes.
  // The two synchronous setState calls here are intentional: they reset
  // local in-effect state (last project's tree + error) before kicking
  // off the async fetch for the new root. Splitting into a derived-from-
  // props pattern would force a re-render dance every time the user
  // expands a folder elsewhere.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoot(null);
    setError("");
    // Reset the expanded set to the new project's persisted entries
    // (or empty when this is the first time the user has opened it).
    // Without this, switching projects would carry the previous
    // project's expanded paths over — collapsed visually in the tree
    // but still present in the set, so the next toggle would write
    // them back into the wrong project's persist slot.
    setExpanded(
      new Set(expandedStoreRef.current.byProject[projectPath] ?? []),
    );
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
            name: project?.name ?? projectPath.split("/").filter(Boolean).pop() ?? projectPath,
            path: projectPath,
            kind: "dir",
          },
          depth: 0,
          children: entries.map((e) => ({ entry: e, depth: 1 })),
        };
        setRoot(rootNode);
        // Hydrate any persisted-expanded folders so the user comes back
        // to the same view they left. We fetch from the outside in
        // (shorter paths first) so a parent's children land before its
        // descendants get their refreshFolder call. Capped against the
        // currently-known set so we don't try to load arbitrary paths
        // that no longer exist.
        const expandedNow = expandedStoreRef.current.byProject[projectPath] ?? [];
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
                    children: childEntries.map((e) => ({
                      entry: e,
                      depth: node.depth + 1,
                    })),
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

  const onRowContextMenu = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    // Raw client coords; the ContextMenu primitive clamps + corrects
    // for WebKit zoom-frame drift before positioning.
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  // Pop a folder out of the tree's children cache so the next expand
  // re-fetches it. Used after create/rename/delete so the tree reflects
  // the new state without a full reload.
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

  // Re-fetch a folder's children inline (used after operations land —
  // skips collapse+expand UX and just updates the visible tree).
  // Handles the root case: when `folderPath === root.entry.path`, the
  // walk's mapper would never see the root itself (it only iterates
  // `r.children`). We special-case at the top so create/rename/delete
  // on root-level items still refreshes the listing.
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
          // Root case: replace the root's children directly.
          if (r.entry.path === folderPath) {
            return {
              ...r,
              children: entries.map((e) => ({ entry: e, depth: 1 })),
            };
          }
          const walk = (node: TreeNode): TreeNode => {
            if (node.entry.path === folderPath) {
              return {
                ...node,
                children: entries.map((e) => ({
                  entry: e,
                  depth: node.depth + 1,
                })),
              };
            }
            if (!node.children) return node;
            return { ...node, children: node.children.map(walk) };
          };
          return { ...r, children: r.children?.map(walk) ?? undefined };
        });
      } catch {
        invalidateFolder(folderPath);
      }
    },
    [invalidateFolder],
  );

  const closeContextMenu = () => setContextMenu(null);

  const onContextNewFile = async () => {
    if (!contextMenu) return;
    const parentPath = parentDirOf(contextMenu.node);
    closeContextMenu();
    const name = window.prompt("New file name");
    if (!name) return;
    const target = `${parentPath.replace(/\/$/, "")}/${name}`;
    try {
      await invoke("fs_create_file", {
        root: projectPathRef.current,
        path: target,
      });
      await refreshFolder(parentPath);
      onEvent("file-tree-open", { filePath: target });
    } catch (err) {
      window.alert(`Failed to create file: ${String(err)}`);
    }
  };

  const onContextNewFolder = async () => {
    if (!contextMenu) return;
    const parentPath = parentDirOf(contextMenu.node);
    closeContextMenu();
    const name = window.prompt("New folder name");
    if (!name) return;
    const target = `${parentPath.replace(/\/$/, "")}/${name}`;
    try {
      await invoke("fs_create_dir", {
        root: projectPathRef.current,
        path: target,
      });
      await refreshFolder(parentPath);
    } catch (err) {
      window.alert(`Failed to create folder: ${String(err)}`);
    }
  };

  const onContextRename = async () => {
    if (!contextMenu) return;
    const node = contextMenu.node;
    closeContextMenu();
    const name = window.prompt("Rename to", node.entry.name);
    if (!name || name === node.entry.name) return;
    const dirIdx = Math.max(
      node.entry.path.lastIndexOf("/"),
      node.entry.path.lastIndexOf("\\"),
    );
    const parentPath = dirIdx >= 0 ? node.entry.path.slice(0, dirIdx) : node.entry.path;
    const target = `${parentPath}/${name}`;
    try {
      await invoke("fs_rename", {
        root: projectPathRef.current,
        from: node.entry.path,
        to: target,
      });
      // Tell App-level routes about the rename so any open editor tab
      // backed by the old path (or any descendant when renaming a
      // folder) updates its filePath + label. Without this the next
      // Cmd+S on a renamed-file's editor tab would write to the
      // pre-rename location and resurrect the old file.
      onEvent("file-tree-rename", {
        from: node.entry.path,
        to: target,
        kind: node.entry.kind,
      });
      await refreshFolder(parentPath);
    } catch (err) {
      window.alert(`Rename failed: ${String(err)}`);
    }
  };

  const onContextDelete = async () => {
    if (!contextMenu) return;
    const node = contextMenu.node;
    closeContextMenu();
    if (!window.confirm(`Move "${node.entry.name}" to the trash?`)) return;
    const dirIdx = Math.max(
      node.entry.path.lastIndexOf("/"),
      node.entry.path.lastIndexOf("\\"),
    );
    const parentPath = dirIdx >= 0 ? node.entry.path.slice(0, dirIdx) : node.entry.path;
    try {
      await invoke("fs_delete", {
        root: projectPathRef.current,
        path: node.entry.path,
      });
      // Notify the App-level routes so any open editor tab backed by
      // the deleted path (or any descendant when deleting a folder)
      // closes and drops its Monaco buffer. Without this, Cmd+S on a
      // stale buffer would resurrect the trashed file.
      onEvent("file-tree-delete", {
        path: node.entry.path,
        kind: node.entry.kind,
      });
      await refreshFolder(parentPath);
    } catch (err) {
      window.alert(`Delete failed: ${String(err)}`);
    }
  };

  const onContextCopyPath = async () => {
    if (!contextMenu) return;
    const path = contextMenu.node.entry.path;
    closeContextMenu();
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      window.alert(path);
    }
  };

  const onContextCopyRelativePath = async () => {
    if (!contextMenu) return;
    const root = projectPathRef.current.replace(/\/+$/, "");
    const path = contextMenu.node.entry.path;
    const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    closeContextMenu();
    try {
      await navigator.clipboard.writeText(rel);
    } catch {
      window.alert(rel);
    }
  };

  const onContextRevealInFinder = async () => {
    if (!contextMenu) return;
    const path = contextMenu.node.entry.path;
    closeContextMenu();
    try {
      await invoke("fs_reveal_in_file_manager", { path });
    } catch (err) {
      window.alert(`Reveal failed: ${String(err)}`);
    }
  };

  const onContextOpenWithDefault = async () => {
    if (!contextMenu) return;
    const path = contextMenu.node.entry.path;
    closeContextMenu();
    try {
      await invoke("fs_open_in_default_app", { path });
    } catch (err) {
      window.alert(`Open failed: ${String(err)}`);
    }
  };

  if (hidden) {
    // Panel toggled off. Render nothing so the flex container collapses
    // and other sidebar sections claim the space. The toggle event
    // brings it back without losing collapsed/height prefs.
    return null;
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    document.body.classList.add("ae-resizing-sidebar");
    const onMove = (ev: MouseEvent) => {
      // Drag handle sits at the TOP of the panel — dragging UP grows
      // the panel (decreasing the panel's flex-basis is reversed
      // compared to a bottom handle).
      const dy = startY - ev.clientY;
      const next = Math.max(
        PANEL_HEIGHT_MIN,
        Math.min(PANEL_HEIGHT_MAX, Math.round(startHeight + dy)),
      );
      setHeight(next);
    };
    const onUp = () => {
      document.body.classList.remove("ae-resizing-sidebar");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Items array for the right-click menu. Memoizing on the contextMenu
  // identity is enough here — handlers reference state via closures and
  // close over a stable `contextMenu` per render, so changing the menu
  // target rebuilds the items, and `setContextMenu(null)` collapses
  // them to an empty list.
  const fileTreeMenuItems: ContextMenuItem[] = contextMenu
    ? [
        { id: "new-file", label: "New File…", onSelect: onContextNewFile },
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
          disabled: contextMenu.node.entry.kind !== "file",
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
        { id: "copy-path", label: "Copy Path", onSelect: onContextCopyPath },
        {
          id: "copy-rel",
          label: "Copy Relative Path",
          onSelect: onContextCopyRelativePath,
        },
      ]
    : [];

  const titleRow = (
    <div className="ae-file-tree-titlebar">
      <button
        type="button"
        className="ae-file-tree-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand files" : "Collapse files"}
        title={collapsed ? "Expand files" : "Collapse files"}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="ae-file-tree-chevron" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="ae-file-tree-title">files</span>
      </button>
      <button
        type="button"
        className="ae-file-tree-hide"
        aria-label="Hide files panel"
        title="Hide files panel"
        onClick={() => setHidden(true)}
      >
        ×
      </button>
    </div>
  );

  // Style honors the collapsed (just header) + resizable (height) state.
  const panelStyle: React.CSSProperties = collapsed
    ? { flex: "0 0 auto" }
    : { flex: `0 0 ${height}px` };

  if (!projectPath) {
    return (
      <div
        className={`ae-file-tree ae-file-tree-empty${collapsed ? " is-collapsed" : ""}`}
        style={panelStyle}
      >
        {!collapsed && (
          <div
            className="ae-file-tree-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize files panel"
            onMouseDown={startResize}
          />
        )}
        {titleRow}
        {!collapsed && (
          <div className="a2ui-sidebar-empty">no project</div>
        )}
      </div>
    );
  }
  if (error) {
    return (
      <div
        className={`ae-file-tree${collapsed ? " is-collapsed" : ""}`}
        style={panelStyle}
      >
        {!collapsed && (
          <div
            className="ae-file-tree-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize files panel"
            onMouseDown={startResize}
          />
        )}
        {titleRow}
        {!collapsed && <div className="ae-file-tree-error">{error}</div>}
      </div>
    );
  }
  if (!root) {
    return (
      <div
        className={`ae-file-tree${collapsed ? " is-collapsed" : ""}`}
        style={panelStyle}
      >
        {!collapsed && (
          <div
            className="ae-file-tree-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize files panel"
            onMouseDown={startResize}
          />
        )}
        {titleRow}
        {!collapsed && <div className="a2ui-sidebar-empty">loading…</div>}
      </div>
    );
  }
  return (
    <div
      className={`ae-file-tree${collapsed ? " is-collapsed" : ""}`}
      role="tree"
      aria-label="Project files"
      style={panelStyle}
    >
      {!collapsed && (
        <div
          className="ae-file-tree-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize files panel"
          onMouseDown={startResize}
        />
      )}
      {titleRow}
      {!collapsed && (
        <ul className="ae-file-tree-list">
          {visibleNodes.map((node) => (
            <FileTreeRow
              key={node.entry.path}
              node={node}
              expanded={expanded.has(node.entry.path)}
              onClick={() => onItemClick(node)}
              onContextMenu={(e) => onRowContextMenu(e, node)}
            />
          ))}
        </ul>
      )}
      <ContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={fileTreeMenuItems}
        onClose={() => setContextMenu(null)}
        ariaLabel="File operations"
        className="ae-file-tree-context-menu"
        estimatedWidth={240}
        estimatedHeight={260}
      />
    </div>
  );
}

interface FileTreeRowProps {
  node: TreeNode;
  expanded: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function FileTreeRow({ node, expanded, onClick, onContextMenu }: FileTreeRowProps) {
  const indent = (node.depth - 1) * 12;
  const isDir = node.entry.kind === "dir";
  return (
    <li
      role="treeitem"
      aria-level={node.depth}
      aria-expanded={isDir ? expanded : undefined}
      className={`ae-file-tree-row ${isDir ? "is-dir" : "is-file"}`}
      style={{ paddingLeft: indent }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={node.entry.path}
    >
      {isDir ? (
        <span
          className="ae-file-tree-chevron-row"
          aria-hidden="true"
        >
          {expanded ? "▾" : "▸"}
        </span>
      ) : (
        <span className="ae-file-tree-chevron-row ae-file-tree-chevron-spacer" />
      )}
      <FileIcon
        path={node.entry.path}
        isDir={isDir}
        open={isDir && expanded}
        className="ae-file-tree-icon"
      />
      <span className="ae-file-tree-label" data-selectable>
        {node.entry.name}
      </span>
      {node.loading && <span className="ae-file-tree-loading" aria-hidden="true">…</span>}
    </li>
  );
}
