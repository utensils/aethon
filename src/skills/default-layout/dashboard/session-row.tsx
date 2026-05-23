import { useState } from "react";

export interface DashboardSessionRowItem {
  id: string;
  label: string;
  lastModified?: string;
  cwd?: string;
}

export function DashboardSessionRow({
  session,
  classPrefix,
  onRestore,
  onDelete,
}: {
  session: DashboardSessionRowItem;
  classPrefix: string;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li
      className={
        confirming
          ? "a2ui-dashboard-session-row is-confirming"
          : "a2ui-dashboard-session-row"
      }
      onMouseLeave={() => setConfirming(false)}
      onClick={() => {
        if (!confirming) onRestore();
      }}
    >
      <span className={`${classPrefix}-session-label`}>{session.label}</span>
      <span className={`${classPrefix}-session-actions`}>
        {confirming ? (
          <span className="a2ui-dashboard-session-confirm">
            <button
              type="button"
              className="a2ui-dashboard-session-confirm-delete"
              aria-label={`Confirm delete ${session.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              Confirm
            </button>
          </span>
        ) : (
          <>
            {session.lastModified && (
              <span className={`${classPrefix}-session-meta`}>
                {session.lastModified}
              </span>
            )}
            <button
              type="button"
              className={`${classPrefix}-session-delete`}
              aria-label={`Delete ${session.label}`}
              title="Delete saved session"
              onClick={(event) => {
                event.stopPropagation();
                setConfirming(true);
              }}
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M5.5 2.75h5M6.25 2.75l.5-1h2.5l.5 1M3.5 4.5h9M5 4.5l.55 9h4.9l.55-9M7 6.5v5M9 6.5v5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.35"
                />
              </svg>
            </button>
          </>
        )}
      </span>
    </li>
  );
}
