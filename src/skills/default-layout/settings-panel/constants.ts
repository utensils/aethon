// Static data for the settings panel: built-in themes the picker shows
// and the ANSI swatch indices for the palette preview block.

export const BUILTIN_THEMES = [
  { id: "ember", label: "Ember — warm dark" },
  { id: "paper", label: "Paper — cream light" },
  { id: "aether", label: "Æther — signature" },
  { id: "brink", label: "Brink — Ristretto warm chrome with gold accent" },
];

// 16-swatch ANSI preview block — order matches xterm's standard ANSI
// indices (0..7 standard + 8..15 bright) so users reading a terminal
// `\x1b[34m` recognise the swatch position. Bound to CSS vars so the
// preview tracks the active theme live.
export const ANSI_PREVIEW_KEYS = [
  "--ansi-black",
  "--ansi-red",
  "--ansi-green",
  "--ansi-yellow",
  "--ansi-blue",
  "--ansi-magenta",
  "--ansi-cyan",
  "--ansi-white",
  "--ansi-bright-black",
  "--ansi-bright-red",
  "--ansi-bright-green",
  "--ansi-bright-yellow",
  "--ansi-bright-blue",
  "--ansi-bright-magenta",
  "--ansi-bright-cyan",
  "--ansi-bright-white",
] as const;
