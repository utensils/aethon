//! On-disk schema migrations. Run once per load so older records
//! survive an upgrade without users losing their geometry.

use super::schema::{CURRENT_VERSION, PersistedStore};

/// Apply per-record migrations so on-disk format changes don't strand
/// users' saved geometry. Currently:
///  - v0 → v1: old records stored window x/y/w/h as physical px (the
///    fields were i32/u32 in the prior release). The new code treats
///    them as logical px. Divide by `monitor.scale` to recover logical
///    units. No-op on a 1× monitor.
pub(super) fn migrate(mut store: PersistedStore) -> PersistedStore {
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
            state.version = CURRENT_VERSION;
        }
    }
    store
}

#[cfg(test)]
mod tests {
    use super::super::schema::WindowState;
    use super::super::test_support::{approx_eq, mon, state};
    use super::*;

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
        let m: WindowState = migrate(serde_json::from_str(raw).unwrap())
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
        let m: &WindowState = migrated.states.get("main").unwrap();
        // Values unchanged — no double-divide by 2.0.
        assert!(approx_eq(m.x, 300.0));
        assert!(approx_eq(m.width, 1000.0));
    }
}
