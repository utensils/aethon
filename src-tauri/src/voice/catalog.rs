use std::time::Duration;

use super::whisper;

pub(crate) const SELECTED_PROVIDER_KEY: &str = "voice:selected_provider";
pub(crate) const AUTO_PROVIDER_KEY: &str = "voice:auto_provider";
pub(crate) const PLATFORM_ID: &str = "voice-platform-system";
pub(crate) const DISTIL_ID: &str = "voice-distil-whisper-candle";
pub(crate) const DISTIL_CACHE_DIR: &str = "distil-whisper-large-v3";
pub(crate) const DISTIL_READY_MESSAGE: &str = "Ready for offline transcription";
pub(crate) const TARGET_SAMPLE_RATE: u32 = whisper::SAMPLE_RATE as u32;
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
pub(crate) const DISTIL_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(90);
#[cfg(not(target_os = "macos"))]
pub(crate) const DISTIL_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const MIN_SIGNAL_PEAK: f32 = 0.001;
pub(crate) const DISTIL_MODEL_FILES: [(&str, Option<u64>); 5] = [
    ("config.json", None),
    ("generation_config.json", None),
    ("preprocessor_config.json", None),
    ("tokenizer.json", None),
    ("model.safetensors", Some(100_000_000)),
];

// --- LFM2-Audio (Liquid AI) provider, run via the prebuilt llama.cpp
// `llama-lfm2-audio` one-shot CLI. End-to-end audio model: ASR (speech-in)
// and TTS (speech-out, see `playback.rs` + `voice_speak`) are both wired up.
// The Q8_0 GGUF trio lives beside the binary's documented `-m` / `--mmproj`
// / `-mv` flags. See `lfm2.rs` for the runtime contract distilled from the
// Phase 0 spike.
pub(crate) const LFM2_ID: &str = "voice-lfm2-audio-llamacpp";
pub(crate) const LFM2_CACHE_DIR: &str = "lfm2-audio-1.5b";
pub(crate) const LFM2_HF_REPO: &str = "LiquidAI/LFM2-Audio-1.5B-GGUF";
pub(crate) const LFM2_READY_MESSAGE: &str = "Ready for offline speech";
pub(crate) const LFM2_LM_FILE: &str = "LFM2-Audio-1.5B-Q8_0.gguf";
pub(crate) const LFM2_ENCODER_FILE: &str = "mmproj-audioencoder-LFM2-Audio-1.5B-Q8_0.gguf";
pub(crate) const LFM2_DECODER_FILE: &str = "audiodecoder-LFM2-Audio-1.5B-Q8_0.gguf";
// Conservative size floors guard against truncated/partial downloads while
// tolerating minor upstream re-quantization. Actual Q8_0 sizes (bytes) are
// LM 1_246_253_280 / encoder 332_716_640 / decoder 375_009_888.
pub(crate) const LFM2_MODEL_FILES: [(&str, Option<u64>); 3] = [
    (LFM2_LM_FILE, Some(1_000_000_000)),
    (LFM2_ENCODER_FILE, Some(250_000_000)),
    (LFM2_DECODER_FILE, Some(250_000_000)),
];
pub(crate) const WHISPER_LANGUAGE_CODES: [&str; 99] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
    "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
    "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
    "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
    "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su",
];
