/**
 * Shared disclosure chevron used across the sidebar + Source Control
 * surfaces (file tree rows, host/project groups, the "N CHANGED" header).
 * One component so every expandable row rotates the same glyph.
 */
export function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
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
