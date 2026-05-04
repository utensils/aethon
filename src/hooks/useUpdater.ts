import { invoke } from "@tauri-apps/api/core";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UseUpdaterContext {
  /** From useChat — surface non-terminal status as system messages so the
   *  user sees what's happening; failures bubble up to the menu handler's
   *  catch and become a system error bubble. */
  appendSystem: (text: string) => void;
}

export interface UseUpdaterActions {
  checkForUpdates: () => Promise<void>;
}

/**
 * Manual "Check for Updates" — wired from the Aethon menu and the tray
 * menu. Walks tauri-plugin-updater's check → download → install pipeline
 * and relaunches when done.
 *
 * The Rust shell only registers the updater plugin when a pubkey is
 * configured; if not, `updater_available` returns false and we tell the
 * user clearly instead of throwing on the first invoke.
 */
export function useUpdater(ctx: UseUpdaterContext): UseUpdaterActions {
  const { appendSystem } = ctx;

  async function checkForUpdates() {
    let available = false;
    try {
      available = await invoke<boolean>("updater_available");
    } catch {
      /* assume unavailable */
    }
    if (!available) {
      appendSystem(
        "Updater isn't configured for this build. See RELEASING.md to set up signing keys.",
      );
      return;
    }
    appendSystem("Checking for updates…");
    let update: Awaited<ReturnType<typeof checkUpdate>>;
    try {
      update = await checkUpdate();
    } catch (err) {
      appendSystem(`Update check failed: ${err}`);
      return;
    }
    if (!update) {
      appendSystem("Aethon is up to date.");
      return;
    }
    appendSystem(`Update available: ${update.version}. Downloading…`);
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            // Periodic-ish progress: every 10% so the chat doesn't drown.
            if (pct % 10 === 0) appendSystem(`Update download: ${pct}%`);
          }
        } else if (event.event === "Finished") {
          appendSystem("Update downloaded. Restarting…");
        }
      });
      await relaunch();
    } catch (err) {
      appendSystem(`Update install failed: ${err}`);
    }
  }

  return { checkForUpdates };
}
