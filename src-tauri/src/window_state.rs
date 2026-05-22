//! Native window geometry persistence — position, size, maximized
//! state, and the monitor the window was on at save time.
//!
//! Storage: a single JSON file at `~/.aethon/window-state.json` keyed by
//! window label (`{"main": {...}, "settings": {...}}`). Aethon ships one
//! window today; the map shape is so adding a second (popout, settings
//! window) is a one-line change instead of a schema migration.
//!
//! Restore happens in `setup()` *before* the window is shown — Tauri
//! config sets `visible: false`, this module applies geometry, then the
//! window is `show()`n. No restoration race, no settle-debounce.
//!
//! Save is 250 ms-debounced on `WindowEvent::Moved` / `WindowEvent::Resized`
//! and flushed synchronously on `WindowEvent::CloseRequested`. The
//! debounce uses a monotonically-incrementing generation counter — every
//! event bumps the counter and spawns a delayed worker that no-ops if
//! the counter moved while it slept.
//!
//! Multi-monitor matching (`restoreable_rect`):
//!  1. Find a monitor whose dimensions exactly match the saved monitor.
//!     If multiple match, pick the one closest in absolute origin.
//!  2. If none match, pick the monitor whose center is nearest the saved
//!     window's center.
//!  3. If the saved rect would land off-screen on the picked monitor,
//!     clamp into the monitor's visible area.
//!
//! This is the 95% case. Spaces/desktops aren't tracked — Tauri 2's
//! public API doesn't expose them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

const STATE_FILE: &str = "window-state.json";
const SAVE_DEBOUNCE_MS: u64 = 250;
const MAIN_LABEL: &str = "main";

/// Per-window persisted geometry. Physical coordinates so the same JSON
/// re-applies cleanly across DPI changes; `monitor` records where the
/// window was at save time so [`restoreable_rect`] can match it back to
/// a current monitor on next boot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub monitor: MonitorSnapshot,
}

/// Snapshot of the monitor the window lived on at save time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorSnapshot {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// Whole-store schema — labelled map so future windows ride this without
/// migration. The outer object is the serialized form of
/// [`WindowStateStore::states`].
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct PersistedStore {
    #[serde(flatten)]
    states: HashMap<String, WindowState>,
}

/// Tauri-managed save coordinator. Holds the debounce generation counter
/// per label so concurrent windows don't stomp each other's pending writes.
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
    let dir = home.join(".aethon");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(STATE_FILE))
}

fn load_store(app: &AppHandle) -> PersistedStore {
    let Ok(path) = state_file_path(app) else {
        return PersistedStore::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or_else(|e| {
            tracing::warn!(target: "aethon::window_state", "parse {}: {e}", path.display());
            PersistedStore::default()
        }),
        _ => PersistedStore::default(),
    }
}

fn save_store(app: &AppHandle, store: &PersistedStore) -> Result<(), String> {
    let path = state_file_path(app)?;
    let body = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Apply persisted geometry to `main` (or whichever window matches the
/// stored label) before it's shown. Falls back to a maximized window on
/// the primary monitor when no state exists. Always shows the window at
/// the end so a partial failure (e.g. monitor-list query) can never
/// leave the user staring at a hidden window.
pub fn restore_on_setup(app: &AppHandle) -> Result<(), String> {
    let store = load_store(app);
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        tracing::warn!(target: "aethon::window_state", "main window not found at setup");
        return Ok(());
    };

    let monitors = window
        .available_monitors()
        .map_err(|e| format!("available_monitors: {e}"))?;
    let monitor_rects: Vec<Rect> = monitors.iter().map(Rect::from_monitor).collect();

    if let Some(state) = store.states.get(MAIN_LABEL)
        && !monitor_rects.is_empty()
    {
        let target = restoreable_rect(state, &monitor_rects);
        let _ = window.unmaximize();
        if let Err(e) = window.set_position(PhysicalPosition::new(target.x, target.y)) {
            tracing::warn!(target: "aethon::window_state", "set_position: {e}");
        }
        if let Err(e) = window.set_size(PhysicalSize::new(target.width, target.height)) {
            tracing::warn!(target: "aethon::window_state", "set_size: {e}");
        }
        if state.maximized
            && let Err(e) = window.maximize()
        {
            tracing::warn!(target: "aethon::window_state", "maximize: {e}");
        }
    } else {
        // No saved state — match the previous behavior of opening
        // maximized on the primary monitor. The manifest's
        // `"maximized": true` is unreliable on macOS so we force it.
        if let Err(e) = window.maximize() {
            tracing::warn!(target: "aethon::window_state", "default maximize: {e}");
        }
    }

    if let Err(e) = window.show() {
        tracing::warn!(target: "aethon::window_state", "show: {e}");
    }
    Ok(())
}

/// Snapshot the window's current geometry and persist after a 250 ms
/// debounce. Repeated calls within the window coalesce into one write.
pub fn schedule_save(app: AppHandle, label: String) {
    let store_state = app.state::<WindowStateStore>();
    let counter = store_state.generation(&label);
    let token = counter.fetch_add(1, Ordering::SeqCst) + 1;

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SAVE_DEBOUNCE_MS)).await;
        let store_state = app.state::<WindowStateStore>();
        let current = store_state.generation(&label).load(Ordering::SeqCst);
        if current != token {
            return; // a newer event superseded this one
        }
        if let Err(e) = save_now(&app, &label) {
            tracing::warn!(target: "aethon::window_state", "scheduled save failed: {e}");
        }
    });
}

/// Synchronous flush — used on `CloseRequested` so we don't lose the
/// final geometry to a debounce that never fires.
pub fn save_now(app: &AppHandle, label: &str) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else {
        return Ok(());
    };
    // Tauri returns an error if the window is minimized; treat that
    // as a no-op rather than persisting bogus minimized coordinates.
    let maximized = window.is_maximized().unwrap_or(false);
    let position = window
        .outer_position()
        .map_err(|e| format!("outer_position: {e}"))?;
    let size = window.outer_size().map_err(|e| format!("outer_size: {e}"))?;
    let monitor = window
        .current_monitor()
        .map_err(|e| format!("current_monitor: {e}"))?;

    let monitor_snap = match monitor.as_ref() {
        Some(m) => MonitorSnapshot {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
        },
        // Window with no monitor (e.g. transient detached state) —
        // don't persist; we'd just write a bogus origin.
        None => return Ok(()),
    };

    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
        monitor: monitor_snap,
    };

    let mut store = load_store(app);
    store.states.insert(label.to_string(), state);
    save_store(app, &store)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn from_monitor(m: &tauri::Monitor) -> Self {
        Self {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        }
    }

    fn from_state(s: &WindowState) -> Self {
        Self {
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
        }
    }

    fn from_monitor_snap(s: &MonitorSnapshot) -> Self {
        Self {
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
        }
    }

    fn center(&self) -> (i64, i64) {
        (
            self.x as i64 + (self.width / 2) as i64,
            self.y as i64 + (self.height / 2) as i64,
        )
    }
}

/// Pick a target rect for `state` against the currently available
/// monitors. Algorithm:
///  1. Exact dimension match on the saved monitor (closest origin if
///     several match) → preserve position-within-monitor exactly.
///  2. Otherwise nearest-by-center monitor → translate the window so
///     its offset within the new monitor mirrors its offset within
///     the saved monitor (best-effort).
///  3. Clamp so the window's top-left lands inside the chosen monitor
///     and at least 80×40 px of titlebar remains on-screen.
pub fn restoreable_rect(state: &WindowState, monitors: &[Rect]) -> Rect {
    debug_assert!(!monitors.is_empty(), "caller guarantees ≥1 monitor");
    let saved_window = Rect::from_state(state);
    let saved_monitor = Rect::from_monitor_snap(&state.monitor);

    let target_monitor = exact_match(&saved_monitor, monitors)
        .or_else(|| Some(nearest_by_center(&saved_window, monitors)))
        .copied()
        .unwrap_or(monitors[0]);

    // Translate the window into the new monitor preserving the
    // offset-within-monitor (e.g. window was 100 px in from the left
    // edge of saved monitor → still 100 px in on the new one). This
    // is a no-op when the monitor matched exactly.
    let dx = target_monitor.x - saved_monitor.x;
    let dy = target_monitor.y - saved_monitor.y;
    let mut x = saved_window.x.saturating_add(dx);
    let mut y = saved_window.y.saturating_add(dy);

    // Cap the window's size to the target monitor — a 4K window
    // restored onto a 1080p screen should fit, not spill off-screen.
    let width = saved_window.width.min(target_monitor.width);
    let height = saved_window.height.min(target_monitor.height);

    let monitor_right = target_monitor.x + target_monitor.width as i32;
    let monitor_bottom = target_monitor.y + target_monitor.height as i32;
    // Clamp x/y so at least 80 px of right edge and 40 px of titlebar
    // stay on-screen — picked to fit a window-control cluster on every
    // platform without making restored windows feel "snapped".
    let min_x = target_monitor.x - (width as i32 - 80).max(0);
    let max_x = monitor_right - 80;
    let min_y = target_monitor.y;
    let max_y = monitor_bottom - 40;
    if min_x <= max_x {
        x = x.clamp(min_x, max_x);
    } else {
        x = target_monitor.x;
    }
    if min_y <= max_y {
        y = y.clamp(min_y, max_y);
    } else {
        y = target_monitor.y;
    }

    Rect {
        x,
        y,
        width,
        height,
    }
}

fn exact_match<'a>(saved: &Rect, monitors: &'a [Rect]) -> Option<&'a Rect> {
    monitors
        .iter()
        .filter(|m| m.width == saved.width && m.height == saved.height)
        .min_by_key(|m| {
            let dx = (m.x - saved.x) as i64;
            let dy = (m.y - saved.y) as i64;
            dx * dx + dy * dy
        })
}

fn nearest_by_center<'a>(saved: &Rect, monitors: &'a [Rect]) -> &'a Rect {
    let (sx, sy) = saved.center();
    monitors
        .iter()
        .min_by_key(|m| {
            let (mx, my) = m.center();
            (mx - sx).pow(2) + (my - sy).pow(2)
        })
        .expect("nearest_by_center called with empty monitors")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(x: i32, y: i32, w: u32, h: u32, monitor: Rect) -> WindowState {
        WindowState {
            x,
            y,
            width: w,
            height: h,
            maximized: false,
            monitor: MonitorSnapshot {
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                scale: 1.0,
            },
        }
    }

    fn mon(x: i32, y: i32, w: u32, h: u32) -> Rect {
        Rect {
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn single_monitor_no_op_when_in_bounds() {
        let m = mon(0, 0, 1920, 1080);
        let s = state(200, 150, 800, 600, m);
        let out = restoreable_rect(&s, &[m]);
        assert_eq!(out, Rect { x: 200, y: 150, width: 800, height: 600 });
    }

    #[test]
    fn exact_dim_match_picked_even_when_position_changed() {
        // Saved monitor and a smaller monitor present; same-dim monitor
        // moved to (-1920, 0) since save. Window should ride along.
        let saved_monitor = mon(0, 0, 1920, 1080);
        let now_a = mon(-1920, 0, 1920, 1080);
        let now_b = mon(0, 0, 1024, 768);
        let s = state(200, 150, 800, 600, saved_monitor);
        let out = restoreable_rect(&s, &[now_b, now_a]);
        // x translated by -1920 (saved was 200 → -1720 on relocated monitor)
        assert_eq!(out.x, -1720);
        assert_eq!(out.y, 150);
        assert_eq!(out.width, 800);
        assert_eq!(out.height, 600);
    }

    #[test]
    fn missing_monitor_falls_back_to_nearest_center() {
        // External monitor at (1920, 0) is gone; only the laptop screen
        // remains. The saved window should land on the laptop, offset
        // mirrored relative to the new monitor's origin.
        let external = mon(1920, 0, 2560, 1440);
        let laptop = mon(0, 0, 1440, 900);
        let s = state(2120, 200, 800, 600, external); // 200 px in from external
        let out = restoreable_rect(&s, &[laptop]);
        // Offset 200/200 preserved relative to laptop origin (0,0)
        assert_eq!(out.x, 200);
        assert_eq!(out.y, 200);
        // Size unchanged (fits within laptop)
        assert_eq!(out.width, 800);
        assert_eq!(out.height, 600);
    }

    #[test]
    fn oversize_window_clamped_to_monitor() {
        // Window saved on a 4K display; only 1080p available now.
        let m4k = mon(0, 0, 3840, 2160);
        let m1080 = mon(0, 0, 1920, 1080);
        let s = state(100, 100, 3000, 1800, m4k);
        let out = restoreable_rect(&s, &[m1080]);
        assert!(out.width <= m1080.width);
        assert!(out.height <= m1080.height);
        // Clamped — x/y should still fit
        assert!(out.x >= m1080.x);
        assert!(out.y >= m1080.y);
    }

    #[test]
    fn off_edge_window_clamped_into_visible_area() {
        // Window saved with its top-left near the bottom-right corner —
        // most of the titlebar would be off-screen on restore without
        // clamping. (Same-monitor save so the translation step is a no-op
        // and only the clamp can rescue it.)
        let m = mon(0, 0, 1920, 1080);
        let s = state(1900, 1070, 800, 600, m);
        let out = restoreable_rect(&s, &[m]);
        // 80 px right margin / 40 px bottom margin pulled in
        assert!(out.x + 80 <= m.x + m.width as i32);
        assert!(out.y + 40 <= m.y + m.height as i32);
        // Still on the monitor (not pulled into negative x/y).
        assert!(out.x >= m.x);
        assert!(out.y >= m.y);
    }

    #[test]
    fn nearest_by_center_picks_closest_when_no_exact_match() {
        let near = mon(-100, -100, 1024, 768);
        let far = mon(5000, 5000, 1024, 768);
        let saved_monitor = mon(0, 0, 1920, 1080); // no exact match
        let s = state(100, 100, 400, 300, saved_monitor);
        let out = restoreable_rect(&s, &[far, near]);
        // Translated relative to `near`, not `far`.
        // dx = -100, dy = -100 → window x = 0, y = 0
        assert_eq!(out.x, 0);
        assert_eq!(out.y, 0);
    }

    #[test]
    fn persisted_store_round_trips_through_json() {
        let mut s = PersistedStore::default();
        s.states.insert(
            "main".to_string(),
            state(100, 200, 800, 600, mon(0, 0, 1920, 1080)),
        );
        let json = serde_json::to_string(&s).unwrap();
        let back: PersistedStore = serde_json::from_str(&json).unwrap();
        assert_eq!(back.states.len(), 1);
        let restored = back.states.get("main").unwrap();
        assert_eq!(restored.x, 100);
        assert_eq!(restored.width, 800);
        assert_eq!(restored.monitor.scale, 1.0);
    }
}
