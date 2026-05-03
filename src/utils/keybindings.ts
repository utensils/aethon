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

// Normalize a keyboard event to the same canonical combo string the bridge
// stores (lowercased, sorted modifiers, "+"-joined). Returns null when no
// printable key was involved (modifier keys alone don't match a combo).
//
//   Cmd+Shift+P   →  "meta+shift+p"
//   Ctrl+]        →  "ctrl+]"
//   Alt+M         →  "alt+m"
export function canonicalCombo(e: KeyboardEvent): string | null {
  const k = e.key;
  if (!k || k.length === 0) return null;
  // Skip modifier-only events (pressing just Shift/Cmd/etc.)
  if (k === "Shift" || k === "Control" || k === "Meta" || k === "Alt") return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(k.toLowerCase());
  return parts.join("+");
}

// Bridge accepts a wide variety of human-readable combo formats
// ("Cmd+Shift+P", "ctrl+]", "Meta+M") and we normalize on the frontend
// for matching. Keep the modifier order stable so equivalent combos
// hash to the same canonical form.
export function normalizeRegisteredCombo(combo: string): string {
  const parts = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  // Aliases: cmd → meta, command → meta, control → ctrl, option → alt.
  const aliased = parts.map((p) =>
    p === "cmd" || p === "command"
      ? "meta"
      : p === "control"
        ? "ctrl"
        : p === "option"
          ? "alt"
          : p,
  );
  const mods = new Set<string>();
  let key = "";
  for (const p of aliased) {
    if (p === "meta" || p === "ctrl" || p === "alt" || p === "shift") {
      mods.add(p);
    } else {
      key = p;
    }
  }
  // Stable ordering matches canonicalCombo above (meta/ctrl/alt/shift).
  const ordered = ["meta", "ctrl", "alt", "shift"].filter((m) => mods.has(m));
  return [...ordered, key].filter(Boolean).join("+");
}

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
