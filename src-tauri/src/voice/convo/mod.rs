//! Streaming conversation engine — the "cascade" voice pipeline.
//!
//! The batch registry (`voice/registry.rs`) serves a record→stop→transcribe
//! lifecycle; a hands-free conversation is a long-lived duplex session, so it
//! gets its own subsystem instead of a fourth arm in the provider match. The
//! engine owns the realtime audio plane only: streaming microphone → cloud
//! STT (semantic turn detection) → turn events up to the frontend, and brain
//! text back down → streaming TTS → streaming playback. Cognition (the voice
//! brain) lives in the agent bridge; the frontend glues the two.
//!
//! Half-duplex by design: while synthesized speech plays, mic frames are
//! captured (for the pre-roll ring + barge-in detection) but NOT forwarded to
//! the STT socket, so the model never hears the app's own voice. A sustained
//! loud interruption stops playback and replays the last ~500 ms of mic audio
//! into the STT stream, so the recognizer sees the user's interjection from
//! its first word.

mod keys;
mod local;
mod mic;
mod stt;
#[cfg(test)]
mod tests;
mod tts;

pub(crate) use keys::resolve_cascade_keys;
pub(crate) use local::{
    LOCAL_STT_PROVIDER, LOCAL_TTS_PROVIDER, Lfm2TtsConnector, LocalWhisperConnector,
};
pub(crate) use stt::{DeepgramFluxConnector, SttConnector, SttEvent, SttStream};
pub(crate) use tts::{
    CartesiaConnector, CartesiaVoiceInfo, TtsConnector, TtsStream, list_cartesia_voices,
};

use std::collections::VecDeque;
use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::audio::compute_rms;
use super::{AudioPlayer, StreamingPlaybackHandle, VoiceLevelPayload};

/// 80 ms of 16 kHz mono — Deepgram's recommended streaming chunk size.
const OUTBOUND_FRAME_SAMPLES: usize = 1280;
/// ~500 ms of mic audio replayed into STT after a barge-in.
const PRE_ROLL_SAMPLES: usize = 8000;
/// Mic RMS that counts toward an interruption while speech is playing. Above
/// typical speaker bleed, below normal close-mic speech (see
/// `VoiceLevelPayload` docs: speech ≈ 0.05–0.3).
const BARGE_IN_RMS: f32 = 0.08;
/// How long the level must stay above `BARGE_IN_RMS` to trigger barge-in.
const BARGE_IN_SUSTAIN_MS: usize = 200;
/// Keep the STT socket alive while the mic gate is closed during playback
/// (Deepgram idles out after ~10 s without audio).
const KEEPALIVE_SECS: u64 = 5;
/// Throttle for `voice://level` re-emission (~30 Hz, matches the batch path).
const LEVEL_EMIT_MS: u64 = 33;
/// Poll cadence for "has the sealed playback clip finished draining".
const DRAIN_POLL_MS: u64 = 50;
/// Backoff schedule for reviving a dropped STT socket mid-conversation. Mic
/// frames keep queueing while a reconnect is in flight, so speech across a
/// brief network blip still reaches the recognizer (late but complete). The
/// budget resets on every completed turn.
#[cfg(not(test))]
const STT_RECONNECT_BACKOFF_MS: [u64; 3] = [250, 1_000, 3_000];
#[cfg(test)]
const STT_RECONNECT_BACKOFF_MS: [u64; 3] = [10, 10, 10];
/// How long a suspected barge-in (sustained mic energy during playback) waits
/// for the recognizer to confirm real speech. Playback pauses — not stops —
/// for the window, so a cough or door slam costs a moment of silence instead
/// of the rest of the reply. StartOfTurn inside the window kills the reply.
#[cfg(not(test))]
const BARGE_CONFIRM_MS: u64 = 1_500;
#[cfg(test)]
const BARGE_CONFIRM_MS: u64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ConvoState {
    Idle,
    Listening,
    UserSpeaking,
    AwaitingBrain,
    Speaking,
}

/// Playback abstraction so the driver is testable without an output device.
/// `AudioPlayer` is the production implementation.
pub(crate) trait PlaybackSink: Send + Sync {
    fn start_stream(
        &self,
        source_rate: u32,
        app: Option<AppHandle>,
    ) -> Result<Box<dyn StreamingPlayback>, String>;
    fn stop(&self);
}

pub(crate) trait StreamingPlayback: Send {
    fn append(&mut self, samples: &[f32]);
    fn mark_complete(&mut self);
    /// Hold the cursor (silence) without losing position.
    fn pause(&mut self);
    fn resume(&mut self);
    fn is_drained(&self) -> bool;
}

impl StreamingPlayback for StreamingPlaybackHandle {
    fn append(&mut self, samples: &[f32]) {
        StreamingPlaybackHandle::append(self, samples);
    }
    fn mark_complete(&mut self) {
        StreamingPlaybackHandle::mark_complete(self);
    }
    fn pause(&mut self) {
        StreamingPlaybackHandle::pause(self);
    }
    fn resume(&mut self) {
        StreamingPlaybackHandle::resume(self);
    }
    fn is_drained(&self) -> bool {
        StreamingPlaybackHandle::is_drained(self)
    }
}

impl PlaybackSink for AudioPlayer {
    fn start_stream(
        &self,
        source_rate: u32,
        app: Option<AppHandle>,
    ) -> Result<Box<dyn StreamingPlayback>, String> {
        AudioPlayer::start_stream(self, source_rate, app).map(|h| Box::new(h) as _)
    }
    fn stop(&self) {
        AudioPlayer::stop(self);
    }
}

enum EngineCommand {
    SpeakChunk(String),
    SpeakEnd,
    CancelSpeech,
    ForceEndTurn,
}

/// Microphone side of `start_with_io`: the frame channel plus the handle
/// keeping the capture stream alive (`None` in tests, which feed frames
/// directly).
pub(crate) struct MicInput {
    pub(crate) frames_rx: mpsc::UnboundedReceiver<Vec<f32>>,
    pub(crate) handle: Option<mic::MicHandle>,
}

/// STT side of `start_with_io`: a pre-connected stream (so start fails fast
/// on bad keys) plus the connector for mid-session reconnects.
pub(crate) struct SttInput {
    pub(crate) connector: Arc<dyn SttConnector>,
    pub(crate) stream: Box<dyn SttStream>,
    pub(crate) events: mpsc::UnboundedReceiver<SttEvent>,
}

/// Observable engine state shared with status queries and tests.
pub(crate) struct ConvoShared {
    state: Mutex<ConvoState>,
    last_turn: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
}

impl ConvoShared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ConvoState::Listening),
            last_turn: Mutex::new(None),
            last_error: Mutex::new(None),
        })
    }

    pub(crate) fn state(&self) -> ConvoState {
        *self.state.lock()
    }

    #[cfg(test)]
    pub(crate) fn last_turn(&self) -> Option<String> {
        self.last_turn.lock().clone()
    }

    pub(crate) fn last_error(&self) -> Option<String> {
        self.last_error.lock().clone()
    }
}

struct ActiveConvo {
    id: u64,
    cmd_tx: mpsc::UnboundedSender<EngineCommand>,
    shared: Arc<ConvoShared>,
    abort: tokio::task::AbortHandle,
    /// Dropping stops mic capture. `None` in tests, which feed frames directly.
    _mic: Option<mic::MicHandle>,
}

/// Tauri-managed singleton. One conversation at a time.
pub(crate) struct ConversationEngine {
    inner: Arc<Mutex<Option<ActiveConvo>>>,
    next_id: AtomicU64,
}

impl Default for ConversationEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationEngine {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            next_id: AtomicU64::new(0),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        self.inner.lock().is_some()
    }

    pub(crate) fn state(&self) -> ConvoState {
        self.inner
            .lock()
            .as_ref()
            .map(|active| active.shared.state())
            .unwrap_or(ConvoState::Idle)
    }

    pub(crate) fn last_error(&self) -> Option<String> {
        self.inner
            .lock()
            .as_ref()
            .and_then(|active| active.shared.last_error())
    }

    /// Open the microphone, connect STT, and start the driver. Fails fast if
    /// a conversation is already running or the STT connection is refused, so
    /// the IPC caller gets a real error instead of a fire-and-forget event.
    pub(crate) async fn start(
        &self,
        app: Option<AppHandle>,
        stt: Arc<dyn SttConnector>,
        tts: Arc<dyn TtsConnector>,
        playback: Arc<dyn PlaybackSink>,
    ) -> Result<(), String> {
        // Reserve the slot before any await so two concurrent starts can't
        // both pass the occupancy check.
        {
            let guard = self.inner.lock();
            if guard.is_some() {
                return Err("A voice conversation is already running".to_string());
            }
        }
        let (stt_stream, stt_rx) = stt.connect().await?;
        let (mic_handle, frames_rx) = mic::start_streaming_mic()?;
        self.start_with_io(
            app,
            SttInput {
                connector: stt,
                stream: stt_stream,
                events: stt_rx,
            },
            tts,
            playback,
            MicInput {
                frames_rx,
                handle: Some(mic_handle),
            },
        )
    }

    /// Test seam: identical to `start` after STT connect + mic open.
    pub(crate) fn start_with_io(
        &self,
        app: Option<AppHandle>,
        stt: SttInput,
        tts: Arc<dyn TtsConnector>,
        playback: Arc<dyn PlaybackSink>,
        mic: MicInput,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock();
        if guard.is_some() {
            return Err("A voice conversation is already running".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let shared = ConvoShared::new();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let ctx = DriverCtx {
            app: app.clone(),
            shared: Arc::clone(&shared),
            stt: stt.stream,
            stt_connector: stt.connector,
            reconnects_used: 0,
            tts_connector: tts,
            playback,
            tts_stream: None,
            playback_handle: None,
            state: ConvoState::Listening,
            outbound: Vec::new(),
            pre_roll: VecDeque::new(),
            current_transcript: String::new(),
            barge_sustain_samples: 0,
            barge_confirm_deadline: None,
            last_level_emit: Instant::now(),
            speak_requested_at: None,
            tts_first_audio_seen: false,
        };
        let driver = tokio::spawn(run_driver(ctx, mic.frames_rx, stt.events, cmd_rx));
        let abort = driver.abort_handle();

        // Reap the slot when the driver ends on its own (STT error, mic
        // gone), so the mic handle is dropped and a new start() can succeed
        // without an explicit stop.
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let _ = driver.await;
            let mut slot = inner.lock();
            if slot.as_ref().is_some_and(|active| active.id == id) {
                *slot = None;
            }
        });

        emit_state(&app, ConvoState::Listening, None);
        *guard = Some(ActiveConvo {
            id,
            cmd_tx,
            shared,
            abort,
            _mic: mic.handle,
        });
        Ok(())
    }

    pub(crate) fn stop(&self, app: Option<&AppHandle>) {
        if let Some(active) = self.inner.lock().take() {
            active.abort.abort();
        }
        if let Some(app) = app {
            emit_state(&Some(app.clone()), ConvoState::Idle, None);
        }
    }

    pub(crate) fn speak_chunk(&self, text: String) -> Result<(), String> {
        self.send_command(EngineCommand::SpeakChunk(text))
    }

    pub(crate) fn speak_end(&self) -> Result<(), String> {
        self.send_command(EngineCommand::SpeakEnd)
    }

    pub(crate) fn cancel_speech(&self) -> Result<(), String> {
        self.send_command(EngineCommand::CancelSpeech)
    }

    pub(crate) fn force_end_turn(&self) -> Result<(), String> {
        self.send_command(EngineCommand::ForceEndTurn)
    }

    fn send_command(&self, command: EngineCommand) -> Result<(), String> {
        let guard = self.inner.lock();
        let active = guard
            .as_ref()
            .ok_or_else(|| "No voice conversation is running".to_string())?;
        active
            .cmd_tx
            .send(command)
            .map_err(|_| "The voice conversation has ended".to_string())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConvoStateEvent {
    state: ConvoState,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConvoTextEvent {
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConvoTurnEvent {
    transcript: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConvoErrorEvent {
    message: String,
}

#[cfg(debug_assertions)]
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConvoMetricEvent {
    stage: &'static str,
    ms: u64,
}

fn emit_state(app: &Option<AppHandle>, state: ConvoState, reason: Option<&'static str>) {
    if let Some(app) = app {
        let _ = app.emit("voice://convo/state", ConvoStateEvent { state, reason });
    }
}

/// Everything the driver mutates outside of the four `select!` receivers.
/// The receivers stay as locals in `run_driver` so the select arms can borrow
/// them while handler methods borrow the context.
struct DriverCtx {
    app: Option<AppHandle>,
    shared: Arc<ConvoShared>,
    stt: Box<dyn SttStream>,
    stt_connector: Arc<dyn SttConnector>,
    /// Consecutive STT reconnects since the last completed turn.
    reconnects_used: usize,
    tts_connector: Arc<dyn TtsConnector>,
    playback: Arc<dyn PlaybackSink>,
    tts_stream: Option<Box<dyn TtsStream>>,
    playback_handle: Option<Box<dyn StreamingPlayback>>,
    state: ConvoState,
    outbound: Vec<f32>,
    pre_roll: VecDeque<f32>,
    current_transcript: String,
    barge_sustain_samples: usize,
    /// Set while a suspected barge-in awaits recognizer confirmation;
    /// playback is paused and the mic gate is open until the deadline.
    barge_confirm_deadline: Option<Instant>,
    last_level_emit: Instant,
    speak_requested_at: Option<Instant>,
    tts_first_audio_seen: bool,
}

/// Outcome of one driver step. `Reconnect` means the STT transport dropped
/// but the conversation can survive if a fresh socket comes up.
enum Step {
    Continue,
    Reconnect(String),
}

impl DriverCtx {
    /// Revive the STT socket after a drop. Consumes one backoff slot per
    /// attempt; the budget refills when a turn completes, so a flaky network
    /// gets three tries per utterance rather than three for the whole
    /// conversation.
    async fn try_reconnect(&mut self, cause: &str) -> Option<mpsc::UnboundedReceiver<SttEvent>> {
        while self.reconnects_used < STT_RECONNECT_BACKOFF_MS.len() {
            let delay = STT_RECONNECT_BACKOFF_MS[self.reconnects_used];
            self.reconnects_used += 1;
            tracing::warn!(
                target: "aethon::voice::convo",
                cause,
                attempt = self.reconnects_used,
                delay_ms = delay,
                "reconnecting speech socket"
            );
            tokio::time::sleep(Duration::from_millis(delay)).await;
            match self.stt_connector.connect().await {
                Ok((stream, rx)) => {
                    let mut old = std::mem::replace(&mut self.stt, stream);
                    old.close().await;
                    return Some(rx);
                }
                Err(err) => {
                    tracing::warn!(
                        target: "aethon::voice::convo",
                        error = %err,
                        "speech reconnect attempt failed"
                    );
                }
            }
        }
        None
    }

    fn set_state(&mut self, state: ConvoState, reason: Option<&'static str>) {
        if self.state == state {
            return;
        }
        self.state = state;
        *self.shared.state.lock() = state;
        emit_state(&self.app, state, reason);
    }

    fn fail(&mut self, message: String) {
        tracing::warn!(target: "aethon::voice::convo", message = %message, "conversation error");
        *self.shared.last_error.lock() = Some(message.clone());
        if let Some(app) = &self.app {
            let _ = app.emit("voice://convo/error", ConvoErrorEvent { message });
        }
    }

    fn emit_level(&mut self, frame: &[f32]) {
        if self.last_level_emit.elapsed() < Duration::from_millis(LEVEL_EMIT_MS) {
            return;
        }
        self.last_level_emit = Instant::now();
        if let Some(app) = &self.app {
            let _ = app.emit(
                "voice://level",
                VoiceLevelPayload {
                    level: compute_rms(frame),
                },
            );
        }
    }

    fn push_pre_roll(&mut self, frame: &[f32]) {
        self.pre_roll.extend(frame.iter().copied());
        while self.pre_roll.len() > PRE_ROLL_SAMPLES {
            self.pre_roll.pop_front();
        }
    }

    async fn forward_outbound(&mut self) -> Result<(), String> {
        while self.outbound.len() >= OUTBOUND_FRAME_SAMPLES {
            let chunk: Vec<f32> = self.outbound.drain(..OUTBOUND_FRAME_SAMPLES).collect();
            self.stt.send_audio(&chunk).await?;
        }
        Ok(())
    }

    /// One mic frame (mono f32 @ 16 kHz). Gate open → forward to STT; gate
    /// closed (speaking) → barge-in detection only.
    async fn handle_frame(&mut self, frame: Vec<f32>) -> Step {
        self.emit_level(&frame);
        self.push_pre_roll(&frame);

        match self.state {
            ConvoState::Listening | ConvoState::UserSpeaking | ConvoState::AwaitingBrain => {
                self.outbound.extend_from_slice(&frame);
                if let Err(err) = self.forward_outbound().await {
                    return Step::Reconnect(format!("audio send failed: {err}"));
                }
            }
            ConvoState::Speaking => {
                if let Some(deadline) = self.barge_confirm_deadline {
                    // Confirm window: playback is paused and the gate is
                    // open — forward audio so the recognizer can rule on
                    // whether this is real speech.
                    self.outbound.extend_from_slice(&frame);
                    if let Err(err) = self.forward_outbound().await {
                        return Step::Reconnect(format!("audio send failed: {err}"));
                    }
                    if Instant::now() >= deadline {
                        self.resume_after_false_barge();
                    }
                    return Step::Continue;
                }
                let sustain_target =
                    BARGE_IN_SUSTAIN_MS * super::TARGET_SAMPLE_RATE as usize / 1000;
                if compute_rms(&frame) >= BARGE_IN_RMS {
                    self.barge_sustain_samples += frame.len();
                } else {
                    self.barge_sustain_samples = 0;
                }
                if self.barge_sustain_samples >= sustain_target {
                    self.barge_sustain_samples = 0;
                    if let Err(err) = self.begin_barge_confirm().await {
                        return Step::Reconnect(format!("barge-in replay failed: {err}"));
                    }
                }
            }
            ConvoState::Idle => {}
        }
        Step::Continue
    }

    /// Sustained mic energy during playback: PAUSE (don't kill) the reply,
    /// replay the pre-roll ring into STT so the recognizer hears the
    /// interruption from its first word, and open the gate. A StartOfTurn
    /// inside the window confirms the barge-in; silence resumes playback.
    async fn begin_barge_confirm(&mut self) -> Result<(), String> {
        if let Some(handle) = self.playback_handle.as_mut() {
            handle.pause();
        }
        let replay: Vec<f32> = self.pre_roll.drain(..).collect();
        if !replay.is_empty() {
            self.stt.send_audio(&replay).await?;
        }
        self.barge_confirm_deadline =
            Some(Instant::now() + Duration::from_millis(BARGE_CONFIRM_MS));
        Ok(())
    }

    /// The recognizer confirmed real speech during playback: now cut the
    /// audio and kill the in-flight TTS context.
    async fn confirm_barge_in(
        &mut self,
        tts_audio_rx: &mut Option<mpsc::UnboundedReceiver<Vec<f32>>>,
    ) {
        self.barge_confirm_deadline = None;
        self.playback.stop();
        self.playback_handle = None;
        *tts_audio_rx = None;
        if let Some(mut stream) = self.tts_stream.take() {
            stream.stop().await;
        }
        self.set_state(ConvoState::Listening, Some("barge-in"));
    }

    /// Confirm window elapsed without recognized speech — a cough, not a
    /// command. Resume the reply where it paused and close the gate.
    fn resume_after_false_barge(&mut self) {
        self.barge_confirm_deadline = None;
        self.barge_sustain_samples = 0;
        if let Some(handle) = self.playback_handle.as_mut() {
            handle.resume();
        }
    }

    async fn handle_stt_event(
        &mut self,
        event: SttEvent,
        tts_audio_rx: &mut Option<mpsc::UnboundedReceiver<Vec<f32>>>,
    ) -> Step {
        let confirming =
            self.state == ConvoState::Speaking && self.barge_confirm_deadline.is_some();
        match event {
            SttEvent::StartOfTurn { transcript } => {
                if confirming {
                    // Real speech over the reply — the barge-in is confirmed.
                    self.confirm_barge_in(tts_audio_rx).await;
                }
                self.current_transcript = transcript.clone();
                if matches!(
                    self.state,
                    ConvoState::Listening | ConvoState::AwaitingBrain
                ) {
                    self.set_state(ConvoState::UserSpeaking, None);
                }
                self.emit_interim(transcript);
            }
            SttEvent::Interim { transcript } => {
                self.current_transcript = transcript.clone();
                self.emit_interim(transcript);
            }
            SttEvent::EndOfTurn { transcript } => {
                if confirming {
                    // A complete short command landed inside the confirm
                    // window ("stop", "wait") — kill the reply AND take the
                    // turn.
                    self.confirm_barge_in(tts_audio_rx).await;
                }
                // Stale end-of-turns can arrive after a local force-end or
                // while speech is already playing; the state guard drops them.
                if matches!(
                    self.state,
                    ConvoState::Listening | ConvoState::UserSpeaking | ConvoState::AwaitingBrain
                ) {
                    self.finish_turn(transcript);
                }
            }
            SttEvent::Error(message) => {
                return Step::Reconnect(format!("speech recognition error: {message}"));
            }
            SttEvent::Closed => {
                return Step::Reconnect("the speech service closed the connection".to_string());
            }
        }
        Step::Continue
    }

    fn emit_interim(&self, text: String) {
        if let Some(app) = &self.app {
            let _ = app.emit("voice://convo/interim", ConvoTextEvent { text });
        }
    }

    fn finish_turn(&mut self, transcript: String) {
        let transcript = transcript.trim().to_string();
        self.current_transcript.clear();
        if transcript.is_empty() {
            self.set_state(ConvoState::Listening, None);
            return;
        }
        *self.shared.last_turn.lock() = Some(transcript.clone());
        // A completed turn proves the transport healthy — refill the
        // reconnect budget.
        self.reconnects_used = 0;
        self.set_state(ConvoState::AwaitingBrain, None);
        if let Some(app) = &self.app {
            let _ = app.emit("voice://convo/turn", ConvoTurnEvent { transcript });
        }
    }

    async fn handle_command(
        &mut self,
        command: EngineCommand,
        tts_audio_rx: &mut Option<mpsc::UnboundedReceiver<Vec<f32>>>,
    ) -> ControlFlow<()> {
        match command {
            EngineCommand::SpeakChunk(text) => {
                if self.tts_stream.is_none() {
                    self.speak_requested_at = Some(Instant::now());
                    self.tts_first_audio_seen = false;
                    let session = match self.tts_connector.connect().await {
                        Ok(session) => session,
                        Err(err) => {
                            self.fail(format!("Speech synthesis unavailable: {err}"));
                            self.set_state(ConvoState::Listening, None);
                            return ControlFlow::Continue(());
                        }
                    };
                    let handle = match self
                        .playback
                        .start_stream(session.sample_rate, self.app.clone())
                    {
                        Ok(handle) => handle,
                        Err(err) => {
                            self.fail(format!("Audio output unavailable: {err}"));
                            self.set_state(ConvoState::Listening, None);
                            return ControlFlow::Continue(());
                        }
                    };
                    self.playback_handle = Some(handle);
                    self.tts_stream = Some(session.stream);
                    *tts_audio_rx = Some(session.audio_rx);
                    self.set_state(ConvoState::Speaking, None);
                }
                if let Some(stream) = self.tts_stream.as_mut()
                    && let Err(err) = stream.feed(&text).await
                {
                    self.fail(format!("Speech synthesis failed: {err}"));
                    self.abandon_speech(tts_audio_rx).await;
                }
            }
            EngineCommand::SpeakEnd => {
                if let Some(stream) = self.tts_stream.as_mut() {
                    if let Err(err) = stream.flush().await {
                        self.fail(format!("Speech synthesis failed: {err}"));
                        self.abandon_speech(tts_audio_rx).await;
                    }
                } else if self.state == ConvoState::AwaitingBrain {
                    // The brain produced no speakable text; go back to
                    // listening so the loop doesn't wedge.
                    self.set_state(ConvoState::Listening, None);
                }
            }
            EngineCommand::CancelSpeech => {
                self.abandon_speech(tts_audio_rx).await;
            }
            EngineCommand::ForceEndTurn => {
                if matches!(self.state, ConvoState::Listening | ConvoState::UserSpeaking) {
                    if self.current_transcript.trim().is_empty() {
                        // No interim text to promote (local providers don't
                        // stream interims) — ask the recognizer to end its
                        // in-progress utterance instead.
                        self.stt.finalize_turn().await;
                    } else {
                        let transcript = std::mem::take(&mut self.current_transcript);
                        self.finish_turn(transcript);
                    }
                }
            }
        }
        ControlFlow::Continue(())
    }

    async fn abandon_speech(
        &mut self,
        tts_audio_rx: &mut Option<mpsc::UnboundedReceiver<Vec<f32>>>,
    ) {
        self.barge_confirm_deadline = None;
        self.playback.stop();
        self.playback_handle = None;
        *tts_audio_rx = None;
        if let Some(mut stream) = self.tts_stream.take() {
            stream.stop().await;
        }
        if matches!(self.state, ConvoState::Speaking | ConvoState::AwaitingBrain) {
            self.set_state(ConvoState::Listening, None);
        }
    }

    fn handle_tts_audio(&mut self, samples: Vec<f32>) {
        #[cfg(debug_assertions)]
        if !self.tts_first_audio_seen
            && let Some(requested) = self.speak_requested_at
            && let Some(app) = &self.app
        {
            let _ = app.emit(
                "voice://convo/metrics",
                ConvoMetricEvent {
                    stage: "tts-first-audio",
                    ms: requested.elapsed().as_millis() as u64,
                },
            );
        }
        self.tts_first_audio_seen = true;
        if let Some(handle) = self.playback_handle.as_mut() {
            handle.append(&samples);
        }
    }

    /// Synthesis is complete; the clip is sealed and drains on its own.
    fn handle_tts_done(&mut self) {
        if let Some(handle) = self.playback_handle.as_mut() {
            handle.mark_complete();
        }
        self.tts_stream = None;
    }

    /// The sealed clip finished draining through the device.
    fn finish_speaking(&mut self) {
        self.playback_handle = None;
        self.barge_sustain_samples = 0;
        self.barge_confirm_deadline = None;
        self.set_state(ConvoState::Listening, None);
    }
}

async fn recv_or_pending(rx: &mut Option<mpsc::UnboundedReceiver<Vec<f32>>>) -> Option<Vec<f32>> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

async fn run_driver(
    mut ctx: DriverCtx,
    mut frames_rx: mpsc::UnboundedReceiver<Vec<f32>>,
    mut stt_rx: mpsc::UnboundedReceiver<SttEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<EngineCommand>,
) {
    let mut tts_audio_rx: Option<mpsc::UnboundedReceiver<Vec<f32>>> = None;
    let mut keepalive = tokio::time::interval(Duration::from_secs(KEEPALIVE_SECS));
    let mut drain_poll = tokio::time::interval(Duration::from_millis(DRAIN_POLL_MS));

    loop {
        let step = tokio::select! {
            maybe_frame = frames_rx.recv() => {
                match maybe_frame {
                    None => {
                        ctx.fail("The microphone stream ended unexpectedly".to_string());
                        break;
                    }
                    Some(frame) => ctx.handle_frame(frame).await,
                }
            }
            maybe_event = stt_rx.recv() => {
                match maybe_event {
                    None => Step::Reconnect("the speech event stream ended".to_string()),
                    Some(event) => ctx.handle_stt_event(event, &mut tts_audio_rx).await,
                }
            }
            maybe_command = cmd_rx.recv() => {
                // Channel closed = the engine slot was dropped; shut down.
                let Some(command) = maybe_command else { break };
                if ctx.handle_command(command, &mut tts_audio_rx).await.is_break() {
                    break;
                }
                Step::Continue
            }
            chunk = recv_or_pending(&mut tts_audio_rx), if tts_audio_rx.is_some() => {
                match chunk {
                    Some(samples) => ctx.handle_tts_audio(samples),
                    None => {
                        tts_audio_rx = None;
                        ctx.handle_tts_done();
                    }
                }
                Step::Continue
            }
            _ = keepalive.tick(), if ctx.state == ConvoState::Speaking => {
                ctx.stt.keepalive().await;
                Step::Continue
            }
            _ = drain_poll.tick(), if ctx.state == ConvoState::Speaking
                && tts_audio_rx.is_none()
                && ctx.tts_stream.is_none() =>
            {
                if ctx.playback_handle.as_ref().is_none_or(|h| h.is_drained()) {
                    ctx.finish_speaking();
                }
                Step::Continue
            }
        };

        match step {
            Step::Continue => {}
            Step::Reconnect(cause) => match ctx.try_reconnect(&cause).await {
                Some(new_rx) => {
                    stt_rx = new_rx;
                }
                None => {
                    ctx.fail(format!("Speech service unavailable: {cause}"));
                    break;
                }
            },
        }
    }

    // Teardown — reached on any break. The reaper task clears the engine slot
    // (dropping the mic) once this future returns.
    ctx.playback.stop();
    ctx.playback_handle = None;
    if let Some(mut stream) = ctx.tts_stream.take() {
        stream.stop().await;
    }
    ctx.stt.close().await;
    ctx.set_state(ConvoState::Idle, None);
}
