export const THEME_STORAGE_KEY = "aethon-theme";

export const LEGACY_THEME_MAP: Record<string, string> = {
  signature: "aether",
  dark: "ember",
  light: "paper",
};

export function normalizeThemeId(id: string): string {
  return LEGACY_THEME_MAP[id] ?? id;
}

function prefersLightTheme(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

export function readBootThemeSeed(): string {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)?.trim();
    if (saved) return normalizeThemeId(saved);
  } catch {
    /* storage may be unavailable during early webview startup */
  }
  return prefersLightTheme() ? "paper" : "ember";
}

export function mirrorBootTheme(id: string): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, normalizeThemeId(id));
  } catch {
    /* best effort; disk/config remains authoritative */
  }
}

export function applyBootTheme(id = readBootThemeSeed()): string {
  const theme = normalizeThemeId(id);
  document.documentElement.dataset.theme = theme;
  return theme;
}
