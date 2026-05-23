// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import {
  useKeyboardShortcuts,
  type UseKeyboardShortcutsContext,
} from "./useKeyboardShortcuts";

afterEach(() => {
  cleanup();
});

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

function Harness({ ctx }: { ctx: UseKeyboardShortcutsContext }) {
  useKeyboardShortcuts(ctx);
  return null;
}

function buildContext(
  state: Record<string, unknown>,
): UseKeyboardShortcutsContext {
  return {
    stateRef: ref(state),
    extensionKeybindingsRef: ref(new Map()),
    shortcutsNewTabKindRef: ref("agent"),
    toggleTerminalAndFocus: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleFilesSidebar: vi.fn(),
    toggleEditorPreview: vi.fn(),
    clearChat: vi.fn(),
    stopPrompt: vi.fn(),
    newTab: vi.fn(),
    newShellTab: vi.fn(),
    nextTab: vi.fn(),
    nextShellSubTab: vi.fn(),
    moveActiveTab: vi.fn(),
    moveActiveShellSubTab: vi.fn(),
    jumpToTab: vi.fn(),
    jumpToShellSubTab: vi.fn(),
    reopenLastClosedTab: vi.fn(),
    closeTab: vi.fn(),
    toggleSessionSearch: vi.fn(),
    openPalette: vi.fn(),
    closePalette: vi.fn(),
    adjustZoom: vi.fn(),
    resetZoom: vi.fn(),
    toggleFocusComposerTerminal: vi.fn(),
    toggleSettings: vi.fn(),
    closeSettings: vi.fn(),
    focusActiveContextInput: vi.fn(),
    exportActiveChatMarkdown: vi.fn(() => Promise.resolve()),
    pushNotification: vi.fn(),
  };
}

describe("useKeyboardShortcuts Escape handling", () => {
  it("closes Settings when it is the active overlay", () => {
    const ctx = buildContext({
      palette: { open: false },
      settings: { open: true },
    });
    render(<Harness ctx={ctx} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(ctx.closeSettings).toHaveBeenCalledTimes(1);
    expect(ctx.closePalette).not.toHaveBeenCalled();
  });

  it("keeps palette precedence over Settings", () => {
    const ctx = buildContext({
      palette: { open: true },
      settings: { open: true },
    });
    render(<Harness ctx={ctx} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(ctx.closePalette).toHaveBeenCalledTimes(1);
    expect(ctx.closeSettings).not.toHaveBeenCalled();
  });
});
