//! Device pairing: the desktop displays an 8-digit code (and a QR
//! payload embedding it); the phone proves possession by POSTing the
//! code to `/pair` within the window and receives its durable device
//! token. Codes are single-use, expire after two minutes, lock out
//! after five failed attempts, and are compared by hash in constant
//! time. `/pair` answers 404 whenever no session is active, so outside
//! a pairing window the route is indistinguishable from absent.

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::commands::host::HostInfo;
use crate::server::remote::GatewayCtx;
use crate::server::remote::devices::constant_time_eq;
use crate::server::tls::sha256_hex;

pub const PAIRING_WINDOW: Duration = Duration::from_secs(120);
pub const PAIRING_MAX_ATTEMPTS: u8 = 5;

pub struct PairingSession {
    code_sha256: String,
    expires_at: Instant,
    attempts_left: u8,
}

/// What `remote_pairing_begin` hands the Settings UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingBegin {
    /// Plaintext code — displayed once, never stored.
    pub code: String,
    /// Wall-clock expiry for the countdown, epoch ms.
    pub expires_at: i64,
    /// JSON string the QR code encodes.
    pub qr_payload: String,
}

pub enum Redeem {
    Ok,
    /// Wrong code; attempts remain.
    BadCode,
    /// Wrong code and the session is exhausted — caller must drop it.
    LockedOut,
    Expired,
}

/// Derive an 8-digit code from UUID entropy (`Date::now`/`rand` are
/// unavailable by convention here; 2^122 bits mod 10^8 has negligible
/// bias).
fn new_code() -> String {
    let n = u128::from_le_bytes(*uuid::Uuid::new_v4().as_bytes()) % 100_000_000;
    format!("{n:08}")
}

/// A 256-bit device token from two UUIDs' entropy.
pub fn new_device_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Non-loopback addresses a phone could dial, most-useful first:
/// IPv4 (incl. Tailscale's 100.x), then the Bonjour-resolvable mDNS name.
fn candidate_hosts() -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            match iface.addr.ip() {
                std::net::IpAddr::V4(v4) if !v4.is_link_local() => hosts.push(v4.to_string()),
                _ => {}
            }
        }
    }
    if let Some(mdns) = crate::server::mdns::local_mdns_hostname() {
        hosts.push(mdns);
    }
    hosts
}

pub fn begin(display_name: &str, port: u16, fingerprint: &str) -> (PairingSession, PairingBegin) {
    let code = new_code();
    let session = PairingSession {
        code_sha256: sha256_hex(code.as_bytes()),
        expires_at: Instant::now() + PAIRING_WINDOW,
        attempts_left: PAIRING_MAX_ATTEMPTS,
    };
    let qr_payload = json!({
        "v": 1,
        "name": display_name,
        "hosts": candidate_hosts(),
        "port": port,
        "fp": fingerprint,
        "code": code,
    })
    .to_string();
    let begin = PairingBegin {
        code,
        expires_at: chrono::Utc::now().timestamp_millis() + PAIRING_WINDOW.as_millis() as i64,
        qr_payload,
    };
    (session, begin)
}

impl PairingSession {
    pub fn redeem(&mut self, code: &str) -> Redeem {
        if Instant::now() >= self.expires_at {
            return Redeem::Expired;
        }
        if constant_time_eq(&self.code_sha256, &sha256_hex(code.as_bytes())) {
            return Redeem::Ok;
        }
        self.attempts_left = self.attempts_left.saturating_sub(1);
        if self.attempts_left == 0 {
            Redeem::LockedOut
        } else {
            Redeem::BadCode
        }
    }

    #[cfg(test)]
    fn expire_now(&mut self) {
        self.expires_at = Instant::now();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub device_name: String,
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_token: String,
    pub host: HostInfo,
}

fn err_body(status: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": msg })))
}

/// `POST /pair` — the only unauthenticated mutating route on the
/// gateway. Kept deliberately boring: active-session gate, constant-time
/// code check, single-use teardown on every terminal outcome.
pub async fn pair_handler(
    State(ctx): State<GatewayCtx>,
    Json(req): Json<PairRequest>,
) -> Result<Json<PairResponse>, (StatusCode, Json<serde_json::Value>)> {
    let device_name = req.device_name.trim();
    if device_name.is_empty() {
        return Err(err_body(StatusCode::BAD_REQUEST, "deviceName required"));
    }
    let mut guard = ctx
        .remote
        .pairing
        .lock()
        .map_err(|e| err_body(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let Some(session) = guard.as_mut() else {
        return Err(err_body(StatusCode::NOT_FOUND, "pairing not active"));
    };
    match session.redeem(&req.code) {
        Redeem::Expired => {
            *guard = None;
            Err(err_body(StatusCode::GONE, "pairing window expired"))
        }
        Redeem::LockedOut => {
            *guard = None;
            Err(err_body(
                StatusCode::TOO_MANY_REQUESTS,
                "too many attempts; pairing cancelled",
            ))
        }
        Redeem::BadCode => Err(err_body(StatusCode::FORBIDDEN, "wrong code")),
        Redeem::Ok => {
            // Single-use: tear the session down before minting anything.
            *guard = None;
            drop(guard);
            let token = new_device_token();
            let platform = req.platform.as_deref().unwrap_or("unknown");
            let device = ctx
                .remote
                .devices
                .add(device_name, platform, &token)
                .map_err(|e| err_body(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
            tracing::info!(
                target: "aethon::server::remote",
                "paired device {} ({})", device.id, device.name
            );
            Ok(Json(PairResponse {
                device_id: device.id,
                device_token: token,
                host: ctx.info.clone(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::server::remote::RemoteState;

    fn test_ctx() -> GatewayCtx {
        GatewayCtx {
            info: HostInfo {
                id: "local:test".into(),
                hostname: "test.local".into(),
                display_name: "test".into(),
                fingerprint: "f".repeat(64),
            },
            remote: Arc::new(RemoteState::in_memory()),
            relay: Arc::new(crate::server::remote::relay::EchoRelay),
            device_changed: Arc::new(|_| {}),
        }
    }

    fn arm(ctx: &GatewayCtx) -> PairingBegin {
        let (session, begin) = begin("test", 4242, &"f".repeat(64));
        *ctx.remote.pairing.lock().unwrap() = Some(session);
        begin
    }

    #[test]
    fn begin_produces_wellformed_qr_payload() {
        let (_, b) = begin("halcyon", 4242, "abcd");
        assert_eq!(b.code.len(), 8);
        assert!(b.code.chars().all(|c| c.is_ascii_digit()));
        let payload: serde_json::Value = serde_json::from_str(&b.qr_payload).unwrap();
        assert_eq!(payload["v"], 1);
        assert_eq!(payload["port"], 4242);
        assert_eq!(payload["fp"], "abcd");
        assert_eq!(payload["code"], b.code);
        assert!(payload["hosts"].as_array().is_some_and(|h| !h.is_empty()));
    }

    #[tokio::test]
    async fn happy_path_mints_token_and_is_single_use() {
        let ctx = test_ctx();
        let b = arm(&ctx);
        let res = pair_handler(
            State(ctx.clone()),
            Json(PairRequest {
                code: b.code.clone(),
                device_name: "iPhone".into(),
                platform: Some("ios".into()),
            }),
        )
        .await
        .expect("pairs");
        assert!(ctx.remote.devices.verify_token(&res.device_token).is_some());
        assert_eq!(res.host.display_name, "test");

        // Session consumed — replaying the same code must 404.
        let replay = pair_handler(
            State(ctx.clone()),
            Json(PairRequest {
                code: b.code,
                device_name: "iPhone".into(),
                platform: None,
            }),
        )
        .await
        .err()
        .expect("must fail");
        assert_eq!(replay.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn wrong_code_locks_out_after_max_attempts() {
        let ctx = test_ctx();
        let b = arm(&ctx);
        for attempt in 1..=PAIRING_MAX_ATTEMPTS {
            let err = pair_handler(
                State(ctx.clone()),
                Json(PairRequest {
                    code: "00000000".into(),
                    device_name: "x".into(),
                    platform: None,
                }),
            )
            .await
            .err()
            .expect("wrong code fails");
            if attempt == PAIRING_MAX_ATTEMPTS {
                assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
            } else {
                assert_eq!(err.0, StatusCode::FORBIDDEN);
            }
        }
        // Locked out → session dropped → even the right code is dead.
        let err = pair_handler(
            State(ctx.clone()),
            Json(PairRequest {
                code: b.code,
                device_name: "x".into(),
                platform: None,
            }),
        )
        .await
        .err()
        .expect("session gone");
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        assert!(ctx.remote.devices.list().is_empty());
    }

    #[tokio::test]
    async fn expired_session_answers_gone_and_tears_down() {
        let ctx = test_ctx();
        let b = arm(&ctx);
        ctx.remote
            .pairing
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .expire_now();
        let err = pair_handler(
            State(ctx.clone()),
            Json(PairRequest {
                code: b.code,
                device_name: "x".into(),
                platform: None,
            }),
        )
        .await
        .err()
        .expect("expired");
        assert_eq!(err.0, StatusCode::GONE);
        assert!(ctx.remote.pairing.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn no_active_session_is_indistinguishable_404() {
        let ctx = test_ctx();
        let err = pair_handler(
            State(ctx),
            Json(PairRequest {
                code: "12345678".into(),
                device_name: "x".into(),
                platform: None,
            }),
        )
        .await
        .err()
        .expect("inactive");
        assert_eq!(err.0, StatusCode::NOT_FOUND);
    }
}
