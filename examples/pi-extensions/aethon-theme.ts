/**
 * Pi extension example — registers two custom Aethon themes.
 *
 * Themes show up in the sidebar Themes section alongside the built-in
 * dark/light entries. Selecting one applies the CSS custom properties
 * defined in `vars` to `:root[data-theme="<id>"]`. The choice persists
 * across reloads via Aethon's normal theme persistence path.
 *
 * Install: copy or symlink into `~/.pi/agent/extensions/`.
 */

/// <reference path="./aethon-types.d.ts" />

interface PiExtensionApi {
  registerCommand?(name: string, options: unknown): void;
}

export default function (_api: PiExtensionApi): void {
  if (!globalThis.aethon) return;
  const aethon = globalThis.aethon;

  // Solarized-ish dark variant. Matches the variable surface the
  // built-in dark theme exposes (see src/styles.css) so every panel
  // recolors consistently.
  aethon.registerTheme({
    id: "solarized-dark",
    label: "Solarized Dark",
    vars: {
      "--bg": "#002b36",
      "--bg-elev": "#073642",
      "--bg-input": "#0a3a46",
      "--border": "#0e4a5a",
      "--text": "#eee8d5",
      "--text-dim": "#93a1a1",
      "--accent": "#b58900",
      "--accent-soft": "rgba(181, 137, 0, 0.22)",
      "--accent-hover-tint": "rgba(181, 137, 0, 0.10)",
      "--accent-active-tint": "rgba(181, 137, 0, 0.18)",
      "--btn-text": "#002b36",
      "--user-bubble": "#0e4a5a",
      "--agent-bubble": "#073642",
      "--scrollbar-thumb": "#0e4a5a",
      "--scrollbar-thumb-hover": "#1e6a7a",
    },
  });

  // High-contrast pinkish accent. Exists mainly to make the difference
  // between themes obvious during UAT.
  aethon.registerTheme({
    id: "synthwave",
    label: "Synthwave",
    vars: {
      "--bg": "#1a0033",
      "--bg-elev": "#240046",
      "--bg-input": "#2d0066",
      "--border": "#3a0080",
      "--text": "#f8e8ff",
      "--text-dim": "#b890d8",
      "--accent": "#ff2bd6",
      "--accent-soft": "rgba(255, 43, 214, 0.22)",
      "--accent-hover-tint": "rgba(255, 43, 214, 0.10)",
      "--accent-active-tint": "rgba(255, 43, 214, 0.18)",
      "--btn-text": "#1a0033",
      "--user-bubble": "#3a0080",
      "--agent-bubble": "#240046",
      "--scrollbar-thumb": "#3a0080",
      "--scrollbar-thumb-hover": "#5a00b0",
    },
  });
}
