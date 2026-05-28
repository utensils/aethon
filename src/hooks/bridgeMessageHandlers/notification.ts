import type { NotificationEntry } from "../../extensions/default-layout/notifications";
import type { BridgeMessageHandler } from "./types";

/** Agent-pushed notification. Bridge supplies a stable id (so dismiss
 *  can reference it from agent code), title, optional message + kind +
 *  actions + durationMs. Auto-expiry runs on the frontend timer; the
 *  bridge doesn't track lifecycle. */
export const handleNotification: BridgeMessageHandler = (data, ctx) => {
  const n = (data.notification as Partial<NotificationEntry> | undefined) ?? {};
  if (typeof n.title === "string" && n.title) {
    ctx.pushNotification({
      ...(typeof n.id === "string" ? { id: n.id } : {}),
      title: n.title,
      ...(typeof n.message === "string" ? { message: n.message } : {}),
      ...(n.kind ? { kind: n.kind } : {}),
      ...(n.durationMs !== undefined ? { durationMs: n.durationMs } : {}),
      ...(Array.isArray(n.actions) ? { actions: n.actions } : {}),
    });
  }
  ctx.ackMutation(data.mutationId, true);
};
