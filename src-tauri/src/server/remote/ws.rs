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

    let hello_ok = ServerFrame::HelloOk {
        protocol: PROTOCOL_VERSION,
        host: ctx.info.clone(),
        device_id: device.id.clone(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    match hello_ok.wire() {
        Ok(wire) => {
            if sink.send(Message::Text(wire)).await.is_err() {
                return;
            }
        }
        Err(_) => return,
    }

    ctx.remote.devices.touch(&device.id);
    let revoked = ctx.remote.register_live(&device.id);
    tracing::info!(
        target: "aethon::server::remote",
        "device {} ({}) connected", device.id, device.name
    );
    run_session(&ctx, &device, &mut sink, &mut stream, &revoked).await;
    ctx.remote.deregister_live(&device.id, &revoked);
    tracing::info!(target: "aethon::server::remote", "device {} disconnected", device.id);
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
                    Ok(frame) if subs.contains(frame.topic) => {
                        let send = sink.send(Message::Text(frame.wire.clone()));
                        match tokio::time::timeout(EVENT_SEND_TIMEOUT, send).await {
                            Ok(Ok(())) => {}
                            Ok(Err(_)) => return,
                            Err(_) => {
                                send_bye(sink, "slow-consumer").await;
                                return;
                            }
                        }
                    }
                    Ok(_) => {}
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
