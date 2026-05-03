import type { A2UIPayload } from "../../types/a2ui";
import type { BridgeMessageHandler } from "./types";

export const handleA2ui: BridgeMessageHandler = (data, ctx) => {
  const payload = data.payload as A2UIPayload | undefined;
  const id = (data.id as string) || crypto.randomUUID();
  const tabId = (data.tabId as string | undefined) ?? "default";
  if (payload) {
    ctx.appendMessage({ id, role: "agent", a2ui: payload }, tabId);
  }
  if (data.done) {
    ctx.updateTab(tabId, (tab) => ({ ...tab, waiting: false }));
    if (ctx.stateRef.current.activeTabId === tabId) {
      ctx.setStatusFlags({ status: "ready" });
    }
  }
};
