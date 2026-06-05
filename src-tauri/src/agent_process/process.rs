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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};

use super::spawn::ensure_agent_spawned;

pub(crate) const GLOBAL_AGENT_KEY: &str = "__global__";

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
    if let Ok(mut map) = meta.lock()
        && let Some(entry) = map.get_mut(key)
    {
        entry.last_activity = Instant::now();
        if let Some(flag) = prompt_in_flight {
            entry.prompt_in_flight = flag;
        }
    }
}

/// Should this worker be retired by the idle sweep? Pure so the policy is
/// testable without spawning processes. Never retires the global agent or a
/// worker that's mid-prompt; otherwise retires once idle past `ttl`.
pub(crate) fn should_retire_idle(
    key: &str,
    meta: &WorkerMeta,
    now: Instant,
    ttl: Duration,
) -> bool {
    if key == GLOBAL_AGENT_KEY {
        return false;
    }
    if meta.prompt_in_flight {
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
    let Ok(map) = meta.lock() else {
        return Vec::new();
    };
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
    let Ok(map) = meta.lock() else {
        return Vec::new();
    };
    map.iter()
        .filter(|(key, m)| {
            *key != GLOBAL_AGENT_KEY
                && !m.prompt_in_flight
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

pub(crate) fn write_agent_payload(
    state: &State<'_, AgentProcesses>,
    app: &AppHandle,
    key: String,
    payload: serde_json::Value,
    worker: Option<AgentWorker>,
) -> Result<(), String> {
    let child = {
        let mut guard = state.children.lock().map_err(|e| e.to_string())?;
        ensure_agent_spawned(
            &mut guard,
            &key,
            app,
            Arc::clone(&state.mutation_routes),
            Arc::clone(&state.intentional_exits),
            Arc::clone(&state.meta),
            worker,
        )?;
        guard.get(&key).cloned().ok_or("agent not running")?
    };

    let prompt_flag = payload_starts_prompt(&payload).then_some(true);

    {
        let mut child = child.lock().map_err(|e| e.to_string())?;
        let stdin = child.stdin.as_mut().ok_or("no stdin")?;
        use std::io::Write;
        writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
        stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    }

    // Inbound traffic counts as activity; a forwarded prompt also marks the
    // worker busy so the idle sweep won't retire it mid-turn.
    touch_worker_activity(&state.meta, &key, prompt_flag);
    Ok(())
}

pub(crate) fn ensure_global_agent(
    state: &State<'_, AgentProcesses>,
    app: &AppHandle,
) -> Result<(), String> {
    let mut guard = state.children.lock().map_err(|e| e.to_string())?;
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
        let mut guard = state.children.lock().map_err(|e| e.to_string())?;
        guard.remove(key)
    };
    if let Ok(mut map) = state.meta.lock() {
        map.remove(key);
    }
    let Some(child) = child else {
        return Ok(());
    };
    if let Ok(mut exits) = state.intentional_exits.lock() {
        exits.insert(key.to_string());
    }
    let mut child = child.lock().map_err(|e| e.to_string())?;
    let pid = child.id();
    tracing::info!(target: "aethon::agent", key = key, "retiring pid={pid}");
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
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
        && let Ok(mut routes) = state.mutation_routes.lock()
        && let Some(key) = routes.remove(mutation_id)
    {
        return key;
    }
    route_payload_key_without_mutation(payload)
}

#[cfg(test)]
mod tests {
    use super::{
        Arc, GLOBAL_AGENT_KEY, HashMap, HashSet, Instant, Mutex, WorkerMeta, idle_keys_to_retire,
        keys_to_reconcile, payload_starts_prompt, route_payload_key_without_mutation,
        should_retire_idle, tab_agent_key, touch_worker_activity,
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
}
