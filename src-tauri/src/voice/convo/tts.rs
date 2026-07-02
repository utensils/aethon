//! Streaming text-to-speech.
//!
//! One `TtsSession` per spoken reply: the engine feeds clause-sized text
//! chunks as the voice brain streams them (`continue: true` input
//! continuations), then flushes. Synthesized PCM arrives on `audio_rx` while
//! generation is still running — the channel closing means the reply is fully
//! synthesized (playback may still be draining).

use async_trait::async_trait;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const CARTESIA_WS_URL: &str = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION: &str = "2025-04-16";
const CARTESIA_MODEL: &str = "sonic-3.5";
/// Cartesia's documented default voice ("Sarah"). Overridable via
/// `[voice] tts_voice`.
const DEFAULT_CARTESIA_VOICE: &str = "694f9389-aac1-45b6-b726-9d9369183238";
/// PCM rate we ask Cartesia for; playback resamples to the device rate.
pub(crate) const TTS_SAMPLE_RATE: u32 = 24_000;
/// How long Cartesia may buffer a continuation waiting for more text before
/// starting generation. The default (3 s) optimizes prosody over latency —
/// exactly backwards for a live conversation.
const MAX_BUFFER_DELAY_MS: u32 = 250;

pub(crate) struct TtsSession {
    pub(crate) stream: Box<dyn TtsStream>,
    /// Mono f32 at `sample_rate`; closes once the reply is fully synthesized.
    pub(crate) audio_rx: mpsc::UnboundedReceiver<Vec<f32>>,
    pub(crate) sample_rate: u32,
}

#[async_trait]
pub(crate) trait TtsStream: Send {
    /// Queue a text chunk for synthesis (more may follow).
    async fn feed(&mut self, text: &str) -> Result<(), String>;
    /// Signal that no more text is coming for this reply.
    async fn flush(&mut self) -> Result<(), String>;
    /// Abandon the reply (barge-in / cancel).
    async fn stop(&mut self);
}

#[async_trait]
pub(crate) trait TtsConnector: Send + Sync {
    async fn connect(&self) -> Result<TtsSession, String>;
}

type WsSink = futures_util::stream::SplitSink<
    WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

pub(crate) struct CartesiaConnector {
    api_key: String,
    voice_id: String,
}

impl CartesiaConnector {
    pub(crate) fn new(api_key: String, voice_id: Option<String>) -> Self {
        Self {
            api_key,
            voice_id: voice_id
                .filter(|id| !id.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_CARTESIA_VOICE.to_string()),
        }
    }
}

#[async_trait]
impl TtsConnector for CartesiaConnector {
    async fn connect(&self) -> Result<TtsSession, String> {
        let url = format!("{CARTESIA_WS_URL}?cartesia_version={CARTESIA_VERSION}");
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("invalid Cartesia request: {e}"))?;
        let key = self
            .api_key
            .parse()
            .map_err(|_| "invalid Cartesia API key format".to_string())?;
        request.headers_mut().insert("X-API-Key", key);

        let (socket, _response) = connect_async(request).await.map_err(friendly_ws_error)?;
        let (sink, mut read) = socket.split();
        let (tx, rx) = mpsc::unbounded_channel();

        let reader = tokio::spawn(async move {
            while let Some(message) = read.next().await {
                match message {
                    Ok(Message::Text(text)) => match parse_cartesia_message(&text) {
                        CartesiaMessage::Chunk(samples) => {
                            if tx.send(samples).is_err() {
                                return;
                            }
                        }
                        CartesiaMessage::Done => return,
                        CartesiaMessage::Error(err) => {
                            tracing::warn!(
                                target: "aethon::voice::convo",
                                error = %err,
                                "cartesia synthesis error"
                            );
                            return;
                        }
                        CartesiaMessage::Other => {}
                    },
                    Ok(Message::Close(_)) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });

        Ok(TtsSession {
            stream: Box::new(CartesiaTts {
                sink,
                reader: Some(reader),
                voice_id: self.voice_id.clone(),
                context_id: uuid::Uuid::new_v4().to_string(),
            }),
            audio_rx: rx,
            sample_rate: TTS_SAMPLE_RATE,
        })
    }
}

fn friendly_ws_error(err: tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match &err {
        Error::Http(response) if matches!(response.status().as_u16(), 401 | 403) => {
            "Cartesia rejected the API key".to_string()
        }
        Error::Http(response) => {
            format!("Cartesia connection failed (HTTP {})", response.status())
        }
        _ => format!("Cartesia connection failed: {err}"),
    }
}

pub(super) enum CartesiaMessage {
    Chunk(Vec<f32>),
    Done,
    Error(String),
    Other,
}

pub(super) fn parse_cartesia_message(raw: &str) -> CartesiaMessage {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return CartesiaMessage::Other;
    };
    match value["type"].as_str().unwrap_or_default() {
        "chunk" => {
            let Some(data) = value["data"].as_str() else {
                return CartesiaMessage::Other;
            };
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
                return CartesiaMessage::Error("undecodable audio chunk".to_string());
            };
            // Requested as raw pcm_s16le — the format every documented
            // Cartesia example uses — then widened to the engine's f32.
            let samples = bytes
                .chunks_exact(2)
                .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / f32::from(i16::MAX))
                .collect();
            CartesiaMessage::Chunk(samples)
        }
        "done" => CartesiaMessage::Done,
        "error" => CartesiaMessage::Error(
            value["message"]
                .as_str()
                .or_else(|| value["title"].as_str())
                .unwrap_or(raw)
                .to_string(),
        ),
        _ => CartesiaMessage::Other,
    }
}

struct CartesiaTts {
    sink: WsSink,
    reader: Option<tokio::task::JoinHandle<()>>,
    voice_id: String,
    context_id: String,
}

impl CartesiaTts {
    async fn send_request(&mut self, transcript: &str, more_follows: bool) -> Result<(), String> {
        let payload = serde_json::json!({
            "model_id": CARTESIA_MODEL,
            "transcript": transcript,
            "voice": { "mode": "id", "id": self.voice_id },
            "output_format": {
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": TTS_SAMPLE_RATE,
            },
            "context_id": self.context_id,
            "continue": more_follows,
            "language": "en",
            "max_buffer_delay_ms": MAX_BUFFER_DELAY_MS,
        });
        self.sink
            .send(Message::Text(payload.to_string()))
            .await
            .map_err(|e| e.to_string())
    }
}

#[async_trait]
impl TtsStream for CartesiaTts {
    async fn feed(&mut self, text: &str) -> Result<(), String> {
        self.send_request(text, true).await
    }

    async fn flush(&mut self) -> Result<(), String> {
        // The documented way to close an input continuation: a final (empty)
        // transcript with `continue: false`.
        self.send_request("", false).await
    }

    async fn stop(&mut self) {
        let _ = self.sink.close().await;
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

impl Drop for CartesiaTts {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CartesiaVoiceInfo {
    pub(crate) id: String,
    pub(crate) name: String,
}

/// Fetch the account's voice catalogue (Settings → Voice → Conversation).
/// Tolerates both response shapes Cartesia has used (bare array and
/// `{"data": [...]}`).
pub(crate) async fn list_cartesia_voices(api_key: &str) -> Result<Vec<CartesiaVoiceInfo>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://api.cartesia.ai/voices")
        .header("X-API-Key", api_key)
        .header("Cartesia-Version", CARTESIA_VERSION)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("voice list request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("voice list failed (HTTP {})", response.status()));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("voice list parse failed: {e}"))?;
    let items = value
        .as_array()
        .cloned()
        .or_else(|| value["data"].as_array().cloned())
        .unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|voice| {
            Some(CartesiaVoiceInfo {
                id: voice["id"].as_str()?.to_string(),
                name: voice["name"].as_str().unwrap_or("(unnamed)").to_string(),
            })
        })
        .take(200)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cartesia_chunk_decodes_s16le_to_f32() {
        // i16::MAX, 0, i16::MIN → 1.0, 0.0, ~-1.0 after widening.
        let pcm: Vec<u8> = [i16::MAX, 0, i16::MIN]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let data = base64::engine::general_purpose::STANDARD.encode(pcm);
        let raw = format!(r#"{{"type":"chunk","data":"{data}"}}"#);
        let CartesiaMessage::Chunk(samples) = parse_cartesia_message(&raw) else {
            panic!("expected chunk");
        };
        assert_eq!(samples.len(), 3);
        assert!((samples[0] - 1.0).abs() < 1e-6);
        assert_eq!(samples[1], 0.0);
        assert!(samples[2] < -0.999);
    }

    #[test]
    fn cartesia_error_and_done_messages_parse() {
        assert!(matches!(
            parse_cartesia_message(r#"{"type":"error","message":"bad key"}"#),
            CartesiaMessage::Error(msg) if msg == "bad key"
        ));
        assert!(matches!(
            parse_cartesia_message(r#"{"type":"done"}"#),
            CartesiaMessage::Done
        ));
        assert!(matches!(
            parse_cartesia_message("not json"),
            CartesiaMessage::Other
        ));
    }
}
