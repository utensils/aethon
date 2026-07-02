// First-run / disconnected screen. Three ways in, best-first:
//   1. Scan the pairing QR from desktop Settings → Remote Devices
//      (camera; Tauri runtime only) — fully automatic.
//   2. Tap a Bonjour-discovered desktop and type its 8-digit code.
//   3. Manual host + token + fingerprint (collapsed) — the permanent
//      fallback and the browser dev-loop path.

import { useState } from "react";

import { isTauriRuntime } from "../gateway/rustBridgeAdapter";
import type { MobileConnection } from "./mobileConnection";
import { ScanOverlay } from "./ScanOverlay";
import { classifyPairError, pairErrorMessage, pairWithHosts, parseQrPayload } from "./pairing";
import { useNearbyDesktops, type DiscoveredDesktop } from "./useNearbyDesktops";

type Phase = "idle" | "scanning" | "pairing";

export function ConnectScreen({
  initial,
  remembered = [],
  error,
  onConnect,
}: {
  initial: MobileConnection | null;
  remembered?: MobileConnection[];
  error: string | null;
  onConnect: (connection: MobileConnection) => void;
}) {
  const [host, setHost] = useState(initial?.host ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [fingerprint, setFingerprint] = useState(initial?.fingerprint ?? "");
  const [phase, setPhase] = useState<Phase>("idle");
  const [pairError, setPairError] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<DiscoveredDesktop | null>(null);
  const [code, setCode] = useState("");

  const native = isTauriRuntime();
  const nearby = useNearbyDesktops(native && phase === "idle");

  const canConnect = host.trim().length > 0 && token.trim().length > 0;
  const selectedDesktop = codeFor;
  const canPairCode = selectedDesktop !== null && code.length === 8 && phase !== "pairing";

  const pairDesktop = (desktop: DiscoveredDesktop, value: string) =>
    finishPairing(() =>
      pairWithHosts({
        hosts: [desktop.host],
        port: desktop.port,
        fingerprint: desktop.fingerprint,
        code: value,
      }),
    );

  const finishPairing = async (run: () => ReturnType<typeof pairWithHosts>) => {
    setPhase("pairing");
    setPairError(null);
    try {
      const { connection } = await run();
      setCodeFor(null);
      setCode("");
      onConnect(connection);
    } catch (err) {
      setPairError(pairErrorMessage(classifyPairError(err)));
    } finally {
      setPhase("idle");
    }
  };

  const onScanned = (text: string) => {
    setPhase("idle");
    const payload = parseQrPayload(text);
    if (!payload) {
      setPairError("Not an Aethon pairing code — scan the QR from Settings → Remote Devices.");
      return;
    }
    void finishPairing(() =>
      pairWithHosts({
        hosts: payload.hosts,
        port: payload.port,
        fingerprint: payload.fp,
        code: payload.code,
      }),
    );
  };

  if (phase === "scanning") {
    return <ScanOverlay onResult={onScanned} onCancel={() => setPhase("idle")} />;
  }

  return (
    <div className="ae-mobile-connect">
      <div className="ae-mobile-connect-card">
        <h1 className="ae-mobile-connect-title">Connect to Aethon</h1>
        <p className="ae-mobile-connect-hint">
          Pair with a running desktop instance — open Settings → Remote Devices on the desktop
          and choose “Pair a device”.
        </p>
        {error ? <p className="ae-mobile-connect-error">{error}</p> : null}
        {pairError ? <p className="ae-mobile-connect-error">{pairError}</p> : null}

        {remembered.length > 0 ? (
          <section className="ae-mobile-remembered" aria-label="Paired hosts">
            <h2 className="ae-mobile-section-title">Paired hosts</h2>
            <div className="ae-mobile-remembered-list">
              {remembered.map((saved) => (
                <button
                  key={saved.fingerprint || saved.host}
                  type="button"
                  className="ae-mobile-remembered-row"
                  disabled={phase === "pairing"}
                  onClick={() => {
                    setPairError(null);
                    onConnect(saved);
                  }}
                >
                  <span className="ae-mobile-remembered-name">
                    {saved.name || saved.host}
                  </span>
                  <span className="ae-mobile-remembered-meta">{saved.host}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {native ? (
          <button
            type="button"
            className="ae-mobile-connect-button"
            disabled={phase === "pairing"}
            onClick={() => {
              setPairError(null);
              setPhase("scanning");
            }}
          >
            {phase === "pairing" ? "Pairing…" : "Scan QR code"}
          </button>
        ) : null}

        {native ? (
          <div className="ae-mobile-nearby" data-testid="nearby-desktops">
            <h2 className="ae-mobile-section-title">
              Nearby desktops
              {nearby.scanning ? <span className="ae-mobile-nearby-spinner" aria-hidden /> : null}
            </h2>
            {nearby.desktops.length === 0 ? (
              <p className="ae-mobile-nearby-empty">
                Searching… Make sure the desktop app is running on this network, and that
                Aethon has Local Network permission (iOS Settings → Privacy).
              </p>
            ) : (
              <ul className="ae-mobile-nearby-list">
                {nearby.desktops.map((desktop) => (
                  <li key={desktop.id}>
                    <button
                      type="button"
                      className="ae-mobile-nearby-row"
                      onClick={() => {
                        setPairError(null);
                        setCode("");
                        setCodeFor((current) =>
                          current?.id === desktop.id ? null : desktop,
                        );
                      }}
                    >
                      <span className="ae-mobile-nearby-name">{desktop.name}</span>
                      <span className="ae-mobile-nearby-meta">
                        {desktop.hostname} · {desktop.fingerprint.slice(0, 8)}
                      </span>
                    </button>
                    {codeFor?.id === desktop.id ? (
                      <form
                        className="ae-mobile-nearby-code"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!canPairCode) return;
                          void pairDesktop(selectedDesktop, code);
                        }}
                      >
                        <input
                          className="ae-mobile-input"
                          inputMode="numeric"
                          enterKeyHint="done"
                          pattern="[0-9]*"
                          autoComplete="one-time-code"
                          maxLength={8}
                          placeholder="8-digit code"
                          aria-label={`Pairing code for ${desktop.name}`}
                          value={code}
                          onChange={(e) => {
                            const next = e.target.value.replace(/\D/g, "").slice(0, 8);
                            setCode(next);
                            if (next.length === 8 && phase !== "pairing") {
                              e.currentTarget.blur();
                              void pairDesktop(desktop, next);
                            }
                          }}
                        />
                        <button
                          type="submit"
                          className="ae-mobile-connect-button"
                          disabled={!canPairCode}
                        >
                          {phase === "pairing" ? "Pairing…" : "Pair device"}
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <details className="ae-mobile-manual" open={!native}>
          <summary>Manual setup</summary>
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
        </details>
      </div>
    </div>
  );
}
