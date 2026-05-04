import type { ExtensionTheme } from "../useExtensionsHydration";
import type { BridgeMessageHandler } from "./types";

export const handleExtensionThemes: BridgeMessageHandler = (data, ctx) => {
  const themes = (data.themes as ExtensionTheme[] | undefined) ?? [];
  ctx.hydrateThemes(themes);
  ctx.ackMutation(data.mutationId, true);
};
