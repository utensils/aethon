// Settings overlay state shape — the `/settings` slice on the main
// state object — and the reader that normalises whatever the renderer
// hands us into a typed view.
//
// Contract:
//   { open: boolean, focusSection: string | null,
//     pending: Partial<AethonConfig> | null }
//
// `pending` mirrors the user's unsaved edits — the form binds form
// controls to it via $ref-style optimistic writes, so the user sees
// changes apply live. Save serialises `pending` and invokes the Tauri
// `write_config` command; Cancel discards `pending`.

import type { AethonConfig } from "../../../config";

export interface SettingsState {
  open: boolean;
  focusSection: string | null;
  /** User's unsaved edits. Null when the panel hasn't loaded the
   *  config yet OR the user hasn't touched anything. The form reads
   *  from `pending` first, falling back to the config snapshot. */
  pending: Partial<AethonConfig> | null;
}

export function readSettingsState(state: Record<string, unknown>): SettingsState {
  const s = (state.settings as Partial<SettingsState> | undefined) ?? {};
  return {
    open: !!s.open,
    focusSection:
      typeof s.focusSection === "string" ? s.focusSection : null,
    pending: (s.pending as Partial<AethonConfig> | null) ?? null,
  };
}
