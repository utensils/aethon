import type { EventRouteContext } from "./types";

export function renameSessionLabel(
  ctx: EventRouteContext,
  tabId: string,
  label: string,
): void {
  applyOptimisticTabLabel(ctx, tabId, label);
  ctx
    .invoke("agent_command", {
      payload: JSON.stringify({
        type: "set_session_label",
        tabId,
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
