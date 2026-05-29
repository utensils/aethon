/**
 * Built-in event routes for the Monaco editor canvas + file tree.
 *
 * The composite (`type:editor-canvas`) emits four event types:
 *
 *   - `editor-change`  — first content change after load; flips dirty.
 *   - `editor-cursor`  — cursor moved; mirrors line/column to the tab.
 *   - `editor-loaded`  — file fully populated from disk; clears dirty.
 *   - `editor-save`    — Cmd+S; writes content via fs_write_file and
 *                        clears dirty on success.
 *
 * The file-tree sidebar section (`type:file-tree`) emits a single
 * `file-tree-open` event to open / focus an editor tab.
 *
 * All handlers return `true` when they claim an event so the renderer
 * suppresses its default bridge forward.
 */

import type {
  EventRouteContext,
  EventRouteEvent,
  EventRouteHandler,
} from "./types";
import { WORKSTATION_AREAS } from "../hooks/useFocus";

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

const FILES_SIDEBAR_MIN_WIDTH = 220;
const FILES_SIDEBAR_MAX_WIDTH = 640;

function clampFilesSidebarWidth(value: number): number {
  return Math.max(
    FILES_SIDEBAR_MIN_WIDTH,
    Math.min(FILES_SIDEBAR_MAX_WIDTH, Math.round(value)),
  );
}

export const handleEditorCanvas: EventRouteHandler = async (
  event: EventRouteEvent,
  ctx: EventRouteContext,
): Promise<boolean> => {
  const { eventType, data } = event;
  const payload = asRecord(data);
  const tabId = typeof payload.tabId === "string" ? payload.tabId : "";
  if (!tabId) return false;

  switch (eventType) {
    case "editor-change": {
      ctx.updateEditorMeta(tabId, { isDirty: true });
      return true;
    }
    case "editor-cursor": {
      const line = typeof payload.line === "number" ? payload.line : undefined;
      const column =
        typeof payload.column === "number" ? payload.column : undefined;
      if (line !== undefined && column !== undefined) {
        ctx.updateEditorMeta(tabId, { cursorLine: line, cursorColumn: column });
      }
      return true;
    }
    case "editor-loaded": {
      ctx.updateEditorMeta(tabId, { isDirty: false });
      return true;
    }
    case "editor-save": {
      const filePath =
        typeof payload.filePath === "string" ? payload.filePath : "";
      const content =
        typeof payload.content === "string" ? payload.content : "";
      if (!filePath) return true;
      const project = ctx.stateRef.current.project as
        | { path?: string }
        | undefined;
      const tabs =
        (ctx.stateRef.current.tabs as
          | Array<{ id: string; editor?: { rootPath?: string } }>
          | undefined) ?? [];
      const tabRoot = tabs.find((t) => t.id === tabId)?.editor?.rootPath;
      const root = tabRoot ?? project?.path ?? "";
      try {
        await ctx.invoke("fs_write_file", { root, path: filePath, content });
        ctx.updateEditorMeta(tabId, { isDirty: false });
        ctx.pushNotification({
          title: `Saved ${filePath.split("/").pop() ?? filePath}`,
          kind: "success",
          durationMs: 2000,
        });
      } catch (err) {
        ctx.pushNotification({
          title: "Save failed",
          message: String(err),
          kind: "error",
          durationMs: 6000,
        });
      }
      return true;
    }
    default:
      return false;
  }
};

export const handleFileTree: EventRouteHandler = (
  event: EventRouteEvent,
  ctx: EventRouteContext,
): boolean => {
  if (event.eventType === "resize") {
    const payload = asRecord(event.data);
    const rawWidth = typeof payload.width === "number" ? payload.width : NaN;
    if (!Number.isFinite(rawWidth)) return true;
    const width = clampFilesSidebarWidth(rawWidth);
    ctx.setState((prev) => {
      const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
      const current =
        typeof layout.columns === "string"
          ? layout.columns
          : "320px minmax(0,1fr) 360px";
      const tokens = current.trim().split(/\s+/);
      if (tokens.length >= 3) {
        tokens[tokens.length - 1] = `${width}px`;
      } else if (tokens.length >= 2 && layout.filesSidebarVisible !== false) {
        tokens.push(`${width}px`);
      }
      return {
        ...prev,
        layout: {
          ...layout,
          columns: tokens.join(" "),
          areas: WORKSTATION_AREAS,
          lastRightWidth: `${width}px`,
        },
      };
    });
    return true;
  }
  if (event.eventType === "resize-end") {
    return true;
  }
  if (event.eventType === "file-tree-open") {
    const payload = asRecord(event.data);
    const filePath =
      typeof payload.filePath === "string" ? payload.filePath : "";
    if (!filePath) return false;
    const rootPath =
      typeof payload.rootPath === "string" ? payload.rootPath : "";
    if (rootPath) ctx.newEditorTab(filePath, { rootPath });
    else ctx.newEditorTab(filePath);
    return true;
  }
  if (event.eventType === "file-tree-rename") {
    const payload = asRecord(event.data);
    const from = typeof payload.from === "string" ? payload.from : "";
    const to = typeof payload.to === "string" ? payload.to : "";
    const kind = typeof payload.kind === "string" ? payload.kind : "file";
    if (!from || !to) return false;
    ctx.renameEditorTabsForPath(from, to, kind);
    return true;
  }
  if (event.eventType === "file-tree-delete") {
    const payload = asRecord(event.data);
    const path = typeof payload.path === "string" ? payload.path : "";
    const kind = typeof payload.kind === "string" ? payload.kind : "file";
    if (!path) return false;
    ctx.closeEditorTabsForPath(path, kind);
    return true;
  }
  return false;
};
