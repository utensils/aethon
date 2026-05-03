// Format a millisecond timestamp into a compact relative-time label like
// "2m ago" / "3h ago" / "yesterday" / "Apr 22". Used by the empty-state's
// recent-sessions list — full timestamps are too noisy and "12345678 ms"
// is meaningless to a user.
export function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
