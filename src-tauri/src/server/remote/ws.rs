//! WebSocket session loop for paired remote clients.
//!
//! One multiplexed socket per client: first frame must be `hello`
//! (token-authenticated, 5s deadline), then `invoke` frames dispatch
//! through the relay (each as its own task; results return by
//! correlation id, possibly out of order) while `sub`scribed hub topics
//! stream as `event` frames.
//!
//! Ordering & backpressure: the loop owns the sink, so frames to one
//! client are strictly ordered. `agent-response` is never dropped or
//! coalesced — a client that can't drain within `EVENT_SEND_TIMEOUT`
//! (or that lags the hub ring) is closed with `bye slow-consumer` and
//! rehydrates on reconnect, which is cheaper to reason about than any
//! replay buffer.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt, stream::SplitSink, stream::SplitStream};
use tokio::sync::{broadcast, mpsc};

use super::GatewayCtx;
use super::devices::DeviceView;
use super::events::is_known_topic;
use super::protocol::{ClientFrame, PROTOCOL_VERSION, ServerFrame};

pub const HELLO_DEADLINE: Duration = Duration::from_secs(5);
/// Slow-consumer eviction: how long one event frame may block the sink.
pub const EVENT_SEND_TIMEOUT: Duration = Duration::from_secs(3);
/// Max hub frames drained per wakeup before writing to the socket.
const EVENT_BATCH_MAX: usize = 256;
/// A coalesced shell-output run larger than this is tail-truncated and
/// flagged; the client resyncs the gap via `shell_read_scrollback`.
const SHELL_MERGE_CAP: usize = 64 * 1024;
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// Two missed pings.
const IDLE_DEADLINE: Duration = Duration::from_secs(45);
/// In-flight invoke results waiting for the sink.
const RESULT_QUEUE: usize = 64;

pub async fn ws_handler(State(ctx): State<GatewayCtx>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| async move {
        client_session(ctx, socket).await;
    })
}

/// Send one frame, ignoring failures — used on paths where the socket
/// is already condemned.
async fn send_bye(sink: &mut SplitSink<WebSocket, Message>, reason: &str) {
    if let Ok(wire) = ServerFrame::bye(reason).wire() {
        let _ = sink.send(Message::Text(wire)).await;
    }
    let _ = sink.close().await;
}

async fn client_session(ctx: GatewayCtx, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    let device = match authenticate(&ctx, &mut stream).await {
        Ok(device) => device,
        Err(reason) => {
            send_bye(&mut sink, reason).await;
            return;
        }
    };

    // Register the live handle BEFORE announcing hello_ok, so a client
    // that revokes the instant it sees hello_ok can't race the
    // registration — the handle is guaranteed to exist by the time the
    // client can act, and `close_device`'s notify_one stores a permit
    // even before the session loop starts awaiting it.
    ctx.remote.devices.touch(&device.id);
    let revoked = ctx.remote.register_live(&device.id);

    let hello_ok = ServerFrame::HelloOk {
        protocol: PROTOCOL_VERSION,
        host: ctx.info.clone(),
        device_id: device.id.clone(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    match hello_ok.wire() {
        Ok(wire) => {
            if sink.send(Message::Text(wire)).await.is_err() {
                ctx.remote.deregister_live(&device.id, &revoked);
                return;
            }
        }
        Err(_) => {
            ctx.remote.deregister_live(&device.id, &revoked);
            return;
        }
    }

    tracing::info!(
        target: "aethon::server::remote",
        "device {} ({}) connected", device.id, device.name
    );
    (ctx.device_changed)(&device);
    run_session(&ctx, &device, &mut sink, &mut stream, &revoked).await;
    ctx.remote.deregister_live(&device.id, &revoked);
    tracing::info!(target: "aethon::server::remote", "device {} disconnected", device.id);
    (ctx.device_changed)(&device);
}

async fn authenticate(
    ctx: &GatewayCtx,
    stream: &mut SplitStream<WebSocket>,
) -> Result<DeviceView, &'static str> {
    let first = tokio::time::timeout(HELLO_DEADLINE, stream.next())
        .await
        .map_err(|_| "hello-timeout")?;
    let Some(Ok(Message::Text(text))) = first else {
        return Err("hello-expected");
    };
    let frame: ClientFrame = serde_json::from_str(&text).map_err(|_| "hello-invalid")?;
    let ClientFrame::Hello {
        protocol,
        token,
        device_id,
        app_version,
    } = frame
    else {
        return Err("hello-expected");
    };
    if protocol != PROTOCOL_VERSION {
        return Err("protocol-unsupported");
    }
    let device = ctx
        .remote
        .devices
        .verify_token(&token)
        .ok_or("auth-failed")?;
    // Claimed id/version are informational — identity came from the token.
    tracing::debug!(
        target: "aethon::server::remote",
        "hello from {} (claimed id {:?}, client v{})",
        device.id,
        device_id,
        app_version.as_deref().unwrap_or("unknown")
    );
    Ok(device)
}

async fn run_session(
    ctx: &GatewayCtx,
    device: &DeviceView,
    sink: &mut SplitSink<WebSocket, Message>,
    stream: &mut SplitStream<WebSocket>,
    revoked: &Arc<tokio::sync::Notify>,
) {
    let mut subs: HashSet<String> = HashSet::new();
    let mut hub_rx = ctx.remote.hub.subscribe();
    let (results_tx, mut results_rx) = mpsc::channel::<String>(RESULT_QUEUE);
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_inbound = Instant::now();

    loop {
        tokio::select! {
            inbound = stream.next() => {
                match inbound {
                    None | Some(Err(_)) => return,
                    Some(Ok(Message::Close(_))) => return,
                    Some(Ok(Message::Text(text))) => {
                        last_inbound = Instant::now();
                        handle_text_frame(ctx, device, &text, &mut subs, &results_tx);
                    }
                    Some(Ok(_)) => {
                        // Pong / Ping / Binary — liveness only.
                        last_inbound = Instant::now();
                    }
                }
            }
            frame = hub_rx.recv() => {
                match frame {
                    Ok(frame) => {
                        // Batch-drain whatever else the hub already has so
                        // bursty streams (a TUI redraw hitting shell-output)
                        // coalesce per tab instead of one socket write per
                        // PTY chunk. Draining hits Lagged the same way
                        // recv() does — treat it identically.
                        let mut batch = vec![frame];
                        let mut lagged = false;
                        while batch.len() < EVENT_BATCH_MAX {
                            match hub_rx.try_recv() {
                                Ok(next) => batch.push(next),
                                Err(broadcast::error::TryRecvError::Empty) => break,
                                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                                    lagged = true;
                                    break;
                                }
                                Err(broadcast::error::TryRecvError::Closed) => break,
                            }
                        }
                        if lagged {
                            send_bye(sink, "slow-consumer").await;
                            return;
                        }
                        batch.retain(|f| subs.contains(f.topic));
                        for wire in coalesce_batch(&batch) {
                            let send = sink.send(Message::Text(wire));
                            match tokio::time::timeout(EVENT_SEND_TIMEOUT, send).await {
                                Ok(Ok(())) => {}
                                Ok(Err(_)) => return,
                                Err(_) => {
                                    send_bye(sink, "slow-consumer").await;
                                    return;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        tracing::warn!(
                            target: "aethon::server::remote",
                            "device {} lagged {missed} events", device.id
                        );
                        send_bye(sink, "slow-consumer").await;
                        return;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
            result = results_rx.recv() => {
                // Senders live in this fn's scope, so recv() can't yield
                // None until the loop itself drops them.
                if let Some(wire) = result
                    && sink.send(Message::Text(wire)).await.is_err() {
                        return;
                    }
            }
            _ = ping.tick() => {
                if last_inbound.elapsed() > IDLE_DEADLINE {
                    send_bye(sink, "timeout").await;
                    return;
                }
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    return;
                }
            }
            _ = revoked.notified() => {
                send_bye(sink, "revoked").await;
                return;
            }
        }
    }
}

/// Per-device invoke rate limit — a fixed window so a buggy or
/// hostile client can't wedge the relay with unbounded concurrent
/// dispatch. Generous enough for real bursts (a screen mounting fires a
/// handful of reads at once). Keyed by device id in [`RemoteState`], so
/// a device opening several concurrent sessions shares one budget.
const RATE_WINDOW: Duration = Duration::from_secs(1);
const RATE_MAX_INVOKES: u32 = 40;

pub(super) struct RateLimiter {
    window_start: Instant,
    count: u32,
}

impl RateLimiter {
    pub(super) fn new() -> Self {
        Self {
            window_start: Instant::now(),
            count: 0,
        }
    }

    /// Record an invoke; `false` when the current window is exhausted.
    pub(super) fn allow(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.window_start) >= RATE_WINDOW {
            self.window_start = now;
            self.count = 0;
        }
        if self.count >= RATE_MAX_INVOKES {
            return false;
        }
        self.count += 1;
        true
    }
}

fn handle_text_frame(
    ctx: &GatewayCtx,
    device: &DeviceView,
    text: &str,
    subs: &mut HashSet<String>,
    results_tx: &mpsc::Sender<String>,
) {
    let frame: ClientFrame = match serde_json::from_str(text) {
        Ok(frame) => frame,
        Err(e) => {
            tracing::debug!(
                target: "aethon::server::remote",
                "device {}: unparsable frame: {e}", device.id
            );
            return;
        }
    };
    match frame {
        ClientFrame::Hello { .. } => {
            // Already authenticated; a stray hello is a no-op.
        }
        ClientFrame::Sub { topics } => {
            for topic in topics {
                if is_known_topic(&topic) {
                    subs.insert(topic);
                } else {
                    tracing::debug!(
                        target: "aethon::server::remote",
                        "device {}: ignoring unknown topic {topic}", device.id
                    );
                }
            }
        }
        ClientFrame::Unsub { topics } => {
            for topic in topics {
                subs.remove(&topic);
            }
        }
        ClientFrame::Invoke { id, cmd, args } => {
            if !ctx.remote.allow_invoke(&device.id) {
                let frame = ServerFrame::result_err(
                    id,
                    "rate limited: too many requests, retry shortly".to_string(),
                );
                if let Ok(wire) = frame.wire() {
                    // Same awaited-send path as real results — a full
                    // queue must delay the rejection, not drop it, or
                    // the client waits out its invoke timeout instead.
                    let results_tx = results_tx.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = results_tx.send(wire).await;
                    });
                }
                return;
            }
            let relay = Arc::clone(&ctx.relay);
            let results_tx = results_tx.clone();
            let device_id = device.id.clone();
            tauri::async_runtime::spawn(async move {
                let frame = match relay.invoke(&cmd, args).await {
                    Ok(data) => ServerFrame::result_ok(id, data),
                    Err(error) => {
                        tracing::debug!(
                            target: "aethon::server::remote",
                            "device {device_id}: {cmd} failed: {error}"
                        );
                        ServerFrame::result_err(id, error)
                    }
                };
                if let Ok(wire) = frame.wire() {
                    // Await capacity: results must not be dropped; the
                    // session loop drains this queue between events.
                    let _ = results_tx.send(wire).await;
                }
            });
        }
    }
}

/// Merge ADJACENT `shell-output` frames for the same tab into one wire
/// frame, preserving total frame order exactly (a run never spans a
/// frame of another topic or tab, so per-tab output/exit ordering
/// holds). Runs above [`SHELL_MERGE_CAP`] keep their tail and gain
/// `"truncated": true` so the client knows to resync scrollback.
/// Single-frame runs pass through byte-identical.
fn coalesce_batch(batch: &[Arc<super::events::EventFrame>]) -> Vec<String> {
    #[derive(serde::Deserialize)]
    struct ShellWire {
        seq: u64,
        payload: ShellPayload,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ShellPayload {
        tab_id: String,
        content: String,
    }

    struct Run {
        tab_id: String,
        content: String,
        last_seq: u64,
        first_wire: String,
        frames: usize,
    }

    fn flush(run: Option<Run>, out: &mut Vec<String>) {
        let Some(run) = run else {
            return;
        };
        if run.frames == 1 {
            out.push(run.first_wire);
            return;
        }
        let truncated = run.content.len() > SHELL_MERGE_CAP;
        let content = if truncated {
            let mut start = run.content.len() - SHELL_MERGE_CAP;
            while !run.content.is_char_boundary(start) {
                start += 1;
            }
            &run.content[start..]
        } else {
            run.content.as_str()
        };
        let mut payload = serde_json::json!({
            "tabId": run.tab_id,
            "content": content,
        });
        if truncated {
            payload["truncated"] = serde_json::Value::Bool(true);
        }
        let frame = serde_json::json!({
            "t": "event",
            "topic": "shell-output",
            "seq": run.last_seq,
            "payload": payload,
        });
        out.push(frame.to_string());
    }

    let mut out = Vec::with_capacity(batch.len());
    let mut run: Option<Run> = None;
    for frame in batch {
        if frame.topic == "shell-output"
            && let Ok(parsed) = serde_json::from_str::<ShellWire>(&frame.wire)
        {
            match run.as_mut() {
                Some(open) if open.tab_id == parsed.payload.tab_id => {
                    open.content.push_str(&parsed.payload.content);
                    open.last_seq = parsed.seq;
                    open.frames += 1;
                }
                _ => {
                    flush(run.take(), &mut out);
                    run = Some(Run {
                        tab_id: parsed.payload.tab_id,
                        content: parsed.payload.content,
                        last_seq: parsed.seq,
                        first_wire: frame.wire.clone(),
                        frames: 1,
                    });
                }
            }
            continue;
        }
        flush(run.take(), &mut out);
        out.push(frame.wire.clone());
    }
    flush(run, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::super::events::EventFrame;
    use super::*;

    fn shell_frame(seq: u64, tab: &str, content: &str) -> Arc<EventFrame> {
        Arc::new(EventFrame {
            topic: "shell-output",
            wire: serde_json::json!({
                "t": "event", "topic": "shell-output", "seq": seq,
                "payload": { "tabId": tab, "content": content },
            })
            .to_string(),
        })
    }

    fn other_frame(seq: u64) -> Arc<EventFrame> {
        Arc::new(EventFrame {
            topic: "shell-exit",
            wire: serde_json::json!({
                "t": "event", "topic": "shell-exit", "seq": seq,
                "payload": { "tabId": "t1", "code": 0 },
            })
            .to_string(),
        })
    }

    #[test]
    fn adjacent_same_tab_output_merges_with_last_seq() {
        let batch = vec![
            shell_frame(1, "t1", "a"),
            shell_frame(2, "t1", "b"),
            shell_frame(3, "t1", "c"),
        ];
        let out = coalesce_batch(&batch);
        assert_eq!(out.len(), 1);
        let parsed: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(parsed["seq"], 3);
        assert_eq!(parsed["payload"]["content"], "abc");
        assert!(parsed["payload"].get("truncated").is_none());
    }

    #[test]
    fn runs_never_span_other_tabs_or_topics() {
        let batch = vec![
            shell_frame(1, "t1", "a"),
            shell_frame(1, "t2", "x"),
            shell_frame(2, "t1", "b"),
            other_frame(1),
            shell_frame(3, "t1", "c"),
        ];
        let out = coalesce_batch(&batch);
        // Nothing adjacent shares a tab, so total order is preserved 1:1.
        assert_eq!(out.len(), 5);
        assert_eq!(out[0], batch[0].wire);
        assert_eq!(out[3], batch[3].wire);
    }

    #[test]
    fn oversized_run_keeps_tail_and_flags_truncation() {
        let chunk = "x".repeat(40 * 1024);
        let batch = vec![shell_frame(1, "t1", &chunk), shell_frame(2, "t1", &chunk)];
        let out = coalesce_batch(&batch);
        assert_eq!(out.len(), 1);
        let parsed: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(parsed["payload"]["truncated"], true);
        assert_eq!(
            parsed["payload"]["content"].as_str().unwrap().len(),
            SHELL_MERGE_CAP
        );
    }

    #[test]
    fn truncation_respects_utf8_boundaries() {
        // 4-byte scorpions guarantee the naive cut lands mid-char.
        let chunk = "🦂".repeat(20 * 1024);
        let batch = vec![shell_frame(1, "t1", &chunk), shell_frame(2, "t1", &chunk)];
        let out = coalesce_batch(&batch);
        let parsed: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        let content = parsed["payload"]["content"].as_str().unwrap();
        assert!(content.len() <= SHELL_MERGE_CAP);
        assert!(content.chars().all(|c| c == '🦂'));
    }

    #[test]
    fn single_frames_pass_through_byte_identical() {
        let batch = vec![shell_frame(9, "t1", "solo"), other_frame(2)];
        let out = coalesce_batch(&batch);
        assert_eq!(out, vec![batch[0].wire.clone(), batch[1].wire.clone()]);
    }

    #[test]
    fn rate_limiter_caps_the_window_then_refills() {
        let mut rate = RateLimiter::new();
        for _ in 0..RATE_MAX_INVOKES {
            assert!(rate.allow());
        }
        assert!(!rate.allow(), "window should be exhausted");
        // Force the window open and confirm it refills.
        rate.window_start = Instant::now() - RATE_WINDOW - Duration::from_millis(1);
        assert!(rate.allow());
    }

    #[test]
    fn invoke_budget_is_shared_per_device_not_per_session() {
        let state = super::super::RemoteState::in_memory();
        for _ in 0..RATE_MAX_INVOKES {
            assert!(state.allow_invoke("device-a"));
        }
        // A second session of the same device shares the exhausted
        // budget; a different device gets its own.
        assert!(!state.allow_invoke("device-a"));
        assert!(state.allow_invoke("device-b"));
        // Last-session deregistration prunes the entry, so a fresh
        // connection starts a fresh window.
        let handle = state.register_live("device-a");
        state.deregister_live("device-a", &handle);
        assert!(state.allow_invoke("device-a"));
    }
}
