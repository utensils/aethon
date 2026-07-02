//! Fully-local cascade providers — the offline path through the SAME
//! conversation engine the cloud cascade uses.
//!
//! - `LocalWhisperConnector`: streaming `SttStream` built from components
//!   already in the tree — a Rust port of the frontend's amplitude VAD
//!   (hysteresis + silence hang) segments utterances, and each utterance is
//!   decoded by the existing candle Distil-Whisper transcriber off the driver
//!   thread. No semantic turn detection and no interim transcripts, but the
//!   engine, brain, and playback pipeline are identical to the cloud path.
//! - `Lfm2TtsConnector`: `TtsStream` over the existing one-shot LFM2 runner.
//!   Text buffers until `flush()` (LFM2 can't stream), then the whole reply
//!   synthesizes in one subprocess call.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use super::stt::{SttConnector, SttEvent, SttStream};
use super::tts::{TtsConnector, TtsSession, TtsStream};
use crate::voice::audio::compute_rms;
use crate::voice::catalog::{DISTIL_CACHE_DIR, DISTIL_TRANSCRIPTION_TIMEOUT, TARGET_SAMPLE_RATE};
use crate::voice::lfm2::LFM2_TTS_SAMPLE_RATE;
use crate::voice::{CapturedAudio, Lfm2Backend, VoiceTranscriber};

pub(crate) const LOCAL_STT_PROVIDER: &str = "local-whisper";
pub(crate) const LOCAL_TTS_PROVIDER: &str = "lfm2";

// Mirror of the frontend VAD (useVoiceConversation.ts) in sample counts at
// 16 kHz: speech onset above 0.05 RMS, utterance ends after 1.1 s below 0.03.
const VAD_SPEECH_RMS: f32 = 0.05;
const VAD_SILENCE_RMS: f32 = 0.03;
const VAD_SILENCE_HANG_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 1100 / 1000;
const VAD_MAX_UTTERANCE_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 30;
/// Rolling onset buffer so the decoded utterance includes the syllables that
/// tripped the VAD (~300 ms).
const ONSET_BUFFER_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 300 / 1000;

pub(crate) struct LocalWhisperConnector {
    cache_path: PathBuf,
    transcriber: Arc<dyn VoiceTranscriber>,
}

impl LocalWhisperConnector {
    pub(crate) fn from_registry(registry: &crate::voice::VoiceProviderRegistry) -> Self {
        Self {
            cache_path: registry.model_root().join(DISTIL_CACHE_DIR),
            transcriber: registry.whisper_transcriber(),
        }
    }

    pub(crate) fn ready(registry: &crate::voice::VoiceProviderRegistry) -> bool {
        crate::voice::distil_model_ready(&registry.model_root().join(DISTIL_CACHE_DIR))
    }
}

#[async_trait]
impl SttConnector for LocalWhisperConnector {
    async fn connect(
        &self,
    ) -> Result<(Box<dyn SttStream>, mpsc::UnboundedReceiver<SttEvent>), String> {
        if !crate::voice::distil_model_ready(&self.cache_path) {
            return Err(
                "The local Whisper model isn't downloaded — set it up in Settings → Voice"
                    .to_string(),
            );
        }
        let (tx, rx) = mpsc::unbounded_channel();
        Ok((
            Box::new(LocalWhisperStt {
                events: tx,
                cache_path: self.cache_path.clone(),
                transcriber: Arc::clone(&self.transcriber),
                onset: Vec::new(),
                utterance: Vec::new(),
                in_speech: false,
                silence_samples: 0,
                cancels: Arc::new(Mutex::new(Vec::new())),
            }),
            rx,
        ))
    }
}

/// Test seam: a stream with an injected transcriber and no on-disk model
/// requirement.
#[cfg(test)]
pub(super) fn test_local_stt(
    transcriber: Arc<dyn VoiceTranscriber>,
) -> (Box<dyn SttStream>, mpsc::UnboundedReceiver<SttEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        Box::new(LocalWhisperStt {
            events: tx,
            cache_path: PathBuf::from("/nonexistent"),
            transcriber,
            onset: Vec::new(),
            utterance: Vec::new(),
            in_speech: false,
            silence_samples: 0,
            cancels: Arc::new(Mutex::new(Vec::new())),
        }),
        rx,
    )
}

/// Test seam: an LFM2 TTS stream with an injected backend.
#[cfg(test)]
pub(super) fn test_lfm2_tts(lfm2: Arc<dyn Lfm2Backend>) -> TtsSession {
    let (tx, rx) = mpsc::unbounded_channel();
    TtsSession {
        stream: Box::new(Lfm2Tts {
            lfm2,
            buffer: String::new(),
            audio_tx: Some(tx),
            cancel: Arc::new(AtomicBool::new(false)),
        }),
        audio_rx: rx,
        sample_rate: LFM2_TTS_SAMPLE_RATE,
    }
}

struct LocalWhisperStt {
    events: mpsc::UnboundedSender<SttEvent>,
    cache_path: PathBuf,
    transcriber: Arc<dyn VoiceTranscriber>,
    onset: Vec<f32>,
    utterance: Vec<f32>,
    in_speech: bool,
    silence_samples: usize,
    /// Cancel flags for in-flight decodes, flipped on close().
    cancels: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}

impl LocalWhisperStt {
    fn finalize_utterance(&mut self) {
        self.in_speech = false;
        self.silence_samples = 0;
        let samples = std::mem::take(&mut self.utterance);
        // Anything below ~200 ms is a click, not speech.
        if samples.len() < TARGET_SAMPLE_RATE as usize / 5 {
            let _ = self.events.send(SttEvent::EndOfTurn {
                transcript: String::new(),
            });
            return;
        }
        let events = self.events.clone();
        let transcriber = Arc::clone(&self.transcriber);
        let cache_path = self.cache_path.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels.lock().push(Arc::clone(&cancel));
        // Decode off the driver thread; the conversation keeps listening
        // while the previous utterance transcribes.
        tokio::spawn(async move {
            let decode = tokio::task::spawn_blocking(move || {
                transcriber.transcribe(
                    &cache_path,
                    CapturedAudio {
                        samples,
                        sample_rate: TARGET_SAMPLE_RATE,
                    },
                    &cancel,
                )
            });
            let outcome = tokio::time::timeout(DISTIL_TRANSCRIPTION_TIMEOUT, decode).await;
            let event = match outcome {
                Err(_) => SttEvent::Error("local transcription timed out".to_string()),
                Ok(Err(join_err)) => {
                    SttEvent::Error(format!("local transcription failed: {join_err}"))
                }
                Ok(Ok(Err(decode_err))) => SttEvent::Error(decode_err),
                Ok(Ok(Ok(transcript))) => SttEvent::EndOfTurn { transcript },
            };
            let _ = events.send(event);
        });
    }
}

#[async_trait]
impl SttStream for LocalWhisperStt {
    async fn send_audio(&mut self, pcm_16k: &[f32]) -> Result<(), String> {
        let rms = compute_rms(pcm_16k);
        if !self.in_speech {
            self.onset.extend_from_slice(pcm_16k);
            let overflow = self.onset.len().saturating_sub(ONSET_BUFFER_SAMPLES);
            if overflow > 0 {
                self.onset.drain(..overflow);
            }
            if rms >= VAD_SPEECH_RMS {
                self.in_speech = true;
                self.silence_samples = 0;
                self.utterance = std::mem::take(&mut self.onset);
                let _ = self.events.send(SttEvent::StartOfTurn {
                    transcript: String::new(),
                });
            }
            return Ok(());
        }

        self.utterance.extend_from_slice(pcm_16k);
        if rms < VAD_SILENCE_RMS {
            self.silence_samples += pcm_16k.len();
        } else {
            self.silence_samples = 0;
        }
        if self.silence_samples >= VAD_SILENCE_HANG_SAMPLES
            || self.utterance.len() >= VAD_MAX_UTTERANCE_SAMPLES
        {
            self.finalize_utterance();
        }
        Ok(())
    }

    async fn keepalive(&mut self) {}

    async fn finalize_turn(&mut self) {
        if self.in_speech {
            self.finalize_utterance();
        }
    }

    async fn close(&mut self) {
        for cancel in self.cancels.lock().drain(..) {
            cancel.store(true, Ordering::SeqCst);
        }
    }
}

pub(crate) struct Lfm2TtsConnector {
    lfm2: Arc<dyn Lfm2Backend>,
    model_root: PathBuf,
}

impl Lfm2TtsConnector {
    pub(crate) fn from_registry(registry: &crate::voice::VoiceProviderRegistry) -> Self {
        Self {
            lfm2: registry.lfm2_backend(),
            model_root: registry.model_root().to_path_buf(),
        }
    }

    pub(crate) fn ready(registry: &crate::voice::VoiceProviderRegistry) -> bool {
        let lfm2 = registry.lfm2_backend();
        lfm2.binary_available()
            && crate::voice::lfm2_model_ready(
                &registry
                    .model_root()
                    .join(crate::voice::catalog::LFM2_CACHE_DIR),
            )
    }
}

#[async_trait]
impl TtsConnector for Lfm2TtsConnector {
    async fn connect(&self) -> Result<TtsSession, String> {
        let ready = self.lfm2.binary_available()
            && crate::voice::lfm2_model_ready(
                &self.model_root.join(crate::voice::catalog::LFM2_CACHE_DIR),
            );
        if !ready {
            return Err(
                "The LFM2-Audio model isn't ready — set it up in Settings → Voice".to_string(),
            );
        }
        let (tx, rx) = mpsc::unbounded_channel();
        Ok(TtsSession {
            stream: Box::new(Lfm2Tts {
                lfm2: Arc::clone(&self.lfm2),
                buffer: String::new(),
                audio_tx: Some(tx),
                cancel: Arc::new(AtomicBool::new(false)),
            }),
            audio_rx: rx,
            sample_rate: LFM2_TTS_SAMPLE_RATE,
        })
    }
}

struct Lfm2Tts {
    lfm2: Arc<dyn Lfm2Backend>,
    buffer: String,
    audio_tx: Option<mpsc::UnboundedSender<Vec<f32>>>,
    cancel: Arc<AtomicBool>,
}

#[async_trait]
impl TtsStream for Lfm2Tts {
    async fn feed(&mut self, text: &str) -> Result<(), String> {
        // LFM2's runner is one-shot: buffer until flush, then synthesize the
        // whole reply. The engine pipeline is unchanged — audio just arrives
        // in one late chunk instead of streaming.
        self.buffer.push_str(text);
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), String> {
        let Some(tx) = self.audio_tx.take() else {
            return Ok(());
        };
        let text = std::mem::take(&mut self.buffer);
        if text.trim().is_empty() {
            return Ok(()); // dropping tx closes the channel = synthesis done
        }
        let lfm2 = Arc::clone(&self.lfm2);
        let cancel = Arc::clone(&self.cancel);
        tokio::spawn(async move {
            match lfm2.tts(text, cancel).await {
                Ok(audio) => {
                    let _ = tx.send(audio.samples);
                }
                Err(err) => {
                    tracing::warn!(
                        target: "aethon::voice::convo",
                        error = %err,
                        "local TTS synthesis failed"
                    );
                }
            }
            // tx drops here → the engine seals the clip.
        });
        Ok(())
    }

    async fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.audio_tx = None;
    }
}
