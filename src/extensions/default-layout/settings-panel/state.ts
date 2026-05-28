// Settings overlay state shape — the `/settings` slice on the main
// state object — and the reader that normalises whatever the renderer
// hands us into a typed view.
//
// Contract:
//   { open: boolean, focusSection: string | null,
//     pending: Partial<AethonConfig> | null,
//     saveStatus: "idle" | "saving" | "saved" | "error",
//     saveError: string | null }
//
// `pending` mirrors live edits over the config snapshot so controls
// never snap back while the panel stays open. The overlay hook
// debounces writes through the same config round-trip path used by
// legacy Save events and tracks write state separately in `saveStatus`.

import type { AethonConfig } from "../../../config";

export interface SettingsState {
  open: boolean;
  focusSection: string | null;
  /** User's live edits over the loaded config snapshot. Null when the
   *  panel hasn't loaded the config yet OR the user hasn't touched
   *  anything this open session. */
  pending: Partial<AethonConfig> | null;
  saveStatus: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
}

export function readSettingsState(state: Record<string, unknown>): SettingsState {
  const s = (state.settings as Partial<SettingsState> | undefined) ?? {};
  return {
    open: !!s.open,
    focusSection:
      typeof s.focusSection === "string" ? s.focusSection : null,
    pending: (s.pending as Partial<AethonConfig> | null) ?? null,
    saveStatus:
      s.saveStatus === "saving" ||
      s.saveStatus === "saved" ||
      s.saveStatus === "error"
        ? s.saveStatus
        : "idle",
    saveError: typeof s.saveError === "string" ? s.saveError : null,
  };
}
