import type { A2UIPayload } from "../../types/a2ui";
import type { BridgeMessageHandler } from "./types";

export const handleExtensionLayouts: BridgeMessageHandler = (data, ctx) => {
  const list =
    (data.layouts as
      | {
          id: string;
          name: string;
          description?: string;
          payload: A2UIPayload;
        }[]
      | undefined) ?? [];
  ctx.hydrateExtensionLayouts(list);
  ctx.ackMutation(data.mutationId, true);
};
