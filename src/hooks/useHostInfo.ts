// useHostInfo — local + LAN-discovered Aethon hosts.
//
// On mount the hook resolves the local host via `host_info` IPC and
// subscribes to the Rust mDNS browser events. Remote hosts join + leave
// the `hosts` list as their announcements come in. The Rust side
// already debounces, so we just maintain a Map keyed by id and emit a
// stable derived list `[local, ...remotes]`.

import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getLocalHost, type Host } from "../hosts";

export interface UseHostInfo {
  hosts: Host[];
  activeHostId: string | null;
  setActiveHost: (id: string | null) => void;
  localHostId: string | null;
}

export function useHostInfo(): UseHostInfo {
  const [localHost, setLocalHost] = useState<Host | null>(null);
  const remotesRef = useRef<Map<string, Host>>(new Map());
  const [remotes, setRemotes] = useState<Host[]>([]);
  const [activeHostId, setActiveHostState] = useState<string | null>(null);

  function emitRemotes(): void {
    setRemotes(Array.from(remotesRef.current.values()));
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

  const hosts: Host[] = localHost ? [localHost, ...remotes] : remotes;

  return {
    hosts,
    activeHostId,
    setActiveHost: (id) => setActiveHostState(id),
    localHostId: localHost?.id ?? null,
  };
}
