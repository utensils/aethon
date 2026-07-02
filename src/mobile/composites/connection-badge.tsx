// Header chip reflecting the gateway connection state. Reads the
// transport status store directly (not app state) so it updates the
// instant the socket changes, independent of any bridge round-trip.

import { useGatewayStatus } from "../../gateway/useGatewayStatus";

const LABELS: Record<string, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Online",
  reconnecting: "Reconnecting",
  disconnected: "Offline",
};

export function ConnectionBadge() {
  const status = useGatewayStatus();
  return (
    <span
      className={`ae-mobile-conn ae-mobile-conn--${status}`}
      role="status"
      aria-label={`Gateway ${LABELS[status] ?? status}`}
    >
      <span className="ae-mobile-conn-dot" aria-hidden />
      <span className="ae-mobile-conn-label">{LABELS[status] ?? status}</span>
    </span>
  );
}
