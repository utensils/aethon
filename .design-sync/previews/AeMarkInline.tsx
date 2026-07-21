import { AeMarkInline, AeWordmark } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the DS preview harness forces a white card
 *  body; the Æπ monogram tile is drawn with `--bg-elev`/`--text`/`--accent`
 *  tokens, so we re-create the app shell's dark surface locally so the mark
 *  reads with the contrast it has in real chrome. */
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

/** The monogram at the sizes chrome uses it — 20px (dense sidebar/tab rail),
 *  32px (header), 64px (empty-state hero) — each labelled so the rounded-tile
 *  proportions and the π badge stay legible as it scales. */
export const Sizes = () => (
  <Surface>
    <div style={{ display: "flex", gap: 40, alignItems: "flex-end" }}>
      {([20, 32, 64] as const).map((size) => (
        <div
          key={size}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            alignItems: "center",
          }}
        >
          <AeMarkInline size={size} />
          <span style={caption}>{size}px</span>
        </div>
      ))}
    </div>
  </Surface>
);

/** Corner-radius range: the same 64px monogram with a sharp, default, and
 *  fully-rounded tile so the `radius` prop's effect is visible. */
export const Radius = () => (
  <Surface>
    <div style={{ display: "flex", gap: 40, alignItems: "flex-end" }}>
      {(
        [
          { radius: 0, label: "radius 0" },
          { radius: 12, label: "radius 12" },
          { radius: 32, label: "radius 32" },
        ] as const
      ).map(({ radius, label }) => (
        <div
          key={label}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            alignItems: "center",
          }}
        >
          <AeMarkInline size={64} radius={radius} />
          <span style={caption}>{label}</span>
        </div>
      ))}
    </div>
  </Surface>
);

/** App-header lockup: the monogram paired with the horizontal wordmark and a
 *  meta line — the brand position the sidebar header composes at the top of
 *  the default layout. */
export const HeaderLockup = () => (
  <Surface>
    <div style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: 320 }}>
      <AeMarkInline size={36} radius={8} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <AeWordmark height={24} />
        <span style={caption}>desktop agent workspace</span>
      </div>
    </div>
  </Surface>
);
