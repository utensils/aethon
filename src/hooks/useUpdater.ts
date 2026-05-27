import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// Background auto-update poll interval. 30 minutes matches Claudette and
/// is well below GitHub's anonymous-API rate limits even with several
/// running Aethon instances on one box.
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export type UpdateChannel = "stable" | "nightly";

export interface UpdateInfo {
  version: string;
  current_version: string;
  body: string | null;
  date: string | null;
}

export interface UpdaterStateView {
  available: boolean;
  version: string | null;
  body: string | null;
  channel: UpdateChannel;
  downloading: boolean;
  preparing: "backup" | "downloading" | null;
  progress: number;
  error: string | null;
  dismissed: boolean;
}

export interface UseUpdaterContext {
  /** From useChat — surface non-terminal status as system messages so the
   *  user sees what's happening; failures bubble up to the menu handler's
   *  catch and become a system error bubble. */
  appendSystem: (text: string) => void;
  /** Initial channel resolved from `config.toml`. The hook keeps it in
   *  sync with `setChannel` so the settings UI and the menu trigger the
   *  same poll. */
  channel: UpdateChannel;
}

export interface UseUpdaterActions {
  /** Manual menu trigger. Forces a check immediately and downloads if
   *  one is available. */
  checkForUpdates: () => Promise<void>;
  /** Banner "Install Now" click. */
  installNow: () => Promise<void>;
  /** Banner "Dismiss" click — hides the banner until the next check
   *  finds a NEWER version. */
  dismiss: () => void;
  /** Manual re-check after a failure. Clears the error first so the
   *  banner shows the in-flight state, not the old failure. */
  retryInstall: () => Promise<void>;
  /** Switch channel at runtime. */
  setChannel: (next: UpdateChannel) => void;
}

const INITIAL_STATE: UpdaterStateView = {
  available: false,
  version: null,
  body: null,
  channel: "stable",
  downloading: false,
  preparing: null,
  progress: 0,
  error: null,
  dismissed: false,
};

const RELEASE_URL_BY_CHANNEL: Record<UpdateChannel, string> = {
  stable: "https://github.com/utensils/aethon/releases/latest",
  nightly: "https://github.com/utensils/aethon/releases/tag/nightly",
};

export function releaseUrl(channel: UpdateChannel): string {
  return RELEASE_URL_BY_CHANNEL[channel];
}

/**
 * Manual + auto-updater. Wires the menu's "Check for Updates" action
 * to the new Rust `check_for_updates_with_channel` command (which engages
 * boot probation on install) and runs a 30-minute background poll on
 * release builds.
 *
 * The Rust shell only registers the updater plugin when a pubkey is
 * configured; if not, `updater_available` returns false and we report
 * cleanly instead of throwing on every poll.
 */
export function useUpdater(ctx: UseUpdaterContext): {
  state: UpdaterStateView;
  actions: UseUpdaterActions;
} {
  const { appendSystem } = ctx;
  const [state, setState] = useState<UpdaterStateView>(() => ({
    ...INITIAL_STATE,
    channel: ctx.channel,
  }));
  // Mirror state into a ref so async callbacks can read the latest
  // value without going back through React's queue. The hook's setters
  // remain the only writer.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const lastDismissedVersion = useRef<string | null>(null);

  const update = useCallback(
    (patch: Partial<UpdaterStateView>) => {
      setState((prev) => ({ ...prev, ...patch }));
    },
    [setState],
  );

  // Channel changes from settings UI: persist the runtime view + trigger
  // a fresh check against the new endpoint.
  const setChannel = useCallback(
    (next: UpdateChannel) => {
      if (next === stateRef.current.channel) return;
      update({
        channel: next,
        available: false,
        version: null,
        body: null,
        dismissed: false,
        error: null,
      });
    },
    [update],
  );

  // The actual check. Internal — `checkForUpdates` calls this and also
  // posts system messages for the manual path.
  const runCheck = useCallback(
    async (
      opts: { announce?: boolean } = {},
    ): Promise<"available" | "up-to-date" | "error" | "disabled"> => {
      const available = await invoke<boolean>("updater_available").catch(
        () => false,
      );
      if (!available) {
        if (opts.announce)
          appendSystem(
            "Updater isn't configured for this build. See RELEASING.md to set up signing keys.",
          );
        return "disabled";
      }
      try {
        const info = await invoke<UpdateInfo | null>(
          "check_for_updates_with_channel",
          { channel: stateRef.current.channel },
        );
        if (info) {
          // Only un-dismiss if this is a different version than what
          // the user already dismissed.
          const dismissed =
            stateRef.current.dismissed &&
            lastDismissedVersion.current === info.version;
          update({
            available: true,
            version: info.version,
            body: info.body,
            error: null,
            dismissed,
          });
          return "available";
        }
        update({ available: false, version: null, body: null, error: null });
        return "up-to-date";
      } catch (err) {
        const message = String(err);
        if (opts.announce) appendSystem(`Update check failed: ${message}`);
        update({ error: message });
        return "error";
      }
    },
    [appendSystem, update],
  );

  const installNow = useCallback(async () => {
    if (stateRef.current.downloading) return;
    update({
      downloading: true,
      preparing: null,
      progress: 0,
      error: null,
    });
    try {
      await invoke("install_pending_update");
      // The Rust side calls app.restart() on success — so this line
      // typically isn't reached. If it is (silent install failure),
      // surface it.
    } catch (err) {
      const message = String(err);
      appendSystem(`Update install failed: ${message}`);
      update({
        downloading: false,
        preparing: null,
        progress: 0,
        error: message,
      });
    }
  }, [appendSystem, update]);

  const retryInstall = useCallback(async () => {
    update({ error: null, dismissed: false });
    const result = await runCheck({ announce: false });
    if (result === "available") await installNow();
  }, [installNow, runCheck, update]);

  const dismiss = useCallback(() => {
    lastDismissedVersion.current = stateRef.current.version;
    update({ dismissed: true });
  }, [update]);

  const checkForUpdates = useCallback(async () => {
    appendSystem("Checking for updates…");
    const result = await runCheck({ announce: true });
    if (result === "up-to-date") appendSystem("Aethon is up to date.");
    else if (result === "available") {
      appendSystem(
        `Update available: ${stateRef.current.version}. Downloading…`,
      );
      await installNow();
    }
  }, [appendSystem, installNow, runCheck]);

  // Acknowledge a healthy boot once the React side has rendered. This
  // cancels any in-flight boot-probation rollback timer.
  useEffect(() => {
    invoke("boot_stage", { stage: "react_mounted", detail: null }).catch(
      () => {},
    );
    // Defer boot_ok by one animation frame so the first paint actually
    // commits. If something throws synchronously during initial render
    // the boot_stage record stays "react_mounted" and the rollback
    // timer fires as designed.
    const raf = requestAnimationFrame(() => {
      invoke("boot_ok").catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Subscribe to download progress + the pre-download `preparing` phase.
  useEffect(() => {
    let cancelled = false;
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenPreparing: UnlistenFn | undefined;
    listen<number>("updater://progress", (event) => {
      update({ progress: event.payload });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenProgress = fn;
      })
      .catch(() => {});
    listen<string>("updater://preparing", (event) => {
      const phase = event.payload === "backup" ? "backup" : "downloading";
      update({ preparing: phase });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenPreparing = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenPreparing?.();
    };
  }, [update]);

  // Background poll. Off in dev so iteration doesn't keep pinging
  // GitHub; in production the first check fires shortly after mount.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    runCheck({ announce: false }).catch(() => {});
    const id = window.setInterval(() => {
      runCheck({ announce: false }).catch(() => {});
    }, CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [runCheck, state.channel]);

  return {
    state,
    actions: {
      checkForUpdates,
      installNow,
      dismiss,
      retryInstall,
      setChannel,
    },
  };
}
