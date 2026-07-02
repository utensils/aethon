import { deepMergeState } from "../../utils/stateMutation";
import type { A2UIPayload } from "../../types/a2ui";
import type { BridgeMessageHandler } from "./types";

/** Extension swapped the active layout wholesale. Goes through the same
 *  path window.aethon.setLayout uses so the new payload hydrates state
 *  and renders identically to a default-layout boot. */
export const handleLayoutSet: BridgeMessageHandler = (data, ctx) => {
  if (import.meta.env.VITE_AETHON_SURFACE === "mobile") {
    // The companion keeps its fixed mobile layout; ack so the sender
    // doesn't retry, but leave a trace for extension authors debugging
    // why their layout "succeeded" without effect on the phone.
    console.debug("layout_set ignored on the mobile surface");
    ctx.ackMutation(data.mutationId, true);
    return;
  }
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
