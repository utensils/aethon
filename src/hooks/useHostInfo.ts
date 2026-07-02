// useHostInfo — local + LAN-discovered Aethon hosts.
//
// On mount the hook resolves the local host via `host_info` IPC and
// subscribes to the Rust mDNS browser events. Remote hosts join + leave
// the `hosts` list as their announcements come in. The Rust side
// already debounces, so we just maintain a Map keyed by id and emit a
// stable derived list `[local, ...remotes]`.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getLocalHost, type Host } from "../hosts";
import { remoteDevicesList, type RemoteDevice } from "../services/remote";

export interface UseHostInfo {
  hosts: Host[];
  mobileDevices: Host[];
  activeHostId: string | null;
  /** Stable across renders — wire directly into event-route ctx without
   *  needing a ref bridge. */
  setActiveHost: (id: string | null) => void;
  localHostId: string | null;
}

export function useHostInfo(): UseHostInfo {
  const [localHost, setLocalHost] = useState<Host | null>(null);
  const remotesRef = useRef<Map<string, Host>>(new Map());
  const devicesRef = useRef<Map<string, Host>>(new Map());
  const [remotes, setRemotes] = useState<Host[]>([]);
  const [devices, setDevices] = useState<Host[]>([]);
  const [activeHostId, setActiveHostState] = useState<string | null>(null);

  function emitRemotes(): void {
    setRemotes(Array.from(remotesRef.current.values()));
  }

  function emitDevices(): void {
    setDevices(Array.from(devicesRef.current.values()));
  }

  function deviceHost(device: RemoteDevice): Host | null {
    if (!device.id || device.revoked) return null;
    const platform = device.platform || "mobile";
    return {
      id: `device:${device.id}`,
      hostname: platform,
      displayName: device.name || platform,
      isLocal: false,
      paired: true,
      connected: device.connected === true,
      createdAt: device.createdAt,
      lastSeen: device.lastSeenAt,
      fingerprintPrefix: device.connected ? "connected" : undefined,
    };
  }

  function hostsEqual(a: Host[], b: Host[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((host, index) => {
      const other = b[index];
      return (
        other &&
        host.id === other.id &&
        host.hostname === other.hostname &&
        host.displayName === other.displayName &&
        host.isLocal === other.isLocal &&
        host.fingerprintPrefix === other.fingerprintPrefix &&
        host.paired === other.paired &&
        host.connected === other.connected &&
        host.createdAt === other.createdAt &&
        host.lastSeen === other.lastSeen
      );
    });
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const local = await getLocalHost();
      if (cancelled) return;
      setLocalHost(local);
      // Default the active host to local on first paint.
      if (local) {
        setActiveHostState((prev) => prev ?? local.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let off: UnlistenFn[] = [];
    let cancelled = false;
    void (async () => {
      try {
        const offDiscovered = await listen<Host>("host-discovered", (event) => {
          const host = event.payload;
          if (!host?.id) return;
          remotesRef.current.set(host.id, { ...host, isLocal: false });
          emitRemotes();
        });
        const offRemoved = await listen<{ id: string }>("host-removed", (event) => {
          const id = event.payload?.id;
          if (!id) return;
          if (remotesRef.current.delete(id)) {
            emitRemotes();
            setActiveHostState((prev) => (prev === id ? localHost?.id ?? null : prev));
          }
        });
        if (cancelled) {
          offDiscovered();
          offRemoved();
          return;
        }
        off = [offDiscovered, offRemoved];
      } catch {
        // Running outside Tauri (tests, plain browser) — no events flow.
      }
    })();
    return () => {
      cancelled = true;
      for (const fn of off) fn();
    };
  }, [localHost?.id]);

  useEffect(() => {
    let cancelled = false;
    async function refreshDevices(): Promise<void> {
      try {
        const list = await remoteDevicesList();
        if (cancelled || !Array.isArray(list)) return;
        const next = new Map<string, Host>();
        for (const device of list) {
          const host = deviceHost(device);
          if (host) next.set(host.id, host);
        }
        const nextHosts = Array.from(next.values());
        if (!hostsEqual(Array.from(devicesRef.current.values()), nextHosts)) {
          devicesRef.current = next;
          emitDevices();
        }
      } catch {
        if (!cancelled && devicesRef.current.size > 0) {
          devicesRef.current = new Map();
          emitDevices();
        }
      }
    }
    void refreshDevices();
    let off: UnlistenFn | null = null;
    void listen("remote-devices-changed", () => {
      void refreshDevices();
    })
      .then((fn) => {
        if (cancelled) fn();
        else off = fn;
      })
      .catch(() => {
        // Running outside Tauri (tests, plain browser) — fallback poll below.
      });
    const timer = window.setInterval(refreshDevices, 30_000);
    return () => {
      cancelled = true;
      off?.();
      window.clearInterval(timer);
    };
  }, []);

  const hosts: Host[] = localHost ? [localHost, ...remotes] : remotes;
  const setActiveHost = useCallback((id: string | null) => {
    setActiveHostState(id);
  }, []);

  return {
    hosts,
    mobileDevices: devices,
    activeHostId,
    setActiveHost,
    localHostId: localHost?.id ?? null,
  };
}
