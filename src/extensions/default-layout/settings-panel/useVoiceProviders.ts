import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import {
  listVoiceProviders,
  prepareVoiceProvider,
  removeVoiceProviderModel,
  setSelectedVoiceProvider,
  setVoiceProviderEnabled,
} from "../../../services/voice";
import type {
  VoiceDownloadProgress,
  VoiceProviderInfo,
} from "../../../types/voice";

export function useVoiceProviders() {
  const [providers, setProviders] = useState<VoiceProviderInfo[] | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<VoiceDownloadProgress | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setProviders(await listVoiceProviders());
    } catch (err) {
      setError(String(err));
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listVoiceProviders()
      .then((nextProviders) => {
        if (cancelled) return;
        setError(null);
        setProviders(nextProviders);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setProviders([]);
      });

    let unlistenProgress: UnlistenFn | undefined;
    let unlistenStatus: UnlistenFn | undefined;
    const progressPromise = listen<VoiceDownloadProgress>(
      "voice-download-progress",
      (event) => setProgress(event.payload),
    ).then((fn) => {
      unlistenProgress = fn;
    });
    const statusPromise = listen<VoiceProviderInfo>(
      "voice-provider-status",
      (event) => {
        setProviders((current) =>
          (current ?? []).map((provider) =>
            provider.id === event.payload.id ? event.payload : provider,
          ),
        );
      },
    ).then((fn) => {
      unlistenStatus = fn;
    });
    return () => {
      cancelled = true;
      progressPromise.then(() => unlistenProgress?.());
      statusPromise.then(() => unlistenStatus?.());
    };
  }, []);

  const run = useCallback(
    async (providerId: string, task: () => Promise<unknown>) => {
      if (busyProvider === providerId) return;
      setBusyProvider(providerId);
      setError(null);
      try {
        await task();
        await refresh();
      } catch (err) {
        setError(String(err));
        await refresh();
      } finally {
        setBusyProvider(null);
        setProgress(null);
      }
    },
    [busyProvider, refresh],
  );

  return {
    providers,
    busyProvider,
    error,
    progress,
    refresh,
    prepareProvider: (providerId: string) =>
      run(providerId, () => prepareVoiceProvider(providerId)),
    removeProviderModel: (providerId: string) =>
      run(providerId, () => removeVoiceProviderModel(providerId)),
    selectProvider: (providerId: string) =>
      run(providerId, () => setSelectedVoiceProvider(providerId)),
    setProviderEnabled: (providerId: string, enabled: boolean) =>
      run(providerId, () => setVoiceProviderEnabled(providerId, enabled)),
  };
}
