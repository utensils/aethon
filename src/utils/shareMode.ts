// Agent ↔ shell sharing — UI helpers (M6 P2). The Rust side
// (`src-tauri/src/shell.rs`) owns the security boundary. These helpers
// only shape the badge UX: the click-cycle order, human label, and
// short tooltip. Kept dependency-free so vitest can exercise them
// without a React runtime.

export type ShareMode =
  | "private"
  | "read"
  | "read-write"
  | "read-write-trusted";

export const SHARE_MODES: readonly ShareMode[] = [
  "private",
  "read",
  "read-write",
  "read-write-trusted",
];

/** Click-through order for the status-bar badge. Wraps so a user can
 *  ramp privileges up step-by-step and reset with one more click. The
 *  order is intentionally monotonic: each step grants strictly more
 *  access than the previous, so accidental over-shares are limited to
 *  one click of distance. */
export function cycleShareMode(current: ShareMode): ShareMode {
  const idx = SHARE_MODES.indexOf(current);
  // Unknown input → treat as private (safest default).
  if (idx < 0) return "private";
  return SHARE_MODES[(idx + 1) % SHARE_MODES.length];
}

/** Short label rendered inside the badge. Picked for compactness on the
 *  shell-tab status line; the longer description goes in the tooltip. */
export function shareModeLabel(mode: ShareMode): string {
  switch (mode) {
    case "private":
      return "private";
    case "read":
      return "read";
    case "read-write":
      return "read-write";
    case "read-write-trusted":
      return "read-write · trusted";
  }
}

/** Hover tooltip — explains what the agent can see/do at this mode. */
export function shareModeTooltip(mode: ShareMode): string {
  switch (mode) {
    case "private":
      return "Agent cannot see or interact with this shell. Click to allow read access.";
    case "read":
      return "Agent can read scrollback (from now on) but cannot type. Click to allow writes with confirmation.";
    case "read-write":
      return "Agent can read scrollback and request to type — each write needs your approval. Click to skip the per-write prompt (trusted).";
    case "read-write-trusted":
      return "Agent can read and type without confirmation. Click to revoke all access.";
  }
}

/** True when the agent has any visibility into the tab. */
export function isShareable(mode: ShareMode): boolean {
  return mode !== "private";
}

/** True when the agent is allowed to write keystrokes. */
export function allowsWrite(mode: ShareMode): boolean {
  return mode === "read-write" || mode === "read-write-trusted";
}
