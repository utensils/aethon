import type { EventRouteHandler } from "./types";

/** settings-panel renders at App root and never goes through the
 *  bridge — events drive the panel's pending overlay directly. */
export const handleSettings: EventRouteHandler = (
  { component, eventType, data },
  ctx,
) => {
  if (component.id !== "settings-panel") return false;
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
