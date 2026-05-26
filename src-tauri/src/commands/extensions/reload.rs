//! Agent-reload behavior. Coalesces a burst of file-watcher events
//! into a single graceful reload request to each live agent child.
//!
//! Reload mechanism (changed 2026-05): instead of SIGKILLing the bun
//! child mid-prompt — which loses the user's in-flight LLM turn — we
//! send a `{"type":"reload_request"}` line over stdin. The bridge
//! drains active prompts, writes a `_reload_done` sentinel to stdout,
//! and exits cleanly. The supervisor's stdout reader watches for the
//! sentinel and flags the upcoming EOF as an intentional reload so
//! the frontend gets `agent-reloaded` (not `agent-crashed`). The next
//! IPC call lazily respawns with fresh extension state.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent_process::AgentProcesses;

pub(super) struct DebounceMsg {
    pub(super) settle_ms: u64,
    pub(super) paths: Vec<PathBuf>,
}

/// Single-thread debounce worker — collapses bursts of file events
/// into one reload request after the channel goes quiet for `settle_ms`.
/// Each new message resets the timeout; the largest settle requested
/// across the burst wins (so a node_modules event that arrives during
/// an extension burst doesn't get prematurely fired).
pub(super) fn run_debounce_worker(rx: std::sync::mpsc::Receiver<DebounceMsg>, app: AppHandle) {
    use std::io::Write;
    use std::sync::mpsc::RecvTimeoutError;

    loop {
        // Block until we have at least one event to act on.
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return, // sender dropped — watcher gone
        };
        let mut settle = first.settle_ms;
        let mut last_paths = first.paths;
        // Drain further events until the channel is quiet for `settle` ms.
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(settle)) {
                Ok(next) => {
                    settle = settle.max(next.settle_ms);
                    last_paths = next.paths;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        // Quiet — ask each bridge to drain & respawn. Clone the per-child
        // handles first so a wedged stdin only blocks that bridge, not the
        // whole process table.
        let state: State<'_, AgentProcesses> = app.state();
        let children: Vec<_> = state
            .children
            .lock()
            .map(|guard| {
                guard
                    .iter()
                    .map(|(key, child)| (key.clone(), Arc::clone(child)))
                    .collect()
            })
            .unwrap_or_default();
        if !children.is_empty() {
            let mut kill_keys = Vec::new();
            for (key, child) in children {
                let Ok(mut child) = child.lock() else {
                    kill_keys.push(key);
                    continue;
                };
                // Capture pid before the mutable borrow on `child.stdin`
                // so we can log it without the borrow-checker complaining
                // about overlapping immutable + mutable borrows of `child`.
                let pid = child.id();
                let write_result = match child.stdin.as_mut() {
                    Some(stdin) => writeln!(stdin, "{{\"type\":\"reload_request\"}}")
                        .and_then(|_| stdin.flush()),
                    None => Err(std::io::Error::other("agent stdin closed")),
                };
                match write_result {
                    Ok(()) => {
                        tracing::info!(
                            target: "aethon::agent_watch",
                            key = key,
                            "asked pid={pid} to reload after {settle}ms settle (last paths={last_paths:?})",
                        );
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "aethon::agent_watch",
                            key = key,
                            "reload_request write failed for pid={pid}: {err}; falling back to kill",
                        );
                        kill_keys.push(key.clone());
                    }
                }
            }
            if !kill_keys.is_empty() {
                if let Ok(mut exits) = state.intentional_exits.lock() {
                    for key in &kill_keys {
                        exits.insert(key.clone());
                    }
                }
                let mut guard = match state.children.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                for key in kill_keys {
                    if let Some(dead) = guard.remove(&key)
                        && let Ok(mut dead) = dead.lock()
                    {
                        let _ = dead.kill();
                        let _ = dead.wait();
                    }
                }
                let _ = app.emit("agent-reloaded", "");
            }
        }
    }
}
