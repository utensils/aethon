import type { EventRouteHandler } from "../types";

/** sidebar toggle-extension: forward to the bridge so the user's
 *  disabled list is updated + persisted. The bridge re-emits `ready`
 *  on success so the sidebar entry shifts buckets without a refresh. */
export const handleSidebarToggleExtension: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "toggle-extension") return false;
  const selected = data as { name?: string; disabled?: boolean } | undefined;
  if (!selected?.name || typeof selected.disabled !== "boolean") return true;
  ctx
    .invoke("agent_command", {
      payload: JSON.stringify({
        type: "set_extension_disabled",
        name: selected.name,
        disabled: selected.disabled,
      }),
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: "Toggle extension failed",
        message: String(err),
        kind: "error",
      });
    });
  return true;
};
