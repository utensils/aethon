import type { EventRouteHandler } from "./types";
import {
  clearLayoutPrefs,
  resetLayoutPrefsInState,
} from "../layoutPrefs";

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
  if (eventType === "open-system-prompt") {
    void ctx
      .invoke("aethon_home_dir")
      .then(async (dir) => {
        if (typeof dir !== "string" || dir.length === 0) {
          throw new Error("Aethon directory unavailable");
        }
        const fileName = "system-prompt.md";
        const existing = await ctx.invoke("read_state", { name: fileName });
        if (typeof existing !== "string" || existing.length === 0) {
          await ctx.invoke("write_state", { name: fileName, content: "" });
        }
        ctx.newEditorTab(`${dir}/${fileName}`, { rootPath: dir });
        ctx.closeSettings();
      })
      .catch((err: unknown) => {
        ctx.pushNotification({
          title: "Open system prompt failed",
          message: String(err),
          kind: "error",
          durationMs: 6000,
        });
      });
    return true;
  }
  if (eventType === "reset-layout-prefs") {
    ctx.setState((prev) => resetLayoutPrefsInState(prev));
    void clearLayoutPrefs(ctx.writeState);
    void ctx.writeState("file-tree-prefs.json", "");
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("aethon:reset-file-tree-prefs"));
    }
    ctx.pushNotification({
      title: "Layout reset",
      message: "Sidebar and panel sizes restored.",
      kind: "success",
      durationMs: 2400,
    });
    return true;
  }
  return false;
};
