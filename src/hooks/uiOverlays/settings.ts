import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { clearConfigCache, getConfig, type AethonConfig } from "../../config";
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
    if (cur.pending && cur.saveStatus !== "saved") void saveSettings();
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
  function applySettingsPatch(
    patch: Partial<{
      ui: unknown;
      agent: unknown;
      shell: unknown;
      shortcuts: unknown;
      voice: unknown;
      updates: unknown;
      devshell: unknown;
    }>,
  ) {
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
  async function saveSettings() {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
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
    const saveGeneration = ++saveGenerationRef.current;
    let live: AethonConfig | null = null;
    try {
      live = await getConfig();
    } catch (err) {
      console.warn("settings save: getConfig failed:", err);
    }
    const merged = {
      ui: { ...(live?.ui ?? {}), ...((pending as { ui?: object }).ui ?? {}) },
      agent: {
        ...(live?.agent ?? {}),
        ...((pending as { agent?: object }).agent ?? {}),
      },
      shell: {
        ...(live?.shell ?? {}),
        ...((pending as { shell?: object }).shell ?? {}),
      },
      // Always include `shortcuts` so `[shortcuts] new_tab_kind` survives
      // any other Settings save. write_config drops sections it doesn't see.
      shortcuts: {
        ...(live?.shortcuts ?? {}),
        ...((pending as { shortcuts?: object }).shortcuts ?? {}),
      },
      voice: {
        ...(live?.voice ?? {}),
        ...((pending as { voice?: object }).voice ?? {}),
      },
      // Likewise for `[updates]` — preserve channel + auto-check settings
      // across saves of unrelated sections.
      updates: {
        ...(live?.updates ?? {}),
        ...((pending as { updates?: object }).updates ?? {}),
      },
      devshell: {
        ...(live?.devshell ?? {}),
        ...((pending as { devshell?: object }).devshell ?? {}),
      },
    };
    try {
      await invoke("write_config", { config: merged });
      clearConfigCache();
      try {
        const fresh = await getConfig();
        reapplyConfig(fresh);
      } catch (err) {
        console.warn("settings save: re-read failed:", err);
      }
      if (saveGeneration === saveGenerationRef.current) {
        setState((prev) => {
          const latest =
            (prev.settings as
              | {
                  open?: boolean;
                  pending?: Record<string, unknown> | null;
                  focusSection?: string | null;
                }
              | undefined) ?? {};
          const visiblePending = latest.pending ?? pending;
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
        return {
          ...prev,
          settings: {
            open: !!latest.open,
            pending: latest.pending ?? pending,
            focusSection:
              typeof latest.focusSection === "string"
                ? latest.focusSection
                : null,
            saveStatus: "error",
            saveError: err instanceof Error ? String(err) : String(err),
          },
        };
      });
      return;
    }
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

function mergeConfigPatch(
  pending: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...pending };
  for (const [key, value] of Object.entries(patch)) {
    const previous = merged[key];
    merged[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? { ...previous, ...value }
        : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
