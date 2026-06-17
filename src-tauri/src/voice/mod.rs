pub(super) use std::path::{Path, PathBuf};
pub(super) use std::sync::atomic::{AtomicBool, Ordering};
pub(super) use std::sync::{Arc, OnceLock};
pub(super) use std::time::{Duration, Instant};

pub(super) use async_trait::async_trait;
pub(super) use candle_core::{D, Device, IndexOp, Tensor};
pub(super) use candle_nn::{VarBuilder, ops::softmax};
pub(super) use candle_transformers::models::whisper::{
    self as whisper, Config, audio as whisper_audio,
};
pub(super) use futures_util::StreamExt;
pub(super) use parking_lot::Mutex;
pub(super) use serde::{Deserialize, Serialize};
pub(super) use tauri::{AppHandle, Emitter};
pub(super) use tokenizers::Tokenizer;
pub(super) use tokio::io::AsyncWriteExt;

#[cfg(any(target_os = "macos", windows))]
pub(super) use crate::platform_speech::PlatformSpeechAvailability;
pub(super) use crate::platform_speech::{
    DefaultPlatformSpeechEngine, PlatformSpeechAvailabilityStatus, PlatformSpeechEngine,
};

mod audio;

pub(crate) use self::audio::CapturedAudio;
pub(crate) use self::audio::{
    AudioRecorder, CpalAudioRecorder, LevelTask, RecordingSession, spawn_level_emitter,
    validate_captured_audio,
};
// Shared DSP helpers consumed by the playback module.
use self::audio::{compute_rms, resample};
#[cfg(test)]
use self::audio::{
    normalize_interleaved_f32, normalize_interleaved_f64, normalize_interleaved_i16,
    normalize_interleaved_i32, normalize_interleaved_u8, normalize_interleaved_u16,
    resample_to_target_rate,
};

mod download;
mod inference;
mod lfm2;
mod mel;
mod playback;
mod providers;
mod registry;
mod settings;
mod types;

use download::*;
use inference::*;
use lfm2::*;
use mel::*;
pub(crate) use playback::*;
use providers::*;
pub(crate) use registry::*;
pub(crate) use settings::*;
pub(crate) use types::*;

pub(super) const SELECTED_PROVIDER_KEY: &str = "voice:selected_provider";
pub(super) const AUTO_PROVIDER_KEY: &str = "voice:auto_provider";
pub(super) const PLATFORM_ID: &str = "voice-platform-system";
pub(super) const DISTIL_ID: &str = "voice-distil-whisper-candle";
pub(super) const DISTIL_CACHE_DIR: &str = "distil-whisper-large-v3";
pub(super) const DISTIL_READY_MESSAGE: &str = "Ready for offline transcription";
pub(super) const TARGET_SAMPLE_RATE: u32 = whisper::SAMPLE_RATE as u32;
// Hard ceiling on a single Distil-Whisper transcription pass. On macOS
// Metal the 756M-param `distil-large-v3` model handles a 30 s clip in a
// few seconds; on CPU (Linux + Windows, including ARM64) the same
// workload is an order of magnitude slower because Candle loads weights
// in F32 with no GPU acceleration. The previous 90 s blanket timeout
// was tuned for Metal and routinely fired on CPU even for a single
// segment of speech, surfacing as "Voice transcription timed out after
// 90 seconds" with the recording silently discarded. Split the default
// so each platform's actual hardware floor governs the cap, and the
// CPU-side ceiling (5 min) gives breathing room for ARM64 Windows
// users transcribing more than a sentence.
#[cfg(target_os = "macos")]
pub(super) const DISTIL_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(90);
#[cfg(not(target_os = "macos"))]
pub(super) const DISTIL_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(300);
pub(super) const MIN_SIGNAL_PEAK: f32 = 0.001;
pub(super) const DISTIL_MODEL_FILES: [(&str, Option<u64>); 5] = [
    ("config.json", None),
    ("generation_config.json", None),
    ("preprocessor_config.json", None),
    ("tokenizer.json", None),
    ("model.safetensors", Some(100_000_000)),
];

// --- LFM2-Audio (Liquid AI) provider, run via the prebuilt llama.cpp
// `llama-lfm2-audio` one-shot CLI. End-to-end audio model: ASR (speech-in)
// today, TTS (speech-out) in a later phase. The Q8_0 GGUF trio lives beside
// the binary's documented `-m` / `--mmproj` / `-mv` flags. See `lfm2.rs` for
// the runtime contract distilled from the Phase 0 spike.
pub(super) const LFM2_ID: &str = "voice-lfm2-audio-llamacpp";
pub(super) const LFM2_CACHE_DIR: &str = "lfm2-audio-1.5b";
pub(super) const LFM2_HF_REPO: &str = "LiquidAI/LFM2-Audio-1.5B-GGUF";
pub(super) const LFM2_READY_MESSAGE: &str = "Ready for offline speech";
pub(super) const LFM2_LM_FILE: &str = "LFM2-Audio-1.5B-Q8_0.gguf";
pub(super) const LFM2_ENCODER_FILE: &str = "mmproj-audioencoder-LFM2-Audio-1.5B-Q8_0.gguf";
pub(super) const LFM2_DECODER_FILE: &str = "audiodecoder-LFM2-Audio-1.5B-Q8_0.gguf";
// Conservative size floors guard against truncated/partial downloads while
// tolerating minor upstream re-quantization. Actual Q8_0 sizes (bytes) are
// LM 1_246_253_280 / encoder 332_716_640 / decoder 375_009_888.
pub(super) const LFM2_MODEL_FILES: [(&str, Option<u64>); 3] = [
    (LFM2_LM_FILE, Some(1_000_000_000)),
    (LFM2_ENCODER_FILE, Some(250_000_000)),
    (LFM2_DECODER_FILE, Some(250_000_000)),
];
pub(super) const WHISPER_LANGUAGE_CODES: [&str; 99] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
    "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
    "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
    "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
    "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su",
];

// Integration-scoped suite kept in `mod.rs` by design rather than split
// across the submodules it covers. The tests share heavyweight fixtures
// (temp-dir settings DBs, WAV decoding, Whisper forward probes) and exercise
// settings/registry/providers/inference/mel together via `super::*`. Pulling
// them apart per file would duplicate fixtures and lose the cross-module
// coverage, so the leaf modules stay test-free intentionally.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;

    fn test_db_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("voice.json");
        let db = VoiceSettings::open(&db_path).expect("open db");
        drop(db);
        (dir, db_path)
    }

    fn open_test_db(path: &Path) -> VoiceSettings {
        VoiceSettings::open(path).expect("open db")
    }

    fn write_complete_distil_model(cache_path: &Path) {
        std::fs::create_dir_all(cache_path).expect("create model cache");
        std::fs::write(cache_path.join("tokenizer.json"), "{}").expect("write tokenizer");
        std::fs::write(cache_path.join("config.json"), "{}").expect("write config");
        std::fs::write(cache_path.join("generation_config.json"), "{}")
            .expect("write generation config");
        std::fs::write(cache_path.join("preprocessor_config.json"), "{}")
            .expect("write preprocessor config");
        let model_file =
            std::fs::File::create(cache_path.join("model.safetensors")).expect("create model");
        model_file.set_len(100_000_001).expect("size model");
    }

    #[cfg(target_os = "macos")]
    fn run_minimal_whisper_forward(device: &Device) -> Result<(), String> {
        let config = Config {
            num_mel_bins: 4,
            max_source_positions: 4,
            d_model: 8,
            encoder_attention_heads: 2,
            encoder_layers: 1,
            vocab_size: 16,
            max_target_positions: 4,
            decoder_attention_heads: 2,
            decoder_layers: 1,
            suppress_tokens: Vec::new(),
        };
        let vb = VarBuilder::zeros(whisper::DTYPE, device);
        let mut model = whisper::model::Whisper::load(&vb, config.clone())
            .map_err(|e| format!("load minimal whisper: {e}"))?;
        let mel = Tensor::zeros(
            (1, config.num_mel_bins, config.max_source_positions * 2),
            whisper::DTYPE,
            device,
        )
        .map_err(|e| format!("build minimal mel: {e}"))?;
        let audio_features = model
            .encoder
            .forward(&mel, true)
            .map_err(|e| format!("minimal encoder forward: {e}"))?;
        let tokens =
            Tensor::new(&[[1_u32]], device).map_err(|e| format!("build minimal tokens: {e}"))?;
        let decoded = model
            .decoder
            .forward(&tokens, &audio_features, true)
            .map_err(|e| format!("minimal decoder forward: {e}"))?;
        let logits = model
            .decoder
            .final_linear(&decoded)
            .map_err(|e| format!("minimal decoder logits: {e}"))?;
        let _ = logits
            .to_vec3::<f32>()
            .map_err(|e| format!("read minimal logits: {e}"))?;
        Ok(())
    }

    fn read_wav_fixture(path: &Path) -> Result<CapturedAudio, String> {
        let mut reader =
            hound::WavReader::open(path).map_err(|e| format!("Failed to open WAV fixture: {e}"))?;
        let spec = reader.spec();
        if spec.channels == 0 {
            return Err("WAV fixture has no audio channels".to_string());
        }

        let samples = match (spec.sample_format, spec.bits_per_sample) {
            (hound::SampleFormat::Float, 32) => {
                let samples = reader
                    .samples::<f32>()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("Failed to read f32 WAV samples: {e}"))?;
                normalize_interleaved_f32(&samples, spec.channels)
            }
            (hound::SampleFormat::Int, 16) => {
                let samples = reader
                    .samples::<i16>()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("Failed to read i16 WAV samples: {e}"))?;
                normalize_interleaved_i16(&samples, spec.channels)
            }
            (hound::SampleFormat::Int, 24 | 32) => {
                let samples = reader
                    .samples::<i32>()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("Failed to read i32 WAV samples: {e}"))?;
                normalize_interleaved_i32(&samples, spec.channels)
            }
            (sample_format, bits) => {
                return Err(format!(
                    "Unsupported WAV fixture format: {sample_format:?} {bits}-bit"
                ));
            }
        };

        Ok(CapturedAudio {
            samples: resample_to_target_rate(&samples, spec.sample_rate),
            sample_rate: TARGET_SAMPLE_RATE,
        })
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candle_metal_feature_is_enabled_on_macos() {
        assert!(candle_core::utils::metal_is_available());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candle_metal_layer_norm_runs_on_macos() {
        let device = Device::new_metal(0).expect("metal device");
        let xs = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0]], &device).expect("input tensor");
        let alpha = Tensor::new(&[1.0_f32, 1.0], &device).expect("alpha tensor");
        let beta = Tensor::new(&[0.0_f32, 0.0], &device).expect("beta tensor");

        candle_nn::ops::layer_norm(&xs, &alpha, &beta, 1e-5).expect("metal layer norm should run");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candle_metal_whisper_ops_probe_runs_on_macos() {
        let device = Device::new_metal(0).expect("metal device");

        verify_candle_whisper_backend(&device).expect("metal whisper op probe should run");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn minimal_whisper_forward_runs_on_selected_metal_backend() {
        let device = Device::new_metal(0).expect("metal device");

        run_minimal_whisper_forward(&device).expect("minimal whisper forward should run");
    }

    #[test]
    fn distil_provider_reports_engine_unavailable_when_backend_probe_fails() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::with_runtime_and_backend(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Arc::new(FakeBackendChecker::err(
                "Candle Metal Whisper backend failed layer_norm: test failure",
            )),
        );

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::EngineUnavailable);
        assert!(!provider.setup_required);
        assert!(
            provider
                .error
                .as_deref()
                .is_some_and(|error| error.contains("failed layer_norm"))
        );
    }

    #[test]
    fn distil_provider_skips_backend_probe_when_disabled() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let db = open_test_db(&db_path);
        db.set_app_setting(&enabled_key(DISTIL_ID), "false")
            .expect("disable");
        let checker = Arc::new(CountingBackendChecker::new());
        let registry = VoiceProviderRegistry::with_runtime_and_backend(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            checker.clone(),
        );

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|p| p.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::Unavailable);
        assert_eq!(
            checker.call_count(),
            0,
            "backend probe should not be called for disabled provider"
        );
        assert!(provider.metadata.accelerator_label.is_none());
    }

    #[test]
    #[ignore = "requires local Distil-Whisper cache and AETHON_VOICE_SAMPLE_WAV"]
    fn ignored_real_model_probe_transcribes_fixture_wav() {
        let cache_path = std::env::var_os("CLAUDETTE_VOICE_MODEL_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from("/Users/jamesbrink/.aethon/models/voice/distil-whisper-large-v3")
            });
        let sample_path = std::env::var_os("AETHON_VOICE_SAMPLE_WAV")
            .map(PathBuf::from)
            .expect("set AETHON_VOICE_SAMPLE_WAV to a short speech WAV");
        let audio = read_wav_fixture(&sample_path).expect("read speech wav");

        let cancel = Arc::new(AtomicBool::new(false));
        let transcript =
            transcribe_distil_whisper(&cache_path, audio, &cancel).expect("transcribe fixture");

        assert!(!transcript.trim().is_empty());
    }

    struct FakeRecorder {
        starts: AtomicUsize,
        samples: Vec<f32>,
        sample_rate: u32,
        stream_error: Option<String>,
    }

    impl FakeRecorder {
        fn new(samples: Vec<f32>) -> Self {
            Self {
                starts: AtomicUsize::new(0),
                samples,
                sample_rate: TARGET_SAMPLE_RATE,
                stream_error: None,
            }
        }

        fn new_with_stream_error(samples: Vec<f32>, stream_error: impl Into<String>) -> Self {
            Self {
                starts: AtomicUsize::new(0),
                samples,
                sample_rate: TARGET_SAMPLE_RATE,
                stream_error: Some(stream_error.into()),
            }
        }
    }

    impl AudioRecorder for FakeRecorder {
        fn start(&self) -> Result<RecordingSession, String> {
            self.starts.fetch_add(1, Ordering::Relaxed);
            if let Some(stream_error) = &self.stream_error {
                return Ok(RecordingSession::from_samples_with_stream_error(
                    self.samples.clone(),
                    self.sample_rate,
                    stream_error.clone(),
                ));
            }
            Ok(RecordingSession::from_samples(
                self.samples.clone(),
                self.sample_rate,
            ))
        }
    }

    struct FakeTranscriber {
        calls: AtomicUsize,
        result: Mutex<Result<String, String>>,
        sleep_for: std::time::Duration,
    }

    impl FakeTranscriber {
        fn ok(text: &str) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                result: Mutex::new(Ok(text.to_string())),
                sleep_for: std::time::Duration::ZERO,
            }
        }

        fn err(message: &str) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                result: Mutex::new(Err(message.to_string())),
                sleep_for: std::time::Duration::ZERO,
            }
        }

        fn slow(text: &str, sleep_for: std::time::Duration) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                result: Mutex::new(Ok(text.to_string())),
                sleep_for,
            }
        }
    }

    impl VoiceTranscriber for FakeTranscriber {
        fn transcribe(
            &self,
            _cache_path: &Path,
            _audio: CapturedAudio,
            cancel: &Arc<AtomicBool>,
        ) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            // Poll the cancel flag at coarse intervals to mirror how the real
            // Whisper decoder checks between segments — lets tests exercise the
            // cancellation path without changing the production loop.
            let step = std::time::Duration::from_millis(10);
            let mut remaining = self.sleep_for;
            while remaining > std::time::Duration::ZERO {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Transcription cancelled.".to_string());
                }
                let nap = std::cmp::min(step, remaining);
                std::thread::sleep(nap);
                remaining = remaining.saturating_sub(nap);
            }
            self.result.lock().clone()
        }
    }

    struct FakeBackendChecker {
        result: Result<CandleBackend, String>,
    }

    impl FakeBackendChecker {
        fn err(message: &str) -> Self {
            Self {
                result: Err(message.to_string()),
            }
        }
    }

    impl CandleBackendChecker for FakeBackendChecker {
        fn ready_backend(&self) -> Result<CandleBackend, String> {
            self.result.clone()
        }
    }

    struct CountingBackendChecker {
        calls: AtomicUsize,
    }

    impl CountingBackendChecker {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::Relaxed)
        }
    }

    impl CandleBackendChecker for CountingBackendChecker {
        fn ready_backend(&self) -> Result<CandleBackend, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            #[cfg(target_os = "macos")]
            return Ok(CandleBackend::Metal);
            #[cfg(not(target_os = "macos"))]
            return Ok(CandleBackend::Cpu);
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    struct PrepareGate {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    #[cfg(any(target_os = "macos", windows))]
    struct FakePlatformSpeechEngine {
        availability: PlatformSpeechAvailability,
        prepare_availability: PlatformSpeechAvailability,
        transcript: Mutex<Result<String, String>>,
        prepare_gate: Option<PrepareGate>,
        prepare_calls: AtomicUsize,
        calls: AtomicUsize,
    }

    #[cfg(any(target_os = "macos", windows))]
    impl FakePlatformSpeechEngine {
        fn ready(engine_label: &str) -> Self {
            let availability = PlatformSpeechAvailability::ready(engine_label);
            Self {
                availability: availability.clone(),
                prepare_availability: availability,
                transcript: Mutex::new(Ok("platform transcript".to_string())),
                prepare_gate: None,
                prepare_calls: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
            }
        }

        fn needs_speech_permission() -> Self {
            let availability = PlatformSpeechAvailability::needs_speech_permission(
                "Needs Speech Recognition permission",
            );
            Self {
                availability: availability.clone(),
                prepare_availability: availability,
                transcript: Mutex::new(Ok("ignored".to_string())),
                prepare_gate: None,
                prepare_calls: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
            }
        }

        fn needs_speech_permission_then_ready() -> Self {
            Self {
                availability: PlatformSpeechAvailability::needs_speech_permission(
                    "Needs Speech Recognition permission",
                ),
                prepare_availability: PlatformSpeechAvailability::ready("Apple Speech"),
                transcript: Mutex::new(Ok("ignored".to_string())),
                prepare_gate: None,
                prepare_calls: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
            }
        }

        fn with_prepare_gate(
            mut self,
            entered: std::sync::mpsc::Sender<()>,
            release: std::sync::mpsc::Receiver<()>,
        ) -> Self {
            self.prepare_gate = Some(PrepareGate {
                entered,
                release: Mutex::new(Some(release)),
            });
            self
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    impl PlatformSpeechEngine for FakePlatformSpeechEngine {
        fn availability(&self) -> PlatformSpeechAvailability {
            self.availability.clone()
        }

        fn prepare(&self) -> PlatformSpeechAvailability {
            self.prepare_calls.fetch_add(1, Ordering::Relaxed);
            if let Some(gate) = &self.prepare_gate {
                let _ = gate.entered.send(());
                if let Some(release) = gate.release.lock().take() {
                    let _ = release.recv();
                }
            }
            self.prepare_availability.clone()
        }

        fn transcribe(&self, _audio: CapturedAudio) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.transcript.lock().clone()
        }
    }

    #[test]
    fn distil_cache_path_uses_provider_specific_directory() {
        let root = PathBuf::from("/tmp/aethon-test-models");
        let registry = VoiceProviderRegistry::new(root.clone());

        assert_eq!(
            registry.distil_cache_path(),
            root.join("distil-whisper-large-v3")
        );
    }

    #[test]
    fn selected_provider_is_persisted_and_reflected_in_status() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(PathBuf::from("/tmp/models"));

        registry
            .set_selected_provider(&db, Some(DISTIL_ID))
            .expect("set selected provider");

        let providers = registry.list_providers(&db);
        assert!(
            providers
                .iter()
                .any(|provider| provider.metadata.id == DISTIL_ID && provider.selected)
        );
        assert!(
            providers
                .iter()
                .any(|provider| provider.metadata.id == PLATFORM_ID && !provider.selected)
        );
    }

    #[test]
    fn disabled_provider_reports_unavailable() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(PathBuf::from("/tmp/models"));

        registry
            .set_enabled(&db, PLATFORM_ID, false)
            .expect("disable platform provider");

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");
        assert_eq!(provider.status, VoiceProviderStatus::Unavailable);
        assert!(!provider.enabled);
        assert!(!provider.setup_required);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn platform_provider_ready_when_native_engine_ready() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Arc::new(FakePlatformSpeechEngine::ready("Test Engine")),
        );

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");

        assert_eq!(provider.status, VoiceProviderStatus::Ready);
        assert!(provider.enabled);
        assert!(!provider.setup_required);
        assert_eq!(provider.metadata.recording_mode, VoiceRecordingMode::Native);
        assert!(provider.status_label.contains("Test Engine"));
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn platform_provider_reports_setup_required_for_speech_permission() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Arc::new(FakePlatformSpeechEngine::needs_speech_permission()),
        );

        registry
            .set_selected_provider(&db, Some(PLATFORM_ID))
            .expect("select platform provider");

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");

        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert!(provider.enabled);
        assert!(provider.selected);
        assert!(provider.setup_required);
        assert!(
            provider
                .error
                .as_deref()
                .is_some_and(|error| error.contains("Speech Recognition"))
        );
    }

    #[test]
    fn missing_distil_model_requires_setup() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert!(provider.setup_required);
        assert!(!provider.can_remove_model);
    }

    #[test]
    fn complete_distil_model_reports_ready() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(DISTIL_CACHE_DIR);
        write_complete_distil_model(&cache_path);

        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::Ready);
        assert!(!provider.setup_required);
        assert!(provider.can_remove_model);
        assert_eq!(provider.error, None);
    }

    #[test]
    fn incomplete_distil_manifest_requires_setup() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(DISTIL_CACHE_DIR);
        std::fs::create_dir_all(&cache_path).expect("create model cache");
        std::fs::write(cache_path.join("tokenizer.json"), "{}").expect("write tokenizer");
        std::fs::write(cache_path.join("config.json"), "{}").expect("write config");
        let model_file =
            std::fs::File::create(cache_path.join("model.safetensors")).expect("create model");
        model_file.set_len(100_000_001).expect("size model");

        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert!(provider.setup_required);
        assert!(!provider.can_remove_model);
    }

    #[test]
    fn sample_conversion_handles_formats_and_channels() {
        assert_eq!(normalize_interleaved_f32(&[], 1), Vec::<f32>::new());
        assert_eq!(
            normalize_interleaved_f32(&[0.5, -0.25], 1),
            vec![0.5, -0.25]
        );
        assert_eq!(
            normalize_interleaved_i16(&[i16::MAX, i16::MIN], 2),
            vec![(-1.0 + 0.9999695) / 2.0]
        );
        assert_eq!(
            normalize_interleaved_u16(&[u16::MIN, u16::MAX], 2),
            vec![(-1.0 + 0.9999695) / 2.0]
        );
        assert_eq!(
            normalize_interleaved_i32(&[i32::MAX, i32::MIN], 2),
            vec![(1.0 + -1.0) / 2.0]
        );
        assert_eq!(
            normalize_interleaved_u8(&[u8::MIN, u8::MAX], 2),
            vec![(-1.0 + 0.9921875) / 2.0]
        );
        assert_eq!(normalize_interleaved_f64(&[1.5, -1.5], 2), vec![0.0]);
    }

    #[test]
    fn decoder_prompt_includes_language_token_when_available() {
        assert_eq!(decoder_prompt_tokens(1, Some(2), 3, 4), vec![1, 2, 3, 4]);
        assert_eq!(decoder_prompt_tokens(1, None, 3, 4), vec![1, 3, 4]);
    }

    #[test]
    fn resample_to_target_rate_keeps_target_rate_unchanged() {
        let samples = vec![0.0, 0.5, 1.0];
        assert_eq!(
            resample_to_target_rate(&samples, TARGET_SAMPLE_RATE),
            samples
        );
    }

    #[tokio::test]
    async fn start_distil_recording_rejects_disabled_provider() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let db = open_test_db(&db_path);
        db.set_app_setting(&enabled_key(DISTIL_ID), "false")
            .expect("disable provider");
        drop(db);

        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        let err = registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect_err("disabled provider should not record");
        assert!(err.contains("disabled"));
    }

    #[tokio::test]
    async fn start_distil_recording_rejects_missing_model() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        let err = registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect_err("missing model should not record");
        assert!(err.contains("Download"));
    }

    #[tokio::test]
    async fn start_distil_recording_rejects_already_active_recording() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let recorder = Arc::new(FakeRecorder::new(vec![0.1]));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            recorder.clone(),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("first recording starts");
        let err = registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect_err("second recording should fail");

        assert!(err.contains("already active"));
        assert_eq!(recorder.starts.load(Ordering::Relaxed), 1);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn start_platform_recording_prepares_permission_on_user_action() {
        let (_db_dir, db_path) = test_db_path();
        let platform_engine =
            Arc::new(FakePlatformSpeechEngine::needs_speech_permission_then_ready());
        let recorder = Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3]));
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            recorder.clone(),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine.clone(),
        );

        let db = open_test_db(&db_path);
        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");
        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert_eq!(platform_engine.prepare_calls.load(Ordering::Relaxed), 0);
        drop(db);

        registry
            .start_recording(&db_path, PLATFORM_ID, None)
            .await
            .expect("platform recording starts after prepare");

        assert_eq!(platform_engine.prepare_calls.load(Ordering::Relaxed), 1);
        assert_eq!(recorder.starts.load(Ordering::Relaxed), 1);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test(flavor = "current_thread")]
    async fn start_platform_recording_prepares_permission_off_runtime_thread() {
        let (_db_dir, db_path) = test_db_path();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_watchdog = release_tx.clone();
        let released = Arc::new(AtomicBool::new(false));
        let watchdog_released = Arc::clone(&released);
        let watchdog = std::thread::spawn(move || {
            if entered_rx.recv_timeout(Duration::from_secs(5)).is_ok() {
                for _ in 0..50 {
                    if watchdog_released.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                let _ = release_watchdog.send(());
            }
        });

        let platform_engine = Arc::new(
            FakePlatformSpeechEngine::needs_speech_permission_then_ready()
                .with_prepare_gate(entered_tx, release_rx),
        );
        let registry = Arc::new(VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine,
        ));

        let start_registry = Arc::clone(&registry);
        let handle = tokio::spawn(async move {
            start_registry
                .start_recording(&db_path, PLATFORM_ID, None)
                .await
        });

        let liveness = tokio::spawn(async {
            tokio::task::yield_now().await;
        });
        tokio::time::timeout(Duration::from_secs(1), liveness)
            .await
            .expect("async runtime must stay live while permission prepare is pending")
            .expect("liveness task joined");

        assert!(
            !handle.is_finished(),
            "recording start must still be waiting for permission prepare"
        );
        released.store(true, Ordering::Relaxed);
        release_tx.send(()).expect("release permission prepare");
        handle
            .await
            .expect("recording task joined")
            .expect("platform recording starts after prepare");
        watchdog.join().expect("watchdog joined");
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn start_then_stop_platform_recording_returns_transcript() {
        let (_db_dir, db_path) = test_db_path();
        let platform_engine = Arc::new(FakePlatformSpeechEngine::ready("Test Engine"));
        *platform_engine.transcript.lock() = Ok("spoken platform words".to_string());
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine.clone(),
        );

        registry
            .start_recording(&db_path, PLATFORM_ID, None)
            .await
            .expect("platform recording starts");
        let transcript = registry
            .stop_and_transcribe(PLATFORM_ID)
            .await
            .expect("platform transcribes");

        assert_eq!(transcript, "spoken platform words");
        assert_eq!(platform_engine.calls.load(Ordering::Relaxed), 1);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn cancel_drops_active_platform_recording() {
        let (_db_dir, db_path) = test_db_path();
        let platform_engine = Arc::new(FakePlatformSpeechEngine::ready("Test Engine"));
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine.clone(),
        );

        registry
            .start_recording(&db_path, PLATFORM_ID, None)
            .await
            .expect("platform recording starts");
        registry
            .cancel_recording(PLATFORM_ID)
            .await
            .expect("cancel platform recording");

        let err = registry
            .stop_and_transcribe(PLATFORM_ID)
            .await
            .expect_err("cancelled platform recording should be gone");
        assert!(err.contains("No voice recording is active"));
        assert_eq!(platform_engine.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn stop_without_recording_returns_clear_error() {
        let registry = VoiceProviderRegistry::with_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("stop without recording should fail");
        assert!(err.contains("No voice recording is active"));
    }

    #[tokio::test]
    async fn cancel_drops_active_recording() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("ignored"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        registry
            .cancel_recording(DISTIL_ID)
            .await
            .expect("cancel recording");

        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("cancelled recording should be gone");
        assert!(err.contains("No voice recording is active"));
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn cancel_during_distil_transcription_returns_early() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::slow(
            "would have transcribed",
            Duration::from_secs(5),
        ));
        let registry = Arc::new(VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            transcriber.clone(),
        ));

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");

        let stop_registry = Arc::clone(&registry);
        let stop_handle =
            tokio::spawn(async move { stop_registry.stop_and_transcribe(DISTIL_ID).await });

        // Give the spawn_blocking worker a moment to enter its sleep loop.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let cancel_started = std::time::Instant::now();
        registry
            .cancel_recording(DISTIL_ID)
            .await
            .expect("cancel succeeds");

        let result = stop_handle.await.expect("stop task joined");
        let elapsed = cancel_started.elapsed();

        let err = result.expect_err("transcription should be cancelled");
        assert!(
            err.contains("cancelled"),
            "expected cancellation error, got: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "expected fast return after cancel, took {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn start_then_stop_returns_fake_transcript() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("hello from test"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let transcript = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect("transcribes");

        assert_eq!(transcript, "hello from test");
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn recorder_stream_error_returns_clear_error_before_transcription() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("ignored"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new_with_stream_error(
                vec![0.1, 0.2, 0.3],
                "device disconnected",
            )),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("stream error should fail");

        assert!(err.contains("device disconnected"));
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn silent_recording_rejects_before_transcription() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("ignored"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.0; TARGET_SAMPLE_RATE as usize])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("silent recording should fail");

        assert!(err.contains("No speech"));
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn empty_transcript_returns_clear_error() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("   ")),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("empty transcript should fail");

        assert!(err.contains("No speech"));
    }

    #[tokio::test]
    async fn transcription_timeout_returns_clear_error() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let registry = VoiceProviderRegistry::with_runtime_and_timeout(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::slow(
                "late transcript",
                std::time::Duration::from_millis(50),
            )),
            std::time::Duration::from_millis(5),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("slow transcription should time out");

        assert!(err.contains("timed out"));
        // Platform-aware suggestion: don't make CPU users blindly retry —
        // route them to the platform provider that's actually fast on
        // their hardware. The macOS variant already pointed at System
        // dictation; bring Windows users along too.
        #[cfg(target_os = "windows")]
        assert!(
            err.contains("Windows SAPI") || err.contains("System dictation"),
            "Windows timeout must point at the SAPI provider: {err}",
        );
        #[cfg(target_os = "macos")]
        assert!(
            err.contains("System dictation"),
            "macOS timeout must point at the platform provider: {err}",
        );
    }

    #[test]
    fn timeout_error_message_renders_platform_specific_hint() {
        // Pin the contract directly — a refactor that drops the
        // platform-specific suggestion would silently regress.
        let msg = timeout_error_message(std::time::Duration::from_secs(300));
        assert!(msg.starts_with("Voice transcription timed out after 300 seconds"));
        #[cfg(target_os = "windows")]
        {
            assert!(msg.contains("CPU"));
            assert!(msg.contains("System dictation"));
        }
        #[cfg(target_os = "macos")]
        assert!(msg.contains("System dictation"));
    }

    #[test]
    fn distil_transcription_timeout_default_matches_platform_hardware() {
        // macOS hits Metal so the small ceiling is fine; CPU platforms
        // need much more headroom for distil-whisper-large-v3 to chew
        // through a multi-segment clip. Pin both so a future "let's just
        // bump the macOS default to be safe" doesn't silently slow down
        // failure detection on the platform that doesn't need it.
        #[cfg(target_os = "macos")]
        assert_eq!(
            DISTIL_TRANSCRIPTION_TIMEOUT,
            std::time::Duration::from_secs(90)
        );
        #[cfg(not(target_os = "macos"))]
        assert!(
            DISTIL_TRANSCRIPTION_TIMEOUT >= std::time::Duration::from_secs(180),
            "CPU transcription timeout must be >= 180 s; was {:?}",
            DISTIL_TRANSCRIPTION_TIMEOUT,
        );
    }

    #[tokio::test]
    async fn transcription_error_does_not_poison_later_recordings() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::err("boom"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("fake transcriber fails");
        assert_eq!(err, "boom");

        *transcriber.result.lock() = Ok("recovered".to_string());
        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording can start again");
        let transcript = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect("later transcription succeeds");
        assert_eq!(transcript, "recovered");
    }

    #[tokio::test]
    async fn remove_distil_model_clears_cache_and_status() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(DISTIL_CACHE_DIR);
        write_complete_distil_model(&cache_path);
        let db = open_test_db(&db_path);
        db.set_app_setting(&model_status_key(DISTIL_ID), "installed")
            .expect("set model status");
        drop(db);

        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        let provider = registry
            .remove_provider_model(&db_path, DISTIL_ID)
            .await
            .expect("remove model");

        assert!(!cache_path.exists());
        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        let db = open_test_db(&db_path);
        assert_eq!(
            db.get_app_setting(&model_status_key(DISTIL_ID))
                .expect("get model status"),
            Some("not-installed".to_string())
        );
    }

    #[test]
    fn stale_downloading_state_does_not_hide_download_action_after_restart() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let db = open_test_db(&db_path);
        db.set_app_setting(&model_status_key(DISTIL_ID), "downloading")
            .expect("set stale downloading");

        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert_eq!(provider.status_label, "Download required");
        assert!(provider.setup_required);
    }

    #[test]
    fn active_download_state_is_runtime_only() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        registry
            .active_downloads
            .lock()
            .insert(DISTIL_ID.to_string());

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::Downloading);
        assert_eq!(provider.status_label, "Downloading model");
        assert!(provider.setup_required);
    }

    // --- LFM2-Audio provider ---------------------------------------------

    struct FakeLfm2Backend {
        binary_available: bool,
        result: Mutex<Result<String, String>>,
        sleep_for: Duration,
        calls: AtomicUsize,
    }

    impl FakeLfm2Backend {
        fn ready(text: &str) -> Self {
            Self {
                binary_available: true,
                result: Mutex::new(Ok(text.to_string())),
                sleep_for: Duration::ZERO,
                calls: AtomicUsize::new(0),
            }
        }

        fn binary_missing() -> Self {
            Self {
                binary_available: false,
                result: Mutex::new(Ok("ignored".to_string())),
                sleep_for: Duration::ZERO,
                calls: AtomicUsize::new(0),
            }
        }

        fn slow(text: &str, sleep_for: Duration) -> Self {
            Self {
                binary_available: true,
                result: Mutex::new(Ok(text.to_string())),
                sleep_for,
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl Lfm2Backend for FakeLfm2Backend {
        fn binary_available(&self) -> bool {
            self.binary_available
        }

        async fn asr(
            &self,
            _audio: CapturedAudio,
            cancel: Arc<AtomicBool>,
        ) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            // Poll the cancel flag while "working" so tests can exercise the
            // cooperative cancel path the real subprocess wrapper uses.
            self.wait_for_cancel(&cancel, "Transcription cancelled.")
                .await?;
            self.result.lock().clone()
        }

        async fn tts(
            &self,
            _text: String,
            cancel: Arc<AtomicBool>,
        ) -> Result<CapturedAudio, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.wait_for_cancel(&cancel, "Speech synthesis cancelled.")
                .await?;
            // Surface a configured error, otherwise return a short canned clip.
            self.result.lock().clone().map(|_| CapturedAudio {
                samples: vec![0.1, -0.1, 0.2, -0.2],
                sample_rate: 24_000,
            })
        }
    }

    impl FakeLfm2Backend {
        /// Poll `cancel` over `sleep_for`, returning an `Err` with `message` if
        /// it flips — mirrors the real subprocess wrapper's cooperative cancel.
        async fn wait_for_cancel(
            &self,
            cancel: &Arc<AtomicBool>,
            message: &str,
        ) -> Result<(), String> {
            let step = Duration::from_millis(10);
            let mut remaining = self.sleep_for;
            while remaining > Duration::ZERO {
                if cancel.load(Ordering::Relaxed) {
                    return Err(message.to_string());
                }
                let nap = step.min(remaining);
                tokio::time::sleep(nap).await;
                remaining = remaining.saturating_sub(nap);
            }
            Ok(())
        }
    }

    fn write_complete_lfm2_model(cache_path: &Path) {
        std::fs::create_dir_all(cache_path).expect("create lfm2 cache");
        for (filename, min_size) in LFM2_MODEL_FILES {
            let file = std::fs::File::create(cache_path.join(filename)).expect("create lfm2 file");
            if let Some(min_size) = min_size {
                file.set_len(min_size).expect("size lfm2 file");
            }
        }
    }

    fn lfm2_registry(model_root: PathBuf, lfm2: FakeLfm2Backend) -> VoiceProviderRegistry {
        VoiceProviderRegistry::with_runtime(
            model_root,
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
        )
        .with_lfm2_backend(Arc::new(lfm2))
    }

    fn find_lfm2(registry: &VoiceProviderRegistry, db: &VoiceSettings) -> VoiceProviderInfo {
        registry
            .list_providers(db)
            .into_iter()
            .find(|provider| provider.metadata.id == LFM2_ID)
            .expect("lfm2 provider present")
    }

    #[test]
    fn lfm2_provider_appears_in_default_list() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(PathBuf::from("/tmp/models"));

        assert!(
            registry
                .list_providers(&db)
                .iter()
                .any(|provider| provider.metadata.id == LFM2_ID)
        );
    }

    #[test]
    fn lfm2_cache_path_uses_provider_specific_directory() {
        let root = PathBuf::from("/tmp/aethon-test-models");
        let registry = VoiceProviderRegistry::new(root.clone());
        assert_eq!(registry.lfm2_cache_path(), root.join(LFM2_CACHE_DIR));
    }

    #[test]
    fn lfm2_ready_when_model_and_binary_present() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let db = open_test_db(&db_path);
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let provider = find_lfm2(&registry, &db);
        assert_eq!(provider.status, VoiceProviderStatus::Ready);
        assert!(!provider.setup_required);
        assert!(provider.can_remove_model);
        assert_eq!(provider.error, None);
    }

    #[test]
    fn lfm2_needs_setup_when_model_missing() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let db = open_test_db(&db_path);
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let provider = find_lfm2(&registry, &db);
        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert!(provider.setup_required);
        assert!(!provider.can_remove_model);
    }

    #[test]
    fn lfm2_engine_unavailable_when_binary_missing() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let db = open_test_db(&db_path);
        let registry = lfm2_registry(
            model_dir.path().to_path_buf(),
            FakeLfm2Backend::binary_missing(),
        );

        let provider = find_lfm2(&registry, &db);
        assert_eq!(provider.status, VoiceProviderStatus::EngineUnavailable);
        assert!(!provider.setup_required);
        assert!(
            provider
                .error
                .as_deref()
                .is_some_and(|error| error.contains("llama-lfm2-audio"))
        );
    }

    #[test]
    fn lfm2_disabled_reports_unavailable() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let db = open_test_db(&db_path);
        db.set_app_setting(&enabled_key(LFM2_ID), "false")
            .expect("disable lfm2");
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let provider = find_lfm2(&registry, &db);
        assert_eq!(provider.status, VoiceProviderStatus::Unavailable);
        assert!(!provider.enabled);
        assert!(!provider.setup_required);
    }

    #[test]
    fn lfm2_model_ready_requires_all_files() {
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(LFM2_CACHE_DIR);
        std::fs::create_dir_all(&cache_path).expect("create cache");
        // Only the LM file present — encoder + decoder still missing.
        let lm = std::fs::File::create(cache_path.join(LFM2_LM_FILE)).expect("create lm");
        lm.set_len(1_000_000_000).expect("size lm");

        assert!(!lfm2_model_ready(&cache_path));
    }

    #[test]
    fn resolve_provider_id_accepts_lfm2() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(PathBuf::from("/tmp/models"));

        assert_eq!(
            registry
                .resolve_provider_id(&db, Some(LFM2_ID))
                .expect("lfm2 is a known provider"),
            LFM2_ID
        );
    }

    #[test]
    fn bundled_lfm2_binary_finds_sibling_runner() {
        let dir = tempdir().expect("dir");
        assert!(bundled_lfm2_binary(dir.path()).is_none());
        let binary = dir.path().join("llama-lfm2-audio");
        std::fs::write(&binary, b"runner").expect("write binary");
        assert_eq!(bundled_lfm2_binary(dir.path()), Some(binary));
    }

    #[test]
    fn bundled_lfm2_binary_finds_runner_subdir() {
        let dir = tempdir().expect("dir");
        let subdir = dir.path().join("lfm2-audio");
        std::fs::create_dir_all(&subdir).expect("create subdir");
        let binary = subdir.join("llama-lfm2-audio");
        std::fs::write(&binary, b"runner").expect("write binary");
        assert_eq!(bundled_lfm2_binary(dir.path()), Some(binary));
    }

    #[test]
    fn bundled_lfm2_binary_finds_macos_resources_runner() {
        // Mirror the .app layout: Contents/MacOS/<exe>, Contents/Resources/.
        let app = tempdir().expect("dir");
        let macos = app.path().join("Contents").join("MacOS");
        let resources = app
            .path()
            .join("Contents")
            .join("Resources")
            .join("lfm2-audio");
        std::fs::create_dir_all(&macos).expect("create MacOS");
        std::fs::create_dir_all(&resources).expect("create Resources");
        let binary = resources.join("llama-lfm2-audio");
        std::fs::write(&binary, b"runner").expect("write binary");
        assert_eq!(bundled_lfm2_binary(&macos), Some(binary));
    }

    #[tokio::test]
    async fn remove_lfm2_model_clears_cache_and_status() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(LFM2_CACHE_DIR);
        write_complete_lfm2_model(&cache_path);
        let db = open_test_db(&db_path);
        db.set_app_setting(&model_status_key(LFM2_ID), "installed")
            .expect("set model status");
        drop(db);

        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));
        let provider = registry
            .remove_provider_model(&db_path, LFM2_ID)
            .await
            .expect("remove lfm2 model");

        assert!(!cache_path.exists());
        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        let db = open_test_db(&db_path);
        assert_eq!(
            db.get_app_setting(&model_status_key(LFM2_ID))
                .expect("get model status"),
            Some("not-installed".to_string())
        );
    }

    #[tokio::test]
    async fn start_lfm2_recording_rejects_missing_model() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let err = registry
            .start_recording(&db_path, LFM2_ID, None)
            .await
            .expect_err("missing model should not record");
        assert!(err.contains("Download"));
    }

    #[tokio::test]
    async fn start_lfm2_recording_rejects_disabled_provider() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let db = open_test_db(&db_path);
        db.set_app_setting(&enabled_key(LFM2_ID), "false")
            .expect("disable provider");
        drop(db);
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let err = registry
            .start_recording(&db_path, LFM2_ID, None)
            .await
            .expect_err("disabled provider should not record");
        assert!(err.contains("disabled"));
    }

    #[tokio::test]
    async fn start_lfm2_recording_rejects_missing_binary() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = lfm2_registry(
            model_dir.path().to_path_buf(),
            FakeLfm2Backend::binary_missing(),
        );

        let err = registry
            .start_recording(&db_path, LFM2_ID, None)
            .await
            .expect_err("missing binary should not record");
        assert!(err.contains("llama-lfm2-audio"));
    }

    #[tokio::test]
    async fn start_then_stop_lfm2_returns_transcript() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = lfm2_registry(
            model_dir.path().to_path_buf(),
            FakeLfm2Backend::ready("hello from lfm2"),
        );

        registry
            .start_recording(&db_path, LFM2_ID, None)
            .await
            .expect("recording starts");
        let transcript = registry
            .stop_and_transcribe(LFM2_ID)
            .await
            .expect("transcribes");

        assert_eq!(transcript, "hello from lfm2");
    }

    #[tokio::test]
    async fn cancel_during_lfm2_transcription_returns_early() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = Arc::new(lfm2_registry(
            model_dir.path().to_path_buf(),
            FakeLfm2Backend::slow("would have transcribed", Duration::from_secs(5)),
        ));

        registry
            .start_recording(&db_path, LFM2_ID, None)
            .await
            .expect("recording starts");

        let stop_registry = Arc::clone(&registry);
        let stop_handle =
            tokio::spawn(async move { stop_registry.stop_and_transcribe(LFM2_ID).await });
        tokio::time::sleep(Duration::from_millis(50)).await;

        let cancel_started = std::time::Instant::now();
        registry
            .cancel_recording(LFM2_ID)
            .await
            .expect("cancel succeeds");

        let result = stop_handle.await.expect("stop task joined");
        let elapsed = cancel_started.elapsed();
        let err = result.expect_err("transcription should be cancelled");
        assert!(err.contains("cancelled"), "expected cancellation: {err}");
        assert!(
            elapsed < Duration::from_secs(2),
            "expected fast return: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn lfm2_transcription_timeout_returns_clear_error() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = VoiceProviderRegistry::with_runtime_and_timeout(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Duration::from_millis(5),
        )
        .with_lfm2_backend(Arc::new(FakeLfm2Backend::slow(
            "late transcript",
            Duration::from_millis(80),
        )));

        registry
            .start_recording(&db_path, LFM2_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(LFM2_ID)
            .await
            .expect_err("slow transcription should time out");
        assert!(err.contains("timed out"));
    }

    #[tokio::test]
    #[ignore = "requires AETHON_LFM2_AUDIO_BIN, the LFM2 model cache, and AETHON_VOICE_SAMPLE_WAV"]
    async fn ignored_real_lfm2_asr_transcribes_fixture_wav() {
        let model_root = std::env::var_os("AETHON_LFM2_MODEL_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(VoiceProviderRegistry::default_model_root);
        let sample_path = std::env::var_os("AETHON_VOICE_SAMPLE_WAV")
            .map(PathBuf::from)
            .expect("set AETHON_VOICE_SAMPLE_WAV to a short speech WAV");
        let audio = read_wav_fixture(&sample_path).expect("read speech wav");

        let backend = Lfm2CliBackend::new(model_root);
        assert!(
            backend.binary_available(),
            "set AETHON_LFM2_AUDIO_BIN to the llama-lfm2-audio binary",
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let transcript = backend
            .asr(audio, cancel)
            .await
            .expect("transcribe fixture");
        assert!(!transcript.trim().is_empty(), "got empty transcript");
        println!("LFM2 ASR transcript: {transcript}");
    }

    #[tokio::test]
    #[ignore = "requires AETHON_LFM2_AUDIO_BIN and the LFM2 model cache"]
    async fn ignored_real_lfm2_tts_synthesizes_audio() {
        let model_root = std::env::var_os("AETHON_LFM2_MODEL_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(VoiceProviderRegistry::default_model_root);
        let backend = Lfm2CliBackend::new(model_root);
        assert!(
            backend.binary_available(),
            "set AETHON_LFM2_AUDIO_BIN to the llama-lfm2-audio binary",
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let audio = backend
            .tts(
                "Hello from Aethon. Phase two is online.".to_string(),
                cancel,
            )
            .await
            .expect("synthesize speech");
        assert!(!audio.samples.is_empty(), "got empty audio");
        assert_eq!(audio.sample_rate, LFM2_TTS_SAMPLE_RATE);

        // Optionally dump the clip for manual listening (AETHON_TTS_OUT=/path.wav).
        if let Some(out) = std::env::var_os("AETHON_TTS_OUT") {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: audio.sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer =
                hound::WavWriter::create(PathBuf::from(out), spec).expect("wav writer");
            for &sample in &audio.samples {
                let scaled = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
                writer.write_sample(scaled).expect("write sample");
            }
            writer.finalize().expect("finalize wav");
        }
        println!(
            "LFM2 TTS produced {} samples @ {} Hz",
            audio.samples.len(),
            audio.sample_rate
        );
    }

    #[test]
    fn parse_asr_stdout_keeps_only_transcript() {
        let stdout = "load_gguf: Loaded 369 tensors from audiodecoder.gguf\n\
             main: loading model: lm.gguf\n\
             encoding audio slice...\n\
             audio slice encoded in 35 ms\n\
             decoding audio batch 1/1, n_tokens_batch = 35\n\
             audio decoded (batch 1/1) in 16 ms\n\
             \n\
             The quick brown fox jumps over the lazy dog.\n\
             \n";
        assert_eq!(
            parse_asr_stdout(stdout),
            "The quick brown fox jumps over the lazy dog."
        );
    }

    #[test]
    fn parse_asr_stdout_joins_multiline_transcript_and_trims_noise() {
        let stdout = "main: loading model: lm.gguf\n\
             First sentence.\n\
             Second sentence.\n\
             ggml_metal_free: deallocating\n";
        assert_eq!(parse_asr_stdout(stdout), "First sentence. Second sentence.");
    }

    // --- Phase 2: TTS synthesis + playback ------------------------------

    #[tokio::test]
    async fn synthesize_speech_returns_audio() {
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let audio = registry
            .synthesize_speech("hello".to_string())
            .await
            .expect("synthesize");
        assert!(!audio.samples.is_empty());
        assert_eq!(audio.sample_rate, 24_000);
    }

    #[tokio::test]
    async fn synthesize_speech_rejects_empty_text() {
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let err = registry
            .synthesize_speech("   ".to_string())
            .await
            .expect_err("empty text should be rejected");
        assert!(err.contains("Nothing to speak"));
    }

    #[tokio::test]
    async fn synthesize_speech_rejects_missing_model() {
        let model_dir = tempdir().expect("model dir");
        let registry = lfm2_registry(model_dir.path().to_path_buf(), FakeLfm2Backend::ready("x"));

        let err = registry
            .synthesize_speech("hello".to_string())
            .await
            .expect_err("missing model should be rejected");
        assert!(err.contains("Download"));
    }

    #[tokio::test]
    async fn synthesize_speech_rejects_missing_binary() {
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = lfm2_registry(
            model_dir.path().to_path_buf(),
            FakeLfm2Backend::binary_missing(),
        );

        let err = registry
            .synthesize_speech("hello".to_string())
            .await
            .expect_err("missing binary should be rejected");
        assert!(err.contains("llama-lfm2-audio"));
    }

    #[tokio::test]
    async fn cancel_speech_aborts_synthesis() {
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = Arc::new(lfm2_registry(
            model_dir.path().to_path_buf(),
            FakeLfm2Backend::slow("x", Duration::from_secs(5)),
        ));

        let synth_registry = Arc::clone(&registry);
        let handle =
            tokio::spawn(
                async move { synth_registry.synthesize_speech("hello".to_string()).await },
            );
        tokio::time::sleep(Duration::from_millis(50)).await;
        registry.cancel_speech();

        let err = handle
            .await
            .expect("synthesis task joined")
            .expect_err("synthesis should be cancelled");
        assert!(err.contains("cancelled"), "expected cancellation: {err}");
    }

    #[tokio::test]
    async fn overlapping_synthesis_cancels_previous() {
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = Arc::new(lfm2_registry(
            model_dir.path().to_path_buf(),
            FakeLfm2Backend::slow("x", Duration::from_secs(5)),
        ));

        let first_registry = Arc::clone(&registry);
        let first =
            tokio::spawn(
                async move { first_registry.synthesize_speech("first".to_string()).await },
            );
        tokio::time::sleep(Duration::from_millis(50)).await;

        // A second request must cancel the first so the older runner can't
        // proceed to playback after the user moved on.
        let second_registry = Arc::clone(&registry);
        let second = tokio::spawn(async move {
            second_registry
                .synthesize_speech("second".to_string())
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        let first_err = first
            .await
            .expect("first task joined")
            .expect_err("first synthesis should be superseded");
        assert!(
            first_err.contains("cancelled"),
            "expected cancellation: {first_err}"
        );

        registry.cancel_speech();
        let _ = second.await;
    }

    #[tokio::test]
    async fn synthesize_speech_times_out() {
        let model_dir = tempdir().expect("model dir");
        write_complete_lfm2_model(&model_dir.path().join(LFM2_CACHE_DIR));
        let registry = VoiceProviderRegistry::with_runtime_and_timeout(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Duration::from_millis(5),
        )
        .with_lfm2_backend(Arc::new(FakeLfm2Backend::slow(
            "late",
            Duration::from_millis(80),
        )));

        let err = registry
            .synthesize_speech("hello".to_string())
            .await
            .expect_err("slow synthesis should time out");
        assert!(err.contains("timed out"));
    }

    #[tokio::test]
    #[ignore = "plays a tone through the default output device"]
    async fn ignored_real_playback_plays_tone() {
        let sample_rate = 24_000_u32;
        let freq = 440.0_f32;
        let count = sample_rate as usize; // ~1 second
        let samples: Vec<f32> = (0..count)
            .map(|i| {
                0.2 * (2.0 * std::f32::consts::PI * freq * i as f32 / sample_rate as f32).sin()
            })
            .collect();

        let player = AudioPlayer::new();
        player
            .play_samples(samples, sample_rate, None)
            .expect("playback should start");
        assert!(
            player.is_playing(),
            "stream should be active during playback"
        );
        // Hold the player (and thus the stream) alive while the tone plays, then
        // confirm the watcher freed the stream on natural completion.
        tokio::time::sleep(Duration::from_millis(1600)).await;
        assert!(
            !player.is_playing(),
            "stream should be released once the clip drains",
        );
        player.stop();
    }

    #[test]
    fn playback_buffer_drains_then_finishes() {
        let mut buffer = PlaybackBuffer::new(vec![0.1, 0.2, 0.3]);
        assert!(!buffer.finished());
        assert_eq!(buffer.next_sample(), Some(0.1));
        assert_eq!(buffer.next_sample(), Some(0.2));
        assert!(!buffer.finished());
        assert_eq!(buffer.next_sample(), Some(0.3));
        assert!(buffer.finished());
        assert_eq!(buffer.next_sample(), None);
        assert!(buffer.finished());
    }

    #[test]
    fn empty_playback_buffer_is_immediately_finished() {
        let mut buffer = PlaybackBuffer::new(Vec::new());
        assert!(buffer.finished());
        assert_eq!(buffer.next_sample(), None);
    }

    #[test]
    fn resample_scales_length_with_rate() {
        let mono = vec![0.0, 0.5, 1.0, 0.5];
        assert_eq!(resample(&mono, 16_000, 16_000), mono);
        assert_eq!(resample(&mono, 24_000, 48_000).len(), 8);
        assert_eq!(resample(&mono, 48_000, 24_000).len(), 2);
        assert!(resample(&[], 24_000, 48_000).is_empty());
    }
}
