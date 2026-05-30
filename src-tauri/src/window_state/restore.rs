//! Restore-before-visible setup path. Applies persisted geometry to the
//! main window in `setup()` (Tauri's manifest sets `visible: false`,
//! this module sizes/positions, then shows). First launch — no file —
//! keeps the manifest default size (1200×800, centered); it does not
//! force-maximize.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size};

use super::monitor_matching::{exact_match, intersects, nearest_by_center};
use super::persistence::load_store;
use super::schema::{LogicalRect, MonitorSnapshot, WindowState};

const MAIN_LABEL: &str = "main";
const MIN_WIDTH: f64 = 600.0;
const MIN_HEIGHT: f64 = 400.0;
/// Minimum logical pixels of right edge / titlebar that must remain
/// visible after a clamp — keeps the window controls reachable on every
/// platform without making restored windows feel "snapped".
const CLAMP_MARGIN_X: f64 = 80.0;
const CLAMP_MARGIN_Y: f64 = 40.0;

/// Apply persisted geometry before the window is shown. First launch
/// keeps the manifest default geometry (no forced maximize). Always
/// shows the window so a partial failure can't strand the user. When
/// `activate_after_show` is true, the main window is also brought to
/// the foreground after an updater relaunch.
pub fn restore_on_setup(app: &AppHandle, activate_after_show: bool) -> Result<(), String> {
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
    }
    // First launch (or no monitors enumerated): keep the manifest default
    // geometry (1200×800, centered). Do NOT force-maximize — booting
    // maximized then snapping to the restored size is jarring, and a
    // zoomed window on macOS also can't be moved via the overlay
    // titlebar's drag region.

    show_main_window(app, &window, activate_after_show);
    Ok(())
}

fn show_main_window(_app: &AppHandle, window: &tauri::WebviewWindow, activate: bool) {
    if activate {
        // Cmd+H on macOS hides the app at the application level;
        // showing/focusing the webview alone does not unhide it.
        #[cfg(target_os = "macos")]
        let _ = _app.show();
        let _ = window.unminimize();
    }
    if let Err(e) = window.show() {
        tracing::warn!(target: "aethon::window_state", "show: {e}");
    }
    if activate && let Err(e) = window.set_focus() {
        tracing::warn!(target: "aethon::window_state", "set_focus: {e}");
    }
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

#[cfg(test)]
mod tests {
    use super::super::test_support::{approx_eq, mon, state};
    use super::*;

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

    #[test]
    fn first_launch_does_not_force_maximize() {
        // Regression: the window used to boot maximized (manifest
        // `"maximized": true` + a forced `window.maximize()` fallback),
        // then snap to the restored size — a jarring flash. A zoomed macOS
        // window also can't be moved via the overlay titlebar's drag
        // region. The ONLY surviving maximize() must be gated on a saved
        // `state.maximized` flag; there must be no unconditional
        // first-launch fallback.
        let src = include_str!("restore.rs");
        let logic = &src[..src.find("#[cfg(test)]").unwrap()];

        // Exactly one real maximize() call (unmaximize() does not match the
        // "window.maximize()" needle), and it sits under the state guard.
        assert_eq!(
            logic.matches("window.maximize()").count(),
            1,
            "restore logic must contain exactly one maximize() call",
        );
        let guard = logic
            .find("if state.maximized")
            .expect("state.maximized guard");
        let maximize = logic.find("window.maximize()").expect("maximize call");
        assert!(
            guard < maximize,
            "the surviving maximize() must be gated by `if state.maximized`",
        );
        assert!(
            !logic.contains("else if let Err(e) = window.maximize()"),
            "must not force-maximize on first launch",
        );
    }

    #[test]
    fn update_launch_activation_shows_unminimizes_and_focuses() {
        let src = include_str!("restore.rs");
        let app_show_pos = src.find("let _ = _app.show()").unwrap();
        let unminimize_pos = src.find("window.unminimize()").unwrap();
        let show_pos = src.find("window.show()").unwrap();
        let focus_pos = src.find("window.set_focus()").unwrap();

        assert!(
            app_show_pos < unminimize_pos && unminimize_pos < show_pos && show_pos < focus_pos,
            "post-update activation must unhide the app, unminimize/show the window, then focus it",
        );
    }
}
