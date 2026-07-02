// First-run / disconnected screen: enter the desktop host + device
// token to pair the companion. QR scanning (via the barcode-scanner
// plugin) fills these in a later phase; manual entry is always the
// fallback and the browser dev path.

import { useState } from "react";

import type { MobileConnection } from "./mobileConnection";

export function ConnectScreen({
  initial,
  error,
  onConnect,
}: {
  initial: MobileConnection | null;
  error: string | null;
  onConnect: (connection: MobileConnection) => void;
}) {
  const [host, setHost] = useState(initial?.host ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [fingerprint, setFingerprint] = useState(initial?.fingerprint ?? "");

  const canConnect = host.trim().length > 0 && token.trim().length > 0;

  return (
    <div className="ae-mobile-connect">
      <div className="ae-mobile-connect-card">
        <h1 className="ae-mobile-connect-title">Connect to Aethon</h1>
        <p className="ae-mobile-connect-hint">
          Pair with a running desktop instance. Open Settings → Remote
          Devices on the desktop to get a code, or enter the host and
          token below.
        </p>
        {error ? <p className="ae-mobile-connect-error">{error}</p> : null}
        <label className="ae-mobile-field">
          <span>Host</span>
          <input
            className="ae-mobile-input"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="192.168.1.10:48213"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </label>
        <label className="ae-mobile-field">
          <span>Device token</span>
          <input
            className="ae-mobile-input"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="paste from pairing"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="ae-mobile-field">
          <span>Fingerprint (optional)</span>
          <input
            className="ae-mobile-input"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="wss cert pin — blank for dev ws"
            value={fingerprint}
            onChange={(e) => setFingerprint(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="ae-mobile-connect-button"
          disabled={!canConnect}
          onClick={() =>
            onConnect({
              host: host.trim(),
              token: token.trim(),
              fingerprint: fingerprint.trim() || undefined,
            })
          }
        >
          Connect
        </button>
      </div>
    </div>
  );
}
