/**
 * useEditorViewSettings — React binding over the framework-free
 * `viewSettings` model. Loads persisted values once, exposes the current
 * settings, and returns toggles / zoom controls that update state and
 * persist in one step. The canvas reads `settings` to drive
 * `editor.updateOptions` and passes the controls to the View menu.
 */
import { useCallback, useMemo, useState } from "react";

import {
  clampFontZoom,
  FONT_ZOOM_STEP,
  loadViewSettings,
  persistViewSetting,
  type EditorViewSettings,
} from "./viewSettings";

export interface EditorViewSettingsControls {
  settings: EditorViewSettings;
  toggleWordWrap: () => void;
  toggleMinimap: () => void;
  toggleLineNumbers: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export function useEditorViewSettings(): EditorViewSettingsControls {
  const [settings, setSettings] = useState<EditorViewSettings>(() =>
    loadViewSettings(),
  );

  const toggleBool = useCallback(
    (key: "wordWrap" | "minimap" | "lineNumbers") => {
      setSettings((prev) => {
        const value = !prev[key];
        persistViewSetting(key, value);
        return { ...prev, [key]: value };
      });
    },
    [],
  );

  const setZoom = useCallback((next: (current: number) => number) => {
    setSettings((prev) => {
      const value = clampFontZoom(next(prev.fontZoom));
      persistViewSetting("fontZoom", value);
      return { ...prev, fontZoom: value };
    });
  }, []);

  const toggleWordWrap = useCallback(
    () => toggleBool("wordWrap"),
    [toggleBool],
  );
  const toggleMinimap = useCallback(() => toggleBool("minimap"), [toggleBool]);
  const toggleLineNumbers = useCallback(
    () => toggleBool("lineNumbers"),
    [toggleBool],
  );
  const zoomIn = useCallback(
    () => setZoom((c) => c + FONT_ZOOM_STEP),
    [setZoom],
  );
  const zoomOut = useCallback(
    () => setZoom((c) => c - FONT_ZOOM_STEP),
    [setZoom],
  );
  const resetZoom = useCallback(() => setZoom(() => 1.0), [setZoom]);

  return useMemo(
    () => ({
      settings,
      toggleWordWrap,
      toggleMinimap,
      toggleLineNumbers,
      zoomIn,
      zoomOut,
      resetZoom,
    }),
    [
      settings,
      toggleWordWrap,
      toggleMinimap,
      toggleLineNumbers,
      zoomIn,
      zoomOut,
      resetZoom,
    ],
  );
}
