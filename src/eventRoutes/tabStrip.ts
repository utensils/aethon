import type { EventRouteHandler } from "./types";
import type { Tab } from "../types/tab";

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
    | { tabId?: string; action?: string; id?: string }
    | undefined;
  if (eventType === "select" && sel?.tabId) {
    ctx.setActiveTab(sel.tabId);
    return true;
  }
  if (eventType === "close" && sel?.tabId) {
    ctx.closeTab(sel.tabId);
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
 *  selection events here seed a fresh tab in the chosen project. */
export const handleEmptyState: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "empty-state") return false;
  if (eventType === "new-tab") {
    ctx.newTab();
    return true;
  }
  if (eventType === "open-project") {
    // Pop the native folder picker. On a successful pick we've already
    // persisted + announced the new project — open a fresh tab in it
    // so the user lands ready-to-chat. On cancel, leave empty state.
    ctx.openProjectFromPicker().then((id) => {
      if (id) ctx.newTab();
    });
    return true;
  }
  if (eventType === "select-project") {
    const sel = data as
      | { projectId?: string; label?: string; path?: string }
      | undefined;
    if (sel?.projectId) {
      ctx.setActiveProjectById(sel.projectId);
      // Only seed a fresh tab when the project's bucket is empty. If
      // the user already has tabs in this project, the bucket load
      // restored them — popping a new tab on top would be jarring.
      const tabsAfter =
        (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
      if (tabsAfter.length === 0) ctx.newTab();
    }
    return true;
  }
  if (eventType === "restore-session") {
    const sel = data as
      | { sessionId?: string; label?: string; cwd?: string }
      | undefined;
    if (sel?.sessionId) {
      // Re-open the persisted session by reusing the same tabId. The
      // bridge's SessionManager.continueRecent reads the existing JSONL
      // files so the LLM history is restored too.
      ctx.newTab(sel.sessionId, sel.label ?? "Restored Session", {
        restoredSession: true,
        ...(sel.cwd ? { cwd: sel.cwd } : {}),
      });
    } else {
      ctx.newTab();
    }
    return true;
  }
  return false;
};
