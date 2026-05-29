// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useEditorViewSettings } from "./useEditorViewSettings";
import { DEFAULT_VIEW_SETTINGS, FONT_ZOOM_MAX } from "./viewSettings";

// This jsdom/bun runner doesn't ship a localStorage; install a minimal
// in-memory one so the hook's persistence path is exercised for real.
function installMemoryLocalStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
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
    },
  });
}

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  localStorage.clear();
});

describe("useEditorViewSettings", () => {
  it("starts from defaults", () => {
    const { result } = renderHook(() => useEditorViewSettings());
    expect(result.current.settings).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  it("toggles word wrap and persists", () => {
    const { result } = renderHook(() => useEditorViewSettings());
    act(() => result.current.toggleWordWrap());
    expect(result.current.settings.wordWrap).toBe(true);
    expect(localStorage.getItem("aethon.editor.wordWrap")).toBe("true");
  });

  it("toggles minimap and line numbers independently", () => {
    const { result } = renderHook(() => useEditorViewSettings());
    act(() => result.current.toggleMinimap());
    act(() => result.current.toggleLineNumbers());
    expect(result.current.settings.minimap).toBe(true);
    expect(result.current.settings.lineNumbers).toBe(false);
  });

  it("zooms in and out in 0.1 steps and persists", () => {
    const { result } = renderHook(() => useEditorViewSettings());
    act(() => result.current.zoomIn());
    expect(result.current.settings.fontZoom).toBe(1.1);
    act(() => result.current.zoomOut());
    act(() => result.current.zoomOut());
    expect(result.current.settings.fontZoom).toBe(0.9);
    expect(localStorage.getItem("aethon.editor.fontZoom")).toBe("0.9");
  });

  it("clamps zoom at the maximum", () => {
    const { result } = renderHook(() => useEditorViewSettings());
    for (let i = 0; i < 30; i++) act(() => result.current.zoomIn());
    expect(result.current.settings.fontZoom).toBe(FONT_ZOOM_MAX);
  });

  it("resets zoom to 1.0", () => {
    const { result } = renderHook(() => useEditorViewSettings());
    act(() => result.current.zoomIn());
    act(() => result.current.resetZoom());
    expect(result.current.settings.fontZoom).toBe(1.0);
  });

  it("rehydrates persisted settings on remount", () => {
    const first = renderHook(() => useEditorViewSettings());
    act(() => first.result.current.toggleWordWrap());
    first.unmount();
    const second = renderHook(() => useEditorViewSettings());
    expect(second.result.current.settings.wordWrap).toBe(true);
  });
});
