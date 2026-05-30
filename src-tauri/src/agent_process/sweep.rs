//! Idle per-tab worker retirement (#159).
//!
//! A background thread wakes every [`SWEEP_INTERVAL`] and retires any
//! `tab:<id>` worker that has sat idle — no prompt in flight, no inbound or
//! outbound traffic — longer than the configured TTL. The global agent is never
//! swept. Retired workers respawn lazily from their persisted pi session on the
//! next message (`ensure_agent_spawned` is idempotent), so this is transparent
//! to the user: it just stops finished, untouched tabs from holding a hot
//! `aethon-agent` child indefinitely.
//!
//! The TTL is read from `[agent] idle_retire_minutes` each tick so a Settings
//! change takes effect without a restart; `0` disables the sweep.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::helpers::{self, parse_config_toml};

use super::process::{AgentProcesses, idle_keys_to_retire, retire_agent_key};

/// How often the sweep wakes. Coarse on purpose — retirement is a cleanup, not
/// a latency-sensitive path, and a 60s cadence keeps the wakeup cost trivial.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Spawn the idle-retirement sweep. Plain OS thread (no async needed): it
/// sleeps, then reaches managed state via the cloned `AppHandle` — the same
/// pattern the extension-reload debounce worker uses.
pub(crate) fn spawn_idle_sweep(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(SWEEP_INTERVAL);
            sweep_once(&app);
        }
    });
}

/// Resolve the configured idle TTL, or `None` when retirement is disabled
/// (`idle_retire_minutes = 0`). Read fresh each tick so Settings edits apply
/// live.
fn configured_ttl(app: &AppHandle) -> Option<Duration> {
    let home = app.path().home_dir().ok()?;
    let user_dir = helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    let raw = std::fs::read_to_string(user_dir.join("config.toml")).unwrap_or_default();
    let minutes = parse_config_toml(&raw)["agent"]["idleRetireMinutes"]
        .as_u64()
        .unwrap_or(15);
    (minutes > 0).then(|| Duration::from_secs(minutes * 60))
}

fn sweep_once(app: &AppHandle) {
    let Some(ttl) = configured_ttl(app) else {
        return;
    };
    let state = app.state::<AgentProcesses>();
    let keys = idle_keys_to_retire(&state.meta, Instant::now(), ttl);
    for key in keys {
        match retire_agent_key(&state, &key) {
            Ok(()) => {
                tracing::info!(target: "aethon::agent", key = key.as_str(), "idle-retired worker")
            }
            Err(e) => {
                tracing::warn!(target: "aethon::agent", key = key.as_str(), "idle retire failed: {e}")
            }
        }
    }
}
