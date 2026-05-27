//! Save lifecycle. Two entry points:
//!
//!  - [`schedule_save`] — debounced 250 ms; coalesces a burst of
//!    Moved/Resized events into one disk write per quiet window.
//!  - [`save_now`] — synchronous flush, called from `CloseRequested`
//!    so we don't lose the final position when the app shuts down.
//!
//! Maximized windows preserve the prior "normal" bounds — only the
//! `maximized` flag flips — so un-maximize later lands at the user's
//! last sensible size. Fullscreen is treated as transient and skipped.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::WindowStateStore;
use super::persistence::{load_store, save_store};
use super::schema::{CURRENT_VERSION, MonitorSnapshot, WindowState, default_normal};

const SAVE_DEBOUNCE_MS: u64 = 250;

/// Schedule a debounced save. Repeated calls within 250 ms coalesce.
pub fn schedule_save(app: AppHandle, label: String) {
    let counter = app.state::<WindowStateStore>().generation(&label);
    let token = counter.fetch_add(1, Ordering::SeqCst) + 1;

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SAVE_DEBOUNCE_MS)).await;
        let current = app
            .state::<WindowStateStore>()
            .generation(&label)
            .load(Ordering::SeqCst);
        if current != token {
            return;
        }
        if let Err(e) = save_now(&app, &label) {
            tracing::warn!(target: "aethon::window_state", "scheduled save failed: {e}");
        }
    });
}

/// Synchronous flush — called on `CloseRequested`.
pub fn save_now(app: &AppHandle, label: &str) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else {
        return Ok(());
    };

    // Fullscreen is a transient mode — don't persist; let the prior
    // saved state stand for the next launch.
    if window.is_fullscreen().unwrap_or(false) {
        return Ok(());
    }

    let scale = window.scale_factor().map_err(|e| format!("scale: {e}"))?;
    let Some(monitor) = window
        .current_monitor()
        .map_err(|e| format!("current_monitor: {e}"))?
    else {
        return Ok(()); // transient detached state — skip
    };
    let monitor_snap = MonitorSnapshot::from_monitor(&monitor);
    let maximized = window.is_maximized().unwrap_or(false);

    let mut store = load_store(app);
    let next = if maximized {
        // Preserve prior normal bounds; flip the maximized flag. Without
        // this, un-maximize would land at the monitor-full geometry.
        let base = store
            .states
            .get(label)
            .cloned()
            .unwrap_or_else(|| default_normal(monitor_snap));
        WindowState {
            maximized: true,
            monitor: monitor_snap,
            version: CURRENT_VERSION,
            ..base
        }
    } else {
        let outer = window
            .outer_position()
            .map_err(|e| format!("outer_position: {e}"))?;
        let inner = window
            .inner_size()
            .map_err(|e| format!("inner_size: {e}"))?;
        WindowState {
            x: f64::from(outer.x) / scale,
            y: f64::from(outer.y) / scale,
            width: f64::from(inner.width) / scale,
            height: f64::from(inner.height) / scale,
            maximized: false,
            monitor: monitor_snap,
            version: CURRENT_VERSION,
        }
    };
    store.states.insert(label.to_string(), next);
    save_store(app, &store)
}
