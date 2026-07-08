//! Outbound desktop-peer client.
//!
//! The frontend never sees paired-host bearer tokens. Commands in
//! `commands::remote` call this module with a stored record and receive
//! sanitized JSON results.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

use super::events::TAPPED_TOPICS;
use super::hosts::PairedHostRecord;
use super::protocol::PROTOCOL_VERSION;
use crate::commands::host::HostInfo;

const PAIR_TIMEOUT: Duration = Duration::from_secs(5);
const INVOKE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PAIR_RESPONSE: usize = 64 * 1024;
const EVENT_RECONNECT_DELAY: Duration = Duration::from_secs(2);

#[derive(Debug)]
struct PinnedCert {
    fingerprint: String,
}

impl rustls::client::danger::ServerCertVerifier for PinnedCert {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let got: String = Sha256::digest(end_entity.as_ref())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if got.eq_ignore_ascii_case(&self.fingerprint) {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("cert fingerprint mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn pinned_client_config(fingerprint: String) -> Arc<rustls::ClientConfig> {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCert { fingerprint }))
        .with_no_client_auth();
    Arc::new(config)
}

fn ws_url(candidate: &str, fingerprint: &str) -> String {
    let scheme = if fingerprint.is_empty() { "ws" } else { "wss" };
    let trimmed = candidate
        .trim()
        .trim_start_matches("ws://")
        .trim_start_matches("wss://")
        .trim_end_matches("/ws")
        .trim_end_matches('/');
    format!("{scheme}://{trimmed}/ws")
}

fn http_host(candidate: &str) -> String {
    candidate
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("ws://")
        .trim_start_matches("wss://")
        .trim_end_matches("/ws")
        .trim_end_matches('/')
        .to_string()
}

fn tls_server_name(host: &str) -> Result<rustls::pki_types::ServerName<'static>, String> {
    let name = host
        .rsplit_once(':')
        .map(|(name, _)| name)
        .unwrap_or(host)
        .trim_matches('[')
        .trim_matches(']')
        .to_owned();
    rustls::pki_types::ServerName::try_from(name).map_err(|e| format!("bad host name: {e}"))
}

pub async fn pair_desktop(
    candidates: &[String],
    fingerprint: &str,
    code: &str,
    local_name: &str,
    local_info: &HostInfo,
    reciprocal_token: &str,
    reciprocal_candidates: Vec<String>,
) -> Result<(String, HostInfo), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let candidates = normalize_pair_candidates(candidates);
    if candidates.is_empty() {
        return Err("pairing address is missing".into());
    }
    let mut failures = Vec::new();
    for candidate in &candidates {
        let host = http_host(candidate);
        let result = tokio::time::timeout(
            PAIR_TIMEOUT,
            pair_exchange(
                &host,
                fingerprint,
                code,
                local_name,
                local_info,
                reciprocal_token,
                reciprocal_candidates.clone(),
            ),
        )
        .await;
        let raw = match result {
            Ok(Ok(raw)) => raw,
            Ok(Err(err)) => {
                failures.push(format!("{host}: {err}"));
                continue;
            }
            Err(_) => {
                failures.push(format!("{host}: timed out"));
                continue;
            }
        };
        let (status, body) = match parse_http_response(&raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                failures.push(format!("{host}: {err}"));
                continue;
            }
        };
        if status != 200 {
            return Err(format!(
                "pairing failed ({status}) at {host}: {}",
                error_message(&body)
            ));
        }
        return parse_pair_body(&body);
    }
    Err(format!(
        "could not reach host for pairing: {}",
        failures.join("; ")
    ))
}

fn normalize_pair_candidates(candidates: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for candidate in candidates {
        let candidate = http_host(candidate);
        if candidate.is_empty() || out.iter().any(|existing| existing == &candidate) {
            continue;
        }
        out.push(candidate);
    }
    out
}

fn parse_pair_body(body: &[u8]) -> Result<(String, HostInfo), String> {
    let parsed: Value =
        serde_json::from_slice(body).map_err(|e| format!("bad pair response: {e}"))?;
    let token = parsed
        .get("deviceToken")
        .and_then(Value::as_str)
        .ok_or("pair response missing deviceToken")?
        .to_string();
    let host: HostInfo = serde_json::from_value(parsed.get("host").cloned().unwrap_or_default())
        .map_err(|e| format!("pair response missing host: {e}"))?;
    Ok((token, host))
}

async fn pair_exchange(
    host: &str,
    fingerprint: &str,
    code: &str,
    local_name: &str,
    local_info: &HostInfo,
    reciprocal_token: &str,
    reciprocal_candidates: Vec<String>,
) -> Result<Vec<u8>, String> {
    let body = serde_json::json!({
        "code": code,
        "deviceName": local_name,
        "platform": "desktop",
        "host": local_info,
        "reciprocalToken": reciprocal_token,
        "reciprocalCandidates": reciprocal_candidates,
    })
    .to_string();
    let request = format!(
        "POST /pair HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    let tcp = TcpStream::connect(host)
        .await
        .map_err(|e| format!("connect {host}: {e}"))?;
    if fingerprint.is_empty() {
        send_and_drain(tcp, request.as_bytes()).await
    } else {
        let connector =
            tokio_rustls::TlsConnector::from(pinned_client_config(fingerprint.to_string()));
        let tls = connector
            .connect(tls_server_name(host)?, tcp)
            .await
            .map_err(|e| format!("tls {host}: {e}"))?;
        send_and_drain(tls, request.as_bytes()).await
    }
}

async fn send_and_drain<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    request: &[u8],
) -> Result<Vec<u8>, String> {
    stream
        .write_all(request)
        .await
        .map_err(|e| format!("send: {e}"))?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > MAX_PAIR_RESPONSE {
            return Err("pair response too large".to_string());
        }
    }
    Ok(raw)
}

fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("bad HTTP response")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("bad HTTP status")?;
    Ok((status, raw[split + 4..].to_vec()))
}

fn error_message(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string())
}

fn candidates_newest_first(candidates: &[String]) -> impl Iterator<Item = &String> {
    candidates.iter().rev()
}

pub async fn invoke(host: &PairedHostRecord, cmd: &str, args: Value) -> Result<Value, String> {
    let mut last_error = None;
    for candidate in candidates_newest_first(&host.candidates) {
        match invoke_candidate(candidate, &host.fingerprint, &host.token, cmd, args.clone()).await {
            Ok(value) => return Ok(value),
            Err(err) => last_error = Some(err),
        }
    }
    Err(last_error.unwrap_or_else(|| "remote host has no connection candidates".to_string()))
}

pub fn spawn_event_forwarder(host: PairedHostRecord, app: tauri::AppHandle, cancel: Arc<Notify>) {
    tauri::async_runtime::spawn(async move {
        event_forwarder_loop(host, app, cancel).await;
    });
}

async fn event_forwarder_loop(host: PairedHostRecord, app: tauri::AppHandle, cancel: Arc<Notify>) {
    loop {
        let result = connect_and_forward_events(&host, &app, &cancel).await;
        if matches!(result, Err(ref err) if err == "cancelled") {
            return;
        }
        let payload = serde_json::json!({
            "id": host.id,
            "connected": false,
            "error": result.err().unwrap_or_else(|| "disconnected".to_string()),
        });
        let _ = app.emit("remote-host-status-changed", payload);
        tokio::select! {
            _ = cancel.notified() => return,
            _ = tokio::time::sleep(EVENT_RECONNECT_DELAY) => {}
        }
    }
}

async fn connect_and_forward_events(
    host: &PairedHostRecord,
    app: &tauri::AppHandle,
    cancel: &Arc<Notify>,
) -> Result<(), String> {
    let mut last_error = None;
    for candidate in candidates_newest_first(&host.candidates) {
        match forward_events_candidate(candidate, host, app, cancel).await {
            Ok(()) => return Ok(()),
            Err(err) => last_error = Some(err),
        }
    }
    Err(last_error.unwrap_or_else(|| "remote host has no connection candidates".to_string()))
}

async fn forward_events_candidate(
    candidate: &str,
    host: &PairedHostRecord,
    app: &tauri::AppHandle,
    cancel: &Arc<Notify>,
) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let connector = if host.fingerprint.is_empty() {
        None
    } else {
        Some(tokio_tungstenite::Connector::Rustls(pinned_client_config(
            host.fingerprint.clone(),
        )))
    };
    let url = ws_url(candidate, &host.fingerprint);
    let (mut ws, _) = tokio::time::timeout(
        INVOKE_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(&url, None, false, connector),
    )
    .await
    .map_err(|_| format!("connect timeout {url}"))?
    .map_err(|e| format!("connect {url}: {e}"))?;
    ws.send(Message::Text(
        serde_json::json!({
            "t": "hello",
            "protocol": PROTOCOL_VERSION,
            "token": host.token,
            "appVersion": env!("CARGO_PKG_VERSION"),
        })
        .to_string(),
    ))
    .await
    .map_err(|e| format!("hello send: {e}"))?;
    wait_for_hello(&mut ws).await?;
    let topics = TAPPED_TOPICS
        .iter()
        .copied()
        .filter(|topic| *topic != "host-discovered" && *topic != "host-removed")
        .collect::<Vec<_>>();
    ws.send(Message::Text(
        serde_json::json!({
            "t": "sub",
            "topics": topics,
        })
        .to_string(),
    ))
    .await
    .map_err(|e| format!("subscribe send: {e}"))?;
    let _ = app.emit(
        "remote-host-status-changed",
        serde_json::json!({ "id": host.id, "connected": true }),
    );
    loop {
        tokio::select! {
            _ = cancel.notified() => return Err("cancelled".to_string()),
            msg = ws.next() => {
                let msg = msg
                    .ok_or("socket closed")?
                    .map_err(|e| format!("event read: {e}"))?;
                let Message::Text(text) = msg else {
                    continue;
                };
                forward_event_text(&host.id, app, &text)?;
            }
        }
    }
}

fn forward_event_text(host_id: &str, app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(text).map_err(|e| format!("bad event: {e}"))?;
    match parsed.get("t").and_then(Value::as_str) {
        Some("event") => {
            let topic = parsed
                .get("topic")
                .and_then(Value::as_str)
                .ok_or("event missing topic")?;
            let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);
            let _ = app.emit(
                "remote-host-event",
                serde_json::json!({
                    "hostId": host_id,
                    "topic": topic,
                    "payload": payload,
                }),
            );
            Ok(())
        }
        Some("bye") => Err(format!(
            "remote closed: {}",
            parsed
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        )),
        _ => Ok(()),
    }
}

async fn invoke_candidate(
    candidate: &str,
    fingerprint: &str,
    token: &str,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let connector = if fingerprint.is_empty() {
        None
    } else {
        Some(tokio_tungstenite::Connector::Rustls(pinned_client_config(
            fingerprint.to_string(),
        )))
    };
    let url = ws_url(candidate, fingerprint);
    let (mut ws, _) = tokio::time::timeout(
        INVOKE_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(&url, None, false, connector),
    )
    .await
    .map_err(|_| format!("connect timeout {url}"))?
    .map_err(|e| format!("connect {url}: {e}"))?;
    ws.send(Message::Text(
        serde_json::json!({
            "t": "hello",
            "protocol": PROTOCOL_VERSION,
            "token": token,
            "appVersion": env!("CARGO_PKG_VERSION"),
        })
        .to_string(),
    ))
    .await
    .map_err(|e| format!("hello send: {e}"))?;
    wait_for_hello(&mut ws).await?;
    let id = format!("remote-{}", uuid::Uuid::new_v4().simple());
    ws.send(Message::Text(
        serde_json::json!({
            "t": "invoke",
            "id": id,
            "cmd": cmd,
            "args": args,
        })
        .to_string(),
    ))
    .await
    .map_err(|e| format!("invoke send: {e}"))?;
    wait_for_result(&mut ws, &id).await
}

async fn wait_for_hello<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let msg = tokio::time::timeout(INVOKE_TIMEOUT, ws.next())
            .await
            .map_err(|_| "hello timeout".to_string())?
            .ok_or("socket closed during hello")?
            .map_err(|e| format!("hello read: {e}"))?;
        let Message::Text(text) = msg else {
            continue;
        };
        let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("bad hello: {e}"))?;
        match parsed.get("t").and_then(Value::as_str) {
            Some("hello_ok") => return Ok(()),
            Some("bye") => {
                return Err(format!(
                    "remote rejected: {}",
                    parsed
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ));
            }
            _ => {}
        }
    }
}

async fn wait_for_result<S>(
    ws: &mut tokio_tungstenite::WebSocketStream<S>,
    id: &str,
) -> Result<Value, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let msg = tokio::time::timeout(INVOKE_TIMEOUT, ws.next())
            .await
            .map_err(|_| "invoke timeout".to_string())?
            .ok_or("socket closed during invoke")?
            .map_err(|e| format!("invoke read: {e}"))?;
        let Message::Text(text) = msg else {
            continue;
        };
        let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("bad result: {e}"))?;
        if parsed.get("t").and_then(Value::as_str) != Some("result") {
            continue;
        }
        if parsed.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(parsed.get("data").cloned().unwrap_or(Value::Null));
        }
        return Err(parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("remote invoke failed")
            .to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn urls_normalize_candidates() {
        assert_eq!(
            ws_url("bender.local:123", "fp"),
            "wss://bender.local:123/ws"
        );
        assert_eq!(
            ws_url("ws://bender.local:123/ws", ""),
            "ws://bender.local:123/ws"
        );
        assert_eq!(http_host("wss://bender.local:123/ws"), "bender.local:123");
    }

    #[test]
    fn pair_candidates_normalize_and_dedupe() {
        assert_eq!(
            normalize_pair_candidates(&[
                "wss://bender.local:123/ws".into(),
                "bender.local:123".into(),
                "192.168.1.44:123".into(),
                "  ".into(),
            ]),
            vec!["bender.local:123", "192.168.1.44:123"]
        );
    }

    #[test]
    fn remote_candidates_prefer_newest_addresses() {
        let candidates = vec![
            "bender.local:1111".to_string(),
            "192.168.1.44:1111".to_string(),
            "bender.local:2222".to_string(),
        ];
        assert_eq!(
            candidates_newest_first(&candidates)
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                "bender.local:2222".to_string(),
                "192.168.1.44:1111".to_string(),
                "bender.local:1111".to_string(),
            ]
        );
    }

    #[test]
    fn parses_basic_http_response() {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}";
        let (status, body) = parse_http_response(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, b"{}");
    }

    #[tokio::test]
    async fn pair_desktop_tries_next_candidate_after_connect_failure() {
        let bad = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bad_addr = bad.local_addr().unwrap();
        drop(bad);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let good_addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0_u8; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]);
            assert!(request.starts_with("POST /pair HTTP/1.1"));
            assert!(request.contains(r#""code":"12345678""#));
            let body = serde_json::json!({
                "deviceToken": "remote-token",
                "host": {
                    "id": "local:remote",
                    "hostname": "remote.local",
                    "displayName": "remote",
                    "fingerprint": "remote-fingerprint"
                }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let local = HostInfo {
            id: "local:test".into(),
            hostname: "local.test".into(),
            display_name: "local".into(),
            fingerprint: "local-fingerprint".into(),
        };
        let (token, host) = pair_desktop(
            &[bad_addr.to_string(), good_addr.to_string()],
            "",
            "12345678",
            "local",
            &local,
            "reciprocal-token",
            vec!["local.test:1234".into()],
        )
        .await
        .unwrap();

        server.await.unwrap();
        assert_eq!(token, "remote-token");
        assert_eq!(host.id, "local:remote");
    }
}
