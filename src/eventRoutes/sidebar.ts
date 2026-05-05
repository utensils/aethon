import type { EventRouteHandler } from "./types";
import { extractSessionId } from "../utils/sidebarHistory";
import type { Tab } from "../types/tab";

interface RecentSessionItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

/** sidebar resize: live drag updates the leading column token in
 *  /layout/columns. Layouts shape grid columns as either
 *  "${SIDEBAR}px minmax(0,1fr)" or
 *  "${SIDEBAR}px minmax(0,1fr) ${INSPECTOR}px" — replace just the first
 *  token so non-sidebar columns survive the rewrite. */
export const handleSidebarResize: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "sidebar" || eventType !== "resize") return false;
  const next = (data as { width?: number } | undefined)?.width;
  if (typeof next === "number") {
    ctx.setState((prev) => {
      const layout =
        (prev.layout as Record<string, unknown> | undefined) ?? {};
      const current =
        (layout.columns as string | undefined) ?? "220px minmax(0,1fr)";
      const tokens = current.trim().split(/\s+/);
      tokens[0] = `${next}px`;
      return { ...prev, layout: { ...layout, columns: tokens.join(" ") } };
    });
  }
  return true;
};

/** sidebar resize-end: persist the final width so the next boot opens
 *  at the same size. Reads from state.layout.columns (the in-flight
 *  value the resize listener just wrote) so a single source of truth
 *  wins. */
export const handleSidebarResizeEnd: EventRouteHandler = (
  { component, eventType },
  ctx,
) => {
  if (component.id !== "sidebar" || eventType !== "resize-end") return false;
  const layout =
    (ctx.stateRef.current.layout as Record<string, unknown> | undefined) ?? {};
  const cols = (layout.columns as string | undefined) ?? "";
  const lead = cols.trim().split(/\s+/)[0] ?? "";
  const px = parseInt(lead, 10);
  if (Number.isFinite(px) && px > 0) {
    ctx.writeState("sidebar_width", String(px)).catch(() => {
      /* ignore — best-effort */
    });
  }
  return true;
};

/** sidebar remove-project: delegate to the projects hook. Returns true
 *  when no projectId is present (treat as handled rather than fall
 *  through — there's no other handler that wants this event). */
export const handleSidebarRemoveProject: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "sidebar" || eventType !== "remove-project") {
    return false;
  }
  const selected = data as
    | { projectId?: string; itemId?: string }
    | undefined;
  const projectId = selected?.projectId ?? selected?.itemId;
  return projectId ? ctx.removeProjectById(projectId) : true;
};

/** sidebar delete-session: prompt user, then delete via the Tauri
 *  command. Delete-then-close ordering matters — the reverse leaves
 *  the user with a closed tab and a failure notification when the
 *  Tauri command refuses (e.g. the default session). */
export const handleSidebarDeleteSession: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "sidebar" || eventType !== "delete-session") {
    return false;
  }
  const selected = data as
    | { sessionId?: string; itemId?: string; label?: string }
    | undefined;
  // Strip the "session:" or "tab:" prefix defensively in case a future
  // caller forgets the split — the sidebar already strips it but we
  // don't want a stray prefix to land in the Tauri command path
  // validator.
  const raw = selected?.sessionId ?? selected?.itemId ?? "";
  const sessionId = extractSessionId(raw);
  const label = selected?.label ?? sessionId;
  if (!sessionId) return true;
  ctx.promptDeleteSessionConfirmation(label).then((allowed) => {
    if (!allowed) return;
    const isOpen = (ctx.stateRef.current.tabs as Tab[] | undefined)?.some(
      (t) => t.id === sessionId,
    );
    ctx
      .invoke("delete_session", { tabId: sessionId })
      .then(() => {
        if (isOpen) ctx.closeTab(sessionId);
        ctx.allDiscoveredSessionsRef.current =
          ctx.allDiscoveredSessionsRef.current.filter(
            (s) => s.tabId !== sessionId,
          );
        ctx.syncRecentSessionsToState();
        ctx.pushNotification({
          title: "Session deleted",
          message: label,
          kind: "success",
        });
      })
      .catch((err: unknown) => {
        ctx.pushNotification({
          title: "Delete session failed",
          message: String(err),
          kind: "error",
        });
      });
  });
  return true;
};

/** sidebar toggle-extension: forward to the bridge so the user's
 *  disabled list is updated + persisted. The bridge re-emits `ready`
 *  on success so the sidebar entry shifts buckets without a refresh. */
export const handleSidebarToggleExtension: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "sidebar" || eventType !== "toggle-extension") {
    return false;
  }
  const selected = data as
    | { name?: string; disabled?: boolean }
    | undefined;
  if (!selected?.name || typeof selected.disabled !== "boolean") return true;
  ctx
    .invoke("agent_command", {
      payload: JSON.stringify({
        type: "set_extension_disabled",
        name: selected.name,
        disabled: selected.disabled,
      }),
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: "Toggle extension failed",
        message: String(err),
        kind: "error",
      });
    });
  return true;
};

/** Sidebar select + dropdown chrome pickers (model-picker /
 *  appearance-menu) all use the same `{sectionId, itemId}` event
 *  shape. Route by section so a chrome dropdown and a sidebar row
 *  converge on the same backing action. */
export const handleSectionedSelect: EventRouteHandler = async (
  { component, eventType, data },
  ctx,
) => {
  const isSectionedSelect =
    eventType === "select" &&
    (component.id === "sidebar" ||
      component.id === "model-picker" ||
      component.id === "appearance-menu");
  if (!isSectionedSelect) return false;

  const selected = data as
    | { sectionId?: string; itemId?: string }
    | undefined;
  if (selected?.itemId === "toggle-terminal") {
    ctx.toggleTerminal();
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
    // Built-in CSS lives in styles.css; extension themes had their
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
    ctx.setActiveProjectById(selected.itemId);
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
      ctx.newTab(
        sessionId,
        item?.label ?? `Session ${sessionId.slice(0, 8)}`,
        {
          restoredSession: true,
          ...(item?.cwd ? { cwd: item.cwd } : {}),
        },
      );
      return true;
    }
    return true;
  }
  return false;
};
