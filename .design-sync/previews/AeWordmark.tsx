import { AeMarkInline, AeWordmark } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the DS preview harness forces a white card
 *  body; the wordmark's `Æthon` glyphs fill with `--text` and the π badge
 *  with `--accent`, so we re-create the app shell's dark surface locally so
 *  the serif lockup reads with its intended contrast. The wordmark is SVG
 *  `<text>` in Playfair Display (bundled via extraFonts). */
const Surface = ({ children }: { children?: React.ReactNode }) => (
  <div
    style={{
      background: "var(--bg)",
      color: "var(--text)",
      fontFamily: "var(--font-ui)",
      padding: 16,
      borderRadius: 8,
    }}
  >
    {children}
  </div>
);

const caption: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-dim)",
};

/** The horizontal lockup at the heights it ships at — 22px (default sidebar
 *  header row), 32px, 48px — stacked so the Playfair serif proportions and
 *  the π-badge placement stay legible as it scales up. */
export const Heights = () => (
  <Surface>
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {([22, 32, 48] as const).map((height) => (
        <div
          key={height}
          style={{ display: "flex", alignItems: "center", gap: 16 }}
        >
          <span style={{ ...caption, width: 40 }}>{height}px</span>
          <AeWordmark height={height} />
        </div>
      ))}
    </div>
  </Surface>
);

/** The wordmark at hero scale — the empty-state / splash brand position,
 *  where the serif Æ and the accent π badge carry the whole surface. */
export const Hero = () => (
  <Surface>
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "32px 16px",
      }}
    >
      <AeWordmark height={56} />
      <span style={caption}>a thin Tauri shell around a TypeScript coding agent</span>
    </div>
  </Surface>
);

/** Brand-family alignment: the monogram tile beside the wordmark at a shared
 *  height, so the two lockups read as one system (the Æ weights match). */
export const WithMark = () => (
  <Surface>
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <AeMarkInline size={40} radius={9} />
      <AeWordmark height={34} />
    </div>
  </Surface>
);
