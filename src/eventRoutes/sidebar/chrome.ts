import type { EventRouteHandler } from "../types";
import { restoreSessionFromSelection } from "../sessionRestore";

interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

/** Sidebar select + dropdown chrome pickers (model-picker /
 *  appearance-menu) all use the same `{sectionId, itemId}` event
 *  shape. Registered under three route-table type keys
 *  (`type:sidebar`, `type:model-picker`, `type:appearance-menu`) so
 *  registry overrides win without per-instance id matching — route by
 *  section so a chrome dropdown and a sidebar row converge on the
 *  same backing action. */
export const handleSectionedSelect: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "select") return false;

  const selected = data as { sectionId?: string; itemId?: string } | undefined;
  if (selected?.itemId === "toggle-terminal") {
    ctx.toggleTerminal();
    return true;
  }
  if (selected?.itemId === "toggle-file-tree") {
    // FileTreePanel listens for this on the window. Keeps the sidebar
    // event route free of file-tree-specific React state.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("aethon:toggle-file-tree"));
    }
    return true;
  }
  if (selected?.itemId === "clear-chat") {
    ctx.clearChat();
    return true;
  }
  if (selected?.sectionId === "models" && selected.itemId) {
    await ctx.setModel(selected.itemId);
    return true;
  }
  if (selected?.sectionId === "themes" && selected.itemId) {
    // Accept any registered theme id (built-ins + extension themes).
    // Built-in CSS lives in src/styles/themes.css; extension themes had their
    // <style> tag injected on hydrateThemes().
    ctx.setTheme(selected.itemId);
    return true;
  }
  if (selected?.sectionId === "layouts" && selected.itemId) {
    ctx.activateLayoutById(selected.itemId);
    return true;
  }
  if (selected?.sectionId === "projects" && selected.itemId) {
    // The sidebar's projects section also surfaces an "Open project…"
    // action item; intercept it here so we don't try to look it up as
    // a project id.
    if (selected.itemId === "open-project") {
      ctx.openProjectFromPicker();
      return true;
    }
    ctx.activateWorktree(null);
    ctx.setActiveProjectById(selected.itemId);
    ctx.setState((prev) => ({ ...prev, landing: null }));
    return true;
  }
  if (selected?.sectionId === "hosts" && selected.itemId) {
    ctx.setActiveHost(selected.itemId);
    return true;
  }
  if (selected?.sectionId === "history" && selected.itemId) {
    if (selected.itemId.startsWith("tab:")) {
      ctx.setActiveTab(selected.itemId.slice(4));
      return true;
    }
    if (selected.itemId.startsWith("session:")) {
      const sessionId = selected.itemId.slice(8);
      const recentSessions =
        (ctx.stateRef.current.recentSessions as
          | RecentSessionItem[]
          | undefined) ?? [];
      const item = recentSessions.find((s) => s.id === sessionId);
      restoreSessionFromSelection(ctx, {
        sessionId,
        label: item?.label ?? `Session ${sessionId.slice(0, 8)}`,
        cwd: item?.cwd,
      });
      return true;
    }
    return true;
  }
  return false;
};
