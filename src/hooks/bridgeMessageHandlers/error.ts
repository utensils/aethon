import type { BridgeMessageHandler } from "./types";

export const handleError: BridgeMessageHandler = (data, ctx) => {
  const message = (data.message as string) ?? "unknown error";
  const tabId = (data.tabId as string | undefined) ?? "default";
  ctx.activeResponseIdRef.current = null;
  ctx.appendMessage(
    { id: crypto.randomUUID(), role: "agent", text: `Error: ${message}` },
    tabId,
  );
  ctx.updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
  if (ctx.stateRef.current.activeTabId === tabId) {
    ctx.setStatusFlags({ status: "error" });
  }
};
