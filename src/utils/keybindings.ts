// Display helper for canonical combo strings (lowercase, "+"-joined,
// stable modifier order — see App.tsx canonicalCombo). Returns the
// macOS glyph form on Apple platforms and a textual form elsewhere so
// the palette and shortcut chips read naturally on each OS.
//
//   formatCombo("meta+shift+p")  → "⌘⇧P"   (mac)
//                                  "Ctrl+Shift+P" (linux/win)
//   formatCombo("ctrl+]")        → "⌃]"   (mac), "Ctrl+]" (other)

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

const MAC_MODS: Record<string, string> = {
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const TEXT_MODS: Record<string, string> = {
  meta: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

const KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  escape: "Esc",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  space: "Space",
  " ": "Space",
  backtick: "`",
};

export function formatCombo(canonical: string): string {
  if (!canonical) return "";
  const parts = canonical.split("+").filter(Boolean);
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    if (p === "meta" || p === "ctrl" || p === "alt" || p === "shift") {
      mods.add(p);
    } else {
      key = p;
    }
  }
  const ordered = ["meta", "ctrl", "alt", "shift"].filter((m) => mods.has(m));
  const renderedKey = (() => {
    const lower = key.toLowerCase();
    if (KEY_GLYPHS[lower]) return KEY_GLYPHS[lower];
    if (key.length === 1) return key.toUpperCase();
    return key.charAt(0).toUpperCase() + key.slice(1);
  })();
  if (IS_MAC) {
    const modGlyphs = ordered.map((m) => MAC_MODS[m]).join("");
    return `${modGlyphs}${renderedKey}`;
  }
  const modText = ordered.map((m) => TEXT_MODS[m]);
  return [...modText, renderedKey].filter(Boolean).join("+");
}
