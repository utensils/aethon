import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { Tab } from "../types/tab";
import { isFocusInTerminalPanel } from "../utils/focus";

export interface UseFocusContext {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
}

export interface UseFocusActions {
  toggleTerminal: () => void;
  toggleTerminalAndFocus: () => void;
  toggleFocusComposerTerminal: () => void;
  focusActiveContextInput: () => void;
  focusComposer: () => void;
  focusTerminalPanel: () => void;
  toggleSidebar: () => void;
}

/**
 * Focus + chrome-toggle helpers. The hook owns:
 *   - terminal panel toggling (open/close + focus shuttle)
 *   - composer/terminal focus routing for Cmd+0 and Cmd+L
 *   - sidebar visibility toggle (atomic columns + areas swap)
 *
 * Intentionally has no React lifecycle of its own — every helper reads
 * `stateRef.current` and writes through `setState`. The hook form keeps
 * the surface uniform with the rest of `src/hooks/` and lets a future
 * refactor add an effect (e.g. focus-restore on tab switch) here without
 * shifting the call site.
 */
export function useFocus(ctx: UseFocusContext): UseFocusActions {
  const { setState, stateRef } = ctx;

  function toggleTerminal() {
    setState((prev) => {
      const term = (prev.terminal as { open?: boolean; output?: string }) ?? {};
      return { ...prev, terminal: { ...term, open: !term.open } };
    });
  }

  function focusComposer() {
    if (typeof document === "undefined") return;
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".a2ui-chat-input textarea, .a2ui-chat-input input",
    );
    ta?.focus();
  }

  function focusTerminalPanel() {
    if (typeof document === "undefined") return;
    // xterm renders an inner textarea (`.xterm-helper-textarea`) that
    // it forwards keystrokes to. Focusing it routes typing into the
    // active sub-tab's PTY (or the read-only agent-bash xterm where
    // it's a no-op input but the cursor still indicates focus).
    const panel = document.querySelector(".ae-terminal-panel");
    const helperTa = panel?.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    if (helperTa) {
      helperTa.focus();
      return;
    }
    // Fallback: focus the panel's first focusable element.
    const focusable = panel?.querySelector<HTMLElement>(
      'button, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }

  /** Toggle the terminal panel AND move focus to/from it.
   *
   *  Open + focus: pulls focus into the active sub-tab's terminal
   *  (xterm has a `.focus()` method exposed via the live DOM).
   *  Close + return-focus: drops focus back to the chat composer so
   *  typing continues seamlessly. Without this users have to re-click
   *  to refocus after every panel toggle. */
  function toggleTerminalAndFocus() {
    const wasOpen = !!(stateRef.current.terminal as { open?: boolean } | undefined)?.open;
    toggleTerminal();
    // Defer focus until after React has committed the render so the
    // panel's xterm canvas exists in the DOM.
    requestAnimationFrame(() => {
      if (wasOpen) {
        focusComposer();
      } else {
        focusTerminalPanel();
      }
    });
  }

  /** Cmd+0: toggle focus between the chat composer and the bottom
   *  terminal panel. If the panel is closed, opens it first. */
  function toggleFocusComposerTerminal() {
    const inPanel = isFocusInTerminalPanel();
    if (inPanel) {
      focusComposer();
      return;
    }
    const term = (stateRef.current.terminal as { open?: boolean } | undefined) ?? {};
    if (!term.open) {
      // Open first, then focus on the next frame.
      setState((prev) => {
        const t = (prev.terminal as { open?: boolean } | undefined) ?? {};
        return { ...prev, terminal: { ...t, open: true } };
      });
    }
    requestAnimationFrame(() => focusTerminalPanel());
  }

  /** Cmd+L: focus the active tab's primary input. Agent tab → chat
   *  composer, shell tab → that shell's xterm. The bottom terminal
   *  panel is opened first when needed so the focus call has a target
   *  to land on. */
  function focusActiveContextInput() {
    const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
    const activeId = stateRef.current.activeTabId as string | undefined;
    const tab = activeId ? tabs.find((t) => t.id === activeId) : undefined;
    if (tab?.kind === "shell") {
      const term =
        (stateRef.current.terminal as { open?: boolean } | undefined) ?? {};
      if (!term.open) {
        setState((prev) => {
          const t = (prev.terminal as { open?: boolean } | undefined) ?? {};
          return { ...prev, terminal: { ...t, open: true } };
        });
      }
      requestAnimationFrame(() => focusTerminalPanel());
      return;
    }
    focusComposer();
  }

  function toggleSidebar() {
    setState((prev) => {
      // Flip /layout/sidebarVisible AND swap /layout/columns +
      // /layout/areas atomically so the grid template adapts on
      // the same frame the sidebar cell hides. Without the
      // template swap the hidden sidebar would still reserve its
      // 220px column. Workstation hoists tabs into the header
      // (5 rows total); future layout variations may own their own
      // area templates and not bind /layout/areas, so this toggle
      // stays workstation-shaped.
      const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
      const visible = !((layout.sidebarVisible as boolean | undefined) ?? true);
      const columns = visible ? "220px minmax(0,1fr)" : "minmax(0,1fr)";
      const areas = visible
        ? [
            "sidebar header",
            "sidebar canvas",
            "sidebar terminal",
            "sidebar composer",
            "status status",
          ]
        : ["header", "canvas", "terminal", "composer", "status"];
      return {
        ...prev,
        layout: { ...layout, sidebarVisible: visible, columns, areas },
      };
    });
  }

  return {
    toggleTerminal,
    toggleTerminalAndFocus,
    toggleFocusComposerTerminal,
    focusActiveContextInput,
    focusComposer,
    focusTerminalPanel,
    toggleSidebar,
  };
}
