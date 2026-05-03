import { useEffect } from "react";
import { writeState } from "../persist";
import { applyUiScale, readZoom, writeUiViewportVars } from "../utils/viewport";

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.6;

interface NotificationInput {
  id: string;
  title: string;
  kind?: "info" | "success" | "warning" | "error";
  durationMs?: number | null;
}

export interface UseZoomAndThemeContext {
  setState: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  /** Toast helper from App. The hook calls this with `id: "ae-zoom"` so
   *  rapid Cmd+/- presses replace the previous toast rather than stacking. */
  pushNotification: (n: NotificationInput) => void;
}

export interface UseZoomAndThemeActions {
  applyZoom: (next: number) => void;
  adjustZoom: (delta: number) => void;
  resetZoom: () => void;
  setTheme: (id: string) => void;
}

/**
 * UI zoom + theme switching. CSS `zoom` scales text + spacing together,
 * while the `--app-ui-scale` token lets viewport-bound shells and
 * portals divide their dimensions back down. Without that compensation,
 * 100vw/100vh elements become wider/taller than the visible window at
 * >100%. The hook also installs a `resize` listener that re-syncs the
 * viewport vars when the window changes size.
 *
 * Theme switching writes `data-theme` on the html element and updates
 * the sidebar's themes section so the appearance pulldown reflects the
 * new selection without a separate hydrate pass.
 */
export function useZoomAndTheme(
  ctx: UseZoomAndThemeContext,
): UseZoomAndThemeActions {
  useEffect(() => {
    const onResize = () => writeUiViewportVars(readZoom());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function applyZoom(next: number) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const rounded = Math.round(clamped * 100) / 100;
    applyUiScale(rounded);
    writeState("ui_zoom", String(rounded)).catch(() => {
      /* best-effort */
    });
    ctx.pushNotification({
      id: "ae-zoom",
      title: `Zoom ${Math.round(rounded * 100)}%`,
      kind: "info",
      durationMs: 1200,
    });
  }

  function adjustZoom(delta: number) {
    applyZoom(readZoom() + delta);
  }

  function resetZoom() {
    applyZoom(1);
  }

  function setTheme(id: string) {
    document.documentElement.dataset.theme = id;
    writeState("theme", id).catch(() => {
      /* ignore */
    });
    // Update /sidebar/themes' active flag so the appearance pulldown +
    // sidebar themes section both reflect the new selection without a
    // separate hydrate pass.
    ctx.setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
      const themes = ((sidebar.themes as { id: string; label: string }[] | undefined) ?? [])
        .map((t) => ({ ...t, active: t.id === id }));
      return { ...prev, sidebar: { ...sidebar, themes } };
    });
  }

  return { applyZoom, adjustZoom, resetZoom, setTheme };
}
