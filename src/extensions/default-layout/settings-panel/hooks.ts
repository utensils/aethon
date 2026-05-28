// Hooks supporting the settings panel. The three are split out here
// only because the panel body is dense — they still form a tight
// dependency chain (snapshot → effective config → scroll target), so
// keep them in this single file rather than scattering them.

import { useEffect, useMemo, useState } from "react";
import { getConfig, type AethonConfig } from "../../../config";

/**
 * Load the live config snapshot when the panel opens. Held in state
 * (not a ref) so the form re-renders when the value lands. The fetch
 * is cancellable to handle close-before-resolve races.
 */
export function useConfigSnapshot(open: boolean): AethonConfig | null {
  const [snapshot, setSnapshot] = useState<AethonConfig | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getConfig().then((cfg) => {
      if (!cancelled) setSnapshot(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return snapshot;
}

/**
 * Merge `pending` (live edits over the loaded config) on top of the
 * snapshot. Form bindings read from this while autosave catches up.
 */
export function useEffectiveConfig(
  snapshot: AethonConfig | null,
  pending: Partial<AethonConfig> | null,
): AethonConfig | null {
  return useMemo<AethonConfig | null>(() => {
    if (!snapshot) return null;
    const p = pending ?? {};
    return {
      ui: { ...snapshot.ui, ...(p.ui ?? {}) },
      agent: { ...snapshot.agent, ...(p.agent ?? {}) },
      shell: { ...snapshot.shell, ...(p.shell ?? {}) },
      shortcuts: { ...snapshot.shortcuts, ...(p.shortcuts ?? {}) },
      voice: { ...snapshot.voice, ...(p.voice ?? {}) },
      updates: { ...snapshot.updates, ...(p.updates ?? {}) },
      devshell: { ...snapshot.devshell, ...(p.devshell ?? {}) },
    };
  }, [snapshot, pending]);
}

/**
 * Smooth-scroll the named section into view when the panel opens with
 * a focus target. Uses `requestAnimationFrame` so the section element
 * has been laid out before we measure it, and cancels on unmount /
 * re-fire to avoid double-scroll.
 */
export function useScrollToSection(
  open: boolean,
  eff: AethonConfig | null,
  focusSection: string | null,
): void {
  useEffect(() => {
    if (!open || !eff || !focusSection) return;
    const frame = window.requestAnimationFrame(() => {
      const target = [
        ...document.querySelectorAll<HTMLElement>("[data-settings-section]"),
      ].find((el) => el.dataset.settingsSection === focusSection);
      target?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [eff, focusSection, open]);
}
