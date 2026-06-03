import type { EventRouteHandler, EventRouteContext } from "./types";
import { OVERVIEW_TAB_ID, type Tab } from "../types/tab";
import { restoreSessionFromSelection } from "./sessionRestore";
import { renameSessionLabel } from "./sessionRename";
import { reorderTabToIndex } from "../utils/tabReorder";

/** Switch the active tab to the overview sentinel. Used both by the
 *  permanent overview pill in the tab strip and by the sidebar
 *  re-click gestures in `sidebar/chrome.ts` + `sidebar/worktree.ts`. */
export function activateOverview(ctx: EventRouteContext): void {
  ctx.setState((prev) => {
    if (prev.activeTabId === OVERVIEW_TAB_ID) return prev;
    return { ...prev, activeTabId: OVERVIEW_TAB_ID };
  });
}

/** tab-strip: select / close / new. Tab events route by component
 *  *type* — id may vary across layouts (workstation hoists the strip
 *  into the header as `header-tabs`). Matching by type keeps the
 *  contract layout-agnostic so a future layout's tabs work without
 *  touching the dispatcher. */
export const handleTabStrip: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.type !== "tab-strip") return false;
  const sel = data as
    | {
        tabId?: string;
        action?: string;
        id?: string;
        label?: string;
        toIndex?: number;
      }
    | undefined;
  if (eventType === "select" && sel?.tabId) {
    if (sel.tabId === OVERVIEW_TAB_ID) {
      activateOverview(ctx);
      return true;
    }
    ctx.setActiveTab(sel.tabId);
    return true;
  }
  if (eventType === "close" && sel?.tabId) {
    ctx.closeTab(sel.tabId);
    return true;
  }
  if (eventType === "close-others" && sel?.tabId) {
    const tabs =
      (ctx.stateRef.current.tabs as
        | Array<{ id: string; kind?: string }>
        | undefined) ?? [];
    // Shell tabs live in the bottom panel, not the top strip — leave them.
    for (const t of tabs) {
      if (t.id !== sel.tabId && t.kind !== "shell") ctx.closeTab(t.id);
    }
    return true;
  }
  if (eventType === "close-all") {
    const tabs =
      (ctx.stateRef.current.tabs as
        | Array<{ id: string; kind?: string }>
        | undefined) ?? [];
    for (const t of tabs) {
      if (t.kind !== "shell") ctx.closeTab(t.id);
    }
    return true;
  }
  if (eventType === "rename" && sel?.tabId) {
    const label = typeof sel.label === "string" ? sel.label : "";
    renameSessionLabel(ctx, sel.tabId, label);
    return true;
  }
  if (eventType === "reorder" && sel?.tabId) {
    const tabId = sel.tabId;
    const toIndex = typeof sel.toIndex === "number" ? sel.toIndex : NaN;
    ctx.setState((prev) => {
      const tabs = (prev.tabs as Tab[] | undefined) ?? [];
      const reordered = reorderTabToIndex(tabs, "top", tabId, toIndex);
      return reordered ? { ...prev, tabs: reordered } : prev;
    });
    return true;
  }
  if (eventType === "new") {
    ctx.newTab();
    return true;
  }
  return false;
};

/** empty-state CTA buttons: new-tab, open-project, select-project,
 *  restore-session. Renders when the active project has no open tabs;
 *  only new-tab / restore-session create conversation tabs.
 *
 *  Routed by `type:empty-state` (registry override key). */
export const handleEmptyState: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "new-tab") {
    ctx.newTab();
    return true;
  }
  if (eventType === "open-project") {
    ctx.openProjectFromPicker();
    return true;
  }
  if (eventType === "select-project") {
    const sel = data as
      | { projectId?: string; label?: string; path?: string }
      | undefined;
    if (sel?.projectId) {
      ctx.setActiveProjectById(sel.projectId);
    }
    return true;
  }
  if (eventType === "restore-session") {
    const sel = data as
      | { sessionId?: string; label?: string; cwd?: string }
      | undefined;
    restoreSessionFromSelection(ctx, sel);
    return true;
  }
  return false;
};
