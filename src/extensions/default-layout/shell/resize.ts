export interface ShellDims {
  cols: number;
  rows: number;
}

/** True when the ResizeObserver fires while the terminal is not actually
 *  visible. The bottom panel stays mounted for chrome animation, so a
 *  Cmd+` close can still report resize events with tiny or stale non-zero
 *  dimensions. Skipping fit + shell_resize there prevents SIGWINCH spam
 *  that makes prompts like starship redraw and stack prompt lines. */
export function shouldSkipResize(
  entry: ResizeObserverEntry | undefined,
  container?: Element | null,
): boolean {
  const panel = container?.closest(".ae-terminal-panel");
  if (
    panel?.classList.contains("is-closed") ||
    panel?.getAttribute("aria-hidden") === "true"
  ) {
    return true;
  }

  const layoutCell = container?.closest<HTMLElement>(
    '.a2ui-layout-cell[data-area="terminal"]',
  );
  if (layoutCell?.dataset.visible === "false") return true;

  if (!entry) return false;
  const { width, height } = entry.contentRect;
  return width === 0 || height === 0;
}

/** Returns the dims to send via `shell_resize`, or `null` when the
 *  current dims match what we sent last time (no PTY change -> no
 *  SIGWINCH). A zero `cols` or `rows` also bails — xterm reports 0 if
 *  the container collapsed between the ResizeObserver fire and `fit()`. */
export function decideShellResize(
  current: ShellDims,
  lastSent: ShellDims | null,
): ShellDims | null {
  if (!current.cols || !current.rows) return null;
  if (
    lastSent &&
    lastSent.cols === current.cols &&
    lastSent.rows === current.rows
  ) {
    return null;
  }
  return current;
}
