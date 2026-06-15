//! Process registry + the public surface the rest of the crate uses to
//! talk to agent children.
//!
//! State held here:
//! - `children` — the per-key live `Child` handles.
//! - `mutation_routes` — the producer/consumer routing map for
//!   `mutation_ack` round-trips. Producer side lives in
//!   [`super::readers::spawn_stdout_reader`]; consumer side is
//!   [`route_payload_key`] below.
//! - `intentional_exits` — keys whose next stdout-close is *expected*
//!   (retirement or hot reload) and therefore must NOT raise
//!   `agent-crashed`. Producer is [`retire_agent_key`]; consumer is the
//!   stdout reader on EOF.

use std::collections::{HashMap, HashSet};
use std::process::Child;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};
use tokio::time::sleep;

use super::sidecar::project_root;
use super::spawn::ensure_agent_spawned;
use crate::env;

pub(crate) const GLOBAL_AGENT_KEY: &str = "__global__";

/// A prompt that has shown no activity for this long is considered wedged:
/// the bridge process is alive but the turn will never produce a
/// `response_end` (provider hang, exception between `prompt_started` and
/// `response_end`). A wedged worker stops blocking idle retirement and tab
/// reconciliation — without this cap a single wedged turn made its worker
/// unreclaimable until app quit. A healthy long turn keeps bumping
/// `last_activity` via stdout/stderr traffic, so it never trips this.
pub(crate) const WEDGED_PROMPT_CAP: Duration = Duration::from_secs(30 * 60);

/// Lock a mutex, recovering from poisoning instead of silently dropping the
/// operation. Every mutex in this module guards plain map/process data that
/// stays structurally valid even if a holder panicked mid-update; recovering
/// is strictly better than freezing routing/meta for the rest of the app
/// (the old `if let Ok(..) = m.lock()` pattern did exactly that, silently).
pub(crate) fn lock_recover<'a, T>(m: &'a Mutex<T>, what: &str) -> MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|poisoned| {
        tracing::warn!(target: "aethon::agent", "recovered poisoned lock: {what}");
        poisoned.into_inner()
    })
}

/// Per-worker diagnostic metadata, keyed alongside `children`. Lets a
/// release-safe `agent_diagnostics` command map a live `aethon-agent` PID back
/// to its key / tab / cwd and report idle + prompt state (#159). `Instant`s are
/// monotonic and reported as "ms ago" so no wall-clock serialization is needed.
pub(crate) struct WorkerMeta {
    pub(crate) tab_id: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) pid: u32,
    pub(crate) spawned_at: Instant,
    pub(crate) last_activity: Instant,
    pub(crate) prompt_in_flight: bool,
    /// When the in-flight prompt started. Set when `prompt_in_flight` flips
    /// to true, cleared when it flips to false. Drives the wedged-prompt
    /// deadline ([`WEDGED_PROMPT_CAP`]).
    pub(crate) prompt_started_at: Option<Instant>,
    pub(crate) bridge_ready: bool,
}

/// True when this worker's prompt has been in flight past the wedge cap
/// with no activity in the same window — i.e. the `prompt_in_flight` flag
/// can no longer be trusted to mean "a live turn is streaming".
pub(crate) fn prompt_wedged(meta: &WorkerMeta, now: Instant) -> bool {
    meta.prompt_in_flight
        && meta
            .prompt_started_at
            .is_some_and(|t| now.duration_since(t) >= WEDGED_PROMPT_CAP)
        && now.duration_since(meta.last_activity) >= WEDGED_PROMPT_CAP
}

pub(crate) struct AgentProcesses {
    pub(crate) children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    pub(crate) mutation_routes: Arc<Mutex<HashMap<String, String>>>,
    pub(crate) intentional_exits: Arc<Mutex<HashSet<String>>>,
    pub(crate) meta: Arc<Mutex<HashMap<String, WorkerMeta>>>,
}

impl AgentProcesses {
    pub(crate) fn new() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
            mutation_routes: Arc::new(Mutex::new(HashMap::new())),
            intentional_exits: Arc::new(Mutex::new(HashSet::new())),
            meta: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Whether an outbound payload begins a real agent turn — used to flip
/// `prompt_in_flight` true the instant we forward it, before the bridge echoes
/// `prompt_started`. ONLY `chat` qualifies: it's the one type guaranteed to be
/// bracketed by `prompt_started`/`response_end`, so the flag is always cleared.
/// `local_chat_message` (persist-only) and `native_slash_command` (emits
/// `notice`/`native_slash_result`, no `response_end`) must NOT set it, or the
/// worker would read as permanently mid-prompt. They still bump `last_activity`
/// via the write path. Idle-retirement (Phase 5) keys off this flag.
pub(crate) fn payload_starts_prompt(payload: &serde_json::Value) -> bool {
    payload.get("type").and_then(|v| v.as_str()) == Some("chat")
}

/// Record activity against a worker key: bump `last_activity` and, when given,
/// set `prompt_in_flight`. No-op if the key has no meta entry yet.
pub(crate) fn touch_worker_activity(
    meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>,
    key: &str,
    prompt_in_flight: Option<bool>,
) {
    let mut map = lock_recover(meta, "worker meta (touch)");
    if let Some(entry) = map.get_mut(key) {
        let now = Instant::now();
        entry.last_activity = now;
        if let Some(flag) = prompt_in_flight {
            if flag && !entry.prompt_in_flight {
                entry.prompt_started_at = Some(now);
            } else if !flag {
                entry.prompt_started_at = None;
            }
            entry.prompt_in_flight = flag;
        }
    }
}

pub(crate) fn mark_worker_ready(meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>, key: &str) {
    let mut map = lock_recover(meta, "worker meta (ready)");
    if let Some(entry) = map.get_mut(key) {
        entry.last_activity = Instant::now();
        entry.bridge_ready = true;
    }
}

pub(crate) fn clear_worker_meta_for_pid(
    meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>,
    key: &str,
    pid: u32,
) {
    let mut map = lock_recover(meta, "worker meta (clear)");
    let should_remove = map.get(key).is_some_and(|entry| entry.pid == pid);
    if should_remove {
        map.remove(key);
    }
}

/// Drop every mutation route pointing at `key`. Called whenever the process
/// behind the key goes away (retirement, cwd respawn, stdout EOF) — pending
/// acks for a dead process are unroutable, and before this purge they leaked
/// in the map forever.
pub(crate) fn purge_routes_for_key(routes: &Arc<Mutex<HashMap<String, String>>>, key: &str) {
    let mut map = lock_recover(routes, "mutation routes (purge)");
    map.retain(|_, v| v != key);
}

fn worker_ready(meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>, key: &str) -> bool {
    lock_recover(meta, "worker meta (ready check)")
        .get(key)
        .map(|entry| entry.bridge_ready)
        .unwrap_or(false)
}

async fn wait_for_worker_ready(
    child: &Arc<Mutex<Child>>,
    meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>,
    key: &str,
    timeout: Duration,
) -> Result<(), String> {
    if key == GLOBAL_AGENT_KEY || worker_ready(meta, key) {
        return Ok(());
    }
    let start = Instant::now();
    while start.elapsed() < timeout {
        if worker_ready(meta, key) {
            return Ok(());
        }
        if let Some(status) = lock_recover(child, "agent child (ready wait)")
            .try_wait()
            .ok()
            .flatten()
        {
            return Err(format!("agent worker exited before ready: {status:?}"));
        }
        sleep(Duration::from_millis(25)).await;
    }
    Err(format!(
        "agent worker did not become ready within {timeout:?}"
    ))
}

/// Should this worker be retired by the idle sweep? Pure so the policy is
/// testable without spawning processes. Never retires the global agent or a
/// worker that's mid-prompt — unless the prompt is wedged past
/// [`WEDGED_PROMPT_CAP`], in which case the flag no longer protects it;
/// otherwise retires once idle past `ttl`.
pub(crate) fn should_retire_idle(
    key: &str,
    meta: &WorkerMeta,
    now: Instant,
    ttl: Duration,
) -> bool {
    if key == GLOBAL_AGENT_KEY {
        return false;
    }
    if meta.prompt_in_flight && !prompt_wedged(meta, now) {
        return false;
    }
    now.duration_since(meta.last_activity) >= ttl
}

/// Collect the worker keys the idle sweep should retire this tick. Snapshots
/// under the meta lock and returns owned keys so the caller can retire them
/// after releasing the lock (retirement re-locks meta + children).
pub(crate) fn idle_keys_to_retire(
    meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>,
    now: Instant,
    ttl: Duration,
) -> Vec<String> {
    let map = lock_recover(meta, "worker meta (idle sweep)");
    map.iter()
        .filter(|(key, m)| should_retire_idle(key, m, now, ttl))
        .map(|(key, _)| key.clone())
        .collect()
}

/// Worker keys to retire because their tab no longer exists in the frontend's
/// live set — a safety net for a dropped `tab_close` or a post-crash straggler.
/// Retires only a `tab:<id>` worker that is ALL of: not the global agent; not
/// mid-prompt (don't kill an in-flight turn); older than `min_age` (so a worker
/// the frontend just spawned but hasn't reported yet survives); and whose tab
/// id is absent from `live_tab_ids`. `live_tab_ids` must span every project
/// bucket, not just the active one — tabs are project-scoped (see
/// `useAgentWorkerReconcile`).
pub(crate) fn keys_to_reconcile(
    meta: &Arc<Mutex<HashMap<String, WorkerMeta>>>,
    live_tab_ids: &HashSet<String>,
    now: Instant,
    min_age: Duration,
) -> Vec<String> {
    let map = lock_recover(meta, "worker meta (reconcile)");
    map.iter()
        .filter(|(key, m)| {
            *key != GLOBAL_AGENT_KEY
                && (!m.prompt_in_flight || prompt_wedged(m, now))
                && now.duration_since(m.spawned_at) >= min_age
                && m.tab_id
                    .as_deref()
                    .is_some_and(|t| !live_tab_ids.contains(t))
        })
        .map(|(key, _)| key.clone())
        .collect()
}

pub(crate) struct AgentWorker {
    pub(crate) tab_id: String,
    pub(crate) cwd: Option<String>,
}

pub(crate) fn tab_agent_key(tab_id: &str) -> String {
    format!("tab:{tab_id}")
}

pub(crate) async fn write_agent_payload(
    state: &State<'_, AgentProcesses>,
    app: &AppHandle,
    key: String,
    payload: serde_json::Value,
    worker: Option<AgentWorker>,
) -> Result<(), String> {
    let prompt_starts = payload_starts_prompt(&payload);
    let prompt_flag = prompt_starts.then_some(true);
    let mut last_err = String::from("agent not running");

    // Two attempts: `wait_for_worker_ready` can take seconds, and a
    // concurrent cwd-change respawn may replace the child under us in that
    // window. Writing into the replaced (killed) child would either error or
    // — worse — succeed into a pipe nobody reads. Re-verify the handle is
    // still the registered one before writing; on mismatch or write failure,
    // re-ensure and retry once.
    for _attempt in 0..2 {
        let child = {
            let mut guard = lock_recover(&state.children, "agent children (write)");
            ensure_agent_spawned(
                &mut guard,
                &key,
                app,
                Arc::clone(&state.mutation_routes),
                Arc::clone(&state.intentional_exits),
                Arc::clone(&state.meta),
                worker.as_ref(),
            )?;
            guard.get(&key).cloned().ok_or("agent not running")?
        };

        if prompt_starts {
            wait_for_worker_ready(&child, &state.meta, &key, Duration::from_secs(20)).await?;
        }

        let still_current = {
            let guard = lock_recover(&state.children, "agent children (verify)");
            guard
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &child))
        };
        if !still_current {
            last_err = "agent worker was replaced while preparing the write".to_string();
            continue;
        }

        let write_result = {
            let mut child = lock_recover(&child, "agent child (write)");
            write_payload_line(&mut child, &payload)
        };
        match write_result {
            Ok(()) => {
                // Inbound traffic counts as activity; a forwarded prompt also
                // marks the worker busy so the idle sweep won't retire it
                // mid-turn.
                touch_worker_activity(&state.meta, &key, prompt_flag);
                return Ok(());
            }
            Err(e) => {
                last_err = e;
                continue;
            }
        }
    }
    tracing::warn!(
        target: "aethon::agent",
        key = key.as_str(),
        "payload not delivered after retry: {last_err}"
    );
    Err(format!("agent message not delivered: {last_err}"))
}

fn write_payload_line(child: &mut Child, payload: &serde_json::Value) -> Result<(), String> {
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    use std::io::Write;
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))
}

pub(crate) fn ensure_global_agent(
    state: &State<'_, AgentProcesses>,
    app: &AppHandle,
) -> Result<(), String> {
    let mut guard = lock_recover(&state.children, "agent children (ensure global)");
    ensure_agent_spawned(
        &mut guard,
        GLOBAL_AGENT_KEY,
        app,
        Arc::clone(&state.mutation_routes),
        Arc::clone(&state.intentional_exits),
        Arc::clone(&state.meta),
        None,
    )
}

pub(crate) fn retire_agent_key(state: &State<'_, AgentProcesses>, key: &str) -> Result<(), String> {
    let child = {
        let mut guard = lock_recover(&state.children, "agent children (retire)");
        guard.remove(key)
    };
    lock_recover(&state.meta, "worker meta (retire)").remove(key);
    purge_routes_for_key(&state.mutation_routes, key);
    let Some(child) = child else {
        return Ok(());
    };
    lock_recover(&state.intentional_exits, "intentional exits (retire)").insert(key.to_string());
    let mut child = lock_recover(&child, "agent child (retire)");
    let pid = child.id();
    tracing::info!(target: "aethon::agent", key = key, "retiring pid={pid}");
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

pub(crate) fn shutdown_all_agents(state: &AgentProcesses, reason: &str) {
    let children: Vec<_> = lock_recover(&state.children, "agent children (shutdown)")
        .drain()
        .collect();
    if children.is_empty() {
        return;
    }
    {
        let mut exits = lock_recover(&state.intentional_exits, "intentional exits (shutdown)");
        for (key, _) in &children {
            exits.insert(key.clone());
        }
    }
    for (key, child) in children {
        let mut child = lock_recover(&child, "agent child (shutdown)");
        let pid = child.id();
        tracing::info!(target: "aethon::agent", key = key, "shutdown: killing pid={pid}; reason={reason}");
        let _ = child.kill();
        let _ = child.wait();
    }
    lock_recover(&state.mutation_routes, "mutation routes (shutdown)").clear();
    lock_recover(&state.meta, "worker meta (shutdown)").clear();
}

pub(crate) fn cleanup_orphaned_dev_agents() {
    if !cfg!(debug_assertions) {
        return;
    }
    let marker = project_root()
        .join("agent")
        .join("main.ts")
        .to_string_lossy()
        .to_string();
    let output = match env::command("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            tracing::warn!(
                target: "aethon::agent",
                "orphan cleanup ps exited with status {}",
                output.status
            );
            return;
        }
        Err(e) => {
            tracing::warn!(target: "aethon::agent", "orphan cleanup ps failed: {e}");
            return;
        }
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let Some((pid, ppid, command)) = parse_ps_process_line(line) else {
            continue;
        };
        if ppid != 1 || !command.contains(&marker) {
            continue;
        }
        tracing::warn!(
            target: "aethon::agent",
            "terminating orphaned dev agent pid={pid}"
        );
        if let Err(e) = env::command("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
        {
            tracing::warn!(target: "aethon::agent", "orphan cleanup kill pid={pid}: {e}");
        }
    }
}

fn parse_ps_process_line(line: &str) -> Option<(u32, u32, &str)> {
    let trimmed = line.trim_start();
    let (pid_s, rest) = trimmed.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (ppid_s, command) = rest.split_once(char::is_whitespace)?;
    Some((
        pid_s.parse().ok()?,
        ppid_s.parse().ok()?,
        command.trim_start(),
    ))
}

fn route_payload_key_without_mutation(payload: &serde_json::Value) -> String {
    let tab_scoped = matches!(
        payload.get("type").and_then(|v| v.as_str()),
        Some(
            "a2ui_event"
                | "chat"
                | "local_chat_message"
                | "native_slash_command"
                | "set_model"
                | "set_thinking_level"
                | "stop"
                | "tab_close"
                | "tab_open"
        )
    );
    if tab_scoped
        && let Some(tab_id) = payload.get("tabId").and_then(|v| v.as_str())
        && !tab_id.is_empty()
        && tab_id != "default"
    {
        return tab_agent_key(tab_id);
    }
    GLOBAL_AGENT_KEY.to_string()
}

pub(crate) fn route_payload_key(
    state: &State<'_, AgentProcesses>,
    payload: &serde_json::Value,
) -> String {
    if payload.get("type").and_then(|v| v.as_str()) == Some("mutation_ack")
        && let Some(mutation_id) = payload.get("mutationId").and_then(|v| v.as_str())
        && let Some(key) =
            lock_recover(&state.mutation_routes, "mutation routes (ack)").remove(mutation_id)
    {
        return key;
    }
    route_payload_key_without_mutation(payload)
}

#[cfg(test)]
mod tests {
    use super::{
        Arc, GLOBAL_AGENT_KEY, HashMap, HashSet, Instant, Mutex, WEDGED_PROMPT_CAP, WorkerMeta,
        idle_keys_to_retire, keys_to_reconcile, payload_starts_prompt, prompt_wedged,
        purge_routes_for_key, route_payload_key_without_mutation, should_retire_idle,
        tab_agent_key, touch_worker_activity,
    };
    use std::time::Duration;

    fn worker_aged(tab_id: &str, age: Duration) -> WorkerMeta {
        let spawned = Instant::now().checked_sub(age).expect("instant in range");
        WorkerMeta {
            tab_id: Some(tab_id.into()),
            cwd: None,
            pid: 1,
            spawned_at: spawned,
            last_activity: spawned,
            prompt_in_flight: false,
            prompt_started_at: None,
            bridge_ready: true,
        }
    }

    fn worker(prompt_in_flight: bool, idle: Duration) -> WorkerMeta {
        let last = Instant::now().checked_sub(idle).expect("instant in range");
        WorkerMeta {
            tab_id: Some("t".into()),
            cwd: None,
            pid: 1,
            spawned_at: last,
            last_activity: last,
            prompt_in_flight,
            prompt_started_at: prompt_in_flight.then_some(last),
            bridge_ready: true,
        }
    }

    #[test]
    fn idle_tab_worker_past_ttl_is_retired() {
        let ttl = Duration::from_secs(60);
        let now = Instant::now();
        assert!(should_retire_idle(
            "tab:x",
            &worker(false, Duration::from_secs(120)),
            now,
            ttl
        ));
    }

    #[test]
    fn fresh_or_busy_or_global_workers_are_kept() {
        let ttl = Duration::from_secs(60);
        let now = Instant::now();
        // Recently active.
        assert!(!should_retire_idle(
            "tab:x",
            &worker(false, Duration::from_secs(5)),
            now,
            ttl
        ));
        // Mid-prompt, even if idle clock would otherwise trip.
        assert!(!should_retire_idle(
            "tab:x",
            &worker(true, Duration::from_secs(120)),
            now,
            ttl
        ));
        // The global agent is never swept.
        assert!(!should_retire_idle(
            GLOBAL_AGENT_KEY,
            &worker(false, Duration::from_secs(9999)),
            now,
            ttl
        ));
    }

    #[test]
    fn idle_keys_collects_only_eligible() {
        let mut map = HashMap::new();
        map.insert(
            "tab:idle".to_string(),
            worker(false, Duration::from_secs(120)),
        );
        map.insert(
            "tab:busy".to_string(),
            worker(true, Duration::from_secs(120)),
        );
        map.insert(
            "tab:fresh".to_string(),
            worker(false, Duration::from_secs(1)),
        );
        map.insert(
            GLOBAL_AGENT_KEY.to_string(),
            worker(false, Duration::from_secs(120)),
        );
        let meta = Arc::new(Mutex::new(map));

        let keys = idle_keys_to_retire(&meta, Instant::now(), Duration::from_secs(60));

        assert_eq!(keys, vec!["tab:idle".to_string()]);
    }

    #[test]
    fn reconcile_retires_only_aged_orphan_tab_workers() {
        let mut map = HashMap::new();
        // Orphaned (tab gone) and old enough → retire.
        map.insert(
            tab_agent_key("gone"),
            worker_aged("gone", Duration::from_secs(30)),
        );
        // Orphaned but just spawned → keep (frontend may not have reported it).
        map.insert(
            tab_agent_key("new"),
            worker_aged("new", Duration::from_secs(1)),
        );
        // Still live → keep.
        map.insert(
            tab_agent_key("live"),
            worker_aged("live", Duration::from_secs(30)),
        );
        // Orphaned + aged but mid-prompt → keep (don't kill an in-flight turn).
        let mut busy_orphan = worker_aged("busy", Duration::from_secs(30));
        busy_orphan.prompt_in_flight = true;
        map.insert(tab_agent_key("busy"), busy_orphan);
        // Global is never reconciled.
        map.insert(
            GLOBAL_AGENT_KEY.to_string(),
            worker_aged("ignored", Duration::from_secs(30)),
        );
        let meta = Arc::new(Mutex::new(map));
        let live: HashSet<String> = ["live".to_string()].into_iter().collect();

        let keys = keys_to_reconcile(&meta, &live, Instant::now(), Duration::from_secs(10));

        assert_eq!(keys, vec![tab_agent_key("gone")]);
    }

    #[test]
    fn global_agent_key_is_stable() {
        assert_eq!(GLOBAL_AGENT_KEY, "__global__");
    }

    #[test]
    fn tab_agent_key_keeps_tab_prefix() {
        assert_eq!(tab_agent_key("abc"), "tab:abc");
    }

    #[test]
    fn tab_scoped_chats_route_to_distinct_workers() {
        let first = route_payload_key_without_mutation(&serde_json::json!({
            "type": "chat",
            "tabId": "tab-a",
        }));
        let second = route_payload_key_without_mutation(&serde_json::json!({
            "type": "chat",
            "tabId": "tab-b",
        }));

        assert_eq!(first, tab_agent_key("tab-a"));
        assert_eq!(second, tab_agent_key("tab-b"));
        assert_ne!(first, second);
    }

    #[test]
    fn tab_scoped_control_payloads_route_to_tab_worker() {
        for ty in ["set_model", "set_thinking_level", "stop", "tab_open"] {
            assert_eq!(
                route_payload_key_without_mutation(&serde_json::json!({
                    "type": ty,
                    "tabId": "tab-a",
                })),
                tab_agent_key("tab-a")
            );
        }
    }

    #[test]
    fn default_and_unscoped_payloads_route_to_global_worker() {
        assert_eq!(
            route_payload_key_without_mutation(&serde_json::json!({
                "type": "chat",
                "tabId": "default",
            })),
            GLOBAL_AGENT_KEY
        );
        assert_eq!(
            route_payload_key_without_mutation(&serde_json::json!({ "type": "report" })),
            GLOBAL_AGENT_KEY
        );
    }

    #[test]
    fn only_chat_starts_a_prompt() {
        assert!(payload_starts_prompt(
            &serde_json::json!({ "type": "chat" })
        ));
        // These reach the bridge but never produce a response_end, so they must
        // not latch prompt_in_flight (codex P2).
        for ty in [
            "local_chat_message",
            "native_slash_command",
            "a2ui_event",
            "set_model",
            "set_thinking_level",
            "tab_open",
            "report",
        ] {
            assert!(!payload_starts_prompt(&serde_json::json!({ "type": ty })));
        }
    }

    fn meta_with_stale_entry(key: &str) -> Arc<Mutex<HashMap<String, WorkerMeta>>> {
        let stale = Instant::now()
            .checked_sub(Duration::from_secs(30))
            .expect("instant in range");
        let mut map = HashMap::new();
        map.insert(
            key.to_string(),
            WorkerMeta {
                tab_id: Some("t".into()),
                cwd: None,
                pid: 1,
                spawned_at: stale,
                last_activity: stale,
                prompt_in_flight: true,
                prompt_started_at: Some(stale),
                bridge_ready: true,
            },
        );
        Arc::new(Mutex::new(map))
    }

    #[test]
    fn touch_bumps_activity_and_sets_prompt_flag() {
        let meta = meta_with_stale_entry("tab:x");
        let before = meta.lock().unwrap().get("tab:x").unwrap().last_activity;

        touch_worker_activity(&meta, "tab:x", Some(false));

        let entry_guard = meta.lock().unwrap();
        let entry = entry_guard.get("tab:x").unwrap();
        assert!(entry.last_activity > before, "last_activity should advance");
        assert!(
            !entry.prompt_in_flight,
            "flag should clear when Some(false)"
        );
    }

    #[test]
    fn touch_without_flag_leaves_prompt_state() {
        let meta = meta_with_stale_entry("tab:x");
        touch_worker_activity(&meta, "tab:x", None);
        assert!(meta.lock().unwrap().get("tab:x").unwrap().prompt_in_flight);
    }

    #[test]
    fn touch_unknown_key_is_a_noop() {
        let meta = meta_with_stale_entry("tab:x");
        touch_worker_activity(&meta, "tab:missing", Some(false));
        // Existing entry untouched, no panic for the missing key.
        assert!(meta.lock().unwrap().get("tab:x").unwrap().prompt_in_flight);
    }

    #[test]
    fn touch_manages_prompt_started_at_lifecycle() {
        let meta = meta_with_stale_entry("tab:x");
        // Already in flight: flag true again must NOT reset the start time.
        let before = meta.lock().unwrap().get("tab:x").unwrap().prompt_started_at;
        touch_worker_activity(&meta, "tab:x", Some(true));
        assert_eq!(
            meta.lock().unwrap().get("tab:x").unwrap().prompt_started_at,
            before
        );
        // Turn end clears it.
        touch_worker_activity(&meta, "tab:x", Some(false));
        assert!(
            meta.lock()
                .unwrap()
                .get("tab:x")
                .unwrap()
                .prompt_started_at
                .is_none()
        );
        // A fresh turn sets a new start time.
        touch_worker_activity(&meta, "tab:x", Some(true));
        assert!(
            meta.lock()
                .unwrap()
                .get("tab:x")
                .unwrap()
                .prompt_started_at
                .is_some()
        );
    }

    fn wedged_worker() -> WorkerMeta {
        let long_ago = Instant::now()
            .checked_sub(WEDGED_PROMPT_CAP + Duration::from_secs(60))
            .expect("instant in range");
        WorkerMeta {
            tab_id: Some("t".into()),
            cwd: None,
            pid: 1,
            spawned_at: long_ago,
            last_activity: long_ago,
            prompt_in_flight: true,
            prompt_started_at: Some(long_ago),
            bridge_ready: true,
        }
    }

    #[test]
    fn wedged_prompt_no_longer_blocks_idle_retirement() {
        let now = Instant::now();
        let wedged = wedged_worker();
        assert!(prompt_wedged(&wedged, now));
        assert!(should_retire_idle(
            "tab:x",
            &wedged,
            now,
            Duration::from_secs(60)
        ));
    }

    #[test]
    fn streaming_turn_is_never_wedged() {
        let now = Instant::now();
        let mut streaming = wedged_worker();
        // A live turn keeps bumping last_activity via stdout traffic.
        streaming.last_activity = now;
        assert!(!prompt_wedged(&streaming, now));
        assert!(!should_retire_idle(
            "tab:x",
            &streaming,
            now,
            Duration::from_secs(60)
        ));
    }

    #[test]
    fn wedged_orphan_is_reconciled() {
        let mut map = HashMap::new();
        map.insert(tab_agent_key("gone"), wedged_worker());
        let meta = Arc::new(Mutex::new(map));
        let live: HashSet<String> = HashSet::new();

        let keys = keys_to_reconcile(&meta, &live, Instant::now(), Duration::from_secs(10));

        assert_eq!(keys, vec![tab_agent_key("gone")]);
    }

    #[test]
    fn purge_routes_drops_only_the_dead_key() {
        let routes = Arc::new(Mutex::new(HashMap::from([
            ("m1".to_string(), "tab:dead".to_string()),
            ("m2".to_string(), "tab:dead".to_string()),
            ("m3".to_string(), "tab:live".to_string()),
        ])));

        purge_routes_for_key(&routes, "tab:dead");

        let map = routes.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("m3"), Some(&"tab:live".to_string()));
    }
}
