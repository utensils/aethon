//! Three-tier monitor-fallback helpers. Consumed only by
//! [`super::restore::restoreable_state`]. Each helper is a pure function
//! over logical-pixel rectangles.
//!
//!  1. [`exact_match`] — dimension match, closest origin wins.
//!  2. [`intersects`] — overlapping rect; tie-broken by center distance
//!     so mixed-scale arrangements pick the most visually-aligned target.
//!  3. [`nearest_by_center`] — last-resort fallback when no candidate
//!     intersects.

use super::schema::{LogicalRect, MonitorSnapshot};

pub(super) fn exact_match<'a>(
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

pub(super) fn intersects<'a>(
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

pub(super) fn nearest_by_center(
    saved: &MonitorSnapshot,
    monitors: &[MonitorSnapshot],
) -> MonitorSnapshot {
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
