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
  /** Friendly desktop name captured at pairing time, when available. */
  name?: string;
  /** Last successful connection attempt, epoch ms. */
  lastConnectedAt?: number;
}

const STORAGE_KEY = "aethon-mobile-connection";
const REMEMBERED_STORAGE_KEY = "aethon-mobile-connections";

function normalizeConnection(raw: unknown): MobileConnection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<MobileConnection>;
  if (typeof candidate.host !== "string" || typeof candidate.token !== "string") {
    return null;
  }
  const host = candidate.host.trim();
  const token = candidate.token.trim();
  if (!host || !token) return null;
  return {
    host,
    token,
    fingerprint:
      typeof candidate.fingerprint === "string" && candidate.fingerprint.trim()
        ? candidate.fingerprint.trim()
        : undefined,
    name:
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : undefined,
    lastConnectedAt:
      typeof candidate.lastConnectedAt === "number"
        ? candidate.lastConnectedAt
        : undefined,
  };
}

function connectionKey(connection: MobileConnection): string {
  return connection.fingerprint || connection.host;
}

export function loadConnection(): MobileConnection | null {
  // Dev / e2e override: ?gateway=ws://host:port&token=…[&fp=<sha256>].
  // `fp` pins the cert and flips the transport to wss, so the dev loop
  // can drive a real TLS gateway (e.g. the simulator against a running
  // desktop) — without it the override stays the plaintext dev path.
  try {
    const params = new URLSearchParams(window.location.search);
    const gatewayUrl = params.get("gateway");
    const token = params.get("token");
    if (gatewayUrl && token) {
      const host = gatewayUrl.replace(/^wss?:\/\//, "").replace(/\/ws$/, "");
      return { host, token, fingerprint: params.get("fp") ?? undefined };
    }
  } catch {
    // No URLSearchParams (non-browser) — fall through to storage.
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeConnection(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function loadRememberedConnections(): MobileConnection[] {
  try {
    const raw = localStorage.getItem(REMEMBERED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const remembered = Array.isArray(parsed)
      ? parsed
          .map(normalizeConnection)
          .filter((c): c is MobileConnection => c !== null)
      : [];
    const active = loadConnection();
    const all = active ? [active, ...remembered] : remembered;
    const byKey = new Map<string, MobileConnection>();
    for (const connection of all) {
      byKey.set(connectionKey(connection), connection);
    }
    return [...byKey.values()].sort(
      (a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0),
    );
  } catch {
    return [];
  }
}

export function saveConnection(connection: MobileConnection): void {
  const saved: MobileConnection = {
    ...connection,
    host: connection.host.trim(),
    token: connection.token.trim(),
    fingerprint: connection.fingerprint?.trim() || undefined,
    name: connection.name?.trim() || undefined,
    lastConnectedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    const remembered = loadRememberedConnections().filter(
      (existing) => connectionKey(existing) !== connectionKey(saved),
    );
    localStorage.setItem(
      REMEMBERED_STORAGE_KEY,
      JSON.stringify([saved, ...remembered].slice(0, 8)),
    );
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
