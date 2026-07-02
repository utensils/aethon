//! Conversation-engine tests with fake STT/TTS/playback, mirroring the
//! injected-fake pattern the batch registry uses (`Lfm2Backend` fakes).
//! Frames are fed straight into the driver channel, so no microphone or
//! output device is needed.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use super::stt::parse_flux_message;
use super::tts::TtsSession;
use super::*;
use crate::voice::audio::StreamResampler;
use crate::voice::audio::resample;

// ── fakes ────────────────────────────────────────────────────────────────

struct FakeSttStream {
    sent_samples: Arc<AtomicUsize>,
    keepalives: Arc<AtomicUsize>,
}

#[async_trait]
impl SttStream for FakeSttStream {
    async fn send_audio(&mut self, pcm_16k: &[f32]) -> Result<(), String> {
        self.sent_samples.fetch_add(pcm_16k.len(), Ordering::SeqCst);
        Ok(())
    }
    async fn keepalive(&mut self) {
        self.keepalives.fetch_add(1, Ordering::SeqCst);
    }
    async fn close(&mut self) {}
}

/// Reconnectable fake: each successful connect() hands its event sender to
/// the test through `event_txs` and shares the same sample counter.
struct FakeSttConnector {
    sent_samples: Arc<AtomicUsize>,
    event_txs: Arc<Mutex<Vec<mpsc::UnboundedSender<SttEvent>>>>,
    connects: Arc<AtomicUsize>,
    /// Connect attempts that should fail before succeeding again.
    fail_next: Arc<AtomicUsize>,
}

impl FakeSttConnector {
    fn new(sent_samples: Arc<AtomicUsize>) -> Self {
        Self {
            sent_samples,
            event_txs: Arc::new(Mutex::new(Vec::new())),
            connects: Arc::new(AtomicUsize::new(0)),
            fail_next: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[async_trait]
impl SttConnector for FakeSttConnector {
    async fn connect(
        &self,
    ) -> Result<(Box<dyn SttStream>, mpsc::UnboundedReceiver<SttEvent>), String> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        if self.fail_next.load(Ordering::SeqCst) > 0 {
            self.fail_next.fetch_sub(1, Ordering::SeqCst);
            return Err("connect refused".to_string());
        }
        let (tx, rx) = mpsc::unbounded_channel();
        self.event_txs.lock().push(tx);
        Ok((
            Box::new(FakeSttStream {
                sent_samples: Arc::clone(&self.sent_samples),
                keepalives: Arc::new(AtomicUsize::new(0)),
            }),
            rx,
        ))
    }
}

struct FakeTts {
    feeds: Arc<Mutex<Vec<String>>>,
    flushed: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    audio_tx: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<f32>>>>>,
    /// Samples emitted on flush before the channel closes.
    flush_samples: usize,
}

#[async_trait]
impl TtsStream for FakeTts {
    async fn feed(&mut self, text: &str) -> Result<(), String> {
        self.feeds.lock().push(text.to_string());
        Ok(())
    }
    async fn flush(&mut self) -> Result<(), String> {
        self.flushed.store(true, Ordering::SeqCst);
        // Taking (and dropping) tx closes audio_rx = synthesis complete.
        let tx = self.audio_tx.lock().take();
        if let Some(tx) = tx
            && self.flush_samples > 0
        {
            let _ = tx.send(vec![0.25; self.flush_samples]);
        }
        Ok(())
    }
    async fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.audio_tx.lock().take();
    }
}

#[derive(Clone)]
struct FakeTtsConnector {
    feeds: Arc<Mutex<Vec<String>>>,
    flushed: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    flush_samples: usize,
}

impl FakeTtsConnector {
    fn new(flush_samples: usize) -> Self {
        Self {
            feeds: Arc::new(Mutex::new(Vec::new())),
            flushed: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            flush_samples,
        }
    }
}

#[async_trait]
impl TtsConnector for FakeTtsConnector {
    async fn connect(&self) -> Result<TtsSession, String> {
        let (tx, rx) = mpsc::unbounded_channel();
        Ok(TtsSession {
            stream: Box::new(FakeTts {
                feeds: Arc::clone(&self.feeds),
                flushed: Arc::clone(&self.flushed),
                stopped: Arc::clone(&self.stopped),
                audio_tx: Arc::new(Mutex::new(Some(tx))),
                flush_samples: self.flush_samples,
            }),
            audio_rx: rx,
            sample_rate: 24_000,
        })
    }
}

#[derive(Clone)]
struct FakePlayback {
    appended: Arc<AtomicUsize>,
    completed: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    streams_opened: Arc<AtomicUsize>,
}

impl FakePlayback {
    fn new() -> Self {
        Self {
            appended: Arc::new(AtomicUsize::new(0)),
            completed: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(false)),
            streams_opened: Arc::new(AtomicUsize::new(0)),
        }
    }
}

struct FakePlaybackStream {
    appended: Arc<AtomicUsize>,
    completed: Arc<AtomicBool>,
}

impl StreamingPlayback for FakePlaybackStream {
    fn append(&mut self, samples: &[f32]) {
        self.appended.fetch_add(samples.len(), Ordering::SeqCst);
    }
    fn mark_complete(&mut self) {
        self.completed.store(true, Ordering::SeqCst);
    }
    fn is_drained(&self) -> bool {
        // Drained as soon as sealed — playback latency isn't under test.
        self.completed.load(Ordering::SeqCst)
    }
}

impl PlaybackSink for FakePlayback {
    fn start_stream(
        &self,
        _source_rate: u32,
        _app: Option<tauri::AppHandle>,
    ) -> Result<Box<dyn StreamingPlayback>, String> {
        self.streams_opened.fetch_add(1, Ordering::SeqCst);
        self.stopped.store(false, Ordering::SeqCst);
        Ok(Box::new(FakePlaybackStream {
            appended: Arc::clone(&self.appended),
            completed: Arc::clone(&self.completed),
        }))
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

// ── harness ──────────────────────────────────────────────────────────────

struct Harness {
    engine: ConversationEngine,
    frames_tx: mpsc::UnboundedSender<Vec<f32>>,
    stt_tx: mpsc::UnboundedSender<SttEvent>,
    sent_samples: Arc<AtomicUsize>,
    stt_connector: Arc<FakeSttConnector>,
    tts: FakeTtsConnector,
    playback: FakePlayback,
}

fn start_harness(flush_samples: usize) -> Harness {
    let engine = ConversationEngine::new();
    let (frames_tx, frames_rx) = mpsc::unbounded_channel();
    let (stt_tx, stt_rx) = mpsc::unbounded_channel();
    let sent_samples = Arc::new(AtomicUsize::new(0));
    let stt_stream = Box::new(FakeSttStream {
        sent_samples: Arc::clone(&sent_samples),
        keepalives: Arc::new(AtomicUsize::new(0)),
    });
    let stt_connector = Arc::new(FakeSttConnector::new(Arc::clone(&sent_samples)));
    let tts = FakeTtsConnector::new(flush_samples);
    let playback = FakePlayback::new();
    engine
        .start_with_io(
            None,
            SttInput {
                connector: Arc::clone(&stt_connector) as Arc<dyn SttConnector>,
                stream: stt_stream,
                events: stt_rx,
            },
            Arc::new(tts.clone()),
            Arc::new(playback.clone()),
            MicInput {
                frames_rx,
                handle: None,
            },
        )
        .expect("engine should start");
    Harness {
        engine,
        frames_tx,
        stt_tx,
        sent_samples,
        stt_connector,
        tts,
        playback,
    }
}

async fn wait_for(mut condition: impl FnMut() -> bool, what: &str) {
    for _ in 0..200 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn wait_for_state(engine: &ConversationEngine, state: ConvoState) {
    wait_for(|| engine.state() == state, &format!("state {state:?}")).await;
}

fn shared(engine: &ConversationEngine) -> Arc<ConvoShared> {
    engine
        .inner
        .lock()
        .as_ref()
        .map(|active| Arc::clone(&active.shared))
        .expect("engine should be active")
}

// ── tests ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn turn_lifecycle_reaches_awaiting_brain() {
    let h = start_harness(0);
    assert_eq!(h.engine.state(), ConvoState::Listening);
    let shared = shared(&h.engine);

    h.stt_tx
        .send(SttEvent::StartOfTurn {
            transcript: "rename".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::UserSpeaking).await;

    h.stt_tx
        .send(SttEvent::Interim {
            transcript: "rename the config helper".into(),
        })
        .unwrap();
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "rename the config helper".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    assert_eq!(
        shared.last_turn().as_deref(),
        Some("rename the config helper")
    );
}

#[tokio::test]
async fn empty_end_of_turn_returns_to_listening() {
    let h = start_harness(0);
    h.stt_tx
        .send(SttEvent::StartOfTurn {
            transcript: "hm".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::UserSpeaking).await;
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "  ".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::Listening).await;
    assert_eq!(shared(&h.engine).last_turn(), None);
}

#[tokio::test]
async fn mic_frames_forward_to_stt_in_batches() {
    let h = start_harness(0);
    // 2× the outbound batch size → exactly two sends.
    for _ in 0..4 {
        h.frames_tx.send(vec![0.01; 640]).unwrap();
    }
    wait_for(
        || h.sent_samples.load(Ordering::SeqCst) >= 2 * OUTBOUND_FRAME_SAMPLES,
        "audio forwarded to STT",
    )
    .await;
}

#[tokio::test]
async fn speak_flow_feeds_tts_and_returns_to_listening() {
    let h = start_harness(240);
    let shared = shared(&h.engine);
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "status".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    assert_eq!(shared.last_turn().as_deref(), Some("status"));

    h.engine.speak_chunk("One task is running.".into()).unwrap();
    wait_for_state(&h.engine, ConvoState::Speaking).await;
    h.engine.speak_chunk(" Nearly done.".into()).unwrap();
    h.engine.speak_end().unwrap();

    // flush emits audio then closes the channel → sealed → drained →
    // back to listening.
    wait_for_state(&h.engine, ConvoState::Listening).await;
    assert!(h.tts.flushed.load(Ordering::SeqCst));
    assert_eq!(
        h.tts.feeds.lock().as_slice(),
        ["One task is running.", " Nearly done."]
    );
    assert!(h.playback.appended.load(Ordering::SeqCst) > 0);
    assert!(h.playback.completed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn speak_end_without_chunks_unwedges_awaiting_brain() {
    let h = start_harness(0);
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "hello".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    h.engine.speak_end().unwrap();
    wait_for_state(&h.engine, ConvoState::Listening).await;
}

#[tokio::test]
async fn barge_in_stops_playback_and_replays_pre_roll() {
    let h = start_harness(0);
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "explain".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    h.engine.speak_chunk("A long explanation".into()).unwrap();
    wait_for_state(&h.engine, ConvoState::Speaking).await;

    let forwarded_before = h.sent_samples.load(Ordering::SeqCst);
    // Loud frames worth >200 ms: gate is closed, so nothing forwards until
    // the barge-in replays the pre-roll ring.
    for _ in 0..6 {
        h.frames_tx.send(vec![0.5; 1024]).unwrap();
    }
    wait_for_state(&h.engine, ConvoState::Listening).await;
    assert!(h.playback.stopped.load(Ordering::SeqCst));
    assert!(h.tts.stopped.load(Ordering::SeqCst));
    assert!(
        h.sent_samples.load(Ordering::SeqCst) > forwarded_before,
        "pre-roll should replay into STT"
    );
}

#[tokio::test]
async fn quiet_audio_while_speaking_does_not_barge_in() {
    let h = start_harness(0);
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "explain".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    h.engine.speak_chunk("Text".into()).unwrap();
    wait_for_state(&h.engine, ConvoState::Speaking).await;

    let forwarded_before = h.sent_samples.load(Ordering::SeqCst);
    for _ in 0..20 {
        h.frames_tx.send(vec![0.02; 1024]).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(h.engine.state(), ConvoState::Speaking);
    assert_eq!(
        h.sent_samples.load(Ordering::SeqCst),
        forwarded_before,
        "gated frames must not reach STT"
    );
    assert!(!h.playback.stopped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn force_end_turn_uses_running_transcript_and_ignores_late_eot() {
    let h = start_harness(0);
    let shared = shared(&h.engine);
    h.stt_tx
        .send(SttEvent::StartOfTurn {
            transcript: "fix".into(),
        })
        .unwrap();
    h.stt_tx
        .send(SttEvent::Interim {
            transcript: "fix the flaky test".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::UserSpeaking).await;

    h.engine.force_end_turn().unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    assert_eq!(shared.last_turn().as_deref(), Some("fix the flaky test"));

    // Flux's own EndOfTurn for that audio arrives late — must not re-fire.
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "fix the flaky test".into(),
        })
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(h.engine.state(), ConvoState::AwaitingBrain);
}

#[tokio::test]
async fn stt_error_reconnects_and_the_conversation_survives() {
    let h = start_harness(0);
    let shared = shared(&h.engine);
    h.stt_tx.send(SttEvent::Error("blip".into())).unwrap();
    wait_for(
        || !h.stt_connector.event_txs.lock().is_empty(),
        "replacement event channel",
    )
    .await;
    // Drive a turn through the REPLACEMENT socket.
    let new_tx = h.stt_connector.event_txs.lock()[0].clone();
    new_tx
        .send(SttEvent::EndOfTurn {
            transcript: "still here".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    assert_eq!(shared.last_turn().as_deref(), Some("still here"));
    assert!(h.engine.is_active());
}

#[tokio::test]
async fn exhausted_reconnects_tear_down_and_free_the_slot() {
    let h = start_harness(0);
    // Every backoff slot fails → fatal.
    h.stt_connector.fail_next.store(16, Ordering::SeqCst);
    h.stt_tx.send(SttEvent::Error("boom".into())).unwrap();
    wait_for(|| !h.engine.is_active(), "engine slot reaped").await;
    assert_eq!(h.engine.state(), ConvoState::Idle);
}

#[tokio::test]
async fn cancel_speech_returns_to_listening() {
    let h = start_harness(0);
    h.stt_tx
        .send(SttEvent::EndOfTurn {
            transcript: "talk".into(),
        })
        .unwrap();
    wait_for_state(&h.engine, ConvoState::AwaitingBrain).await;
    h.engine.speak_chunk("Blah".into()).unwrap();
    wait_for_state(&h.engine, ConvoState::Speaking).await;
    h.engine.cancel_speech().unwrap();
    wait_for_state(&h.engine, ConvoState::Listening).await;
    assert!(h.playback.stopped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn second_start_is_rejected_while_active() {
    let h = start_harness(0);
    let (_tx, frames_rx) = mpsc::unbounded_channel();
    let (_stt_tx, stt_rx) = mpsc::unbounded_channel::<SttEvent>();
    let counter = Arc::new(AtomicUsize::new(0));
    let err = h
        .engine
        .start_with_io(
            None,
            SttInput {
                connector: Arc::new(FakeSttConnector::new(Arc::clone(&counter))),
                stream: Box::new(FakeSttStream {
                    sent_samples: counter,
                    keepalives: Arc::new(AtomicUsize::new(0)),
                }),
                events: stt_rx,
            },
            Arc::new(FakeTtsConnector::new(0)),
            Arc::new(FakePlayback::new()),
            MicInput {
                frames_rx,
                handle: None,
            },
        )
        .expect_err("second start must fail");
    assert!(err.contains("already running"));
}

// ── protocol parsing ─────────────────────────────────────────────────────

#[test]
fn parse_flux_turn_messages() {
    assert_eq!(
        parse_flux_message(
            r#"{"type":"TurnInfo","event":"StartOfTurn","transcript":"hey","turn_index":0}"#
        ),
        Some(SttEvent::StartOfTurn {
            transcript: "hey".into()
        })
    );
    assert_eq!(
        parse_flux_message(r#"{"type":"TurnInfo","event":"Update","transcript":"hey there"}"#),
        Some(SttEvent::Interim {
            transcript: "hey there".into()
        })
    );
    assert_eq!(
        parse_flux_message(
            r#"{"type":"TurnInfo","event":"EndOfTurn","transcript":"hey there","end_of_turn_confidence":0.91}"#
        ),
        Some(SttEvent::EndOfTurn {
            transcript: "hey there".into()
        })
    );
    assert_eq!(
        parse_flux_message(r#"{"type":"Connected","request_id":"x"}"#),
        None
    );
    assert!(matches!(
        parse_flux_message(r#"{"type":"Error","description":"bad model"}"#),
        Some(SttEvent::Error(message)) if message == "bad model"
    ));
    assert_eq!(parse_flux_message("not json"), None);
}

// ── DSP ──────────────────────────────────────────────────────────────────

#[test]
fn stream_resampler_matches_batch_resample_across_chunks() {
    let input: Vec<f32> = (0..480).map(|i| (i as f32 * 0.13).sin()).collect();
    let batch = resample(&input, 48_000, 16_000);

    let mut streaming = StreamResampler::new(48_000, 16_000);
    let mut chunked = Vec::new();
    for chunk in input.chunks(77) {
        chunked.extend(streaming.process(chunk));
    }
    // The tail beyond the last full interpolation window stays carried, so
    // compare the shared prefix.
    let shared_len = chunked.len().min(batch.len());
    assert!(shared_len >= batch.len() - 2, "streaming output too short");
    for (index, (a, b)) in batch[..shared_len]
        .iter()
        .zip(chunked[..shared_len].iter())
        .enumerate()
    {
        assert!(
            (a - b).abs() < 1e-4,
            "sample {index} diverged: batch={a} streaming={b}"
        );
    }
}

#[test]
fn stream_resampler_is_identity_at_equal_rates() {
    let mut resampler = StreamResampler::new(16_000, 16_000);
    let chunk = vec![0.1_f32, -0.2, 0.3];
    assert_eq!(resampler.process(&chunk), chunk);
}

#[test]
fn stream_resampler_upsamples_without_gaps() {
    let mut resampler = StreamResampler::new(16_000, 48_000);
    let mut total = 0usize;
    for _ in 0..10 {
        total += resampler.process(&vec![0.5_f32; 160]).len();
    }
    // 1600 input samples → ~4800 output samples (± carried edges).
    assert!((4780..=4800).contains(&total), "got {total}");
}
