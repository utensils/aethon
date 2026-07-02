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
      startup: { ...snapshot.startup, ...(p.startup ?? {}) },
      mcp: { ...snapshot.mcp, ...(p.mcp ?? {}) },
      guardrails: { ...snapshot.guardrails, ...(p.guardrails ?? {}) },
    };
  }, [snapshot, pending]);
}

/**
 * Track which section currently owns the top of the settings scroll
 * viewport, for the nav rail's active highlight. IntersectionObserver
 * with a top-biased band (the section crossing the upper quarter wins)
 * so the highlight flips as a section's title reaches the reading line,
 * not when its last row leaves the screen.
 */
export function useActiveSection(
  open: boolean,
  ready: boolean,
  initial: string,
): [string, (id: string) => void] {
  const [active, setActive] = useState(initial);
  useEffect(() => {
    if (!open || !ready) return;
    // jsdom (tests) has no IntersectionObserver; the rail then only
    // highlights on click, which is fine.
    if (typeof IntersectionObserver === "undefined") return;
    const sections = [
      ...document.querySelectorAll<HTMLElement>("[data-settings-section]"),
    ];
    if (sections.length === 0) return;
    const root = document.querySelector<HTMLElement>(".ae-settings-body");
    const lastId = sections[sections.length - 1]?.dataset.settingsSection;
    const visible = new Map<string, number>();
    const pickActive = () => {
      // The last sections can never reach the top band; scrolled to the
      // end, the final section is the honest highlight. Checked here (not
      // in a separate scroll handler) so a late observer callback can't
      // overwrite it.
      if (root && lastId && root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
        setActive(lastId);
        return;
      }
      if (visible.size === 0) return;
      // Topmost visible section wins.
      const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
      if (top) setActive(top[0]);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.settingsSection;
          if (!id) continue;
          if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
          else visible.delete(id);
        }
        pickActive();
      },
      {
        root,
        rootMargin: "0px 0px -60% 0px",
      },
    );
    sections.forEach((section) => observer.observe(section));
    root?.addEventListener("scroll", pickActive, { passive: true });
    return () => {
      observer.disconnect();
      root?.removeEventListener("scroll", pickActive);
    };
  }, [open, ready]);
  return [active, setActive];
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
