//! Stdout/stderr reader threads for a spawned agent child.
//!
//! Each spawn gets two dedicated threads: one peels JSON-lines off
//! stdout and emits `agent-response`, the other tails stderr into the
//! supervisor and emits `agent-stderr`. The stdout reader is also the
//! sole producer of mutation-id → agent-key route entries; the
//! corresponding consumer lives in [`super::process::route_payload_key`].
//!
//! Crash / reload signalling:
//! - `agent-reloaded` is emitted when a `"_reload_done"` sentinel slips
//!   through stdout (the bridge writes it after draining in-flight
//!   prompts during a hot reload).
//! - `agent-crashed` is emitted iff stdout closes *without* a reload
//!   sentinel *and* the supervisor did not mark the exit as intentional.
//! - `agent-stderr` is per-line; the last [`STDERR_TAIL_CAP`] lines are
//!   captured into a shared ring so the crash payload can carry them.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{ChildStderr, ChildStdout};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use tauri::{AppHandle, Emitter};

use super::process::{
    GLOBAL_AGENT_KEY, WorkerMeta, clear_worker_meta_for_pid, lock_recover, mark_worker_ready,
    purge_routes_for_key, touch_worker_activity,
};

/// EOF cleanup shared by every stdout-reader exit path: purge this key's
/// mutation routes (pending acks for a dead process are unroutable and used
/// to leak forever), then drop the meta entry. Both steps are pid-guarded so
/// a late-exiting reader of an already-replaced child can't clobber the
/// respawned worker's state.
fn cleanup_after_stdout_eof(
    meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>,
    readiness: &Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    mutation_routes: &Arc<Mutex<HashMap<String, String>>>,
    key: &str,
    pid: u32,
) {
    let owned_by_other = lock_recover(meta, "worker meta (eof)")
        .get(key)
        .is_some_and(|m| m.pid != pid);
    if !owned_by_other {
        purge_routes_for_key(mutation_routes, key);
        if let Some(signal) = lock_recover(readiness, "worker readiness (eof)").remove(key) {
            signal.notify_waiters();
        }
    }
    clear_worker_meta_for_pid(meta, key, pid);
}

pub(super) const STDERR_TAIL_CAP: usize = 32;

/// Inputs for the stdout reader thread. Bundled into a struct so the
/// caller in `spawn.rs` doesn't have to remember a six-argument
/// positional contract.
pub(super) struct StdoutReaderCtx {
    pub(super) stdout: ChildStdout,
    pub(super) app: AppHandle,
    pub(super) pid: u32,
    pub(super) key: String,
    pub(super) tab_id: Option<String>,
    pub(super) mutation_routes: Arc<Mutex<HashMap<String, String>>>,
    pub(super) intentional_exits: Arc<Mutex<HashSet<String>>>,
    pub(super) pending_reloads: Arc<Mutex<HashSet<String>>>,
    pub(super) meta: Arc<Mutex<HashMap<String, WorkerMeta>>>,
    pub(super) readiness: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    pub(super) stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

pub(super) fn spawn_stdout_reader(ctx: StdoutReaderCtx) {
    let StdoutReaderCtx {
        stdout,
        app,
        pid,
        key,
        tab_id,
        mutation_routes,
        intentional_exits,
        pending_reloads,
        meta,
        readiness,
        stderr_tail,
    } = ctx;
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut saw_reload_done = false;
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    if text.contains("\"_reload_done\"") {
                        saw_reload_done = true;
                        let _ = app.emit("agent-reloaded", "");
                        continue;
                    }
                    // Any stdout line is activity — including non-JSON noise
                    // (startup banners, panics) — so bump last_activity
                    // unconditionally. Only parsed turn-lifecycle events flip
                    // prompt_in_flight (idle sweep + diagnostics read both).
                    let mut prompt_flag = None;
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(mutation_id) = value.get("mutationId").and_then(|v| v.as_str())
                        {
                            lock_recover(&mutation_routes, "mutation routes (insert)")
                                .insert(mutation_id.to_string(), key.clone());
                        }
                        prompt_flag = match value.get("type").and_then(|v| v.as_str()) {
                            Some("worker_ready") => {
                                mark_worker_ready(&meta, &readiness, &key);
                                None
                            }
                            Some("ready") | Some("tab_ready") => {
                                mark_worker_ready(&meta, &readiness, &key);
                                None
                            }
                            Some("prompt_started") => Some(true),
                            Some("response_end") => Some(false),
                            _ => None,
                        };
                    } else {
                        let mut g = lock_recover(&stderr_tail, "stderr tail (stdout noise)");
                        if g.len() >= STDERR_TAIL_CAP {
                            g.pop_front();
                        }
                        g.push_back(format!(
                            "stdout: {}",
                            text.chars().take(500).collect::<String>()
                        ));
                    }
                    touch_worker_activity(&meta, &key, prompt_flag);
                    let _ = app.emit("agent-response", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", key = key, "stdout reader for pid={pid} exited");
        let intentional_exit =
            lock_recover(&intentional_exits, "intentional exits (eof)").remove(&key);
        let reload_was_asked = lock_recover(&pending_reloads, "pending reloads (eof)").remove(&key);
        if intentional_exit || saw_reload_done {
            cleanup_after_stdout_eof(&meta, &readiness, &mutation_routes, &key, pid);
            return;
        }
        // The watcher asked this child to reload but the `_reload_done`
        // sentinel never arrived (lost or corrupted in the pipe). The exit
        // was still requested — classify as a reload, not a crash, so the
        // user doesn't get a phantom "exited unexpectedly" toast.
        if reload_was_asked {
            tracing::info!(
                target: "aethon::agent",
                key = key,
                "reload-asked pid={pid} closed stdout without sentinel; treating as reload"
            );
            let _ = app.emit("agent-reloaded", "");
            cleanup_after_stdout_eof(&meta, &readiness, &mutation_routes, &key, pid);
            return;
        }
        let mut tail: Vec<String> = lock_recover(&stderr_tail, "stderr tail (eof)")
            .iter()
            .cloned()
            .collect();
        if quiet_global_stdout_eof(&key, &tail) {
            tracing::info!(
                target: "aethon::agent",
                key = key,
                "global agent stdout closed without stderr; waiting for the next global request"
            );
            cleanup_after_stdout_eof(&meta, &readiness, &mutation_routes, &key, pid);
            return;
        }
        fill_empty_stdout_tail(&mut tail, &key, pid);
        let _ = app.emit(
            "agent-crashed",
            serde_json::json!({
                "pid": pid,
                "key": key,
                "tabId": tab_id,
                "stderrTail": tail,
            }),
        );
        cleanup_after_stdout_eof(&meta, &readiness, &mutation_routes, &key, pid);
    });
}

fn quiet_global_stdout_eof(key: &str, tail: &[String]) -> bool {
    key == GLOBAL_AGENT_KEY && tail.is_empty()
}

fn fill_empty_stdout_tail(tail: &mut Vec<String>, key: &str, pid: u32) {
    if tail.is_empty() {
        tail.push(format!(
            "agent stdout closed unexpectedly (key={key}, pid={pid})"
        ));
    }
}

pub(super) struct StderrReaderCtx {
    pub(super) stderr: ChildStderr,
    pub(super) app: AppHandle,
    pub(super) pid: u32,
    pub(super) key: String,
    pub(super) stderr_tail: Arc<Mutex<VecDeque<String>>>,
    pub(super) meta: Arc<Mutex<HashMap<String, WorkerMeta>>>,
}

pub(super) fn spawn_stderr_reader(ctx: StderrReaderCtx) {
    let StderrReaderCtx {
        stderr,
        app,
        pid,
        key,
        stderr_tail,
        meta,
    } = ctx;
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    tracing::info!(target: "aethon::agent::stderr", pid = pid, key = key, "{text}");
                    let prompt_flag = if text.contains("turn: start") {
                        Some(true)
                    } else if text.contains("turn: end") {
                        Some(false)
                    } else {
                        None
                    };
                    touch_worker_activity(&meta, &key, prompt_flag);
                    {
                        let mut g = lock_recover(&stderr_tail, "stderr tail (stderr line)");
                        if g.len() >= STDERR_TAIL_CAP {
                            g.pop_front();
                        }
                        g.push_back(text.clone());
                    }
                    let _ = app.emit("agent-stderr", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", key = key, "stderr reader for pid={pid} exited");
    });
}

#[cfg(test)]
mod tests {
    use super::{fill_empty_stdout_tail, quiet_global_stdout_eof};
    use crate::agent_process::GLOBAL_AGENT_KEY;

    #[test]
    fn quiet_global_stdout_eof_does_not_count_as_a_crash() {
        assert!(quiet_global_stdout_eof(GLOBAL_AGENT_KEY, &[]));
        assert!(!quiet_global_stdout_eof(
            GLOBAL_AGENT_KEY,
            &["panic".to_string()]
        ));
        assert!(!quiet_global_stdout_eof("tab:abc", &[]));
    }

    #[test]
    fn non_global_empty_stdout_tail_gets_a_diagnostic_line() {
        let mut tail = Vec::new();
        fill_empty_stdout_tail(&mut tail, "tab:abc", 42);
        assert_eq!(
            tail,
            ["agent stdout closed unexpectedly (key=tab:abc, pid=42)"]
        );
    }
}
