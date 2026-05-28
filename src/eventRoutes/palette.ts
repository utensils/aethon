import type { EventRouteHandler } from "./types";
import type { PaletteItem } from "../extensions/default-layout/palette-items";

/** command-palette renders at App root and never goes through the
 *  dispatch_a2ui bridge (no agent counterpart to invoke). Events land
 *  here directly. Selection runs the item *after* closing the palette
 *  so a slow handler doesn't leave the result obscured.
 *
 *  Routed by `type:command-palette` (not id) so a custom layout payload
 *  that renames the palette instance still routes correctly. */
export const handlePalette: EventRouteHandler = (
  { eventType, data },
  ctx,
) => {
  if (eventType === "close") {
    ctx.closePalette();
    return true;
  }
  if (eventType === "query") {
    const value = (data as { value?: string } | undefined)?.value ?? "";
    ctx.setState((prev) => ({
      ...prev,
      palette: {
        ...(prev.palette ?? {}),
        query: value,
        selectedIndex: 0,
      },
    }));
    return true;
  }
  if (eventType === "navigate") {
    const idx = (data as { index?: number } | undefined)?.index ?? 0;
    ctx.setState((prev) => ({
      ...prev,
      palette: {
        ...(prev.palette ?? {}),
        selectedIndex: idx,
      },
    }));
    return true;
  }
  if (eventType === "select") {
    const item = (data as { item?: PaletteItem } | undefined)?.item;
    if (item) {
      ctx.closePalette();
      void ctx.runPaletteItem(item);
    }
    return true;
  }
  return false;
};
