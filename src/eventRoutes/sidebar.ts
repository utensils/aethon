import type { EventRouteContext, EventRouteHandler } from "./types";
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
 *  token so non-sidebar columns survive the rewrite.
 *
 *  All sidebar handlers below are routed by `type:sidebar` (registry
 *  override key) so a custom layout that renames the sidebar instance
 *  still receives these events — only the eventType filters apply. */
export const handleSidebarResize: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "resize") return false;
  const next = (data as { width?: number } | undefined)?.width;
  if (typeof next === "number") {
    ctx.setState((prev) => {
      const layout =
        (prev.layout as Record<string, unknown> | undefined) ?? {};
      const current =
        (layout.columns as string | undefined) ?? "220px minmax(0,1fr)";
      const tokens = current.trim().split(/\s+/);
      tokens[0] = `${next}px`;
      // Stash the new left width on the layout so a hide/show
      // round-trip restores the user's sized sidebar instead of the
      // boot default. The files sidebar carries its own memo via the
      // toggle helpers.
      return {
        ...prev,
        layout: {
          ...layout,
          columns: tokens.join(" "),
          lastLeftWidth: `${next}px`,
        },
      };
    });
  }
  return true;
};

/** sidebar resize-end: handled for drag lifecycle symmetry. The app-wide
 *  session UI snapshot persists the final /layout/columns value. */
export const handleSidebarResizeEnd: EventRouteHandler = (
  { eventType },
) => {
  if (eventType !== "resize-end") return false;
  return true;
};

/** sidebar remove-project: delegate to the projects hook. Returns true
 *  when no projectId is present (treat as handled rather than fall
 *  through — there's no other handler that wants this event). */
export const handleSidebarRemoveProject: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "remove-project") return false;
  const selected = data as
    | { projectId?: string; itemId?: string }
    | undefined;
  const projectId = selected?.projectId ?? selected?.itemId;
  return projectId ? ctx.removeProjectById(projectId) : true;
};

/** sidebar delete-session: prompt user, then delete via the Tauri
 *  command. Delete-then-close ordering matters — if deletion fails,
 *  the open tab should stay visible. */
export const handleSidebarDeleteSession: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "delete-session") return false;
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

/** sidebar rename-session: forward the new label to the bridge AND
 *  optimistically update the open tab's label if the target is
 *  currently open. The bridge persists
 *  `<sessionsDir>/<tabId>/label.txt` and re-emits `ready`; the
 *  optimistic update is what makes the change visible immediately for
 *  open-tab rows (whose `tab:` label flows from `Tab.label`, not from
 *  `recentSessions`/`discoveredTabs`). */
export const handleSidebarRenameSession: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-session") return false;
  const selected = data as
    | { sessionId?: string; itemId?: string; label?: string }
    | undefined;
  const raw = selected?.sessionId ?? selected?.itemId ?? "";
  const sessionId = extractSessionId(raw);
  const label = typeof selected?.label === "string" ? selected.label : "";
  if (!sessionId) return true;
  applyOptimisticTabLabel(ctx, sessionId, label);
  ctx
    .invoke("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId: sessionId,
        label,
      }),
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: "Rename session failed",
        message: String(err),
        kind: "error",
      });
    });
  return true;
};

/** Update an open tab's `label` in App state when renaming a currently
 *  open session. Empty input restores the auto-derived sequential
 *  "Tab N" label using the tab's existing index in the array (matches
 *  the original useTabs naming convention so the auto-label fallback
 *  behaviour from `buildSidebarHistory` kicks in). No-op if no tab
 *  matches the id. */
function applyOptimisticTabLabel(
  ctx: EventRouteContext,
  tabId: string,
  label: string,
): void {
  ctx.setState((prev) => {
    const tabs = (prev.tabs as { id: string; label: string }[] | undefined) ??
      [];
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return prev;
    const trimmed = label.trim();
    const fallback = `Tab ${idx + 1}`;
    const nextLabel = trimmed.length > 0 ? trimmed : fallback;
    if (tabs[idx].label === nextLabel) return prev;
    const nextTabs = [...tabs];
    nextTabs[idx] = { ...nextTabs[idx], label: nextLabel };
    return { ...prev, tabs: nextTabs };
  });
}

/** Sidebar disclosure on a project row — toggle the per-project
 *  expanded state so worktrees show/hide nested under the row. */
export const handleSidebarToggleProjectExpand: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "toggle-project-expand") return false;
  const selected = data as { itemId?: string } | undefined;
  if (!selected?.itemId) return true;
  // Read current expanded flag from state.
  const projects = (ctx.stateRef.current.projects as Array<{ id: string; uiExpanded?: boolean }> | undefined) ?? [];
  const project = projects.find((p) => p.id === selected.itemId);
  ctx.setProjectExpanded(selected.itemId, !(project?.uiExpanded ?? false));
  return true;
};

/** Worktree event family — all routed through useProjectOps actions. */
export const handleSidebarCreateWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "create-worktree") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (projectId) void ctx.createWorktreeForProject(projectId);
  return true;
};
export const handleSidebarSwitchWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "switch-worktree") return false;
  const worktreeId =
    (data as { worktreeId?: string } | undefined)?.worktreeId ?? null;
  ctx.activateWorktree(worktreeId);
  return true;
};
export const handleSidebarRemoveWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "remove-worktree") return false;
  const worktreeId = (data as { worktreeId?: string } | undefined)?.worktreeId;
  if (worktreeId) void ctx.removeWorktreeById(worktreeId);
  return true;
};
export const handleSidebarCancelPendingWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "cancel-pending-worktree") return false;
  const worktreeId = (data as { worktreeId?: string } | undefined)?.worktreeId;
  if (worktreeId) ctx.dismissPendingWorktree(worktreeId);
  return true;
};
export const handleSidebarRetryPendingWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "retry-pending-worktree") return false;
  const worktreeId = (data as { worktreeId?: string } | undefined)?.worktreeId;
  if (worktreeId) void ctx.retryPendingWorktree(worktreeId);
  return true;
};
export const handleSidebarRenameWorktree: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-worktree") return false;
  const { worktreeId, label } =
    (data as { worktreeId?: string; label?: string } | undefined) ?? {};
  if (worktreeId && typeof label === "string") ctx.renameWorktree(worktreeId, label);
  return true;
};

/** Filesystem helpers — open + copy on a project or worktree. The path
 *  to act on is read from the projects state when only an id is given. */
export const handleSidebarOpenProjectInFinder: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "open-project-in-finder") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (!projectId) return true;
  const projects = (ctx.stateRef.current.projects as Array<{ id: string; path?: string }> | undefined) ?? [];
  const path = projects.find((p) => p.id === projectId)?.path;
  if (!path) return true;
  await ctx
    .invoke("fs_open_in_file_manager", { path })
    .catch(() => {
      /* command may not exist in older builds; ignore */
    });
  return true;
};
export const handleSidebarCopyProjectPath: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "copy-project-path") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (!projectId) return true;
  const projects = (ctx.stateRef.current.projects as Array<{ id: string; path?: string }> | undefined) ?? [];
  const path = projects.find((p) => p.id === projectId)?.path;
  if (path && navigator.clipboard) {
    void navigator.clipboard.writeText(path).catch(() => {});
  }
  return true;
};
export const handleSidebarOpenWorktreeInFinder: EventRouteHandler = async (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "open-worktree-in-finder") return false;
  const path = (data as { path?: string } | undefined)?.path;
  if (!path) return true;
  await ctx
    .invoke("fs_open_in_file_manager", { path })
    .catch(() => {});
  return true;
};
export const handleSidebarCopyWorktreePath: EventRouteHandler = (
  { eventType, data },
) => {
  if (eventType !== "copy-worktree-path") return false;
  const path = (data as { path?: string } | undefined)?.path;
  if (path && navigator.clipboard) {
    void navigator.clipboard.writeText(path).catch(() => {});
  }
  return true;
};
export const handleSidebarSwitchToProject: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "switch-to-project") return false;
  const projectId = (data as { projectId?: string } | undefined)?.projectId;
  if (projectId) ctx.setActiveProjectById(projectId);
  return true;
};
export const handleSidebarRenameProject: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "rename-project") return false;
  const { projectId, label } =
    (data as { projectId?: string; label?: string } | undefined) ?? {};
  if (projectId && typeof label === "string") ctx.renameProject(projectId, label);
  return true;
};

/** sidebar toggle-extension: forward to the bridge so the user's
 *  disabled list is updated + persisted. The bridge re-emits `ready`
 *  on success so the sidebar entry shifts buckets without a refresh. */
export const handleSidebarToggleExtension: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "toggle-extension") return false;
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

  const selected = data as
    | { sectionId?: string; itemId?: string }
    | undefined;
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
