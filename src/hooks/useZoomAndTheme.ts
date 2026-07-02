import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { writeState } from "../persist";
import { applyUiScale, readZoom, writeUiViewportVars } from "../utils/viewport";
import { mirrorBootTheme, normalizeThemeId } from "../themeBootstrap";

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
  const { setState, pushNotification } = ctx;
  const mobileSurface = import.meta.env.VITE_AETHON_SURFACE === "mobile";

  useEffect(() => {
    const onResize = () => writeUiViewportVars(readZoom());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!mobileSurface) return;
    const applySyncedTheme = (raw: unknown) => {
      const id = syncedThemeId(raw);
      if (!id || document.documentElement.dataset.theme === id) return;
      applyThemeLocally(id, setState, false);
    };
    const unlistenTheme = listen("theme-changed", (event) => {
      applySyncedTheme(event.payload);
    });
    const unlistenState = listen("frontend-state", (event) => {
      applySyncedTheme(event.payload);
    });
    return () => {
      unlistenTheme.then((fn) => fn());
      unlistenState.then((fn) => fn());
    };
  }, [mobileSurface, setState]);

  function applyZoom(next: number) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const rounded = Math.round(clamped * 100) / 100;
    applyUiScale(rounded);
    writeState("ui_zoom", String(rounded)).catch(() => {
      /* best-effort */
    });
    pushNotification({
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
    const theme = normalizeThemeId(id);
    applyThemeLocally(theme, setState, true);
    if (mobileSurface) {
      invoke("set_theme", { id: theme }).catch((err: unknown) => {
        pushNotification({
          id: "ae-theme-sync",
          title: "Theme sync failed",
          kind: "warning",
          durationMs: 2200,
        });
        console.warn("set_theme failed:", err);
      });
      return;
    }
    emit("theme-changed", { id: theme }).catch(() => {
      /* best-effort remote sync */
    });
  }

  return { applyZoom, adjustZoom, resetZoom, setTheme };
}

function syncedThemeId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { id?: unknown; theme?: unknown };
  const raw = typeof record.id === "string" ? record.id : record.theme;
  return typeof raw === "string" && raw.trim()
    ? normalizeThemeId(raw.trim())
    : "";
}

function applyThemeLocally(
  id: string,
  setState: React.Dispatch<React.SetStateAction<Record<string, unknown>>>,
  persist: boolean,
) {
  const root = document.documentElement;
  // One-shot crossfade: enable surface/text transitions for the duration
  // of the swap, then drop the class so hover/idle interactions stay
  // snappy. Skipped implicitly under prefers-reduced-motion (the CSS
  // rule zeroes the transition there).
  root.classList.add("ae-theme-switching");
  window.setTimeout(() => root.classList.remove("ae-theme-switching"), 320);
  root.dataset.theme = id;
  mirrorBootTheme(id);
  if (persist) {
    writeState("theme", id).catch(() => {
      /* ignore */
    });
  }
  // Update /sidebar/themes' active flag so the appearance pulldown +
  // sidebar themes section both reflect the new selection without a
  // separate hydrate pass.
  setState((prev) => {
    const sidebar = (prev.sidebar as Record<string, unknown> | undefined) ?? {};
    const themes = ((sidebar.themes as { id: string; label: string }[] | undefined) ?? [])
      .map((t) => ({ ...t, active: t.id === id }));
    return { ...prev, sidebar: { ...sidebar, themes } };
  });
}
