export function LiveActivityCard({
  label,
  detail,
}: {
  label: string;
  detail: string;
}) {
  return (
    <div
      className="ae-live-activity-card"
      role="status"
      aria-live="polite"
      aria-label={`${label}. ${detail}`}
    >
      <span className="ae-live-activity-pulse" aria-hidden="true" />
      <span className="ae-live-activity-copy">
        <span className="ae-live-activity-label">{label}</span>
        <span className="ae-live-activity-detail">{detail}</span>
      </span>
    </div>
  );
}
