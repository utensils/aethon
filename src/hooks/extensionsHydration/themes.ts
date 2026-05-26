import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { BUILTIN_THEMES, type ExtensionTheme } from "./types";

/** Inject (or replace) the <style> element holding an extension theme's
 *  CSS custom properties. Keyed by id so re-registering replaces the
 *  previous rule rather than stacking. Values written via CSSOM
 *  setProperty (not string interpolation) so a malformed value
 *  containing `;` or `}` can't escape the declaration. */
export function injectThemeStyle(theme: ExtensionTheme) {
  const styleId = `aethon-theme-${theme.id}`;
  let el = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = styleId;
    document.head.appendChild(el);
  }
  const safe =
    window.CSS && window.CSS.escape
      ? window.CSS.escape(theme.id)
      : theme.id.replace(/[^A-Za-z0-9_-]/g, "");
  const sheet = el.sheet;
  if (!sheet) {
    el.textContent = "";
    return;
  }
  while (sheet.cssRules.length > 0) sheet.deleteRule(0);
  sheet.insertRule(`:root[data-theme="${safe}"] {}`);
  const rule = sheet.cssRules[0] as CSSStyleRule;
  rule.style.setProperty("color-scheme", "dark");
  for (const [k, v] of Object.entries(theme.vars)) {
    rule.style.setProperty(k, v);
  }
}

export interface ThemesDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  themesRef: MutableRefObject<Map<string, ExtensionTheme>>;
}

export function useThemeActions(deps: ThemesDeps) {
  const { setState, themesRef } = deps;

  /** Apply a fresh themes list — replace the registry, inject CSS for
   *  each, and mirror id/label pairs to /sidebar/themes so the sidebar
   *  updates. Style tags whose ids no longer appear in the list are
   *  removed first so a deleted/disabled extension stops bleeding stale
   *  CSS into the page. */
  function hydrateThemes(list: ExtensionTheme[]) {
    themesRef.current = new Map(list.map((t) => [t.id, t]));
    const keep = new Set(list.map((t) => `aethon-theme-${t.id}`));
    for (const el of document.querySelectorAll('style[id^="aethon-theme-"]')) {
      if (!keep.has(el.id)) el.remove();
    }
    for (const t of list) injectThemeStyle(t);
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
      const currentTheme =
        document.documentElement.dataset.theme || BUILTIN_THEMES[0]?.id;
      const themes = [
        ...BUILTIN_THEMES,
        ...list.map((t) => ({ id: t.id, label: t.label })),
      ].map((t) => ({ ...t, active: t.id === currentTheme }));
      return {
        ...prev,
        sidebar: { ...sidebar, themes },
      };
    });
  }

  function listThemes(): { id: string; label: string }[] {
    return [
      ...BUILTIN_THEMES,
      ...[...themesRef.current.values()].map((t) => ({
        id: t.id,
        label: t.label,
      })),
    ];
  }

  return { hydrateThemes, listThemes };
}
