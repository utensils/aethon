// Polls the mobile shell's Bonjour snapshot scan while the connect
// screen is visible. Each `discovery_scan` browses for ~2.5s; polling
// back-to-back (with a small gap) is effectively live discovery without
// a streaming thread to manage across iOS backgrounding.

import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../gateway/rustBridgeAdapter";

export interface DiscoveredDesktop {
  id: string;
  name: string;
  /** `<hostname>:<port>` — ready for gateway_pair / MobileConnection. */
  host: string;
  hostname: string;
  port: number;
  /** Full cert fingerprint — what the connection pins. */
  fingerprint: string;
  version: string;
}

const SCAN_MS = 2500;
const GAP_MS = 1500;

export function useNearbyDesktops(enabled: boolean): {
  desktops: DiscoveredDesktop[];
  scanning: boolean;
  error: string | null;
} {
  const [desktops, setDesktops] = useState<DiscoveredDesktop[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = enabled && isTauriRuntime();
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      setScanning(true);
      try {
        const found = await invoke<DiscoveredDesktop[]>("discovery_scan", {
          timeoutMs: SCAN_MS,
        });
        if (cancelledRef.current) return;
        setDesktops([...found].sort((a, b) => a.name.localeCompare(b.name)));
        setError(null);
      } catch (err) {
        if (cancelledRef.current) return;
        setError(String(err));
      }
      if (cancelledRef.current) return;
      setScanning(false);
      timer = setTimeout(() => void tick(), GAP_MS);
    };
    void tick();

    return () => {
      cancelledRef.current = true;
      if (timer !== undefined) clearTimeout(timer);
      setScanning(false);
    };
  }, [active]);

  return { desktops, scanning, error };
}
