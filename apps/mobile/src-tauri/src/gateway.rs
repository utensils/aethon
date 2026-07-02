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

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::Message;

/// One outbound socket + its writer channel. Replacing it (reconnect)
/// drops the previous task, closing the old socket.
#[derive(Default)]
pub struct GatewayState {
    tx: Mutex<Option<mpsc::UnboundedSender<Message>>>,
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

    fn verify_tls12_signature(
        &self,
        _m: &[u8],
        _c: &rustls::pki_types::CertificateDer<'_>,
        _d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _m: &[u8],
        _c: &rustls::pki_types::CertificateDer<'_>,
        _d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn pinned_tls_connector(fingerprint: String) -> tokio_tungstenite::Connector {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCert { fingerprint }))
        .with_no_client_auth();
    tokio_tungstenite::Connector::Rustls(Arc::new(config))
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
    let (mut sink, mut stream) = ws.split();
    emit(&app, GatewayFrame::Open);

    let app_reader = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Text(text)) => emit(&app_reader, GatewayFrame::Message { text }),
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        emit(&app_reader, GatewayFrame::Close);
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
pub async fn gateway_send(
    state: State<'_, Arc<GatewayState>>,
    text: String,
) -> Result<(), String> {
    let guard = state.tx.lock().await;
    let tx = guard.as_ref().ok_or("gateway not connected")?;
    tx.send(Message::Text(text)).map_err(|_| "gateway closed".to_string())
}

#[tauri::command]
pub async fn gateway_close(state: State<'_, Arc<GatewayState>>) -> Result<(), String> {
    // Dropping the sender ends the writer task, which closes the socket.
    *state.tx.lock().await = None;
    Ok(())
}

pub fn register(app: &AppHandle) {
    app.manage(Arc::new(GatewayState::default()));
}
