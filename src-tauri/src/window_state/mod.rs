//! Native window geometry persistence, in **logical** (DPI-independent)
//! pixels. The load-bearing detail: physical pixels aren't portable
//! across monitors with different scale factors, so a window saved on
//! Retina (scale 2.0) would render at the wrong user-visible size when
//! restored onto a 1× monitor unless every dimension is stored as
//! logical units.
//!
//! Storage: `~/.aethon/window-state.json`, map keyed by window label.
//!
//! Restore runs in `setup()` *before* the window is shown — Tauri's
//! manifest sets `visible: false`, this module applies bounds, then
//! shows. No restoration race, no settle-debounce. First launch (no
//! file) falls back to maximized on the primary monitor.
//!
//! Save: 250 ms-debounced on `Moved`/`Resized`, synchronous flush on
//! `CloseRequested`. When the window is maximized at save time the
//! prior "normal" bounds are preserved (only the `maximized` flag
//! flips) so un-maximizing later lands at the user's last sensible
//! size. Fullscreen is treated as transient and skipped.
//!
//! Monitor matching, three-tier fallback:
//!  1. Exact logical-dimension match — closest origin wins when several
//!     candidates share dimensions.
//!  2. Intersects — a current monitor whose rect overlaps the saved
//!     window. Catches resolution toggles since save.
//!  3. Nearest by saved-monitor center.
//!
//! Then the window is translated so its offset-within-saved-monitor is
//! preserved on the target, clamped so at least `CLAMP_MARGIN` of the
//! titlebar stays on-screen, and capped at the target monitor's size.
//!
//! Spaces / virtual desktops aren't tracked — Tauri 2's public API
//! doesn't expose a stable identifier.
//!
//! Submodules:
//!  - [`schema`]            — `WindowState` / `MonitorSnapshot` /
//!    `LogicalRect` / `PersistedStore`, `CURRENT_VERSION`, default-normal
//!    factory.
//!  - [`migration`]         — v0→v1 physical→logical migration.
//!  - [`persistence`]       — JSON read/write under `~/.aethon/`.
//!  - [`monitor_matching`]  — three-tier fallback (exact / intersect /
//!    nearest).
//!  - [`restore`]           — `restore_on_setup`, `restoreable_state`.
//!  - [`save`]              — `schedule_save`, `save_now`.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

mod migration;
mod monitor_matching;
mod persistence;
mod restore;
mod save;
mod schema;

pub use restore::{restore_on_setup, restore_window};
pub use save::{save_now, schedule_save};

/// Tauri-managed save coordinator. One debounce generation counter per
/// window label so concurrent windows don't stomp each other.
#[derive(Default)]
pub struct WindowStateStore {
    save_gen: Mutex<HashMap<String, Arc<AtomicU64>>>,
}

impl WindowStateStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub(super) fn generation(&self, label: &str) -> Arc<AtomicU64> {
        let mut g = self.save_gen.lock().unwrap();
        Arc::clone(g.entry(label.to_string()).or_default())
    }
}

#[cfg(test)]
pub(super) mod test_support {
    //! Shared `#[cfg(test)]` helpers — constructed `MonitorSnapshot` /
    //! `WindowState` values used by every submodule's unit tests, plus
    //! the float-tolerance comparison. Kept in one place so changes to
    //! the schema only touch one factory.

    use super::schema::{CURRENT_VERSION, MonitorSnapshot, WindowState};

    pub(crate) fn mon(x: f64, y: f64, w: f64, h: f64, scale: f64) -> MonitorSnapshot {
        MonitorSnapshot {
            x,
            y,
            width: w,
            height: h,
            scale,
        }
    }

    pub(crate) fn state(x: f64, y: f64, w: f64, h: f64, monitor: MonitorSnapshot) -> WindowState {
        WindowState {
            x,
            y,
            width: w,
            height: h,
            maximized: false,
            monitor,
            version: CURRENT_VERSION,
        }
    }

    pub(crate) fn approx_eq(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.5
    }
}
