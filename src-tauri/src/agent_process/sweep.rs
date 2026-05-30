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
//! The TTL comes from `[agent] idle_retire_minutes`; it's re-read only when
//! `config.toml`'s mtime changes (so a Settings edit applies without a restart,
//! but we don't re-parse from disk every minute for the app's lifetime). `0`
//! disables the sweep.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

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
        // (config mtime seen, resolved ttl) — avoids re-reading + re-parsing
        // config.toml every tick; only re-parse when the file actually changes.
        let mut ttl_cache: Option<(SystemTime, Option<Duration>)> = None;
        loop {
            std::thread::sleep(SWEEP_INTERVAL);
            let Some(ttl) = resolve_ttl_cached(&app, &mut ttl_cache) else {
                continue;
            };
            sweep_once(&app, ttl);
        }
    });
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let user_dir = helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    Some(user_dir.join("config.toml"))
}

/// Resolve the configured idle TTL (`None` = retirement disabled). Re-reads +
/// re-parses `config.toml` only when its mtime differs from the cached one;
/// otherwise returns the cached value. A missing file (no mtime) falls back to
/// reading (cheap — yields the default) without caching.
fn resolve_ttl_cached(
    app: &AppHandle,
    cache: &mut Option<(SystemTime, Option<Duration>)>,
) -> Option<Duration> {
    let path = config_path(app)?;
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    if let (Some(mtime), Some((cached_mtime, cached_ttl))) = (mtime, cache.as_ref())
        && mtime == *cached_mtime
    {
        return *cached_ttl;
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let minutes = parse_config_toml(&raw)["agent"]["idleRetireMinutes"]
        .as_u64()
        .unwrap_or(15);
    let ttl = (minutes > 0).then(|| Duration::from_secs(minutes * 60));
    if let Some(mtime) = mtime {
        *cache = Some((mtime, ttl));
    }
    ttl
}

fn sweep_once(app: &AppHandle, ttl: Duration) {
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
