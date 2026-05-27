//! Persisted + runtime data structures for window-state. All units are
//! logical pixels — physical pixels aren't portable across monitors
//! with different scale factors (see the module-level doc comment).
//!
//! [`WindowState`] is the per-window record on disk; [`MonitorSnapshot`]
//! is both the persisted monitor descriptor and the runtime view we
//! build from `tauri::Monitor`. [`PersistedStore`] is the top-level
//! file shape. [`LogicalRect`] is the geometry type returned from the
//! restore-computation path.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::Monitor;

/// On-disk schema version. Bumped when persisted semantics change so
/// older records can be migrated forward without losing geometry.
pub(super) const CURRENT_VERSION: u32 = 1;

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
    pub(super) fn from_monitor(m: &Monitor) -> Self {
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

    pub(super) fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub(super) struct PersistedStore {
    #[serde(flatten)]
    pub(super) states: HashMap<String, WindowState>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Build a sensible default normal-mode window state centered on the
/// given monitor. Used when persisting a maximized window for the first
/// time so a later un-maximize lands at usable bounds.
pub(super) fn default_normal(monitor: MonitorSnapshot) -> WindowState {
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
