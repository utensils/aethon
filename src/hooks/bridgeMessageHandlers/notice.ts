import type { BridgeMessageHandler } from "./types";

/** Non-terminal — surface as a system message but DO NOT touch
 *  waiting/status. Used e.g. when a second chat IPC arrives while a
 *  prompt is in-flight: the user sees the rejection but the Stop button
 *  and waiting state for the original prompt persist. Also surface as a
 *  warning toast so a notice that arrives while the user isn't looking
 *  at chat doesn't get missed. */
export const handleNotice: BridgeMessageHandler = (data, ctx) => {
  const message = (data.message as string) ?? "";
  const tabId = (data.tabId as string | undefined) ?? "default";
  if (data.busy === true) {
    ctx.updateTab(tabId, (tab) => ({
      ...tab,
      waiting: true,
      queueCount: (tab.queuedMessages ?? []).length,
    }));
    if (ctx.stateRef.current.activeTabId === tabId) {
      ctx.setStatusFlags({ waiting: true, status: "thinking…" });
    }
  }
  if (message) {
    ctx.appendMessage(
      { id: crypto.randomUUID(), role: "system", text: message },
      tabId,
    );
    ctx.pushNotification({ title: message, kind: "warning" });
  }
};
