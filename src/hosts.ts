// Hosts — machines running an Aethon instance. The local host is always
// present; remotes appear via mDNS browse and disappear when their
// announcement times out.
//
// Persistence: `~/.aethon/hosts.json` stores only PAIRED hosts so the
// list survives restart. The pairing PR will populate it. Today only
// the local entry is "persistable" — discovered remotes live in memory.
//
// Forward-compat: keep the file schema simple and stable so a future
// build can drop `paired: true` records straight in without touching
// the wire format.

import { invoke } from "@tauri-apps/api/core";
import { readState, writeState } from "./persist";

export interface Host {
  id: string;
  /** Stable host id reported by the peer itself; remote `id` is
   *  fingerprint-based so mDNS hostname conflicts don't create duplicates. */
  hostId?: string;
  hostname: string;
  displayName: string;
  isLocal: boolean;
  fingerprintPrefix?: string;
  fingerprint?: string;
  port?: number;
  candidates?: string[];
  paired?: boolean;
  lastSeen?: number;
  createdAt?: number;
  connected?: boolean;
  discovered?: boolean;
}

const FILE = "hosts.json";
const SCHEMA_VERSION = 1;

interface PersistedV1 {
  schemaVersion?: number;
  hosts?: Host[];
}

let cachedLocalHostId: string | null = null;

/** Cached fetch of the local host id from the Rust `host_info` IPC.
 *  Used by `loadProjects(localHostId)` + every place that needs to
 *  stamp a project record with its host. */
export async function getLocalHostId(fallback = "local:unknown"): Promise<string> {
  if (cachedLocalHostId) return cachedLocalHostId;
  try {
    const info = await invoke<{ id: string } | null>("host_info");
    if (info?.id) {
      cachedLocalHostId = info.id;
      return info.id;
    }
  } catch {
    // Tauri command unavailable (tests, plain browser) — fall through.
  }
  return fallback;
}

/** Returns the full local Host record. Cached parallel to
 *  `getLocalHostId` so callers can paint host UI without a round-trip
 *  to the bridge on every render. */
let cachedLocalHost: Host | null = null;
export async function getLocalHost(): Promise<Host | null> {
  if (cachedLocalHost) return cachedLocalHost;
  try {
    const info = await invoke<{
      id: string;
      hostname: string;
      displayName: string;
      fingerprint: string;
    } | null>("host_info");
    if (info?.id) {
      cachedLocalHost = {
        id: info.id,
        hostname: info.hostname,
        displayName: info.displayName || info.hostname,
        isLocal: true,
        fingerprintPrefix: info.fingerprint,
      };
      cachedLocalHostId = info.id;
      return cachedLocalHost;
    }
  } catch {
    // Tauri command unavailable.
  }
  return null;
}

export async function loadPairedHosts(): Promise<Host[]> {
  const raw = await readState(FILE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PersistedV1;
    if (!Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter(
      (h): h is Host =>
        typeof h?.id === "string" &&
        typeof h?.hostname === "string" &&
        typeof h?.displayName === "string",
    );
  } catch {
    return [];
  }
}

export async function savePairedHosts(hosts: Host[]): Promise<void> {
  const payload: PersistedV1 = { schemaVersion: SCHEMA_VERSION, hosts };
  await writeState(FILE, JSON.stringify(payload));
}

/** Reset both the local-host caches. Test-only helper — production code
 *  never needs to invalidate because the local host doesn't change
 *  within a process lifetime. */
export function _resetLocalHostCacheForTests(): void {
  cachedLocalHostId = null;
  cachedLocalHost = null;
}
