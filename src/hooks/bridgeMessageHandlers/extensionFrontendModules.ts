import type { BridgeMessageHandler } from "./types";

export const handleExtensionFrontendModules: BridgeMessageHandler = (data, ctx) => {
  const list =
    (data.modules as { name: string; code: string }[] | undefined) ?? [];
  ctx.hydrateFrontendModules(list);
  ctx.ackMutation(data.mutationId, true);
};
