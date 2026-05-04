import type { BridgeMessageHandler } from "./types";

export const handleNotificationDismiss: BridgeMessageHandler = (data, ctx) => {
  const id = data.id as string | undefined;
  if (id) ctx.dismissNotification(id);
  ctx.ackMutation(data.mutationId, true);
};
