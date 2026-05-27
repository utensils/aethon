import { usePaletteOverlay } from "./uiOverlays/palette";
import { useSearchOverlay } from "./uiOverlays/search";
import { useSettingsOverlay } from "./uiOverlays/settings";
import type {
  UseUiOverlaysActions,
  UseUiOverlaysContext,
} from "./uiOverlays/types";

export type { UseUiOverlaysActions, UseUiOverlaysContext };

/**
 * Three modal/overlay surfaces that render at App root over every
 * layout: command palette (Cmd+P / Cmd+Shift+P), settings panel
 * (Cmd+,), and cross-session search (Cmd+Shift+F). Each owns its
 * open/close/setters and exposes them for the dispatch ctx.
 *
 * Settings save composes a full config from (live snapshot + pending
 * overlay), invokes `write_config`, then re-primes the in-memory cache
 * via `reapplyConfig` so the running app picks up the new values
 * without a page reload.
 *
 * Palette dispatch routes the serializable item.payload to the right
 * App helper — kept here so the palette component itself stays a pure
 * renderer.
 */
export function useUiOverlays(
  ctx: UseUiOverlaysContext,
): UseUiOverlaysActions {
  const settings = useSettingsOverlay(ctx);
  const search = useSearchOverlay(ctx);
  const palette = usePaletteOverlay(ctx);

  return {
    ...settings,
    ...search,
    ...palette,
  };
}
