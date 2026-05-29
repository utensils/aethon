// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";

import { usePaletteOverlay } from "./palette";
import type { UseUiOverlaysContext } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

afterEach(() => vi.restoreAllMocks());

/** A minimal palette context — only the bits openPalette("files") touches. */
function makeCtx(setState: ReturnType<typeof vi.fn>) {
  const stateRef = {
    current: { project: undefined, activeTabId: "t" },
  } as unknown as MutableRefObject<Record<string, unknown>>;
  const noop = vi.fn();
  return {
    setState,
    stateRef,
    pushNotification: noop,
    setActiveTab: noop,
    newTab: noop,
    newEditorTab: noop,
    setActiveProjectById: noop,
    openProjectFromPicker: noop,
    closeTab: noop,
    nextTab: noop,
    toggleTerminalAndFocus: noop,
    toggleFocusComposerTerminal: noop,
    clearChat: noop,
    stopPrompt: noop,
    adjustZoom: noop,
    resetZoom: noop,
    setTheme: noop,
    setModel: noop,
    activateLayoutById: noop,
    sendChat: noop,
    slashCommandsRef: { current: [] },
    slashContext: () => ({}),
  } as unknown as UseUiOverlaysContext;
}

describe("usePaletteOverlay — goto-file bridge", () => {
  it("opens quick-open file mode when aethon:goto-file fires", () => {
    const setState = vi.fn();
    renderHook(() => usePaletteOverlay(makeCtx(setState)));

    window.dispatchEvent(new Event("aethon:goto-file"));

    expect(setState).toHaveBeenCalledTimes(1);
    const updater = setState.mock.calls[0][0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    const next = updater({});
    const palette = next.palette as { open?: boolean; mode?: string };
    expect(palette.open).toBe(true);
    expect(palette.mode).toBe("files");
  });

  it("removes the listener on unmount", () => {
    const setState = vi.fn();
    const { unmount } = renderHook(() => usePaletteOverlay(makeCtx(setState)));
    unmount();
    window.dispatchEvent(new Event("aethon:goto-file"));
    expect(setState).not.toHaveBeenCalled();
  });
});
