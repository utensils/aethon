import type { Terminal as XTerm } from "@xterm/xterm";

interface XTermThemeShape {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const ANSI_FALLBACK: XTermThemeShape = {
  background: "#0e0e10",
  foreground: "#e8e8ec",
  cursor: "#7c8cff",
  selectionBackground: "rgba(124, 140, 255, 0.32)",
  black: "#1a1a1c",
  red: "#ff5c4d",
  green: "#6ec85c",
  yellow: "#ffb845",
  blue: "#6ea7ff",
  magenta: "#d97afa",
  cyan: "#5fd5e0",
  white: "#d6cfc1",
  brightBlack: "#4a4a4f",
  brightRed: "#ff7a6f",
  brightGreen: "#88dd75",
  brightYellow: "#ffc870",
  brightBlue: "#8fbeff",
  brightMagenta: "#e69dff",
  brightCyan: "#82e1ea",
  brightWhite: "#fef3e2",
};

export const TERMINAL_FIT_DEBOUNCE_MS = 80;
export const TERMINAL_FIT_DRAG_THROTTLE_MS = 48;

export function terminalFitDelay(isUserResizing: boolean): number {
  return isUserResizing
    ? TERMINAL_FIT_DRAG_THROTTLE_MS
    : TERMINAL_FIT_DEBOUNCE_MS;
}

export function readTerminalTheme(): XTermThemeShape {
  if (typeof window === "undefined") return ANSI_FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => {
    const raw = cs.getPropertyValue(name).trim();
    return raw.length > 0 ? raw : fallback;
  };
  return {
    background: v("--terminal-bg", ANSI_FALLBACK.background),
    foreground: v("--terminal-fg", ANSI_FALLBACK.foreground),
    cursor: v("--terminal-cursor", ANSI_FALLBACK.cursor),
    selectionBackground: v(
      "--terminal-selection",
      ANSI_FALLBACK.selectionBackground,
    ),
    black: v("--ansi-black", ANSI_FALLBACK.black),
    red: v("--ansi-red", ANSI_FALLBACK.red),
    green: v("--ansi-green", ANSI_FALLBACK.green),
    yellow: v("--ansi-yellow", ANSI_FALLBACK.yellow),
    blue: v("--ansi-blue", ANSI_FALLBACK.blue),
    magenta: v("--ansi-magenta", ANSI_FALLBACK.magenta),
    cyan: v("--ansi-cyan", ANSI_FALLBACK.cyan),
    white: v("--ansi-white", ANSI_FALLBACK.white),
    brightBlack: v("--ansi-bright-black", ANSI_FALLBACK.brightBlack),
    brightRed: v("--ansi-bright-red", ANSI_FALLBACK.brightRed),
    brightGreen: v("--ansi-bright-green", ANSI_FALLBACK.brightGreen),
    brightYellow: v("--ansi-bright-yellow", ANSI_FALLBACK.brightYellow),
    brightBlue: v("--ansi-bright-blue", ANSI_FALLBACK.brightBlue),
    brightMagenta: v("--ansi-bright-magenta", ANSI_FALLBACK.brightMagenta),
    brightCyan: v("--ansi-bright-cyan", ANSI_FALLBACK.brightCyan),
    brightWhite: v("--ansi-bright-white", ANSI_FALLBACK.brightWhite),
  };
}

export function observeTerminalTheme(term: XTerm): () => void {
  if (typeof window === "undefined") return () => {};
  const apply = () => {
    try {
      term.options.theme = readTerminalTheme();
    } catch {
      /* term disposed mid-update — drop */
    }
  };
  const obs = new MutationObserver(apply);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => obs.disconnect();
}
