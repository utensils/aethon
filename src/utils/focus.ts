/** True when keyboard focus is anywhere inside the bottom terminal
 *  panel (the agent-bash xterm or any shell sub-tab). Drives the
 *  focus-aware Cmd+T routing: focus in the panel → new shell sub-tab,
 *  otherwise → new agent tab. Falls back to false outside Tauri
 *  (no DOM) so unit tests don't have to mock `document`. */
export function isFocusInTerminalPanel(): boolean {
  if (typeof document === "undefined") return false;
  const focused = document.activeElement;
  if (!focused) return false;
  const panel = document.querySelector(".ae-terminal-panel");
  return !!panel?.contains(focused);
}

export function focusTerminalPanel(): void {
  if (typeof document === "undefined") return;
  const panel = document.querySelector(".ae-terminal-panel");
  const helperTa = panel?.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  if (helperTa) {
    helperTa.focus();
    return;
  }
  const focusable = panel?.querySelector<HTMLElement>(
    'button, [tabindex]:not([tabindex="-1"])',
  );
  focusable?.focus();
}

export function focusTerminalPanelSoon(): void {
  if (typeof requestAnimationFrame !== "function") {
    focusTerminalPanel();
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => focusTerminalPanel());
  });
}
