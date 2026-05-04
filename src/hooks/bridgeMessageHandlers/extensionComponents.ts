import type { BridgeMessageHandler } from "./types";

/** Bridge: a delta of extension-registered component templates. Wholesale
 *  replace — bridge is the source of truth for the current template set. */
export const handleExtensionComponents: BridgeMessageHandler = (data, ctx) => {
  const components = (data.components as Record<string, unknown>) ?? {};
  ctx.registry.setTemplates(components);
  ctx.ackMutation(data.mutationId, true);
};
