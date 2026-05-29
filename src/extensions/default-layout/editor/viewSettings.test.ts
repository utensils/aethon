import { describe, expect, it } from "vitest";

import {
  clampFontZoom,
  DEFAULT_VIEW_SETTINGS,
  EDITOR_BASE_FONT_SIZE,
  FONT_ZOOM_MAX,
  FONT_ZOOM_MIN,
  loadViewSettings,
  monacoOptionsFor,
  persistViewSetting,
} from "./viewSettings";

/** Minimal in-memory Storage stand-in so tests don't touch a real DOM. */
function memStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("clampFontZoom", () => {
  it("clamps above the max", () => {
    expect(clampFontZoom(5)).toBe(FONT_ZOOM_MAX);
  });
  it("clamps below the min", () => {
    expect(clampFontZoom(0.1)).toBe(FONT_ZOOM_MIN);
  });
  it("snaps to the 0.1 grid without float drift", () => {
    expect(clampFontZoom(1.0 + 0.1 + 0.1)).toBe(1.2);
  });
  it("falls back to default on NaN", () => {
    expect(clampFontZoom(Number.NaN)).toBe(DEFAULT_VIEW_SETTINGS.fontZoom);
  });
});

describe("loadViewSettings", () => {
  it("returns defaults when storage is empty", () => {
    expect(loadViewSettings(memStorage())).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  it("reads persisted booleans and zoom", () => {
    const storage = memStorage({
      "aethon.editor.wordWrap": "true",
      "aethon.editor.minimap": "true",
      "aethon.editor.lineNumbers": "false",
      "aethon.editor.fontZoom": "1.5",
    });
    expect(loadViewSettings(storage)).toEqual({
      wordWrap: true,
      minimap: true,
      lineNumbers: false,
      fontZoom: 1.5,
    });
  });

  it("clamps a corrupt persisted zoom", () => {
    const storage = memStorage({ "aethon.editor.fontZoom": "99" });
    expect(loadViewSettings(storage).fontZoom).toBe(FONT_ZOOM_MAX);
  });

  it("treats a non-'true' boolean string as false", () => {
    const storage = memStorage({ "aethon.editor.lineNumbers": "garbage" });
    expect(loadViewSettings(storage).lineNumbers).toBe(false);
  });
});

describe("persistViewSetting", () => {
  it("round-trips a value through storage", () => {
    const storage = memStorage();
    persistViewSetting("wordWrap", true, storage);
    persistViewSetting("fontZoom", 1.3, storage);
    expect(loadViewSettings(storage).wordWrap).toBe(true);
    expect(loadViewSettings(storage).fontZoom).toBe(1.3);
  });

  it("never throws when storage rejects writes", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(() => persistViewSetting("minimap", true, broken)).not.toThrow();
  });
});

describe("monacoOptionsFor", () => {
  it("maps settings to Monaco option shapes", () => {
    expect(
      monacoOptionsFor({
        wordWrap: true,
        minimap: false,
        lineNumbers: true,
        fontZoom: 2,
      }),
    ).toEqual({
      wordWrap: "on",
      minimap: { enabled: false },
      lineNumbers: "on",
      fontSize: EDITOR_BASE_FONT_SIZE * 2,
    });
  });
});
