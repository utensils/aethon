//! One-shot `POST /pair` client with the same cert pinning as the WS
//! bridge.
//!
//! WKWebView's fetch can't pin a self-signed cert, and pulling reqwest
//! into the iOS staticlib for a single endpoint is not worth its tree —
//! so this is a hand-rolled HTTP/1.1 exchange over the shared
//! [`crate::gateway::pinned_client_config`] connector. `Connection:
//! close` keeps the parse trivial: status line + header/body split, body
//! is everything until EOF (the desktop's axum always sends sized JSON
//! bodies here).
//!
//! Error contract consumed by `src/mobile/pairing.ts`:
//! - transport problems  -> `Err("net:<detail>")`
//! - HTTP non-200        -> `Err("pair:<status>:<server error message>")`

use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

const PAIR_TIMEOUT: Duration = Duration::from_secs(5);
/// A pair response is a few hundred bytes; anything past this is not
/// our server.
const MAX_RESPONSE: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairOutcome {
    pub device_id: String,
    pub device_token: String,
    pub host_display_name: String,
    pub host_fingerprint: String,
}

/// Redeem a pairing `code` against `host` ("ip-or-name:port"). Empty
/// `fingerprint` speaks plain HTTP (dev parity with
/// `[server] allow_insecure_ws`); otherwise HTTPS pinned to it.
#[tauri::command]
pub async fn gateway_pair(
    host: String,
    fingerprint: String,
    code: String,
    device_name: String,
) -> Result<PairOutcome, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let raw = tokio::time::timeout(
        PAIR_TIMEOUT,
        exchange(&host, &fingerprint, &code, &device_name),
    )
    .await
    .map_err(|_| format!("net:timed out connecting to {host}"))??;
    let (status, body) = parse_http_response(&raw).map_err(|e| format!("net:{e}"))?;
    if status != 200 {
        return Err(format!("pair:{status}:{}", error_message(&body)));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| format!("net:bad pair response: {e}"))?;
    let field = |k: &str| parsed.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let host_info = parsed.get("host").cloned().unwrap_or_default();
    let host_field = |k: &str| {
        host_info
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    Ok(PairOutcome {
        device_id: field("deviceId").ok_or("net:pair response missing deviceId")?,
        device_token: field("deviceToken").ok_or("net:pair response missing deviceToken")?,
        host_display_name: host_field("displayName"),
        host_fingerprint: host_field("fingerprint"),
    })
}

async fn exchange(
    host: &str,
    fingerprint: &str,
    code: &str,
    device_name: &str,
) -> Result<Vec<u8>, String> {
    let body = serde_json::json!({
        "code": code,
        "deviceName": device_name,
        "platform": "ios",
    })
    .to_string();
    let request = format!(
        "POST /pair HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );

    let tcp = TcpStream::connect(host)
        .await
        .map_err(|e| format!("net:connect {host}: {e}"))?;

    if fingerprint.is_empty() {
        send_and_drain(tcp, request.as_bytes()).await
    } else {
        let server_name = host
            .rsplit_once(':')
            .map(|(name, _)| name)
            .unwrap_or(host)
            .to_owned();
        let server_name = rustls::pki_types::ServerName::try_from(server_name)
            .map_err(|e| format!("net:bad host name: {e}"))?;
        let connector = tokio_rustls::TlsConnector::from(crate::gateway::pinned_client_config(
            fingerprint.to_owned(),
        ));
        let tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| format!("net:tls {host}: {e}"))?;
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
        .map_err(|e| format!("net:send: {e}"))?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("net:read: {e}"))?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > MAX_RESPONSE {
            return Err("net:response too large".into());
        }
    }
    Ok(raw)
}

/// Split a `Connection: close` HTTP/1.1 response into (status, body).
fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("malformed http response")?;
    let head = std::str::from_utf8(&raw[..sep]).map_err(|_| "non-utf8 http header")?;
    let status_line = head.lines().next().ok_or("empty http response")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("malformed status line: {status_line}"))?;
    Ok((status, raw[sep + 4..].to_vec()))
}

/// Pull the message out of the desktop's `{"error": "..."}` body,
/// falling back to the raw text.
fn error_message(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ok_response_with_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"deviceId\":1}\n";
        let (status, body) = parse_http_response(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, b"{\"deviceId\":1}\n");
    }

    #[test]
    fn parses_error_status_and_json_message() {
        let raw = b"HTTP/1.1 403 Forbidden\r\n\r\n{\"error\":\"wrong code\"}";
        let (status, body) = parse_http_response(raw).unwrap();
        assert_eq!(status, 403);
        assert_eq!(error_message(&body), "wrong code");
    }

    #[test]
    fn error_message_falls_back_to_raw_text() {
        assert_eq!(error_message(b"nope"), "nope");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_http_response(b"not http at all").is_err());
        assert!(parse_http_response(b"HTTP/1.1 abc\r\n\r\n").is_err());
    }
}
