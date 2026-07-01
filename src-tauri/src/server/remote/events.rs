//! Rust-side event tap + fan-out hub for remote clients.
//!
//! Every Tauri event site in this codebase broadcasts via `app.emit(..)`
//! (no targeted `emit_to`), so `listen_any` taps observe the exact
//! payloads the desktop webview receives — no changes at the emit sites.
//! The hub stamps a per-topic sequence number and rebroadcasts
//! `Arc<EventFrame>`s; per-client connection tasks filter by their
//! subscription set. Clients detect a `seq` gap after reconnect and
//! rehydrate via invokes instead of relying on a replay buffer.

// TODO(remote-gateway): consumed by the WS connection layer later on this
// branch; drop this allow when ws.rs lands.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Listener;
use tokio::sync::broadcast;

/// Topics remote clients may subscribe to. Phase 1 covers the agent
/// bridge stream + host discovery; later phases append shell/fs/git
/// topics here (the tap mechanism is topic-agnostic).
pub const REMOTE_TOPICS: &[&str] = &[
    "agent-response",
    "agent-reloaded",
    "agent-stderr",
    "scheduled-tasks-changed",
    "host-discovered",
    "host-removed",
];

/// One tapped Tauri event, fanned out to subscribed clients.
#[derive(Debug)]
pub struct EventFrame {
    pub topic: &'static str,
    pub seq: u64,
    /// Raw JSON exactly as Tauri serialized the emitted payload — a remote
    /// client parses it the same way the webview's `listen` callback would.
    pub payload: String,
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
        let seqs = REMOTE_TOPICS
            .iter()
            .map(|&topic| (topic, AtomicU64::new(0)))
            .collect();
        Self { tx, seqs }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<EventFrame>> {
        self.tx.subscribe()
    }

    /// Stamp and fan out one event. Send errors just mean no client is
    /// connected right now — that's the idle steady state, not a fault.
    pub fn publish(&self, topic: &'static str, payload: String) {
        let Some(seq) = self.seqs.get(topic) else {
            debug_assert!(false, "publish for unregistered topic {topic}");
            return;
        };
        let frame = EventFrame {
            topic,
            seq: seq.fetch_add(1, Ordering::Relaxed) + 1,
            payload,
        };
        let _ = self.tx.send(Arc::new(frame));
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Install `listen_any` taps for every remote topic. `listen_any` (rather
/// than `listen`) so targeted emits would also be observed if an emit
/// site ever switches to `emit_to`.
pub fn install_taps<R: tauri::Runtime>(hub: &Arc<EventHub>, app: &tauri::AppHandle<R>) {
    for &topic in REMOTE_TOPICS {
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
        assert_eq!(frame.seq, 1);
        // Tauri serializes the emitted String, so the tap sees its JSON
        // encoding; decoding restores the exact bridge line.
        let decoded: String = serde_json::from_str(&frame.payload).expect("json string");
        assert_eq!(decoded, "{\"type\":\"ready\"}");
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
            seen.push((frame.topic, frame.seq));
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
}
