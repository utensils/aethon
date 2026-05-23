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
  toggleFilesSidebar: () => void;
}

const DEFAULT_LEFT_WIDTH = "220px";
const DEFAULT_RIGHT_WIDTH = "280px";
const DEFAULT_TERMINAL_HEIGHT = 240;

function parseWidth(token: string | undefined, fallback: string): string {
  return token && /^\d+px$/.test(token) ? token : fallback;
}

/**
 * Pick out the left + right px widths from any of the workstation's
 * column shapes. The modern grid stays 3-column so hidden sidebars can
 * animate as 0px tracks, but older persisted state may still have:
 *   [L, 1fr, R]   3-column (canonical)
 *   [L, 1fr]      2-column left-only
 *   [1fr, R]      2-column right-only
 *   [1fr]         1-column (both hidden)
 * Returns the first/last tokens iff they're `<n>px`. Width memos on
 * `layout.lastLeftWidth` / `layout.lastRightWidth` win over inference so
 * a hide/show round-trip restores the user's previous size. See
 * `workstationLayout` below for the consumer that uses these widths.
 */
function pickWidths(current: {
  columns?: unknown;
  lastLeftWidth?: unknown;
  lastRightWidth?: unknown;
}): { left: string; right: string } {
  const tokens =
    typeof current.columns === "string"
      ? current.columns.trim().split(/\s+/)
      : [];
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  // Right token is only the LAST token when there are ≥3 tokens (3-col
  // shape) or when the last token is px AND the layout had no left
  // sidebar (2-col right-only).
  const inferredLeft =
    first && !/^minmax/.test(first) && first !== "0px" ? first : undefined;
  const inferredRight =
    tokens.length >= 3 && last && /^\d+px$/.test(last) && last !== "0px"
      ? last
      : tokens.length === 2 &&
          last &&
          /^\d+px$/.test(last) &&
          last !== "0px" &&
          first &&
          /^minmax/.test(first)
        ? last
        : undefined;
  const memoLeft = typeof current.lastLeftWidth === "string"
    ? current.lastLeftWidth
    : undefined;
  const memoRight = typeof current.lastRightWidth === "string"
    ? current.lastRightWidth
    : undefined;
  return {
    left: parseWidth(inferredLeft ?? memoLeft, DEFAULT_LEFT_WIDTH),
    right: parseWidth(inferredRight ?? memoRight, DEFAULT_RIGHT_WIDTH),
  };
}

/**
 * Compose the workstation grid template from `{left, right}` visibility +
 * the user's most-recently-resized widths. Layout-as-payload means the
 * sidebar can't just `display: none` — that snaps in WebKit. Keep a
 * stable 3-column grid and animate hidden chrome tracks down to 0px.
 *
 * Width tokens are pulled from the current `layout.columns` so user
 * resizes survive a hide/show round-trip; falls back to the boot defaults
 * when the token is missing or malformed.
 */
export function workstationLayout(
  current: {
    columns?: unknown;
    lastLeftWidth?: unknown;
    lastRightWidth?: unknown;
  },
  leftVisible: boolean,
  rightVisible: boolean,
): {
  columns: string;
  areas: string[];
  lastLeftWidth: string;
  lastRightWidth: string;
} {
  const { left, right } = pickWidths(current);

  const parts = [
    leftVisible ? left : "0px",
    "minmax(0,1fr)",
    rightVisible ? right : "0px",
  ];
  const areaCols = ["sidebar", "__center__", "files-sidebar"];
  const centerIndex = 1;

  const rowFor = (centerName: string) => {
    const cols = [...areaCols];
    cols[centerIndex] = centerName;
    return cols.join(" ");
  };
  const statusRow = areaCols.map(() => "status").join(" ");

  return {
    columns: parts.join(" "),
    areas: [
      rowFor("header"),
      rowFor("canvas"),
      rowFor("terminal"),
      rowFor("composer"),
      statusRow,
    ],
    lastLeftWidth: left,
    lastRightWidth: right,
  };
}

function terminalHeightFromState(state: Record<string, unknown>): number {
  const panel = state.terminalPanel as { height?: unknown } | undefined;
  const height = panel?.height;
  return typeof height === "number" && Number.isFinite(height)
    ? Math.max(120, Math.min(720, Math.round(height)))
    : DEFAULT_TERMINAL_HEIGHT;
}

export function workstationRows(
  terminalOpen: boolean,
  terminalHeight: number,
): string {
  const terminalTrack = terminalOpen
    ? `${Math.max(120, Math.min(720, Math.round(terminalHeight)))}px`
    : "0px";
  return `38px minmax(0,1fr) ${terminalTrack} auto auto`;
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
      const nextOpen = !term.open;
      const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
      return {
        ...prev,
        terminal: { ...term, open: nextOpen },
        layout: {
          ...layout,
          rows: workstationRows(nextOpen, terminalHeightFromState(prev)),
        },
      };
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
        const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
        return {
          ...prev,
          terminal: { ...t, open: true },
          layout: {
            ...layout,
            rows: workstationRows(true, terminalHeightFromState(prev)),
          },
        };
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
          const layout =
            (prev.layout as Record<string, unknown> | undefined) ?? {};
          return {
            ...prev,
            terminal: { ...t, open: true },
            layout: {
              ...layout,
              rows: workstationRows(true, terminalHeightFromState(prev)),
            },
          };
        });
      }
      requestAnimationFrame(() => focusTerminalPanel());
      return;
    }
    focusComposer();
  }

  function toggleSidebar() {
    setState((prev) => {
      const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
      const leftVisible = !((layout.sidebarVisible as boolean | undefined) ?? true);
      const rightVisible =
        (layout.filesSidebarVisible as boolean | undefined) ?? true;
      const next = workstationLayout(layout, leftVisible, rightVisible);
      return {
        ...prev,
        layout: {
          ...layout,
          sidebarVisible: leftVisible,
          filesSidebarVisible: rightVisible,
          columns: next.columns,
          areas: next.areas,
          lastLeftWidth: next.lastLeftWidth,
          lastRightWidth: next.lastRightWidth,
        },
      };
    });
  }

  function toggleFilesSidebar() {
    setState((prev) => {
      const layout = (prev.layout as Record<string, unknown> | undefined) ?? {};
      const leftVisible =
        (layout.sidebarVisible as boolean | undefined) ?? true;
      const rightVisible = !(
        (layout.filesSidebarVisible as boolean | undefined) ?? true
      );
      const next = workstationLayout(layout, leftVisible, rightVisible);
      return {
        ...prev,
        layout: {
          ...layout,
          sidebarVisible: leftVisible,
          filesSidebarVisible: rightVisible,
          columns: next.columns,
          areas: next.areas,
          lastLeftWidth: next.lastLeftWidth,
          lastRightWidth: next.lastRightWidth,
        },
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
    toggleFilesSidebar,
  };
}
