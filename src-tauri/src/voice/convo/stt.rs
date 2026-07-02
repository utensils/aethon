//! Streaming speech-to-text with semantic turn detection.
//!
//! `SttStream`/`SttConnector` abstract the transport so the engine is
//! testable with fakes; `DeepgramFluxStt` is the production implementation.
//! Flux is a conversational STT model whose turn events (StartOfTurn /
//! EndOfTurn) come from acoustic + semantic context, not silence thresholds —
//! that's what makes the conversation feel like turn-taking instead of a
//! walkie-talkie.

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::voice::catalog::TARGET_SAMPLE_RATE;

const FLUX_MODEL: &str = "flux-general-en";
/// End-of-turn confidence (Deepgram default). Raise for fewer premature
/// turn-ends, lower for snappier responses.
const EOT_THRESHOLD: &str = "0.7";
/// Silence fallback (ms) that forces EndOfTurn when confidence never clears
/// the threshold. Shorter than Deepgram's 5 s default — a hands-free UI
/// should not hang that long on a trailing "um".
const EOT_TIMEOUT_MS: &str = "3000";

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SttEvent {
    /// The recognizer heard the user start a turn (non-empty transcript).
    StartOfTurn {
        transcript: String,
    },
    /// Rolling transcript for the in-progress turn (cumulative).
    Interim {
        transcript: String,
    },
    /// The turn is complete; `transcript` is its final text.
    EndOfTurn {
        transcript: String,
    },
    Error(String),
    Closed,
}

#[async_trait]
pub(crate) trait SttStream: Send {
    /// Forward mono 16 kHz f32 samples to the recognizer.
    async fn send_audio(&mut self, pcm_16k: &[f32]) -> Result<(), String>;
    /// Keep the socket alive while no audio is being forwarded (best-effort).
    async fn keepalive(&mut self);
    /// Push-to-talk release landed before any transcript accumulated: end the
    /// in-progress utterance now if the recognizer segments locally (the
    /// engine synthesizes the turn itself when it already has interim text).
    async fn finalize_turn(&mut self) {}
    async fn close(&mut self);
}

#[async_trait]
pub(crate) trait SttConnector: Send + Sync {
    async fn connect(
        &self,
    ) -> Result<(Box<dyn SttStream>, mpsc::UnboundedReceiver<SttEvent>), String>;
}

type WsSink = futures_util::stream::SplitSink<
    WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

pub(crate) struct DeepgramFluxConnector {
    api_key: String,
}

impl DeepgramFluxConnector {
    pub(crate) fn new(api_key: String) -> Self {
        Self { api_key }
    }
}

#[async_trait]
impl SttConnector for DeepgramFluxConnector {
    async fn connect(
        &self,
    ) -> Result<(Box<dyn SttStream>, mpsc::UnboundedReceiver<SttEvent>), String> {
        let url = format!(
            "wss://api.deepgram.com/v2/listen?model={FLUX_MODEL}&encoding=linear16&sample_rate={TARGET_SAMPLE_RATE}&eot_threshold={EOT_THRESHOLD}&eot_timeout_ms={EOT_TIMEOUT_MS}"
        );
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("invalid Deepgram request: {e}"))?;
        let auth = format!("Token {}", self.api_key)
            .parse()
            .map_err(|_| "invalid Deepgram API key format".to_string())?;
        request.headers_mut().insert("Authorization", auth);

        let (socket, _response) = connect_async(request).await.map_err(friendly_ws_error)?;
        let (sink, mut read) = socket.split();
        let (tx, rx) = mpsc::unbounded_channel();

        let reader = tokio::spawn(async move {
            while let Some(message) = read.next().await {
                match message {
                    Ok(Message::Text(text)) => {
                        if let Some(event) = parse_flux_message(&text)
                            && tx.send(event).is_err()
                        {
                            return;
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(err) => {
                        let _ = tx.send(SttEvent::Error(err.to_string()));
                        return;
                    }
                }
            }
            let _ = tx.send(SttEvent::Closed);
        });

        Ok((
            Box::new(DeepgramFluxStt {
                sink,
                reader: Some(reader),
            }),
            rx,
        ))
    }
}

fn friendly_ws_error(err: tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match &err {
        Error::Http(response) if response.status().as_u16() == 401 => {
            "Deepgram rejected the API key".to_string()
        }
        Error::Http(response) => {
            format!("Deepgram connection failed (HTTP {})", response.status())
        }
        _ => format!("Deepgram connection failed: {err}"),
    }
}

/// Map a Flux JSON message to an engine event. Unknown/irrelevant message
/// types (Connected, etc.) return `None`.
pub(super) fn parse_flux_message(raw: &str) -> Option<SttEvent> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let message_type = value["type"].as_str().unwrap_or_default();
    if message_type.eq_ignore_ascii_case("error") {
        let description = value["description"]
            .as_str()
            .or_else(|| value["message"].as_str())
            .unwrap_or(raw);
        return Some(SttEvent::Error(description.to_string()));
    }
    if message_type != "TurnInfo" {
        return None;
    }
    let transcript = value["transcript"].as_str().unwrap_or_default().to_string();
    match value["event"].as_str().unwrap_or_default() {
        "StartOfTurn" => Some(SttEvent::StartOfTurn { transcript }),
        "Update" | "EagerEndOfTurn" | "TurnResumed" => Some(SttEvent::Interim { transcript }),
        "EndOfTurn" => Some(SttEvent::EndOfTurn { transcript }),
        _ => None,
    }
}

struct DeepgramFluxStt {
    sink: WsSink,
    reader: Option<tokio::task::JoinHandle<()>>,
}

#[async_trait]
impl SttStream for DeepgramFluxStt {
    async fn send_audio(&mut self, pcm_16k: &[f32]) -> Result<(), String> {
        let mut bytes = Vec::with_capacity(pcm_16k.len() * 2);
        for sample in pcm_16k {
            let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        self.sink
            .send(Message::Binary(bytes))
            .await
            .map_err(|e| e.to_string())
    }

    async fn keepalive(&mut self) {
        let _ = self
            .sink
            .send(Message::Text(r#"{"type":"KeepAlive"}"#.to_string()))
            .await;
    }

    async fn close(&mut self) {
        let _ = self
            .sink
            .send(Message::Text(r#"{"type":"CloseStream"}"#.to_string()))
            .await;
        let _ = self.sink.close().await;
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

impl Drop for DeepgramFluxStt {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}
