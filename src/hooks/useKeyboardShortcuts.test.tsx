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
  vi.unstubAllGlobals();
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

describe("Cmd+W is focus-aware", () => {
  function mountWithTerminalPanel(focused: "panel" | "elsewhere") {
    // Build a DOM fragment that mimics the workstation layout enough
    // for isFocusInTerminalPanel() to report the right answer.
    document.body.innerHTML = `
      <div class="ae-elsewhere"><textarea data-testid="elsewhere"></textarea></div>
      <div class="ae-terminal-panel"><textarea data-testid="panel-input" class="xterm-helper-textarea"></textarea></div>
    `;
    const target = document.querySelector<HTMLTextAreaElement>(
      focused === "panel"
        ? '[data-testid="panel-input"]'
        : '[data-testid="elsewhere"]',
    );
    target?.focus();
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("closes the active agent tab when focus is not in the terminal panel", () => {
    mountWithTerminalPanel("elsewhere");
    const ctx = buildContext({
      activeTabId: "agent-1",
      tabs: [{ id: "agent-1", kind: "agent", label: "Tab 1" }],
      terminalPanel: { activeSubId: "shell-1" },
    });
    render(<Harness ctx={ctx} />);
    fireEvent.keyDown(document, { key: "w", metaKey: true });
    expect(ctx.closeTab).toHaveBeenCalledWith("agent-1");
  });

  it("closes the active shell sub-tab when focus is in the terminal panel", () => {
    mountWithTerminalPanel("panel");
    const ctx = buildContext({
      activeTabId: "agent-1",
      tabs: [
        { id: "agent-1", kind: "agent", label: "Tab 1" },
        { id: "shell-1", kind: "shell", label: "Shell 1" },
      ],
      terminalPanel: { activeSubId: "shell-1" },
    });
    render(<Harness ctx={ctx} />);
    fireEvent.keyDown(document, { key: "w", metaKey: true });
    expect(ctx.closeTab).toHaveBeenCalledWith("shell-1");
  });

  it("closes the *displayed* shell when state still points at agent-bash on overview", () => {
    // Codex regression: on overview the panel clamps a stale
    // requestedActiveId="agent-bash" to the first real shell, but the
    // shortcut handler used to read raw state and no-op. The shared
    // resolver should now produce the same id.
    mountWithTerminalPanel("panel");
    const ctx = buildContext({
      activeTabId: "__overview__",
      tabs: [{ id: "shell-1", kind: "shell", label: "Shell 1" }],
      terminalPanel: { activeSubId: "agent-bash" },
    });
    render(<Harness ctx={ctx} />);
    fireEvent.keyDown(document, { key: "w", metaKey: true });
    expect(ctx.closeTab).toHaveBeenCalledWith("shell-1");
  });

  it("is a no-op in the terminal panel when only the agent-bash sub-tab is active", () => {
    // agent-bash is the always-present read-only sub-tab; it isn't a
    // real /tabs entry and has nothing to close. Cmd+W must not fall
    // through and accidentally kill the agent tab in the top strip.
    mountWithTerminalPanel("panel");
    const ctx = buildContext({
      activeTabId: "agent-1",
      tabs: [{ id: "agent-1", kind: "agent", label: "Tab 1" }],
      terminalPanel: { activeSubId: "agent-bash" },
    });
    render(<Harness ctx={ctx} />);
    fireEvent.keyDown(document, { key: "w", metaKey: true });
    expect(ctx.closeTab).not.toHaveBeenCalled();
  });
});

describe("Cmd+T terminal focus retention", () => {
  function mountTerminalFocusDom() {
    document.body.innerHTML = `
      <div class="ae-elsewhere"><textarea data-testid="elsewhere"></textarea></div>
      <div class="ae-terminal-panel"><textarea data-testid="panel-input" class="xterm-helper-textarea"></textarea></div>
    `;
    const panelInput = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="panel-input"]',
    );
    const elsewhere = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="elsewhere"]',
    );
    return { panelInput, elsewhere };
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("returns focus to the terminal after Cmd+T creates a shell sub-tab", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const { panelInput, elsewhere } = mountTerminalFocusDom();
    panelInput?.focus();
    const ctx = buildContext({
      activeTabId: "agent-1",
      tabs: [
        { id: "agent-1", kind: "agent", label: "Tab 1" },
        { id: "shell-1", kind: "shell", label: "Shell 1" },
      ],
      terminalPanel: { activeSubId: "shell-1" },
    });
    ctx.newShellTab = vi.fn(() => elsewhere?.focus());
    render(<Harness ctx={ctx} />);

    fireEvent.keyDown(document, { key: "t", metaKey: true });

    expect(ctx.newShellTab).toHaveBeenCalledTimes(1);
    expect(ctx.newTab).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(panelInput);
  });

  it("returns focus to the terminal after Cmd+Shift+T creates a shell sub-tab", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const { panelInput, elsewhere } = mountTerminalFocusDom();
    elsewhere?.focus();
    const ctx = buildContext({
      activeTabId: "agent-1",
      tabs: [{ id: "agent-1", kind: "agent", label: "Tab 1" }],
      terminalPanel: { activeSubId: "agent-bash" },
    });
    ctx.newShellTab = vi.fn(() => elsewhere?.focus());
    render(<Harness ctx={ctx} />);

    fireEvent.keyDown(document, { key: "t", metaKey: true, shiftKey: true });

    expect(ctx.newShellTab).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(panelInput);
  });
});
