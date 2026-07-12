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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::helpers;

use super::process::{AgentProcesses, idle_keys_to_retire, lock_recover, retire_agent_key};

/// How often the sweep wakes. Coarse on purpose — retirement is a cleanup, not
/// a latency-sensitive path, and a 60s cadence keeps the wakeup cost trivial.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

struct IdleSweepWorker {
    cancelled: Arc<AtomicBool>,
    wake: Arc<(Mutex<()>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl IdleSweepWorker {
    fn stop(mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.wake.1.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
pub(crate) struct IdleSweepState {
    worker: Mutex<Option<IdleSweepWorker>>,
}

impl IdleSweepState {
    pub(crate) fn start(&self, app: AppHandle) {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return;
        }
        *worker = Some(spawn_worker(SWEEP_INTERVAL, move || {
            let Some(ttl) = resolve_ttl(&app) else {
                return;
            };
            sweep_once(&app, ttl);
        }));
    }

    pub(crate) fn stop(&self) {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker {
            worker.stop();
        }
    }
}

fn spawn_worker(interval: Duration, mut tick: impl FnMut() + Send + 'static) -> IdleSweepWorker {
    let cancelled = Arc::new(AtomicBool::new(false));
    let wake = Arc::new((Mutex::new(()), Condvar::new()));
    let thread_cancelled = Arc::clone(&cancelled);
    let thread_wake = Arc::clone(&wake);
    let thread = std::thread::spawn(move || {
        while !thread_cancelled.load(Ordering::Acquire) {
            let guard = thread_wake
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = thread_wake
                .1
                .wait_timeout_while(guard, interval, |_| {
                    !thread_cancelled.load(Ordering::Acquire)
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if thread_cancelled.load(Ordering::Acquire) {
                break;
            }
            tick();
        }
    });
    IdleSweepWorker {
        cancelled,
        wake,
        thread: Some(thread),
    }
}

/// Spawn the idle-retirement sweep. Plain OS thread (no async needed): it
/// sleeps, then reaches managed state via the cloned `AppHandle` — the same
/// pattern the extension-reload debounce worker uses.
pub(crate) fn spawn_idle_sweep(app: AppHandle, state: &IdleSweepState) {
    state.start(app);
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let user_dir = helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
    Some(user_dir.join("config.toml"))
}

/// Resolve the configured idle TTL (`None` = retirement disabled). The shared
/// config snapshot avoids disk I/O and parsing unless the file fingerprint
/// changed, while still observing Settings and external-editor updates.
fn resolve_ttl(app: &AppHandle) -> Option<Duration> {
    let path = config_path(app)?;
    let minutes = helpers::read_config_snapshot(&path).parsed["agent"]["idleRetireMinutes"]
        .as_u64()
        .unwrap_or(15);
    (minutes > 0).then(|| Duration::from_secs(minutes * 60))
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
    reap_meta_less_children(&state);
}

/// Reap child handles whose meta entry is gone — the stdout-EOF cleanup
/// removes meta on crash, but the exited `Child` stayed in `children`
/// holding a zombie process until the next write for that key. Collect the
/// exit status here so the OS entry is released.
fn reap_meta_less_children(state: &AgentProcesses) {
    let meta_keys: std::collections::HashSet<String> = lock_recover(&state.meta, "meta (reap)")
        .keys()
        .cloned()
        .collect();
    let mut guard = lock_recover(&state.children, "children (reap)");
    guard.retain(|key, child| {
        if meta_keys.contains(key) {
            return true;
        }
        let mut child = lock_recover(child, "agent child (reap)");
        match child.try_wait() {
            Ok(Some(status)) => {
                tracing::info!(
                    target: "aethon::agent",
                    key = key.as_str(),
                    "reaped exited child without meta: {status:?}"
                );
                false
            }
            _ => true,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn owned_worker_cancels_without_waiting_for_next_interval() {
        let ticks = Arc::new(AtomicUsize::new(0));
        let worker_ticks = Arc::clone(&ticks);
        let started = Instant::now();
        let worker = spawn_worker(Duration::from_secs(60), move || {
            worker_ticks.fetch_add(1, Ordering::SeqCst);
        });

        worker.stop();

        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(ticks.load(Ordering::SeqCst), 0);
    }
}
