/**
 * Editor view settings — pure model + localStorage persistence for the
 * Monaco "View" menu (word wrap, minimap, line numbers, font zoom).
 *
 * Kept framework-free so the clamp / parse / serialize logic is unit
 * testable without React; `useEditorViewSettings` (sibling file) is the
 * thin hook that wires this to component state. Mirrors claudette's
 * `editor_*` localStorage keys but namespaced under `aethon.editor.*`.
 */

export interface EditorViewSettings {
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  /** Multiplier on the base font size. Clamped to [MIN, MAX] in steps. */
  fontZoom: number;
}

/** Base Monaco font size in px; fontZoom multiplies it. */
export const EDITOR_BASE_FONT_SIZE = 13;
export const FONT_ZOOM_MIN = 0.7;
export const FONT_ZOOM_MAX = 2.0;
export const FONT_ZOOM_STEP = 0.1;

export const DEFAULT_VIEW_SETTINGS: EditorViewSettings = {
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  fontZoom: 1.0,
};

const STORAGE_KEYS = {
  wordWrap: "aethon.editor.wordWrap",
  minimap: "aethon.editor.minimap",
  lineNumbers: "aethon.editor.lineNumbers",
  fontZoom: "aethon.editor.fontZoom",
} as const;

/** Clamp + snap a zoom multiplier to the allowed range / step grid so a
 *  corrupt persisted value (or repeated stepping) can't drift the editor
 *  into an unusable size. Rounds to the nearest 0.1 to avoid float drift. */
export function clampFontZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VIEW_SETTINGS.fontZoom;
  const snapped = Math.round(value / FONT_ZOOM_STEP) * FONT_ZOOM_STEP;
  const clamped = Math.min(FONT_ZOOM_MAX, Math.max(FONT_ZOOM_MIN, snapped));
  // One decimal place — kills accumulated 0.1+0.2 style float noise.
  return Math.round(clamped * 10) / 10;
}

function readBool(
  storage: Storage | undefined,
  key: string,
  fallback: boolean,
): boolean {
  try {
    const raw = storage?.getItem(key);
    if (raw == null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function readZoom(storage: Storage | undefined): number {
  try {
    const raw = storage?.getItem(STORAGE_KEYS.fontZoom);
    if (raw == null) return DEFAULT_VIEW_SETTINGS.fontZoom;
    return clampFontZoom(Number.parseFloat(raw));
  } catch {
    return DEFAULT_VIEW_SETTINGS.fontZoom;
  }
}

/** Load persisted settings, falling back to defaults for any missing /
 *  corrupt key. `storage` is injectable for tests; defaults to
 *  `window.localStorage` when available. */
export function loadViewSettings(
  storage: Storage | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined,
): EditorViewSettings {
  return {
    wordWrap: readBool(
      storage,
      STORAGE_KEYS.wordWrap,
      DEFAULT_VIEW_SETTINGS.wordWrap,
    ),
    minimap: readBool(
      storage,
      STORAGE_KEYS.minimap,
      DEFAULT_VIEW_SETTINGS.minimap,
    ),
    lineNumbers: readBool(
      storage,
      STORAGE_KEYS.lineNumbers,
      DEFAULT_VIEW_SETTINGS.lineNumbers,
    ),
    fontZoom: readZoom(storage),
  };
}

/** Persist a single setting. Best-effort: a thrown quota / disabled-storage
 *  error is swallowed so toggling a view option never crashes the editor. */
export function persistViewSetting<K extends keyof EditorViewSettings>(
  key: K,
  value: EditorViewSettings[K],
  storage: Storage | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : undefined,
): void {
  try {
    storage?.setItem(STORAGE_KEYS[key], String(value));
  } catch {
    /* storage unavailable — in-memory value still applies this session */
  }
}

/** Map the settings to the Monaco `IEditorOptions` subset they control.
 *  Centralised so the canvas applies them identically on mount, model
 *  swap, and change. */
export function monacoOptionsFor(settings: EditorViewSettings): {
  wordWrap: "on" | "off";
  minimap: { enabled: boolean };
  lineNumbers: "on" | "off";
  fontSize: number;
} {
  return {
    wordWrap: settings.wordWrap ? "on" : "off",
    minimap: { enabled: settings.minimap },
    lineNumbers: settings.lineNumbers ? "on" : "off",
    fontSize: EDITOR_BASE_FONT_SIZE * settings.fontZoom,
  };
}
