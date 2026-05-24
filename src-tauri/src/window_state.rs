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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, Position, Size};

const STATE_FILE: &str = "window-state.json";
const SAVE_DEBOUNCE_MS: u64 = 250;
const MAIN_LABEL: &str = "main";
const MIN_WIDTH: f64 = 600.0;
const MIN_HEIGHT: f64 = 400.0;
/// Minimum logical pixels of right edge / titlebar that must remain
/// visible after a clamp — keeps the window controls reachable on every
/// platform without making restored windows feel "snapped".
const CLAMP_MARGIN_X: f64 = 80.0;
const CLAMP_MARGIN_Y: f64 = 40.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    pub monitor: MonitorSnapshot,
    /// Schema version. Bumped when the on-disk semantics change so old
    /// records can be migrated. Missing → `0` (the original
    /// physical-pixel format from the prior release).
    #[serde(default)]
    pub version: u32,
}

const CURRENT_VERSION: u32 = 1;

/// Logical-pixel snapshot of a monitor — used both as the persisted
/// "saved monitor" record and as the runtime view of a current monitor
/// (constructed via [`MonitorSnapshot::from_monitor`]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MonitorSnapshot {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

impl MonitorSnapshot {
    fn from_monitor(m: &Monitor) -> Self {
        let scale = m.scale_factor();
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        Self {
            x: f64::from(m.position().x) / scale,
            y: f64::from(m.position().y) / scale,
            width: f64::from(m.size().width) / scale,
            height: f64::from(m.size().height) / scale,
            scale,
        }
    }

    fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct PersistedStore {
    #[serde(flatten)]
    states: HashMap<String, WindowState>,
}

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

    fn generation(&self, label: &str) -> Arc<AtomicU64> {
        let mut g = self.save_gen.lock().unwrap();
        Arc::clone(g.entry(label.to_string()).or_default())
    }
}

fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(STATE_FILE))
}

fn load_store(app: &AppHandle) -> PersistedStore {
    let Ok(path) = state_file_path(app) else {
        return PersistedStore::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => {
            let raw: PersistedStore = serde_json::from_str(&s).unwrap_or_else(|e| {
                tracing::warn!(target: "aethon::window_state", "parse {}: {e}", path.display());
                PersistedStore::default()
            });
            migrate(raw)
        }
        _ => PersistedStore::default(),
    }
}

/// Apply per-record migrations so on-disk format changes don't strand
/// users' saved geometry. Currently:
///  - v0 → v1: old records stored window x/y/w/h as physical px (the
///    fields were i32/u32 in the prior release). The new code treats
///    them as logical px. Divide by `monitor.scale` to recover logical
///    units. No-op on a 1× monitor.
fn migrate(mut store: PersistedStore) -> PersistedStore {
    for state in store.states.values_mut() {
        if state.version < 1 {
            let scale = if state.monitor.scale.is_finite() && state.monitor.scale > 0.0 {
                state.monitor.scale
            } else {
                1.0
            };
            state.x /= scale;
            state.y /= scale;
            state.width /= scale;
            state.height /= scale;
            state.version = 1;
        }
    }
    store
}

fn save_store(app: &AppHandle, store: &PersistedStore) -> Result<(), String> {
    let path = state_file_path(app)?;
    let body = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Apply persisted geometry before the window is shown. First launch
/// falls back to maximized on the primary monitor. Always shows the
/// window so a partial failure can't strand the user.
pub fn restore_on_setup(app: &AppHandle) -> Result<(), String> {
    let store = load_store(app);
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        tracing::warn!(target: "aethon::window_state", "main window not found at setup");
        return Ok(());
    };

    let monitors = window
        .available_monitors()
        .map_err(|e| format!("available_monitors: {e}"))?;
    let monitor_snaps: Vec<MonitorSnapshot> =
        monitors.iter().map(MonitorSnapshot::from_monitor).collect();

    if let Some(state) = store.states.get(MAIN_LABEL)
        && !monitor_snaps.is_empty()
    {
        let target = restoreable_state(state, &monitor_snaps);
        // Un-maximize first so set_position/set_size apply to the
        // normal bounds, then re-maximize at the end if needed.
        let _ = window.unmaximize();
        if let Err(e) = window.set_size(Size::Logical(LogicalSize {
            width: target.width,
            height: target.height,
        })) {
            tracing::warn!(target: "aethon::window_state", "set_size: {e}");
        }
        if let Err(e) = window.set_position(Position::Logical(LogicalPosition {
            x: target.x,
            y: target.y,
        })) {
            tracing::warn!(target: "aethon::window_state", "set_position: {e}");
        }
        if state.maximized
            && let Err(e) = window.maximize()
        {
            tracing::warn!(target: "aethon::window_state", "maximize: {e}");
        }
    } else if let Err(e) = window.maximize() {
        // Manifest `"maximized": true` is unreliable on macOS — force.
        tracing::warn!(target: "aethon::window_state", "default maximize: {e}");
    }

    if let Err(e) = window.show() {
        tracing::warn!(target: "aethon::window_state", "show: {e}");
    }
    Ok(())
}

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

fn default_normal(monitor: MonitorSnapshot) -> WindowState {
    let width = 1200.0_f64.min(monitor.width);
    let height = 800.0_f64.min(monitor.height);
    WindowState {
        x: monitor.x + (monitor.width - width).max(0.0) / 2.0,
        y: monitor.y + (monitor.height - height).max(0.0) / 2.0,
        width,
        height,
        maximized: false,
        monitor,
        version: CURRENT_VERSION,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Compute the bounds the window should restore to, given the saved
/// state and the current monitor list. All units are logical.
pub fn restoreable_state(state: &WindowState, monitors: &[MonitorSnapshot]) -> LogicalRect {
    debug_assert!(!monitors.is_empty());
    let saved_monitor = state.monitor;
    let saved_window = LogicalRect {
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
    };

    let target = exact_match(&saved_monitor, monitors)
        .or_else(|| intersects(&saved_window, monitors))
        .copied()
        .unwrap_or_else(|| nearest_by_center(&saved_monitor, monitors));

    // Preserve offset-within-monitor onto the target.
    let dx = target.x - saved_monitor.x;
    let dy = target.y - saved_monitor.y;
    let mut x = saved_window.x + dx;
    let mut y = saved_window.y + dy;

    let width = saved_window
        .width
        .min(target.width)
        .max(MIN_WIDTH.min(target.width));
    let height = saved_window
        .height
        .min(target.height)
        .max(MIN_HEIGHT.min(target.height));

    let max_x = target.x + target.width - CLAMP_MARGIN_X;
    let max_y = target.y + target.height - CLAMP_MARGIN_Y;
    let min_x = target.x - (width - CLAMP_MARGIN_X).max(0.0);
    let min_y = target.y;
    if min_x <= max_x {
        x = x.clamp(min_x, max_x);
    } else {
        x = target.x;
    }
    if min_y <= max_y {
        y = y.clamp(min_y, max_y);
    } else {
        y = target.y;
    }

    LogicalRect {
        x,
        y,
        width,
        height,
    }
}

fn exact_match<'a>(
    saved: &MonitorSnapshot,
    monitors: &'a [MonitorSnapshot],
) -> Option<&'a MonitorSnapshot> {
    monitors
        .iter()
        .filter(|m| (m.width - saved.width).abs() < 0.5 && (m.height - saved.height).abs() < 0.5)
        .min_by(|a, b| {
            sq_distance((a.x, a.y), (saved.x, saved.y))
                .partial_cmp(&sq_distance((b.x, b.y), (saved.x, saved.y)))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn intersects<'a>(
    window: &LogicalRect,
    monitors: &'a [MonitorSnapshot],
) -> Option<&'a MonitorSnapshot> {
    let right = window.x + window.width;
    let bottom = window.y + window.height;
    let window_center = (
        window.x + window.width / 2.0,
        window.y + window.height / 2.0,
    );
    // With mixed-scale monitor arrangements the per-monitor logical
    // rects can overlap numerically, so first-overlap could pick the
    // wrong display. Among all intersecting candidates, return the one
    // whose center is closest to the saved window's center.
    monitors
        .iter()
        .filter(|m| {
            window.x < m.x + m.width && right > m.x && window.y < m.y + m.height && bottom > m.y
        })
        .min_by(|a, b| {
            sq_distance(a.center(), window_center)
                .partial_cmp(&sq_distance(b.center(), window_center))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn nearest_by_center(saved: &MonitorSnapshot, monitors: &[MonitorSnapshot]) -> MonitorSnapshot {
    let saved_center = saved.center();
    monitors
        .iter()
        .min_by(|a, b| {
            sq_distance(a.center(), saved_center)
                .partial_cmp(&sq_distance(b.center(), saved_center))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .copied()
        .expect("non-empty monitors")
}

fn sq_distance(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: f64, y: f64, w: f64, h: f64, scale: f64) -> MonitorSnapshot {
        MonitorSnapshot {
            x,
            y,
            width: w,
            height: h,
            scale,
        }
    }

    fn state(x: f64, y: f64, w: f64, h: f64, monitor: MonitorSnapshot) -> WindowState {
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

    fn approx_eq(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.5
    }

    #[test]
    fn single_monitor_no_op_when_in_bounds() {
        let m = mon(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let out = restoreable_state(&state(200.0, 150.0, 800.0, 600.0, m), &[m]);
        assert!(approx_eq(out.x, 200.0) && approx_eq(out.y, 150.0));
        assert!(approx_eq(out.width, 800.0) && approx_eq(out.height, 600.0));
    }

    #[test]
    fn exact_dim_match_picks_repositioned_monitor() {
        // Saved monitor and a smaller one present; same-dim monitor
        // moved since save. Window rides along.
        let saved = mon(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let now_repositioned = mon(-1920.0, 0.0, 1920.0, 1080.0, 1.0);
        let other = mon(0.0, 0.0, 1024.0, 768.0, 1.0);
        let out = restoreable_state(
            &state(200.0, 150.0, 800.0, 600.0, saved),
            &[other, now_repositioned],
        );
        assert!(approx_eq(out.x, -1720.0));
        assert!(approx_eq(out.y, 150.0));
        assert!(approx_eq(out.width, 800.0));
    }

    #[test]
    fn duplicate_dimension_monitors_pick_closest_origin() {
        // Three same-dim monitors arranged horizontally; saved monitor
        // is the middle one. Exact match picks closest origin → middle.
        let a = mon(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let b = mon(1920.0, 0.0, 1920.0, 1080.0, 1.0);
        let c = mon(3840.0, 0.0, 1920.0, 1080.0, 1.0);
        let out = restoreable_state(&state(2020.0, 100.0, 800.0, 600.0, b), &[a, b, c]);
        assert!(approx_eq(out.x, 2020.0));
        assert!(approx_eq(out.y, 100.0));
    }

    #[test]
    fn cross_dpi_save_restore_keeps_logical_size() {
        // Saved on a 2× monitor, restored onto a 1× monitor — window
        // should keep its user-visible size (logical units). No exact
        // match → intersect / nearest fallback.
        let retina = mon(0.0, 0.0, 1500.0, 900.0, 2.0);
        let one_x = mon(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let out = restoreable_state(&state(100.0, 100.0, 800.0, 600.0, retina), &[one_x]);
        // Intersects → translate dx=0; size unchanged logical 800×600.
        assert!(approx_eq(out.width, 800.0));
        assert!(approx_eq(out.height, 600.0));
    }

    #[test]
    fn missing_monitor_falls_back_to_nearest_center() {
        let external = mon(1920.0, 0.0, 2560.0, 1440.0, 1.0);
        let laptop = mon(0.0, 0.0, 1440.0, 900.0, 1.0);
        let out = restoreable_state(&state(2120.0, 200.0, 800.0, 600.0, external), &[laptop]);
        // Offset (200, 200) preserved onto laptop origin (0, 0).
        assert!(approx_eq(out.x, 200.0));
        assert!(approx_eq(out.y, 200.0));
    }

    #[test]
    fn intersect_fallback_when_saved_monitor_dims_changed() {
        // Saved on 1920×1080, that monitor's resolution toggled.
        let now = mon(0.0, 0.0, 2560.0, 1440.0, 1.0);
        let out = restoreable_state(
            &state(
                100.0,
                100.0,
                800.0,
                600.0,
                mon(0.0, 0.0, 1920.0, 1080.0, 1.0),
            ),
            &[now],
        );
        assert!(approx_eq(out.x, 100.0));
        assert!(approx_eq(out.y, 100.0));
    }

    #[test]
    fn oversize_window_clamped_to_target_monitor() {
        let small = mon(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let big_phantom = mon(0.0, 0.0, 3840.0, 2160.0, 1.0);
        let out = restoreable_state(&state(100.0, 100.0, 3000.0, 1800.0, big_phantom), &[small]);
        assert!(out.width <= small.width + 0.5);
        assert!(out.height <= small.height + 0.5);
    }

    #[test]
    fn off_edge_window_clamped_into_visible_area() {
        let m = mon(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let out = restoreable_state(&state(1900.0, 1070.0, 800.0, 600.0, m), &[m]);
        assert!(out.x + CLAMP_MARGIN_X <= m.x + m.width + 0.5);
        assert!(out.y + CLAMP_MARGIN_Y <= m.y + m.height + 0.5);
    }

    #[test]
    fn persisted_store_round_trips_through_json() {
        let mut store = PersistedStore::default();
        store.states.insert(
            "main".into(),
            state(
                100.0,
                200.0,
                800.0,
                600.0,
                mon(0.0, 0.0, 1920.0, 1080.0, 1.0),
            ),
        );
        let back: PersistedStore =
            serde_json::from_str(&serde_json::to_string(&store).unwrap()).unwrap();
        let r = back.states.get("main").unwrap();
        assert!(approx_eq(r.x, 100.0) && approx_eq(r.width, 800.0));
        assert!(approx_eq(r.monitor.scale, 1.0));
        assert_eq!(r.version, CURRENT_VERSION);
    }

    #[test]
    fn migrate_v0_physical_record_to_logical() {
        // Prior release stored window x/y/w/h as physical px alongside
        // a Retina-scale monitor. Round-trip through migrate() must
        // divide by scale to recover logical units.
        let raw = r#"{
            "main": {
                "x": 600, "y": 400, "width": 2000, "height": 1400,
                "maximized": false,
                "monitor": { "x": 0, "y": 0, "width": 2056, "height": 1329, "scale": 2.0 }
            }
        }"#;
        let parsed: PersistedStore = serde_json::from_str(raw).unwrap();
        let migrated = migrate(parsed);
        let m = migrated.states.get("main").unwrap();
        assert!(approx_eq(m.x, 300.0));
        assert!(approx_eq(m.y, 200.0));
        assert!(approx_eq(m.width, 1000.0));
        assert!(approx_eq(m.height, 700.0));
        assert_eq!(m.version, CURRENT_VERSION);
    }

    #[test]
    fn migrate_v0_on_1x_monitor_is_noop() {
        // On a 1× monitor physical == logical, so no value change.
        let raw = r#"{
            "main": {
                "x": -1325, "y": 440, "width": 1281, "height": 859,
                "maximized": false,
                "monitor": { "x": -5120, "y": 0, "width": 5120, "height": 1440, "scale": 1.0 }
            }
        }"#;
        let m = migrate(serde_json::from_str(raw).unwrap())
            .states
            .remove("main")
            .unwrap();
        assert!(approx_eq(m.x, -1325.0));
        assert!(approx_eq(m.width, 1281.0));
        assert_eq!(m.version, CURRENT_VERSION);
    }

    #[test]
    fn migrate_skips_records_already_at_current_version() {
        // A v1 record must not be migrated again.
        let mut store = PersistedStore::default();
        store.states.insert(
            "main".into(),
            state(
                300.0,
                200.0,
                1000.0,
                700.0,
                mon(0.0, 0.0, 2056.0, 1329.0, 2.0),
            ),
        );
        let migrated = migrate(store);
        let m = migrated.states.get("main").unwrap();
        // Values unchanged — no double-divide by 2.0.
        assert!(approx_eq(m.x, 300.0));
        assert!(approx_eq(m.width, 1000.0));
    }

    #[test]
    fn intersect_picks_best_center_match_when_multiple_candidates() {
        // Two monitors whose logical rects both intersect the saved
        // window (mixed-scale overlap scenario). The one whose center
        // is closest to the window's center should win.
        let near_window = mon(0.0, 0.0, 1920.0, 1080.0, 1.0);
        let far_overlap = mon(800.0, 0.0, 1920.0, 1080.0, 1.0);
        let s = state(
            100.0,
            100.0,
            800.0,
            600.0,
            // Phantom saved monitor — no dim match.
            mon(0.0, 0.0, 9999.0, 9999.0, 1.0),
        );
        let out = restoreable_state(&s, &[far_overlap, near_window]);
        // Window center ≈ (500, 400). near_window center (960, 540)
        // is closer than far_overlap center (1760, 540). The result
        // should translate as if `near_window` was picked — dx = 0.
        assert!(approx_eq(out.x, 100.0));
        assert!(approx_eq(out.y, 100.0));
    }
}
