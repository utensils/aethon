//! Agent ↔ shell sharing model.
//!
//! [`ShareMode`] is the four-value enum the user toggles per shell tab.
//! [`ShareState`] pairs the mode with a *privacy floor* — the byte cursor
//! below which scrollback reads are forbidden. The floor is what makes
//! shareable→private→shareable round-trips safe: it advances on every
//! private→shareable transition so a user toggling Read off then back on
//! never re-exposes the in-between window.
//!
//! Held under a single mutex by the slot so flipping mode and bumping
//! the floor is atomic — otherwise an agent read could land between the
//! two writes and observe pre-consent bytes.

use serde::{Deserialize, Serialize};

/// Agent ↔ shell sharing model. Default is `Private` — the agent sees
/// nothing of the tab's contents until the user opts in. The four-value
/// shape is intentional: `ReadWrite` is the same as `ReadWriteTrusted`
/// with confirmation gating; merging them would erase the difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareMode {
    Private,
    Read,
    ReadWrite,
    ReadWriteTrusted,
}

impl ShareMode {
    pub fn is_shareable(self) -> bool {
        !matches!(self, Self::Private)
    }
    /// Used by the write path to gate `aethon.shells.write` — kept
    /// alongside `is_shareable` so the predicate set lives in one place.
    pub fn allows_write(self) -> bool {
        matches!(self, Self::ReadWrite | Self::ReadWriteTrusted)
    }
}

/// Mode + privacy-floor pair. Held under a single mutex so transitions
/// are atomic — flipping mode and bumping the floor must never tear,
/// otherwise an agent read could land between the two writes and
/// observe scrollback from before the user opted in.
#[derive(Debug)]
pub struct ShareState {
    pub mode: ShareMode,
    /// Byte index in `Scrollback::total_appended` space below which
    /// reads are not allowed. Set on each transition into a shareable
    /// mode from a non-shareable one. Stays put across shareable→shareable
    /// transitions and across shareable→private→shareable round-trips
    /// (so a user toggling read off then back on doesn't suddenly
    /// re-expose the in-between window).
    pub floor: u64,
}

impl ShareState {
    pub fn new() -> Self {
        Self {
            mode: ShareMode::Private,
            floor: 0,
        }
    }
    /// Apply a mode change relative to the live scrollback cursor.
    /// Bumps `floor` to `total_appended` whenever the new mode is
    /// shareable AND was previously private — that's the moment the
    /// agent first gains visibility, and only content from that point
    /// on is in-bounds. Returns the resulting state.
    pub fn transition(&mut self, next: ShareMode, total_appended: u64) -> &Self {
        let was_private = !self.mode.is_shareable();
        let now_shareable = next.is_shareable();
        if was_private && now_shareable {
            self.floor = total_appended;
        }
        self.mode = next;
        self
    }
}

impl Default for ShareState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_mode_classification() {
        assert!(!ShareMode::Private.is_shareable());
        assert!(ShareMode::Read.is_shareable());
        assert!(ShareMode::ReadWrite.is_shareable());
        assert!(ShareMode::ReadWriteTrusted.is_shareable());
        assert!(!ShareMode::Private.allows_write());
        assert!(!ShareMode::Read.allows_write());
        assert!(ShareMode::ReadWrite.allows_write());
        assert!(ShareMode::ReadWriteTrusted.allows_write());
    }

    #[test]
    fn share_state_floor_pins_at_first_shareable_transition() {
        let mut s = ShareState::new();
        assert_eq!(s.floor, 0);
        s.transition(ShareMode::Read, 1024);
        assert_eq!(s.floor, 1024);
        // Shareable → shareable: floor stays put.
        s.transition(ShareMode::ReadWrite, 2048);
        assert_eq!(s.floor, 1024);
        // Shareable → private: floor stays put.
        s.transition(ShareMode::Private, 3072);
        assert_eq!(s.floor, 1024);
        // Private → shareable again: floor advances to *now*. No
        // re-exposure of the in-between window.
        s.transition(ShareMode::Read, 4096);
        assert_eq!(s.floor, 4096);
    }

    #[test]
    fn share_state_round_trip_through_private_does_not_leak_old_window() {
        // Concrete attack scenario: user grants Read at byte 100, runs
        // sensitive output to 500, flips to Private, runs more output to
        // 1000, flips back to Read. The agent must not see the 500–1000
        // window — the floor must advance to 1000.
        let mut s = ShareState::new();
        s.transition(ShareMode::Read, 100);
        assert_eq!(s.floor, 100);
        s.transition(ShareMode::Private, 500);
        s.transition(ShareMode::Read, 1000);
        assert_eq!(s.floor, 1000);
    }
}
