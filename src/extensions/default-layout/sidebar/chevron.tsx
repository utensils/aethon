/**
 * Shared disclosure chevron used across the sidebar + Source Control
 * surfaces (file tree rows, host/project groups, collapsible sections,
 * the "N CHANGED" header). One component so every expandable row rotates
 * the same glyph.
 *
 * HARD RULE (see CLAUDE.md / AGENTS.md → Conventions): every
 * expand/collapse affordance must render this `<Chevron>` — never a
 * hand-rolled `▸`/`▾`/`>` text caret or a one-off rotating glyph.
 */
export function Chevron({
  expanded,
  size = 14,
}: {
  expanded: boolean;
  /** Rendered px (viewBox stays 12×12, so the glyph scales uniformly).
   *  Defaults to 14; dense sidebar/chat rows pass 12. */
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={expanded ? "M2.5 4.5L6 8L9.5 4.5" : "M4.5 2.5L8 6L4.5 9.5"} />
    </svg>
  );
}
