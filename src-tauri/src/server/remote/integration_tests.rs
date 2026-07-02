//! End-to-end protocol tests: the real axum router served over a plain
//! TCP loopback socket, driven by a real WebSocket client. TLS pinning
//! is covered structurally in `tls.rs`; here we exercise the wire
//! protocol — pairing, hello auth, invoke correlation, event fan-out,
//! and revocation — with the `EchoRelay` so no Tauri runtime is needed.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::relay::EchoRelay;
use super::{GatewayCtx, RemoteState};
use crate::commands::host::HostInfo;

struct Harness {
    addr: String,
    remote: Arc<RemoteState>,
}

async fn spawn_gateway() -> Harness {
    let remote = Arc::new(RemoteState::in_memory());
    let ctx = GatewayCtx {
        info: HostInfo {
            id: "local:test".into(),
            hostname: "test.local".into(),
            display_name: "test".into(),
            fingerprint: "f".repeat(64),
        },
        remote: Arc::clone(&remote),
        relay: Arc::new(EchoRelay),
    };
    let router = crate::server::http::router(ctx.info.clone(), ctx.remote.clone(), ctx.relay.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Harness {
        addr: format!("{addr}"),
        remote,
    }
}

/// Arm a pairing session, redeem it over HTTP, return the device token.
async fn pair(h: &Harness) -> String {
    let (session, begin) = super::pairing::begin("test", 0, &"f".repeat(64));
    *h.remote.pairing.lock().unwrap() = Some(session);
    let resp: Value = reqwest::Client::new()
        .post(format!("http://{}/pair", h.addr))
        .json(&json!({ "code": begin.code, "deviceName": "iPhone", "platform": "ios" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    resp["deviceToken"].as_str().unwrap().to_string()
}

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn connect(h: &Harness) -> Ws {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", h.addr))
        .await
        .unwrap();
    ws
}

async fn next_json(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("frame within timeout")
            .expect("stream open")
            .expect("no ws error");
        if let Message::Text(text) = msg {
            return serde_json::from_str(&text).unwrap();
        }
        // Skip ping/pong control frames.
    }
}

async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string())).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_flow_pair_hello_invoke_subscribe_event() {
    let h = spawn_gateway().await;
    let token = pair(&h).await;
    let mut ws = connect(&h).await;

    send(&mut ws, json!({ "t": "hello", "protocol": 1, "token": token })).await;
    let hello_ok = next_json(&mut ws).await;
    assert_eq!(hello_ok["t"], "hello_ok");
    assert_eq!(hello_ok["host"]["displayName"], "test");

    // Invoke correlates by id; EchoRelay reflects cmd+args back.
    send(
        &mut ws,
        json!({ "t": "invoke", "id": "i-1", "cmd": "host_info", "args": {} }),
    )
    .await;
    let result = next_json(&mut ws).await;
    assert_eq!(result["t"], "result");
    assert_eq!(result["id"], "i-1");
    assert_eq!(result["ok"], true);
    assert_eq!(result["data"]["cmd"], "host_info");

    // Subscribe, then fire a second invoke as a barrier: inbound frames
    // are processed in order, so once its result returns the `sub` has
    // been applied — no sleep, no race with the publish below.
    send(&mut ws, json!({ "t": "sub", "topics": ["agent-response"] })).await;
    send(
        &mut ws,
        json!({ "t": "invoke", "id": "i-2", "cmd": "host_info", "args": {} }),
    )
    .await;
    let barrier = next_json(&mut ws).await;
    assert_eq!(barrier["id"], "i-2");
    h.remote
        .hub
        .publish("agent-response", "\"{\\\"type\\\":\\\"ready\\\"}\"".to_string());
    let event = next_json(&mut ws).await;
    assert_eq!(event["t"], "event");
    assert_eq!(event["topic"], "agent-response");
    assert_eq!(event["seq"], 1);
    assert_eq!(event["payload"], "{\"type\":\"ready\"}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bad_token_is_rejected_with_bye() {
    let h = spawn_gateway().await;
    let mut ws = connect(&h).await;
    send(
        &mut ws,
        json!({ "t": "hello", "protocol": 1, "token": "not-a-real-token" }),
    )
    .await;
    let bye = next_json(&mut ws).await;
    assert_eq!(bye["t"], "bye");
    assert_eq!(bye["reason"], "auth-failed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsubscribed_topic_is_not_delivered() {
    let h = spawn_gateway().await;
    let token = pair(&h).await;
    let mut ws = connect(&h).await;
    send(&mut ws, json!({ "t": "hello", "protocol": 1, "token": token })).await;
    assert_eq!(next_json(&mut ws).await["t"], "hello_ok");

    // No sub for agent-response; publish, then invoke — the invoke
    // result must be the next frame (event was filtered out).
    h.remote
        .hub
        .publish("agent-response", "\"x\"".to_string());
    send(
        &mut ws,
        json!({ "t": "invoke", "id": "i-9", "cmd": "host_info", "args": {} }),
    )
    .await;
    let frame = next_json(&mut ws).await;
    assert_eq!(frame["t"], "result");
    assert_eq!(frame["id"], "i-9");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_closes_the_live_session() {
    let h = spawn_gateway().await;
    let token = pair(&h).await;
    let mut ws = connect(&h).await;
    send(&mut ws, json!({ "t": "hello", "protocol": 1, "token": token.clone() })).await;
    let hello_ok = next_json(&mut ws).await;
    let device_id = hello_ok["deviceId"].as_str().unwrap().to_string();

    // hello_ok is sent only after the live handle is registered, so no
    // sleep is needed; close_device's notify_one stores a permit even if
    // the session loop hasn't started awaiting revocation yet.
    h.remote.devices.revoke(&device_id).unwrap();
    h.remote.close_device(&device_id);

    let bye = next_json(&mut ws).await;
    assert_eq!(bye["t"], "bye");
    assert_eq!(bye["reason"], "revoked");
}
