import type { BridgeMessageHandler } from "./types";

export const handleExtensionKeybindings: BridgeMessageHandler = (data, ctx) => {
  const list =
    (data.bindings as
      | { combo: string; action: string; description?: string }[]
      | undefined) ?? [];
  ctx.hydrateKeybindings(list);
  ctx.ackMutation(data.mutationId, true);
};
