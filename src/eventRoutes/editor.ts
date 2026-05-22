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

import type { EventRouteContext, EventRouteEvent, EventRouteHandler } from "./types";

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
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
      const column = typeof payload.column === "number" ? payload.column : undefined;
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
      const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
      const content = typeof payload.content === "string" ? payload.content : "";
      if (!filePath) return true;
      const project = ctx.stateRef.current.project as { path?: string } | undefined;
      const root = project?.path ?? "";
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
  if (event.eventType !== "file-tree-open") return false;
  const payload = asRecord(event.data);
  const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
  if (!filePath) return false;
  ctx.newEditorTab(filePath);
  return true;
};
