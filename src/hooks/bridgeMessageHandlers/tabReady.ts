import type { BridgeMessageHandler } from "./types";
import { recomputeModelPicker } from "../../utils/modelPicker";
import { contextUsageFromMessage } from "./contextUsage";

/** Bridge confirms a per-tab pi session is up and tells us its chosen
 *  model. Update the tab record so the sidebar can reflect it on next
 *  switch. If the tab is currently active, also refresh the model
 *  picker's `active` flag now (otherwise it'd lag until the user
 *  manually switched). */
export const handleTabReady: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  const model = (data.model as string) ?? "";
  const contextUsage = contextUsageFromMessage(
    (data.contextUsage as Record<string, unknown> | undefined) ?? {},
  );
  ctx.updateTab(tabId, (tab) => ({
    ...tab,
    model,
    ...(contextUsage ? { contextUsage } : {}),
  }));
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setState((prev) => ({
      ...prev,
      sidebar: recomputeModelPicker(
        prev.sidebar as Record<string, unknown> | undefined,
        model,
      ),
    }));
  }
};
