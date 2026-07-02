// Connection gate for the companion app. Holds the ConnectScreen until
// the gateway handshake succeeds, then mounts the full reused App.
// App only mounts post-connect, so its boot `invoke("start_agent")`
// never races the socket. A reconnect hook re-hydrates after the phone
// wakes from background (iOS drops sockets on lock).
//
// App is loaded lazily (not just mounted lazily): the module graph is
// multiple MB and parsing it synchronously would delay the very first
// paint of this gate's own spinner/ConnectScreen. `loadApp()` kicks the
// dynamic import off a frame after mount (so the gate paints first) and
// memoizes the promise so StrictMode's double-invoke and React.lazy's
// own call to the loader collapse onto one fetch+parse. The import is
// allowed to happen well before the socket connects — it's *mounting*
// App that stays strictly gated on phase === "connected" below, so its
// boot `invoke("start_agent")` still never races the handshake.

import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from "react";

import { setAssetBase } from "../gateway/tauriCoreShim";
import { RustBridgeAdapter, isTauriRuntime } from "../gateway/rustBridgeAdapter";
import { gateway, type SocketAdapter } from "../gateway/transport";
import { useGatewayStatus } from "../gateway/useGatewayStatus";
import { ConnectScreen } from "./ConnectScreen";
import {
  clearConnection,
  connectionUrl,
  loadConnection,
  loadRememberedConnections,
  saveConnection,
  type MobileConnection,
} from "./mobileConnection";
import { perfEnabled, perfMark } from "./perfMarks";

type Phase = "connecting" | "connected" | "need-config";

let appModulePromise: Promise<{ default: ComponentType }> | null = null;
const loadApp = () => (appModulePromise ??= import("../App"));
const App = lazy(loadApp);

interface ConnectingScreenProps {
  hostLabel: string;
  onForget: () => void;
}

// Shared with the Suspense fallback below so the "still connecting" UI
// looks identical whether we're waiting on the socket handshake or on
// the App chunk finishing its parse after the handshake already landed.
function ConnectingScreen({ hostLabel, onForget }: ConnectingScreenProps) {
  return (
    <div className="ae-mobile-connecting">
      <div className="ae-mobile-spinner" aria-hidden />
      <p>Connecting to {hostLabel}…</p>
      <button type="button" className="ae-mobile-text-button" onClick={onForget}>
        Use a different host
      </button>
    </div>
  );
}

export function MobileGate() {
  const [connection, setConnection] = useState<MobileConnection | null>(loadConnection);
  const [remembered, setRemembered] = useState<MobileConnection[]>(loadRememberedConnections);
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
      perfMark("connect-start");
      await gateway.connect();
      perfMark("hello-ok");
      if (persist) {
        saveConnection(target);
        setRemembered(loadRememberedConnections());
      }
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

  // Kick the App chunk's download+parse off a frame after mount, so this
  // gate's own first paint (ConnectScreen or the spinner below) isn't
  // delayed by it. On the saved-host path this overlaps the App parse
  // with the gateway.connect() handshake kicked off in the effect above.
  // Loading the module early is fine — mounting <App /> stays gated on
  // phase === "connected" in the render below.
  useEffect(() => {
    const raf = requestAnimationFrame(() => void loadApp());
    return () => cancelAnimationFrame(raf);
  }, []);

  // Startup perf marks (no-ops unless perf capture is enabled): first
  // gate paint, App mount commit, and the first agent event after
  // connect — the last is the "hydration is flowing" proxy.
  useEffect(() => {
    const raf = requestAnimationFrame(() => perfMark("gate-first-paint"));
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    if (phase === "connected") perfMark("app-mounted");
  }, [phase]);
  useEffect(() => {
    if (phase !== "connected" || !perfEnabled()) return;
    let seen = false;
    return gateway.subscribe("agent-response", () => {
      if (seen) return;
      seen = true;
      perfMark("first-agent-event");
    });
  }, [phase]);

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
    setRemembered(loadRememberedConnections());
    setPhase("need-config");
  }, []);

  if (phase === "need-config") {
    return (
      <ConnectScreen
        initial={connection}
        remembered={remembered}
        error={error}
        onConnect={onConnect}
      />
    );
  }

  if (phase === "connecting") {
    return (
      <ConnectingScreen hostLabel={connection?.host ?? "desktop"} onForget={onForget} />
    );
  }

  return (
    <>
      {status === "disconnected" || status === "reconnecting" ? (
        <div className="ae-mobile-reconnect-banner" role="status">
          Reconnecting…
        </div>
      ) : null}
      <Suspense
        fallback={
          <ConnectingScreen hostLabel={connection?.host ?? "desktop"} onForget={onForget} />
        }
      >
        <App />
      </Suspense>
    </>
  );
}
