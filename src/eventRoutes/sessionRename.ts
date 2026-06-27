import type { EventRouteContext } from "./types";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cwdForSession(
  ctx: EventRouteContext,
  tabId: string,
): string | undefined {
  const tabs =
    (ctx.stateRef.current.tabs as { id?: unknown; cwd?: unknown }[] | undefined) ??
    [];
  const tab = tabs.find((item) => item.id === tabId);
  const tabCwd = nonEmptyString(tab?.cwd);
  if (tabCwd) return tabCwd;

  const recentSessions =
    (ctx.stateRef.current.recentSessions as
      | { id?: unknown; cwd?: unknown }[]
      | undefined) ?? [];
  const recent = recentSessions.find((item) => item.id === tabId);
  const recentCwd = nonEmptyString(recent?.cwd);
  if (recentCwd) return recentCwd;

  const discovered = ctx.allDiscoveredSessionsRef.current.find(
    (item) => item.tabId === tabId,
  );
  return nonEmptyString(discovered?.cwd);
}

export function renameSessionLabel(
  ctx: EventRouteContext,
  tabId: string,
  label: string,
): void {
  applyOptimisticTabLabel(ctx, tabId, label);
  const cwd = cwdForSession(ctx, tabId);
  ctx
    .invoke("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId,
        label,
        ...(cwd ? { cwd } : {}),
      }),
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: "Rename session failed",
        message: String(err),
        kind: "error",
      });
    });
}

/** Update an open tab's `label` in App state when renaming a currently
 *  open session. Empty input restores the auto-derived sequential
 *  "Tab N" label using the tab's existing index in the array. */
export function applyOptimisticTabLabel(
  ctx: Pick<EventRouteContext, "setState">,
  tabId: string,
  label: string,
): void {
  ctx.setState((prev) => {
    const tabs =
      (prev.tabs as { id: string; label: string }[] | undefined) ?? [];
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
