import type { BridgeMessageHandler } from "./types";

/** Per-tab model change. Bridge tags with tabId; default for legacy.
 *  Sidebar model picker is global — reflects the active tab's model.
 *  When a non-active tab changes model we leave the picker alone so the
 *  user's currently visible context isn't surprised by it. */
export const handleModelChanged: BridgeMessageHandler = (data, ctx) => {
  const model = (data.model as string) || "";
  const tabId = (data.tabId as string | undefined) ?? "default";
  ctx.updateTab(tabId, (tab) => ({ ...tab, model }));
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
      const items =
        (sidebar.models as { id: string; label: string }[] | undefined) ?? [];
      return {
        ...prev,
        status: `switched to ${model}`,
        sidebar: {
          ...sidebar,
          models: items.map((m) => ({
            id: m.id,
            label: m.label,
            active: m.id === model,
          })),
        },
      };
    });
  }
};
