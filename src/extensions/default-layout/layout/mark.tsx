/**
 * The Æπ brand monogram + the `--app-ui-scale` reader. Together they
 * sit at the visual root of the default layout: every chrome surface
 * that paints the wordmark imports `AeMarkInline`, and the small
 * helpers that need to read the live UI-scale CSS var (chat input
 * autosize, slash picker positioning) import `readUiScale`.
 */

// eslint-disable-next-line react-refresh/only-export-components -- helper used by sibling chat module; doesn't affect HMR in practice
export function readUiScale(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-ui-scale")
    .trim();
  const scale = parseFloat(raw || "1");
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// Inline Æπ monogram — used by Sidebar / TabRail / etc. without going
// through the A2UI registry (so brand-chrome inside a composite doesn't
// require a payload to declare an `ae-mark` child).
export function AeMarkInline({
  size = 20,
  radius = 4,
}: {
  size?: number;
  radius?: number;
}) {
  return (
    <svg
      className="ae-mark"
      width={size}
      height={size}
      viewBox="0 0 320 320"
      role="img"
      aria-label="Aethon"
      style={{ display: "block", borderRadius: radius, flexShrink: 0 }}
    >
      <title>Aethon</title>
      <rect width="320" height="320" rx="60" fill="var(--bg-elev, #1f1f23)" />
      <text
        x="152"
        y="160"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"Playfair Display", "Bodoni 72", Didot, Georgia, serif'
        fontSize="236"
        fontWeight={700}
        fill="var(--text, #fef3e2)"
      >
        Æ
      </text>
      <circle
        cx="248"
        cy="82"
        r="38"
        fill="var(--accent, #ff6a18)"
        opacity="0.85"
      />
      <text
        x="248"
        y="86"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"Playfair Display", Didot, Georgia, serif'
        fontSize="44"
        fontWeight={700}
        fontStyle="italic"
        fill="var(--text, #fef3e2)"
      >
        π
      </text>
    </svg>
  );
}
