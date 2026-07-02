// Settings → Remote Devices. Pairs companion clients (the iOS app) with
// this running instance and lists / revokes the paired devices.
//
// The section drives the gateway commands directly (remote_status,
// remote_pairing_begin/cancel, remote_devices_list, remote_device_*)
// rather than routing through config writes — pairing is a live action,
// not a persisted setting.

import { useEffect, useState } from "react";

import { PairingQr } from "./pairing-qr";
import { Field, Section } from "./sections";
import { useRemoteDevices } from "./useRemoteDevices";

function shortFingerprint(fp: string): string {
  return fp.length > 16 ? `${fp.slice(0, 8)}…${fp.slice(-8)}` : fp;
}

function relativeTime(epochMs: number): string {
  const delta = Date.now() - epochMs;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function PairingCode({
  expiresAt,
  code,
  qrPayload,
}: {
  expiresAt: number;
  code: string;
  qrPayload: string;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
  );
  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return (
    <div className="ae-remote-pairing" data-testid="remote-pairing-code">
      <PairingQr payload={qrPayload} />
      <div className="ae-remote-pairing-code">{code}</div>
      <p className="ae-remote-pairing-hint">
        Scan the QR with the Aethon app, or enter this code on the device. Expires in{" "}
        {secondsLeft}s.
      </p>
      <details className="ae-remote-pairing-payload">
        <summary>Pairing payload (QR)</summary>
        <code>{qrPayload}</code>
      </details>
    </div>
  );
}

export function RemoteDevicesSection({ open }: { open: boolean }) {
  const remote = useRemoteDevices(open);
  const { status, devices, pairing, error, busy } = remote;

  const canPair = status?.running && status.tlsActive;

  return (
    <Section id="remote" title="Remote Devices">
      {error ? <p className="ae-settings-error">{error}</p> : null}

      <Field label="Gateway">
        <span className="ae-remote-status">
          {status == null
            ? "…"
            : !status.running
              ? "Server stopped"
              : status.tlsActive
                ? `Secure on port ${status.port ?? "?"}`
                : `Insecure (dev) on port ${status.port ?? "?"}`}
        </span>
      </Field>

      {status?.fingerprint ? (
        <Field label="Certificate fingerprint">
          <code className="ae-remote-fingerprint" title={status.fingerprint}>
            {shortFingerprint(status.fingerprint)}
          </code>
        </Field>
      ) : null}

      {!canPair ? (
        <p className="ae-remote-hint">
          {status && !status.running
            ? "Start the server (Settings → Server) to pair a device."
            : "This host has no TLS identity, so pairing is unavailable."}
        </p>
      ) : pairing ? (
        <>
          <PairingCode
            code={pairing.code}
            expiresAt={pairing.expiresAt}
            qrPayload={pairing.qrPayload}
          />
          <button
            type="button"
            className="ae-settings-secondary"
            onClick={() => void remote.cancelPairing()}
          >
            Cancel pairing
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ae-settings-secondary"
          disabled={busy}
          onClick={() => void remote.beginPairing()}
        >
          Pair a device
        </button>
      )}

      <div className="ae-remote-devices">
        {devices.length === 0 ? (
          <p className="ae-remote-hint">No paired devices.</p>
        ) : (
          <ul className="ae-remote-device-list">
            {devices.map((device) => (
              <li
                key={device.id}
                className={`ae-remote-device${device.revoked ? " ae-remote-device--revoked" : ""}`}
              >
                <span className="ae-remote-device-name">{device.name}</span>
                <span className="ae-remote-device-meta">
                  {device.platform} · seen {relativeTime(device.lastSeenAt)}
                  {device.revoked ? " · revoked" : ""}
                </span>
                {!device.revoked ? (
                  <button
                    type="button"
                    className="ae-settings-secondary ae-remote-revoke"
                    onClick={() => void remote.revoke(device.id)}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
