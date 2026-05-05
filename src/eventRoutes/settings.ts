import type { EventRouteHandler } from "./types";

/** settings-panel renders at App root and never goes through the
 *  bridge — events drive the panel's pending overlay directly.
 *
 *  Routed by `type:settings-panel` so an extension's
 *  `aethon.registerComponent("settings-panel", custom)` override still
 *  receives events even when the layout payload renames the instance. */
export const handleSettings: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "close") {
    ctx.closeSettings();
    return true;
  }
  if (eventType === "update") {
    const patch = (data as { patch?: Record<string, unknown> } | undefined)
      ?.patch;
    if (patch) ctx.applySettingsPatch(patch);
    return true;
  }
  if (eventType === "save") {
    void ctx.saveSettings();
    return true;
  }
  return false;
};
