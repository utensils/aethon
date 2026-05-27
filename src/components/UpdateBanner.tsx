//! Top-of-window banner that surfaces the auto-updater's pending update
//! state. Mounted by `App.tsx` outside the layout payload (chrome that
//! sits above whatever the agent rendered).
//!
//! The banner has three visual modes:
//!
//! 1. **Available** — "Aethon v0.4.0 is available" + Install / Dismiss.
//! 2. **Downloading** — `updater://preparing` ("Preparing backup…") then
//!    `updater://progress` (0–100 percent bar). The Rust side restarts
//!    the app once the install finishes; the banner stays mounted
//!    through that lifecycle.
//! 3. **Error** — install failed; offer Retry / Open release page /
//!    Dismiss. The release URL changes by channel so a stuck nightly
//!    user can still pick up the latest signed bundle by hand.
//!
//! Unstyled-by-design: pulls in a small CSS module so themes can
//! override `--update-banner-bg` / accent vars without forking the
//! component. Skill authors can register a `update-banner` composite
//! to replace this entirely via [`SkillRegistry.registerComponent`].

import type { JSX } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { releaseUrl, type UpdaterStateView } from "../hooks/useUpdater";
import styles from "./UpdateBanner.module.css";

export interface UpdateBannerProps {
  state: UpdaterStateView;
  onInstallNow: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}

export function UpdateBanner({
  state,
  onInstallNow,
  onDismiss,
  onRetry,
}: UpdateBannerProps): JSX.Element | null {
  if (state.error) {
    const url = releaseUrl(state.channel);
    return (
      <div className={styles.banner} role="alert">
        <span className={`${styles.message} ${styles.errorMessage}`}>
          Update failed: {state.error}
        </span>
        <div className={styles.actions}>
          <button className={styles.btnPrimary} onClick={onRetry}>
            Try again
          </button>
          <button
            className={styles.btn}
            onClick={() => {
              void openUrl(url).catch(() => {});
            }}
          >
            View release page
          </button>
          <button className={styles.btn} onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!state.available || state.dismissed) return null;

  const productLabel =
    state.channel === "nightly" ? "Aethon Nightly" : "Aethon";

  if (state.downloading) {
    const phaseLabel =
      state.preparing === "backup"
        ? "Preparing rollback backup…"
        : "Downloading update…";
    return (
      <div className={styles.banner}>
        <span className={styles.message}>{phaseLabel}</span>
        <div className={styles.progressWrap}>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressBar}
              style={{ width: `${state.progress}%` }}
            />
          </div>
          <span className={styles.progressLabel}>{state.progress}%</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.banner}>
      <span className={styles.message}>
        {productLabel}{" "}
        <span className={styles.version}>v{state.version}</span> is available
      </span>
      <div className={styles.actions}>
        <button className={styles.btnPrimary} onClick={onInstallNow}>
          Install Now
        </button>
        <button className={styles.btn} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
