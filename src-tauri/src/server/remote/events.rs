//! Rust-side event tap + fan-out hub for remote clients.
//!
//! Every Tauri event site in this codebase broadcasts via `app.emit(..)`
//! (no targeted `emit_to`), so `listen_any` taps observe the exact
//! payloads the desktop webview receives — no changes at the emit sites.
//! The hub stamps a per-topic sequence number, serializes the wire frame
//! once, and rebroadcasts `Arc<EventFrame>`s; per-client connection
//! tasks filter by their subscription set. Clients detect a `seq` gap
//! after reconnect and rehydrate via invokes instead of relying on a
//! replay buffer.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::value::RawValue;
use tauri::Listener;
use tokio::sync::broadcast;

use crate::server::remote::protocol::ServerFrame;

/// Topics tapped from Tauri events. Phase 1 covers the agent bridge
/// stream + host discovery; later phases append shell/fs/git topics
/// here (the tap mechanism is topic-agnostic).
pub const TAPPED_TOPICS: &[&str] = &[
    "agent-response",
    "agent-reloaded",
    "agent-stderr",
    "scheduled-tasks-changed",
    "host-discovered",
    "host-removed",
    // Phase 4 — terminal / files / git surfaces. shell-output is the
    // highest-volume topic; the client coalesces per tab (the shell
    // stream re-fans to per-tab CustomEvents frontend-side unchanged).
    "shell-output",
    "shell-title",
    "shell-exit",
    "fs-tree-changed",
    "git-state-changed",
];

/// Topics published directly by Rust code rather than tapped from a
/// Tauri event: `frontend-state` carries the `control_update_state`
/// snapshot so every connected device converges on tab/model/account
/// changes regardless of who caused them.
pub const PUSHED_TOPICS: &[&str] = &["frontend-state"];

/// Every topic a client may subscribe to.
pub fn is_known_topic(topic: &str) -> bool {
    TAPPED_TOPICS.contains(&topic) || PUSHED_TOPICS.contains(&topic)
}

/// One event, fanned out to subscribed clients. `wire` is the fully
/// serialized `{"t":"event",...}` frame (seq stamped inside) —
/// serialized once, written N times.
#[derive(Debug)]
pub struct EventFrame {
    pub topic: &'static str,
    pub wire: String,
}

/// Broadcast hub between the Tauri event taps and client connections.
pub struct EventHub {
    tx: broadcast::Sender<Arc<EventFrame>>,
    seqs: HashMap<&'static str, AtomicU64>,
}

/// Bounded so a wedged consumer can't hold unbounded memory; a receiver
/// that observes `Lagged` is disconnected by its connection task and the
/// client rehydrates on reconnect.
const HUB_CAPACITY: usize = 1024;

impl EventHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(HUB_CAPACITY);
        let seqs = TAPPED_TOPICS
            .iter()
            .chain(PUSHED_TOPICS.iter())
            .map(|&topic| (topic, AtomicU64::new(0)))
            .collect();
        Self { tx, seqs }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<EventFrame>> {
        self.tx.subscribe()
    }

    /// Stamp, serialize, and fan out one event. `payload` is the raw
    /// JSON Tauri serialized (or that the pusher produced). Send errors
    /// just mean no client is connected right now — that's the idle
    /// steady state, not a fault.
    pub fn publish(&self, topic: &'static str, payload: String) {
        let Some(seq) = self.seqs.get(topic) else {
            debug_assert!(false, "publish for unregistered topic {topic}");
            return;
        };
        let seq = seq.fetch_add(1, Ordering::Relaxed) + 1;
        let raw = match RawValue::from_string(payload) {
            Ok(raw) => raw,
            Err(e) => {
                // Tauri payloads are valid JSON by construction; treat a
                // violation loudly but don't kill the stream.
                tracing::warn!(target: "aethon::server::remote", "non-JSON payload on {topic}: {e}");
                return;
            }
        };
        let frame = ServerFrame::Event {
            topic: topic.to_string(),
            seq,
            payload: raw,
        };
        let Ok(wire) = frame.wire() else {
            return;
        };
        let _ = self.tx.send(Arc::new(EventFrame { topic, wire }));
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Install `listen_any` taps for every tapped topic. `listen_any`
/// (rather than `listen`) so targeted emits would also be observed if an
/// emit site ever switches to `emit_to`. Call once per process — taps
/// survive server stop/start.
pub fn install_taps<R: tauri::Runtime>(hub: &Arc<EventHub>, app: &tauri::AppHandle<R>) {
    for &topic in TAPPED_TOPICS {
        let hub = Arc::clone(hub);
        app.listen_any(topic, move |event| {
            hub.publish(topic, event.payload().to_string());
        });
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tauri::Emitter;

    use super::*;

    /// The load-bearing assumption for the whole gateway fan-out: a
    /// Rust-side `listen_any` tap receives payloads sent with the same
    /// `app.emit(..)` call every event site in this codebase uses.
    #[tokio::test]
    async fn listen_any_tap_receives_app_emit_payloads() {
        let app = tauri::test::mock_app();
        let hub = Arc::new(EventHub::new());
        install_taps(&hub, app.handle());
        let mut rx = hub.subscribe();

        app.handle()
            .emit("agent-response", "{\"type\":\"ready\"}")
            .expect("emit");

        let frame = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("tap must observe the emit promptly")
            .expect("hub closed");
        assert_eq!(frame.topic, "agent-response");
        // The wire frame embeds Tauri's serialization of the emitted
        // String; decoding restores the exact bridge line.
        let parsed: serde_json::Value = serde_json::from_str(&frame.wire).unwrap();
        assert_eq!(parsed["t"], "event");
        assert_eq!(parsed["topic"], "agent-response");
        assert_eq!(parsed["seq"], 1);
        assert_eq!(parsed["payload"], "{\"type\":\"ready\"}");
    }

    #[tokio::test]
    async fn seq_increments_per_topic_and_untapped_events_are_ignored() {
        let app = tauri::test::mock_app();
        let hub = Arc::new(EventHub::new());
        install_taps(&hub, app.handle());
        let mut rx = hub.subscribe();

        app.handle().emit("agent-response", "a").expect("emit");
        app.handle().emit("menu", "ignored-topic").expect("emit");
        app.handle().emit("agent-stderr", "warn").expect("emit");
        app.handle().emit("agent-response", "b").expect("emit");

        let mut seen = Vec::new();
        for _ in 0..3 {
            let frame = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("timely")
                .expect("open");
            let parsed: serde_json::Value = serde_json::from_str(&frame.wire).unwrap();
            seen.push((frame.topic, parsed["seq"].as_u64().unwrap()));
        }
        assert_eq!(
            seen,
            vec![
                ("agent-response", 1),
                ("agent-stderr", 1),
                ("agent-response", 2),
            ]
        );
        assert!(rx.try_recv().is_err(), "menu must not be tapped");
    }

    #[test]
    fn pushed_topics_publish_without_a_tap() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe();
        hub.publish("frontend-state", "{\"tabs\":[]}".to_string());
        let frame = rx.try_recv().expect("published");
        assert_eq!(frame.topic, "frontend-state");
        assert!(is_known_topic("frontend-state"));
        assert!(is_known_topic("agent-response"));
        assert!(!is_known_topic("menu"));
    }
}
