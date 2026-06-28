import type { BridgeMessageHandler } from "./types";
import { clearPendingForksForTab } from "../../eventRoutes/session";

/** The bridge forked the SQLite-backed session and allocated `newTabId`.
 * Pi's default session file is a sidecar only; Aethon opens the new tab from
 * SQLite state and never copies/reads pi session files. */
export const handleSessionForked: BridgeMessageHandler = (data, ctx) => {
  const newTabId = typeof data.newTabId === "string" ? data.newTabId : "";
  const label = typeof data.label === "string" ? data.label : "Fork";
  const cwd = typeof data.cwd === "string" ? data.cwd : undefined;
  const sourceTabId = typeof data.tabId === "string" ? data.tabId : "";
  if (!newTabId) return;

  ctx.newTab(newTabId, label, {
    restoredSession: true,
    ...(cwd ? { cwd } : {}),
  });
  if (sourceTabId) ctx.dismissNotification(`session-fork-${sourceTabId}`);
  if (sourceTabId) clearPendingForksForTab(sourceTabId);
  ctx.pushNotification({
    title: "Forked session",
    message: `Opened ${label}.`,
    kind: "success",
    durationMs: 3000,
  });
};
