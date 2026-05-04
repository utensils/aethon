import type { BridgeMessageHandler } from "./types";

/** Bridge dropped this tab's pi follow-up queue (typically on Stop).
 *  Mirror by zeroing the local queueCount so the next response_end
 *  clears `waiting` instead of staying stuck on the
 *  "queue > 0 keeps Stop" gate. */
export const handleQueueReset: BridgeMessageHandler = (data, ctx) => {
  const tabId = (data.tabId as string | undefined) ?? "default";
  ctx.updateTab(tabId, (tab) => ({ ...tab, queueCount: 0 }));
};
