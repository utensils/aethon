import type { BridgeMessageHandler } from "./types";

/** Non-terminal — surface as a system message without ending the turn.
 *  Most notices deliberately leave waiting/status untouched: a second
 *  chat IPC while a prompt is in-flight should not hide Stop or clear
 *  the original prompt's waiting state. Notices with `busy: true` are
 *  the explicit exception used by retry flows to reassert that the tab
 *  is still working while the SDK owns a pending retry. Also surface as
 *  a warning toast so a notice that arrives while the user isn't looking
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
