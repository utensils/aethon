import { layoutPatch } from "../../utils/stateMutation";
import type { BridgeMessageHandler } from "./types";

/** Extension mutated a path inside the active layout (e.g. add a sidebar
 *  section, swap a child). Immutable patch that preserves arrays — the
 *  generic setPointer collapses arrays into plain objects on traversal
 *  because it spreads with `{...existing}`, which would crash the
 *  renderer on `components.map()`. Walk manually here so arrays stay
 *  arrays. */
export const handleLayoutPatch: BridgeMessageHandler = (data, ctx) => {
  const path = data.path as string | undefined;
  if (!path) {
    ctx.ackMutation(data.mutationId, false, "missing path");
    return;
  }
  ctx.setLayout((prev) => layoutPatch(prev, path, data.value));
  ctx.ackMutation(data.mutationId, true);
};
