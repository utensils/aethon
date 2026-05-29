/**
 * FileTreePanel — sidebar section that browses the active project's
 * working directory tree and opens files in editor tabs.
 *
 * The component is intentionally a thin render shell. Tree loading and
 * persistence live in useFileTreeData, file watching in useFileTreeWatch,
 * prefs in useFileTreePrefs, and context-menu operations in fileTreeActions.
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import { FileIcon } from "../../../components/file-icon";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { ContextMenu } from "../../../components/primitives/context-menu";
import { useFileTreeActions } from "./fileTreeActions";
import {
  GIT_STATUS_META,
  basename,
  relativePathFor,
  type EditorTabShape,
  type GitDecoration,
  type ProjectShape,
  type TreeNode,
} from "./fileTreeModel";
import { useFileTreeData } from "./useFileTreeData";
import {
  PANEL_HEIGHT_MAX,
  PANEL_HEIGHT_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useFileTreePrefs,
} from "./useFileTreePrefs";
import { useFileTreeWatch } from "./useFileTreeWatch";

export function FileTreePanel({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const componentProps =
    (component.props as { embed?: string } | undefined) ?? {};
  // When `embed === "right-sidebar"` the file tree fills its parent grid
  // cell vertically. Legacy left-stack layouts keep the resizable bottom
  // panel behavior.
  const embedMode = componentProps.embed ?? "left-stack";
  const fillsContainer = embedMode === "right-sidebar";
  const project = state["project"] as ProjectShape | undefined;
  const tabs = (state["tabs"] as EditorTabShape[] | undefined) ?? [];
  const activeTabId = state["activeTabId"] as string | undefined;
  const activeTab = activeTabId
    ? tabs.find((t) => t.id === activeTabId)
    : undefined;
  const activeEditorRoot =
    activeTab?.kind === "editor" ? activeTab.editor?.rootPath : undefined;
  const [aethonRoot, setAethonRoot] = useState<string>("");

  useEffect(() => {
    if (project?.path || activeEditorRoot || aethonRoot) return;
    let cancelled = false;
    void invoke<string>("aethon_home_dir")
      .then((dir) => {
        if (!cancelled && dir) setAethonRoot(dir);
      })
      .catch(() => {
        /* Dashboard files are best-effort when the home dir is unavailable. */
      });
    return () => {
      cancelled = true;
    };
  }, [activeEditorRoot, aethonRoot, project?.path]);

  const activeWorktreeId = (state["activeWorktreeId"] as string | null) ?? null;
  const projectPath = useMemo(() => {
    if (activeWorktreeId) {
      const sidebar = state["sidebar"] as
        | {
            projects?: {
              id?: string;
              worktrees?: { id?: string; path?: string }[];
            }[];
          }
        | undefined;
      const projects = sidebar?.projects ?? [];
      for (const p of projects) {
        const wt = p.worktrees?.find((w) => w.id === activeWorktreeId);
        if (wt?.path) return wt.path;
      }
    }
    return project?.path ?? activeEditorRoot ?? aethonRoot;
  }, [activeEditorRoot, activeWorktreeId, aethonRoot, project?.path, state]);
  const rootLabel = (project?.name ?? basename(projectPath)) || "files";

  const { collapsed, hidden, height, setCollapsed, setHidden, setHeight } =
    useFileTreePrefs();
  const {
    error,
    expanded,
    gitDecorations,
    ignoreMatcher,
    projectPathRef,
    refreshFolder,
    root,
    toggleFolder,
    visibleNodes,
    watchedDirs,
  } = useFileTreeData({ hidden, projectPath, rootLabel });

  useFileTreeWatch({
    projectPath,
    projectPathRef,
    refreshFolder,
    watchedDirs,
  });

  const { contextMenu, fileTreeMenuItems, openContextMenu, setContextMenu } =
    useFileTreeActions({
      onEvent,
      projectPath,
      projectPathRef,
      refreshFolder,
    });

  const onItemClick = (node: TreeNode) => {
    if (node.entry.kind === "dir") {
      toggleFolder(node);
      return;
    }
    onEvent("file-tree-open", {
      filePath: node.entry.path,
      rootPath: projectPathRef.current,
    });
  };

  if (hidden) {
    return null;
  }

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    document.body.classList.add("ae-resizing-sidebar");
    const onMove = (ev: MouseEvent) => {
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

  const startSidebarResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const host = (e.currentTarget as HTMLElement).closest(".ae-file-tree");
    const startWidth = Math.round(
      host?.getBoundingClientRect().width ?? SIDEBAR_WIDTH_MIN,
    );
    document.body.classList.add("ae-resizing-sidebar");
    const onMove = (ev: MouseEvent) => {
      const dx = startX - ev.clientX;
      const next = Math.max(
        SIDEBAR_WIDTH_MIN,
        Math.min(SIDEBAR_WIDTH_MAX, Math.round(startWidth + dx)),
      );
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

  const sidebarResizeHandle = fillsContainer ? (
    <div
      className="ae-file-tree-sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize files sidebar"
      onMouseDown={startSidebarResize}
    />
  ) : null;

  const sidebarProjects =
    ((state.sidebar as Record<string, unknown> | undefined)?.projects as
      | Array<{
          id: string;
          label?: string;
          active?: boolean;
          worktrees?: Array<{
            id: string;
            label?: string;
            branch?: string;
            active?: boolean;
          }>;
          git?: { branch?: string };
        }>
      | undefined) ?? [];
  const activeProjectId =
    typeof state["activeProjectId"] === "string"
      ? state["activeProjectId"]
      : null;
  const activeProject =
    sidebarProjects.find((p) => p.id === activeProjectId) ??
    sidebarProjects.find((p) => p.active === true);
  const activeWorktree = activeProject?.worktrees?.find(
    (w) => w.active === true,
  );
  const headerLabel = activeProject?.label ?? rootLabel;
  const headerBranch =
    activeWorktree?.label ??
    activeWorktree?.branch ??
    activeProject?.git?.branch;

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
        <span className="ae-file-tree-title">{headerLabel}</span>
        {headerBranch ? (
          <span className="ae-file-tree-branch">{headerBranch}</span>
        ) : null}
      </button>
      {fillsContainer ? null : (
        <button
          type="button"
          className="ae-file-tree-hide"
          aria-label="Hide files panel"
          title="Hide files panel"
          onClick={() => setHidden(true)}
        >
          ×
        </button>
      )}
    </div>
  );

  const panelStyle: CSSProperties = fillsContainer
    ? { flex: "1 1 auto", minHeight: 0 }
    : collapsed
      ? { flex: "0 0 auto" }
      : { flex: `0 0 ${height}px` };

  const resizeHandle =
    !collapsed && !fillsContainer ? (
      <div
        className="ae-file-tree-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize files panel"
        onMouseDown={startResize}
      />
    ) : null;

  if (!projectPath) {
    return (
      <div
        className={`ae-file-tree ae-file-tree-empty${collapsed ? " is-collapsed" : ""}`}
        style={panelStyle}
      >
        {sidebarResizeHandle}
        {resizeHandle}
        {titleRow}
        {!collapsed && <div className="a2ui-sidebar-empty">no project</div>}
      </div>
    );
  }
  if (error) {
    return (
      <div
        className={`ae-file-tree${collapsed ? " is-collapsed" : ""}`}
        style={panelStyle}
      >
        {sidebarResizeHandle}
        {resizeHandle}
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
        {sidebarResizeHandle}
        {resizeHandle}
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
      {sidebarResizeHandle}
      {resizeHandle}
      {titleRow}
      {!collapsed && (
        <ul className="ae-file-tree-list">
          {visibleNodes.map((node) => {
            const rel = relativePathFor(projectPath, node.entry.path);
            const ignored = rel != null && ignoreMatcher.isIgnored(rel);
            // Ignored paths carry no git status anyway; skip the lookup so an
            // ignored row never picks up a tint and reads as dimmed-only.
            const direct =
              rel == null || ignored
                ? undefined
                : gitDecorations.direct.get(rel);
            const descendant =
              rel == null || ignored
                ? undefined
                : gitDecorations.descendants.get(rel);
            const decoration = direct
              ? ({ status: direct, source: "direct" } as const)
              : descendant
                ? ({ status: descendant, source: "descendant" } as const)
                : undefined;
            return (
              <FileTreeRow
                key={node.entry.path}
                node={node}
                expanded={expanded.has(node.entry.path)}
                decoration={decoration}
                ignored={ignored}
                onClick={() => onItemClick(node)}
                onContextMenu={(e) => openContextMenu(e, node)}
              />
            );
          })}
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
  decoration?: GitDecoration;
  ignored?: boolean;
  onClick: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}

function FileTreeRow({
  node,
  expanded,
  decoration,
  ignored,
  onClick,
  onContextMenu,
}: FileTreeRowProps) {
  const indent = (node.depth - 1) * 12;
  const isDir = node.entry.kind === "dir";
  const statusMeta = decoration ? GIT_STATUS_META[decoration.status] : null;
  const statusTitle = statusMeta
    ? `${statusMeta.title}${
        decoration?.source === "descendant" ? " descendant" : ""
      }`
    : "";
  const titleBase = ignored ? `${node.entry.path} — Ignored` : node.entry.path;
  return (
    <li
      role="treeitem"
      aria-level={node.depth}
      aria-expanded={isDir ? expanded : undefined}
      className={`ae-file-tree-row ${isDir ? "is-dir" : "is-file"}${
        ignored ? " is-ignored" : ""
      }${
        decoration
          ? ` has-git-status git-status-${decoration.status} git-status-${decoration.source}`
          : ""
      }`}
      style={{ paddingLeft: indent }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={statusTitle ? `${node.entry.path} — ${statusTitle}` : titleBase}
    >
      {isDir ? (
        <span className="ae-file-tree-chevron-row" aria-hidden="true">
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
      <span className="ae-file-tree-label">{node.entry.name}</span>
      {statusMeta && (
        <span
          className="ae-file-tree-git-decoration"
          aria-label={statusTitle}
          title={statusTitle}
        >
          {statusMeta.label}
        </span>
      )}
      {node.loading && (
        <span className="ae-file-tree-loading" aria-hidden="true">
          …
        </span>
      )}
    </li>
  );
}
