//! Native WebSocket bridge for the companion webview.
//!
//! The webview can't open a `wss://` socket to the desktop's self-signed
//! cert: WKWebView's App Transport Security blocks it and exposes no JS
//! pinning hook. So the socket lives here in Rust — `tokio-tungstenite`
//! over `tokio-rustls` with a custom verifier that pins the exact cert
//! by SHA-256 of its DER, exactly the fingerprint the desktop published
//! in its QR/pairing payload. Raw sockets are outside ATS's scope, so
//! this "just works" with the self-signed identity.
//!
//! Frames flow untouched: the JS transport hands us wire text via
//! `gateway_send`, and we relay every server frame back as a
//! `gateway-frame` Tauri event. The pinning/transport policy is the only
//! logic here — protocol semantics stay in the shared JS transport.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::Message;

/// One outbound socket + its writer channel. Replacing it (reconnect)
/// drops the previous task, closing the old socket.
///
/// `generation` stamps each connect; reader tasks from superseded
/// connections check it before emitting. Without the stamp, the old
/// socket's teardown emitted a `close` frame onto the shared
/// `gateway-frame` stream and the JS transport read it as the NEW
/// connection dying — every reconnect killed its successor, looping
/// forever.
#[derive(Default)]
pub struct GatewayState {
    tx: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    generation: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum GatewayFrame {
    Open,
    Message { text: String },
    Close,
}

fn emit(app: &AppHandle, frame: GatewayFrame) {
    let _ = app.emit("gateway-frame", frame);
}

/// Certificate verifier that accepts exactly one cert, matched by the
/// SHA-256 of its DER encoding. Everything else (chain, hostname,
/// expiry) is intentionally ignored — pinning is the whole trust model.
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

    // Delegate handshake-signature verification to ring. Pinning the DER
    // alone is NOT sufficient: the cert is public (sent in the clear
    // during the handshake), so without validating the CertificateVerify
    // signature an attacker who observed it could replay it without the
    // private key. These prove the peer holds the pinned cert's key.
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

/// Client config trusting exactly the pinned cert — shared by the WS
/// bridge here and the pair.rs HTTPS POST.
pub(crate) fn pinned_client_config(fingerprint: String) -> Arc<rustls::ClientConfig> {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCert { fingerprint }))
        .with_no_client_auth();
    Arc::new(config)
}

fn pinned_tls_connector(fingerprint: String) -> tokio_tungstenite::Connector {
    tokio_tungstenite::Connector::Rustls(pinned_client_config(fingerprint))
}

/// Open (or reopen) the socket. `fingerprint` empty → plaintext `ws://`
/// (dev only, matching `[server] allow_insecure_ws`); otherwise the
/// pinned `wss://` path.
#[tauri::command]
pub async fn gateway_connect(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
    url: String,
    fingerprint: String,
) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = Arc::clone(state.inner());
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    // Swapping the sender drops any prior writer; the old task then sees
    // its receiver close and exits, tearing down the previous socket.
    *state.tx.lock().await = Some(tx);

    let connector = if fingerprint.is_empty() {
        None
    } else {
        Some(pinned_tls_connector(fingerprint))
    };
    let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(&url, None, false, connector)
        .await
        .map_err(|e| format!("connect {url}: {e}"))?;
    // The lock isn't held across the handshake await — a newer connect
    // (or an explicit close) may have superseded this one. Dropping the
    // ws here closes the socket without emitting anything.
    if state.generation.load(Ordering::SeqCst) != generation {
        return Ok(());
    }
    let (mut sink, mut stream) = ws.split();
    emit(&app, GatewayFrame::Open);

    let app_reader = app.clone();
    let reader_state = Arc::clone(&state);
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = stream.next().await {
            if reader_state.generation.load(Ordering::SeqCst) != generation {
                // Superseded mid-stream: stop silently. Emitting (or
                // falling through to the close emit) would interleave
                // stale frames into the successor connection.
                return;
            }
            match msg {
                Ok(Message::Text(text)) => emit(&app_reader, GatewayFrame::Message { text }),
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        if reader_state.generation.load(Ordering::SeqCst) == generation {
            emit(&app_reader, GatewayFrame::Close);
        }
    });

    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    Ok(())
}

#[tauri::command]
pub async fn gateway_send(state: State<'_, Arc<GatewayState>>, text: String) -> Result<(), String> {
    let guard = state.tx.lock().await;
    let tx = guard.as_ref().ok_or("gateway not connected")?;
    tx.send(Message::Text(text))
        .map_err(|_| "gateway closed".to_string())
}

#[tauri::command]
pub async fn gateway_close(state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    // Invalidate the live reader so it exits without emitting a close
    // for a connection the JS side already abandoned.
    state.generation.fetch_add(1, Ordering::SeqCst);
    // Dropping the sender ends the writer task, which closes the socket.
    *state.tx.lock().await = None;
    Ok(())
}

pub fn register(app: &AppHandle) {
    app.manage(Arc::new(GatewayState::default()));
}
