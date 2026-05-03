import type { BridgeMessageHandler } from "./types";

export const handleExtensionSlashCommands: BridgeMessageHandler = (data, ctx) => {
  const list =
    (data.commands as
      | { name: string; description: string; usage?: string }[]
      | undefined) ?? [];
  ctx.hydrateSlashCommands(list);
  ctx.ackMutation(data.mutationId, true);
};
