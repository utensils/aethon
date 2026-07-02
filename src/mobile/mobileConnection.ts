// Per-device connection config for the companion app: which desktop to
// reach and the durable device token. Stored in localStorage (device-
// local, never synced through the desktop's persisted state), plus a
// URL-param override for the browser dev loop.
//
// v0 keeps the token in localStorage; a Keychain-backed secret store in
// the mobile shell is a later hardening step.

export interface MobileConnection {
  /** host:port of the desktop gateway. */
  host: string;
  /** Durable device token from pairing. */
  token: string;
  /** Pinned cert fingerprint (wss) — absent means plaintext ws (dev). */
  fingerprint?: string;
}

const STORAGE_KEY = "aethon-mobile-connection";

export function loadConnection(): MobileConnection | null {
  // Dev / e2e override: ?gateway=ws://host:port&token=…
  try {
    const params = new URLSearchParams(window.location.search);
    const gatewayUrl = params.get("gateway");
    const token = params.get("token");
    if (gatewayUrl && token) {
      const host = gatewayUrl.replace(/^wss?:\/\//, "").replace(/\/ws$/, "");
      return { host, token };
    }
  } catch {
    // No URLSearchParams (non-browser) — fall through to storage.
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MobileConnection) : null;
  } catch {
    return null;
  }
}

export function saveConnection(connection: MobileConnection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
  } catch {
    // Private-mode / quota — the session still works, just won't persist.
  }
}

export function clearConnection(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** ws(s):// URL for the transport. Plaintext only when no fingerprint is
 *  pinned (dev); a pinned cert always implies wss. */
export function connectionUrl(connection: MobileConnection): string {
  const scheme = connection.fingerprint ? "wss" : "ws";
  return `${scheme}://${connection.host}/ws`;
}
