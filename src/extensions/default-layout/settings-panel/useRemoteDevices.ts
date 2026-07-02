import { useCallback, useEffect, useState } from "react";

import {
  remoteDeviceRename,
  remoteDeviceRevoke,
  remoteDevicesList,
  remotePairingBegin,
  remotePairingCancel,
  remoteStatus,
  type PairingBegin,
  type RemoteDevice,
  type RemoteStatus,
} from "../../../services/remote";

export interface RemoteDevicesState {
  status: RemoteStatus | null;
  devices: RemoteDevice[];
  pairing: PairingBegin | null;
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  beginPairing: () => Promise<void>;
  cancelPairing: () => Promise<void>;
  revoke: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
}

/** Loads gateway status + the paired-device list while the settings
 *  panel is open, and drives the pairing lifecycle. Pairing auto-clears
 *  when its window expires so the UI never shows a dead code. */
export function useRemoteDevices(open: boolean): RemoteDevicesState {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [pairing, setPairing] = useState<PairingBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        remoteStatus(),
        remoteDevicesList(),
      ]);
      setStatus(nextStatus ?? null);
      setDevices(Array.isArray(nextDevices) ? nextDevices : []);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Async data fetch on open + light poll so lastSeen / connection
    // count stay live; neither mutates state synchronously in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => {
      if (!cancelled) void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, refresh]);

  // Auto-expire the displayed pairing code. The clear always goes
  // through the timer (delay clamped to 0) so state never mutates
  // synchronously inside the effect.
  useEffect(() => {
    if (!pairing) return;
    const remaining = Math.max(0, pairing.expiresAt - Date.now());
    const timer = setTimeout(() => setPairing(null), remaining);
    return () => clearTimeout(timer);
  }, [pairing]);

  const beginPairing = useCallback(async () => {
    setBusy(true);
    try {
      setPairing(await remotePairingBegin());
      setError(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const cancelPairing = useCallback(async () => {
    setPairing(null);
    try {
      await remotePairingCancel();
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }, [refresh]);

  const revoke = useCallback(
    async (id: string) => {
      try {
        await remoteDeviceRevoke(id);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      try {
        await remoteDeviceRename(id, name);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh],
  );

  return {
    status,
    devices,
    pairing,
    error,
    busy,
    refresh,
    beginPairing,
    cancelPairing,
    revoke,
    rename,
  };
}
