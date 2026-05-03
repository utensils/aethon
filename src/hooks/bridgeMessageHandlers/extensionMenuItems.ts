import { invoke } from "@tauri-apps/api/core";
import type { BridgeMessageHandler } from "./types";

export const handleExtensionMenuItems: BridgeMessageHandler = (data, ctx) => {
  const list =
    (data.items as
      | {
          id: string;
          label: string;
          action: string;
          location: "app" | "tray";
          parent?: string;
        }[]
      | undefined) ?? [];
  // Forward to Tauri so the native menu rebuilds. Ack on success
  // (rebuild) or failure (rare — usually means a malformed item
  // slipped through validation).
  invoke("set_extension_menu_items", { items: list })
    .then(() => ctx.ackMutation(data.mutationId, true))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ackMutation(
        data.mutationId,
        false,
        `frontend_rejected: set_extension_menu_items ${message}`,
      );
    });
};
