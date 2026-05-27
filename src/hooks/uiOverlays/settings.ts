import { invoke } from "@tauri-apps/api/core";
import { clearConfigCache, getConfig, type AethonConfig } from "../../config";
import type { UseUiOverlaysContext } from "./types";

type SettingsOverlayContext = Pick<
  UseUiOverlaysContext,
  "setState" | "stateRef" | "reapplyConfig" | "pushNotification"
>;

export function useSettingsOverlay(ctx: SettingsOverlayContext) {
  const { setState, stateRef, reapplyConfig, pushNotification } = ctx;

  /** Toggle the Settings panel. Loads the on-disk config on open via
   *  `getConfig()`, exposes form bindings via `/settings/pending`, and
   *  writes back via the `write_config` Tauri command on Save. */
  function openSettings(section?: string) {
    setState((prev) => ({
      ...prev,
      settings: {
        open: true,
        pending: null,
        focusSection: section ?? null,
      },
    }));
  }

  function toggleSettings() {
    setState((prev) => {
      const cur = (prev.settings as { open?: boolean } | undefined) ?? {};
      return {
        ...prev,
        settings: { open: !cur.open, pending: null, focusSection: null },
      };
    });
  }

  function closeSettings() {
    setState((prev) => ({
      ...prev,
      settings: { open: false, pending: null, focusSection: null },
    }));
  }

  /** Apply a partial AethonConfig patch to `/settings/pending`. */
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
      const merged = { ...(cur.pending ?? {}), ...patch };
      return {
        ...prev,
        settings: {
          open: !!cur.open,
          pending: merged,
          focusSection:
            typeof cur.focusSection === "string" ? cur.focusSection : null,
        },
      };
    });
  }

  /** Save pending settings, then re-prime the cached config so runtime
   *  theme/font/defaults update without a page reload. */
  async function saveSettings() {
    const cur =
      (stateRef.current.settings as
        | { open?: boolean; pending?: Record<string, unknown> | null }
        | undefined) ?? {};
    const pending = cur.pending ?? {};
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
      pushNotification({
        id: "ae-settings-saved",
        title: "Settings saved",
        kind: "success",
        durationMs: 2000,
      });
    } catch (err) {
      pushNotification({
        id: "ae-settings-save-failed",
        title: "Failed to save settings",
        message: err instanceof Error ? err.message : String(err),
        kind: "error",
        durationMs: 4000,
      });
      return;
    }
    closeSettings();
  }

  return {
    openSettings,
    toggleSettings,
    closeSettings,
    applySettingsPatch,
    saveSettings,
  };
}
