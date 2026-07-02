import type { EventRouteHandler } from "../types";

function rawDeviceId(value: unknown): string {
  return typeof value === "string" ? value.replace(/^device:/, "") : "";
}

/** sidebar unpair-mobile-device: revoke a paired client token and clear
 *  its read-only landing if that device owns the current canvas. */
export const handleSidebarUnpairMobileDevice: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType !== "unpair-mobile-device") return false;
  const selected = data as
    | { deviceId?: string; itemId?: string; label?: string }
    | undefined;
  const itemId = selected?.deviceId ?? selected?.itemId ?? "";
  const deviceId = rawDeviceId(itemId);
  if (!deviceId) return true;
  const label = selected?.label ?? deviceId;
  ctx
    .invoke("remote_device_revoke", { id: deviceId })
    .then(() => {
      ctx.setState((prev) => {
        const landing = prev.landing as
          | { kind?: string; deviceId?: string }
          | null
          | undefined;
        if (
          landing?.kind === "mobile-device" &&
          rawDeviceId(landing.deviceId) === deviceId
        ) {
          return { ...prev, landing: null };
        }
        return prev;
      });
      ctx.pushNotification({
        title: "Device unpaired",
        message: label,
        kind: "success",
      });
    })
    .catch((err: unknown) => {
      ctx.pushNotification({
        title: "Unpair device failed",
        message: String(err),
        kind: "error",
      });
    });
  return true;
};
