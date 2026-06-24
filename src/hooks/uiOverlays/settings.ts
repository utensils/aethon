import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { clearConfigCache, getConfig, type AethonConfig } from "../../config";
import {
  buildConfigWritePayload,
  mergeConfigPatch,
  type ConfigWritePatch,
} from "../../configWrites";
import type { UseUiOverlaysContext } from "./types";

export const SETTINGS_AUTOSAVE_DELAY_MS = 350;

type SettingsOverlayContext = Pick<
  UseUiOverlaysContext,
  "setState" | "stateRef" | "reapplyConfig" | "pushNotification"
>;

export function useSettingsOverlay(ctx: SettingsOverlayContext) {
  const { setState, stateRef, reapplyConfig, pushNotification } = ctx;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveGenerationRef = useRef(0);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const saveQueuedRef = useRef(false);
  const reopenOnFailureRef = useRef(false);

  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  /** Toggle the Settings panel. Loads the on-disk config on open via
   *  `getConfig()`, exposes form bindings via `/settings/pending`, and
   *  autosaves edits through the `write_config` Tauri command. */
  function openSettings(section?: string) {
    setState((prev) => ({
      ...prev,
      settings: {
        open: true,
        pending: null,
        focusSection: section ?? null,
        saveStatus: "idle",
        saveError: null,
      },
    }));
  }

  function toggleSettings() {
    setState((prev) => {
      const cur = (prev.settings as { open?: boolean } | undefined) ?? {};
      return {
        ...prev,
        settings: {
          open: !cur.open,
          pending: null,
          focusSection: null,
          saveStatus: "idle",
          saveError: null,
        },
      };
    });
  }

  function closeSettings() {
    const cur =
      (stateRef.current.settings as
        | {
            pending?: Record<string, unknown> | null;
            saveStatus?: string;
          }
        | undefined) ?? {};
    if (cur.pending && cur.saveStatus !== "saved") {
      void saveSettings({ reopenOnFailure: true });
    }
    setState((prev) => {
      const settings = isPlainObject(prev.settings) ? prev.settings : {};
      return {
        ...prev,
        settings: {
          ...settings,
          open: false,
          focusSection: null,
        },
      };
    });
  }

  /** Apply a partial AethonConfig patch to `/settings/pending` and
   *  schedule a debounced autosave. */
  function applySettingsPatch(patch: ConfigWritePatch) {
    setState((prev) => {
      const cur =
        (prev.settings as
          | {
              open?: boolean;
              pending?: Record<string, unknown> | null;
              focusSection?: string | null;
            }
          | undefined) ?? {};
      const merged = mergeConfigPatch(cur.pending ?? {}, patch);
      return {
        ...prev,
        settings: {
          open: !!cur.open,
          pending: merged,
          focusSection:
            typeof cur.focusSection === "string" ? cur.focusSection : null,
          saveStatus: "saving",
          saveError: null,
        },
      };
    });
    scheduleSettingsSave();
  }

  /** Save pending settings, then re-prime the cached config so runtime
   *  theme/font/defaults update without a page reload. */
  async function saveSettings(options?: { reopenOnFailure?: boolean }) {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (options?.reopenOnFailure) reopenOnFailureRef.current = true;
    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      return saveInFlightRef.current;
    }
    const run = drainSettingsSaves();
    saveInFlightRef.current = run;
    try {
      await run;
    } finally {
      if (saveInFlightRef.current === run) saveInFlightRef.current = null;
    }
  }

  async function drainSettingsSaves() {
    do {
      saveQueuedRef.current = false;
      await saveSettingsSnapshot();
    } while (saveQueuedRef.current);
  }

  async function saveSettingsSnapshot() {
    const cur =
      (stateRef.current.settings as
        | {
            open?: boolean;
            pending?: Record<string, unknown> | null;
            focusSection?: string | null;
          }
        | undefined) ?? {};
    const pending = cur.pending ?? {};
    if (Object.keys(pending).length === 0) return;
    const pendingSnapshot = cloneConfigPatch(pending);
    const saveGeneration = ++saveGenerationRef.current;
    let live: AethonConfig | null = null;
    try {
      live = await getConfig();
    } catch (err) {
      console.warn("settings save: getConfig failed:", err);
    }
    const merged = buildConfigWritePayload(live, pendingSnapshot);
    try {
      await invoke("write_config", { config: merged });
      clearConfigCache();
      let fresh: AethonConfig | null = null;
      try {
        fresh = await getConfig();
        reapplyConfig(fresh);
      } catch (err) {
        console.warn("settings save: re-read failed:", err);
      }
      if (fresh) {
        try {
          await invoke("agent_broadcast_command", {
            payload: JSON.stringify({
              type: "runtime_config_changed",
              config: fresh,
            }),
          });
        } catch (err) {
          console.warn("settings save: agent runtime broadcast failed:", err);
        }
      }
      const latestPending = readCurrentPending(stateRef.current);
      if (!sameConfigPatch(latestPending, pendingSnapshot)) {
        saveQueuedRef.current = true;
      }
      if (
        saveGeneration === saveGenerationRef.current &&
        !saveQueuedRef.current
      ) {
        setState((prev) => {
          const latest =
            (prev.settings as
              | {
                  open?: boolean;
                  pending?: Record<string, unknown> | null;
                  focusSection?: string | null;
                }
              | undefined) ?? {};
          const visiblePending = latest.pending ?? pendingSnapshot;
          return {
            ...prev,
            settings: {
              open: !!latest.open,
              pending: latest.open ? visiblePending : null,
              focusSection:
                typeof latest.focusSection === "string"
                  ? latest.focusSection
                  : null,
              saveStatus: "saved",
              saveError: null,
            },
          };
        });
      }
    } catch (err) {
      pushNotification({
        id: "ae-settings-save-failed",
        title: "Failed to save settings",
        message: err instanceof Error ? err.message : String(err),
        kind: "error",
        durationMs: 4000,
      });
      setState((prev) => {
        const latest =
          (prev.settings as
            | {
                open?: boolean;
                pending?: Record<string, unknown> | null;
                focusSection?: string | null;
              }
            | undefined) ?? {};
        const shouldReopen = reopenOnFailureRef.current;
        reopenOnFailureRef.current = false;
        return {
          ...prev,
          settings: {
            open: shouldReopen ? true : !!latest.open,
            pending: latest.pending ?? pendingSnapshot,
            focusSection:
              typeof latest.focusSection === "string"
                ? latest.focusSection
                : typeof cur.focusSection === "string"
                  ? cur.focusSection
                  : null,
            saveStatus: "error",
            saveError: String(err),
          },
        };
      });
      return;
    }
    if (!saveQueuedRef.current) reopenOnFailureRef.current = false;
  }

  function scheduleSettingsSave() {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveSettings();
    }, SETTINGS_AUTOSAVE_DELAY_MS);
  }

  return {
    openSettings,
    toggleSettings,
    closeSettings,
    applySettingsPatch,
    saveSettings,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCurrentPending(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const settings = isPlainObject(state.settings) ? state.settings : {};
  return isPlainObject(settings.pending) ? settings.pending : {};
}

function sameConfigPatch(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneConfigPatch(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
}
