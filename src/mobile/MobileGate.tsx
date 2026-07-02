// Connection gate for the companion app. Holds the ConnectScreen until
// the gateway handshake succeeds, then lazy-mounts the full reused App.
// App only mounts post-connect, so its boot `invoke("start_agent")`
// never races the socket. A reconnect hook re-hydrates after the phone
// wakes from background (iOS drops sockets on lock).

import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { setAssetBase } from "../gateway/tauriCoreShim";
import { RustBridgeAdapter, isTauriRuntime } from "../gateway/rustBridgeAdapter";
import { gateway, type SocketAdapter } from "../gateway/transport";
import { useGatewayStatus } from "../gateway/useGatewayStatus";
import { ConnectScreen } from "./ConnectScreen";
import {
  clearConnection,
  connectionUrl,
  loadConnection,
  saveConnection,
  type MobileConnection,
} from "./mobileConnection";

const App = lazy(() => import("../App"));

type Phase = "connecting" | "connected" | "need-config";

export function MobileGate() {
  const [connection, setConnection] = useState<MobileConnection | null>(loadConnection);
  // Initial phase follows whether we already have a connection to try,
  // so the mount effect never has to setState synchronously.
  const [phase, setPhase] = useState<Phase>(connection ? "connecting" : "need-config");
  const [error, setError] = useState<string | null>(null);
  const status = useGatewayStatus();

  const connect = useCallback(async (target: MobileConnection, persist: boolean) => {
    setError(null);
    setPhase("connecting");
    const url = connectionUrl(target);
    setAssetBase(url, target.token);
    // A pinned fingerprint means wss:// with a self-signed cert, which
    // WKWebView's browser WebSocket can't accept (no JS pinning hook).
    // Route through the native Rust bridge, which opens the socket with
    // the pinned verifier. The plaintext dev path (no fingerprint) uses
    // the default browser WebSocket.
    const adapter: SocketAdapter | undefined =
      target.fingerprint && isTauriRuntime()
        ? new RustBridgeAdapter(target.fingerprint)
        : undefined;
    gateway.configure({ url, token: target.token, appVersion: "companion", adapter });
    try {
      await gateway.connect();
      if (persist) saveConnection(target);
      setPhase("connected");
    } catch (err) {
      setError(String(err));
      setPhase("need-config");
    }
  }, []);

  // Attempt a saved / URL-param connection on first mount only. connect()
  // is deferred to a microtask so it doesn't setState synchronously in
  // the effect; phase already reflects the initial intent.
  useEffect(() => {
    if (connection) queueMicrotask(() => void connect(connection, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect immediately when the app returns to the foreground — iOS
  // suspends the socket on lock, so this is the common path.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") gateway.reconnectNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const onConnect = useCallback(
    (target: MobileConnection) => {
      setConnection(target);
      void connect(target, true);
    },
    [connect],
  );

  const onForget = useCallback(() => {
    clearConnection();
    gateway.disconnect();
    setConnection(null);
    setPhase("need-config");
  }, []);

  if (phase === "need-config") {
    return <ConnectScreen initial={connection} error={error} onConnect={onConnect} />;
  }

  if (phase === "connecting") {
    return (
      <div className="ae-mobile-connecting">
        <div className="ae-mobile-spinner" aria-hidden />
        <p>Connecting to {connection?.host ?? "desktop"}…</p>
        <button type="button" className="ae-mobile-text-button" onClick={onForget}>
          Use a different host
        </button>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="ae-mobile-connecting">Loading…</div>}>
      {status === "disconnected" || status === "reconnecting" ? (
        <div className="ae-mobile-reconnect-banner" role="status">
          Reconnecting…
        </div>
      ) : null}
      <App />
    </Suspense>
  );
}
