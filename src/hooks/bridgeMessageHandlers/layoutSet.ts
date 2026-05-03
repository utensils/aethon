import { deepMergeState } from "../../utils/stateMutation";
import type { A2UIPayload } from "../../types/a2ui";
import type { BridgeMessageHandler } from "./types";

/** Extension swapped the active layout wholesale. Goes through the same
 *  path window.aethon.setLayout uses so the new payload hydrates state
 *  and renders identically to a default-layout boot. */
export const handleLayoutSet: BridgeMessageHandler = (data, ctx) => {
  const next = data.payload as A2UIPayload | undefined;
  if (!next || typeof next !== "object" || !Array.isArray(next.components)) {
    ctx.ackMutation(data.mutationId, false, "payload missing components[]");
    return;
  }
  ctx.setLayout(next);
  if (next.state) {
    // Layout state contributes BOOT DEFAULTS — only fills keys that
    // aren't already set in live state. Existing runtime fields
    // (status, model, connection, sidebar.models, …) win. Achieved by
    // deep-merging with prev as the override layer.
    ctx.setState((prev) =>
      deepMergeState(next.state as Record<string, unknown>, prev),
    );
  }
  ctx.ackMutation(data.mutationId, true);
};
