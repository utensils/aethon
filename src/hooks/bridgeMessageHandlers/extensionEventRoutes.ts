import type { BridgeMessageHandler } from "./types";

export const handleExtensionEventRoutes: BridgeMessageHandler = (data, ctx) => {
  const list =
    (data.routes as
      | { componentId?: string; eventType?: string }[]
      | undefined) ?? [];
  const mode = data.mode === "extension" ? "extension" : "builtin";
  ctx.hydrateEventRoutes(list, mode);
  ctx.ackMutation(data.mutationId, true);
};
