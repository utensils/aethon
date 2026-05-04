import type { BridgeMessageHandler } from "./types";

/** A new chat IPC arrived while a prompt was in flight; pi accepted it
 *  into the followUp queue. Bump the per-tab counter. */
export const handleQueued: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  ctx.updateTab(tabId, (tab) => ({ ...tab, queueCount: tab.queueCount + 1 }));
};
