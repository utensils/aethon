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

use tauri::{AppHandle, Emitter};

use super::process::{WorkerMeta, touch_worker_activity};

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
    pub(super) meta: Arc<Mutex<HashMap<String, WorkerMeta>>>,
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
        meta,
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
                            && let Ok(mut routes) = mutation_routes.lock()
                        {
                            routes.insert(mutation_id.to_string(), key.clone());
                        }
                        prompt_flag = match value.get("type").and_then(|v| v.as_str()) {
                            Some("prompt_started") => Some(true),
                            Some("response_end") => Some(false),
                            _ => None,
                        };
                    }
                    touch_worker_activity(&meta, &key, prompt_flag);
                    let _ = app.emit("agent-response", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", key = key, "stdout reader for pid={pid} exited");
        let intentional_exit = intentional_exits
            .lock()
            .map(|mut exits| exits.remove(&key))
            .unwrap_or(false);
        if intentional_exit || saw_reload_done {
            return;
        }
        let tail: Vec<String> = match stderr_tail.lock() {
            Ok(g) => g.iter().cloned().collect(),
            Err(_) => Vec::new(),
        };
        let _ = app.emit(
            "agent-crashed",
            serde_json::json!({
                "pid": pid,
                "tabId": tab_id,
                "stderrTail": tail,
            }),
        );
    });
}

pub(super) struct StderrReaderCtx {
    pub(super) stderr: ChildStderr,
    pub(super) app: AppHandle,
    pub(super) pid: u32,
    pub(super) key: String,
    pub(super) stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

pub(super) fn spawn_stderr_reader(ctx: StderrReaderCtx) {
    let StderrReaderCtx {
        stderr,
        app,
        pid,
        key,
        stderr_tail,
    } = ctx;
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    tracing::info!(target: "aethon::agent::stderr", pid = pid, key = key, "{text}");
                    if let Ok(mut g) = stderr_tail.lock() {
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
