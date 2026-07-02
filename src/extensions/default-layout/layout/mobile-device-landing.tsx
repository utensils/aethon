/**
 * Read-only overview for a paired mobile client. Phones are client-only:
 * they borrow this desktop host's projects and sessions instead of owning
 * their own project tree.
 */

import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";

interface MobileDeviceLandingState {
  kind?: string;
  deviceId?: string;
  label?: string;
  platform?: string;
  status?: string;
  paired?: boolean;
  connected?: boolean;
  createdAt?: number;
  lastSeenAt?: number;
}

export function MobileDeviceLanding({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as {
    landing?: { $ref: string };
  };
  const landing = (() => {
    if (!props.landing) return null;
    const raw = resolvePointer(state, props.landing.$ref);
    if (!raw || typeof raw !== "object") return null;
    return raw as MobileDeviceLandingState;
  })();
  if (!landing || landing.kind !== "mobile-device") return null;

  const title = landing.label || "Mobile device";
  const platform = landing.platform || "mobile";
  const status = landing.connected ? "Connected" : landing.status || "Paired";
  const pairedAt = formatDeviceDate(landing.createdAt);
  const lastSeen = formatDeviceDate(landing.lastSeenAt);
  const deviceId = landing.deviceId?.replace(/^device:/, "") || "unknown";

  return (
    <div className="a2ui-empty-state a2ui-mobile-device-landing">
      <div className="a2ui-empty-state-card">
        <div
          className="a2ui-empty-state-hero a2ui-mobile-device-landing-hero"
          aria-hidden="true"
        >
          <svg
            width="34"
            height="46"
            viewBox="0 0 34 46"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="7" y="3" width="20" height="40" rx="4.5" />
            <path d="M14.5 36.5h5" />
          </svg>
        </div>
        <h1 className="a2ui-empty-state-title">{title}</h1>
        <p className="a2ui-empty-state-subtitle">
          Client-only companion using this desktop host for projects, sessions,
          and agent work.
        </p>
        <dl className="a2ui-mobile-device-landing-grid">
          <DeviceFact
            label="Status"
            value={status}
            emphasis={landing.connected}
          />
          <DeviceFact label="Platform" value={platform} />
          <DeviceFact label="Role" value="Client only" />
          <DeviceFact label="Projects" value="Uses this desktop host" />
          <DeviceFact label="Sessions" value="Dispatches through this host" />
          <DeviceFact
            label="Access"
            value={landing.paired ? "Paired token" : "Not paired"}
          />
          <DeviceFact label="Paired" value={pairedAt} />
          <DeviceFact label="Last seen" value={lastSeen} />
          <DeviceFact label="Device id" value={deviceId} mono />
        </dl>
        <div className="a2ui-mobile-device-landing-actions">
          <button
            type="button"
            className="a2ui-mobile-device-landing-unpair"
            onClick={() =>
              onEvent(
                "unpair-mobile-device",
                {
                  sectionId: "mobile-devices",
                  itemId: landing.deviceId,
                  deviceId: landing.deviceId,
                  label: title,
                },
                landing.deviceId,
              )
            }
          >
            Unpair device
          </button>
        </div>
      </div>
    </div>
  );
}

function DeviceFact({
  label,
  value,
  emphasis,
  mono,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="a2ui-mobile-device-landing-fact">
      <dt>{label}</dt>
      <dd
        className={[emphasis ? "is-emphasis" : "", mono ? "is-mono" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

function formatDeviceDate(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "Not recorded";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
