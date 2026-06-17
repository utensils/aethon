//! LFM2-Audio runtime — a thin wrapper over Liquid AI's prebuilt llama.cpp
//! `llama-lfm2-audio` one-shot CLI.
//!
//! Runtime contract (validated by the Phase 0 spike on Apple Silicon):
//! - ASR: `llama-lfm2-audio -m <lm> --mmproj <encoder> -mv <decoder>
//!   -sys "Perform ASR." --audio <in.wav>`. The transcript is printed on
//!   **stdout**, interleaved with stable diagnostic lines (`load_gguf:`,
//!   `main:`, `encoding audio slice`, `audio decoded`, …) — filter those out.
//! - The binary is genuinely one-shot (a fresh process per call), which is why
//!   it sidesteps the upstream "crash after the first ASR+TTS cycle" entirely.
//! - **Never** pass `--log-disable`: it suppresses the transcript (a log line)
//!   and breaks audio output writing.
//! - The runner is system-linked (`@rpath` dylibs + `/usr/lib`), so it is
//!   resolved next to the app executable (release sidecar), via the
//!   `AETHON_LFM2_AUDIO_BIN` override (dev), or on `PATH`. Model weights are
//!   downloaded on demand; the binary is never auto-downloaded-and-executed.

use super::*;
use std::process::Stdio;
use tokio::io::AsyncReadExt;

const LFM2_BIN_NAME: &str = "llama-lfm2-audio";
const LFM2_BIN_ENV: &str = "AETHON_LFM2_AUDIO_BIN";
/// The runner ships as a directory (binary + `@loader_path` dylibs), staged
/// beside the app executable under this subdirectory by the release bundle and
/// the dev-app mirror.
const LFM2_BUNDLE_SUBDIR: &str = "lfm2-audio";
pub(super) const LFM2_BINARY_MISSING: &str = "LFM2-Audio runtime not found. The llama-lfm2-audio binary ships with Aethon; \
     reinstall, or set AETHON_LFM2_AUDIO_BIN to its path.";
const ASR_SYSTEM_PROMPT: &str = "Perform ASR.";
// The 1.5B llama.cpp runner only accepts the bare task prompt; appending a
// voice name (e.g. "Use the UK male voice.") makes it abort with
// "Failed to init generation params", so voice selection is intentionally
// not exposed here (see the Phase 0 spike notes).
const TTS_SYSTEM_PROMPT: &str = "Perform TTS.";
// The runner defaults to `--predict -1` (unbounded) and the 1.5B model
// sometimes fails to emit an end token, rambling into a minutes-long clip for
// a short prompt. Cap generation to a ~60 s ceiling (~13 audio tokens/sec) so
// a wedged synthesis can't produce a runaway file. Callers further cap the
// *input* length (see speak-agent-replies).
const TTS_MAX_TOKENS: u32 = 768;
const CANCELLED_MESSAGE: &str = "Transcription cancelled.";
const SYNTHESIS_CANCELLED_MESSAGE: &str = "Speech synthesis cancelled.";
const LFM2_CANCEL_POLL: Duration = Duration::from_millis(100);
/// Mimi codec output sample rate, used as a fallback if the WAV header is
/// somehow missing the rate.
pub(super) const LFM2_TTS_SAMPLE_RATE: u32 = 24_000;

/// Resolved on-disk locations of the three GGUF files the runner needs.
pub(super) struct Lfm2ModelPaths {
    pub(super) lm: PathBuf,
    pub(super) encoder: PathBuf,
    pub(super) decoder: PathBuf,
}

pub(super) fn lfm2_model_paths(cache_path: &Path) -> Lfm2ModelPaths {
    Lfm2ModelPaths {
        lm: cache_path.join(LFM2_LM_FILE),
        encoder: cache_path.join(LFM2_ENCODER_FILE),
        decoder: cache_path.join(LFM2_DECODER_FILE),
    }
}

/// Locate the `llama-lfm2-audio` binary. Order: explicit dev override, a
/// sidecar staged next to the running executable (release bundle), then `PATH`
/// through the shared resolver in `env.rs`.
pub(super) fn resolve_lfm2_binary() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os(LFM2_BIN_ENV) {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
        && let Some(found) = bundled_lfm2_binary(dir)
    {
        return Some(found);
    }
    crate::env::resolve_program(LFM2_BIN_NAME)
}

/// Find the staged runner relative to the executable. Candidates, in order:
/// - `<dir>/llama-lfm2-audio` (direct sibling),
/// - `<dir>/lfm2-audio/llama-lfm2-audio` (subdir beside the exe — dev mirror),
/// - `<dir>/../Resources/lfm2-audio/llama-lfm2-audio` (macOS .app bundle: the
///   exe lives in `Contents/MacOS/`, Tauri `resources` land in
///   `Contents/Resources/`).
pub(super) fn bundled_lfm2_binary(exe_dir: &Path) -> Option<PathBuf> {
    let mut candidates = vec![
        exe_dir.join(LFM2_BIN_NAME),
        exe_dir.join(LFM2_BUNDLE_SUBDIR).join(LFM2_BIN_NAME),
    ];
    if let Some(contents) = exe_dir.parent() {
        candidates.push(
            contents
                .join("Resources")
                .join(LFM2_BUNDLE_SUBDIR)
                .join(LFM2_BIN_NAME),
        );
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Audio capabilities are injected through this trait so the registry can
/// substitute a fake in tests instead of spawning the real binary.
#[async_trait]
pub(super) trait Lfm2Backend: Send + Sync {
    /// Whether the runner binary can be located on this machine. Feeds the
    /// provider's readiness status without spawning anything.
    fn binary_available(&self) -> bool;

    /// Transcribe captured audio. `cancel` is polled cooperatively and kills
    /// the child process if it flips mid-run.
    async fn asr(&self, audio: CapturedAudio, cancel: Arc<AtomicBool>) -> Result<String, String>;

    /// Synthesize speech for `text`, returning 24 kHz mono PCM. `cancel` is
    /// polled cooperatively and kills the child process if it flips mid-run.
    async fn tts(&self, text: String, cancel: Arc<AtomicBool>) -> Result<CapturedAudio, String>;
}

pub(super) struct Lfm2CliBackend {
    model_root: PathBuf,
}

impl Lfm2CliBackend {
    pub(super) fn new(model_root: PathBuf) -> Self {
        Self { model_root }
    }

    fn cache_path(&self) -> PathBuf {
        self.model_root.join(LFM2_CACHE_DIR)
    }
}

#[async_trait]
impl Lfm2Backend for Lfm2CliBackend {
    fn binary_available(&self) -> bool {
        resolve_lfm2_binary().is_some()
    }

    async fn asr(&self, audio: CapturedAudio, cancel: Arc<AtomicBool>) -> Result<String, String> {
        let binary = resolve_lfm2_binary().ok_or_else(|| LFM2_BINARY_MISSING.to_string())?;
        let paths = lfm2_model_paths(&self.cache_path());
        // Held alive for the duration of the run; the CLI reads it from disk.
        // Dropped (and deleted) when this scope ends.
        let input_wav = write_input_wav(&audio)?;

        let mut command = crate::env::tokio_command(binary.to_string_lossy().as_ref());
        command
            .arg("-m")
            .arg(&paths.lm)
            .arg("--mmproj")
            .arg(&paths.encoder)
            .arg("-mv")
            .arg(&paths.decoder)
            .arg("-sys")
            .arg(ASR_SYSTEM_PROMPT)
            .arg("--audio")
            .arg(input_wav.path());

        let output = run_cli_capture(command, &cancel, CANCELLED_MESSAGE).await?;
        if !output.status.success() {
            return Err(format!(
                "LFM2-Audio transcription failed: {}",
                last_error_line(&output.stderr)
            ));
        }
        Ok(parse_asr_stdout(&output.stdout))
    }

    async fn tts(&self, text: String, cancel: Arc<AtomicBool>) -> Result<CapturedAudio, String> {
        let binary = resolve_lfm2_binary().ok_or_else(|| LFM2_BINARY_MISSING.to_string())?;
        let paths = lfm2_model_paths(&self.cache_path());
        // The runner writes the synthesized WAV to this path; held alive (and
        // cleaned up) for the duration of the call.
        let output_wav = tempfile::Builder::new()
            .prefix("aethon-lfm2-tts-")
            .suffix(".wav")
            .tempfile()
            .map_err(|e| format!("Failed to allocate temporary audio file: {e}"))?;

        let mut command = crate::env::tokio_command(binary.to_string_lossy().as_ref());
        command
            .arg("-m")
            .arg(&paths.lm)
            .arg("--mmproj")
            .arg(&paths.encoder)
            .arg("-mv")
            .arg(&paths.decoder)
            .arg("-sys")
            .arg(TTS_SYSTEM_PROMPT)
            .arg("-p")
            .arg(&text)
            .arg("-n")
            .arg(TTS_MAX_TOKENS.to_string())
            .arg("--output")
            .arg(output_wav.path());

        let output = run_cli_capture(command, &cancel, SYNTHESIS_CANCELLED_MESSAGE).await?;
        if !output.status.success() {
            return Err(format!(
                "LFM2-Audio speech synthesis failed: {}",
                last_error_line(&output.stderr)
            ));
        }
        read_output_wav(output_wav.path())
    }
}

/// Read the runner's synthesized WAV back into mono f32 PCM. TTS output is
/// 16-bit mono at 24 kHz, but stay tolerant of float samples / extra channels.
fn read_output_wav(path: &Path) -> Result<CapturedAudio, String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("Failed to open synthesized WAV: {e}"))?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let interleaved: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read synthesized samples: {e}"))?,
        (hound::SampleFormat::Int, 16) => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| f32::from(value) / f32::from(i16::MAX)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read synthesized samples: {e}"))?,
        (hound::SampleFormat::Int, bits @ (24 | 32)) => {
            let scale = (1_i64 << (bits - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Failed to read synthesized samples: {e}"))?
        }
        (format, bits) => {
            return Err(format!(
                "Unsupported synthesized WAV format: {format:?} {bits}-bit"
            ));
        }
    };

    let samples = if channels <= 1 {
        interleaved
    } else {
        interleaved
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect()
    };
    let sample_rate = if spec.sample_rate == 0 {
        LFM2_TTS_SAMPLE_RATE
    } else {
        spec.sample_rate
    };
    Ok(CapturedAudio {
        samples,
        sample_rate,
    })
}

struct CliOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

/// Spawn a runner command, draining stdout/stderr concurrently (so a full pipe
/// can't deadlock the child), while polling `cancel` to kill the process early.
async fn run_cli_capture(
    mut command: tokio::process::Command,
    cancel: &Arc<AtomicBool>,
    cancelled_message: &str,
) -> Result<CliOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to launch LFM2-Audio runner: {e}"))?;

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "LFM2-Audio runner stdout unavailable".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "LFM2-Audio runner stderr unavailable".to_string())?;
    let stdout_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stdout_pipe.read_to_string(&mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr_pipe.read_to_string(&mut buf).await;
        buf
    });

    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(cancelled_message.to_string());
        }
        // Re-create the wait future each tick so neither branch holds a
        // long-lived mutable borrow of `child` (the tokio::select! footgun).
        match tokio::time::timeout(LFM2_CANCEL_POLL, child.wait()).await {
            Ok(status) => break status.map_err(|e| format!("LFM2-Audio runner failed: {e}"))?,
            Err(_) => continue,
        }
    };

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    Ok(CliOutput {
        status,
        stdout,
        stderr,
    })
}

/// Write captured 16 kHz mono audio to a temporary 16-bit PCM WAV for the CLI.
fn write_input_wav(audio: &CapturedAudio) -> Result<tempfile::NamedTempFile, String> {
    let temp = tempfile::Builder::new()
        .prefix("aethon-lfm2-asr-")
        .suffix(".wav")
        .tempfile()
        .map_err(|e| format!("Failed to allocate temporary audio file: {e}"))?;
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(temp.path(), spec)
        .map_err(|e| format!("Failed to open WAV writer: {e}"))?;
    for &sample in &audio.samples {
        let scaled = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        writer
            .write_sample(scaled)
            .map_err(|e| format!("Failed to write WAV sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize WAV: {e}"))?;
    Ok(temp)
}

/// Extract the transcript from runner stdout, dropping the interleaved
/// llama.cpp/mtmd diagnostic lines. The remaining non-empty lines are the
/// model's generated text.
pub(super) fn parse_asr_stdout(stdout: &str) -> String {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_lfm2_diagnostic_line(line))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn is_lfm2_diagnostic_line(line: &str) -> bool {
    const DIAGNOSTIC_PREFIXES: &[&str] = &[
        "load_gguf:",
        "main:",
        "encoding audio slice",
        "audio slice encoded",
        "decoding audio batch",
        "audio decoded",
        "load_backend",
        "register_backend",
        "build:",
        "llama_",
        "ggml_",
        "clip_",
        "mtmd_",
        "init_audio:",
        "init:",
        "warming up",
        "<|audio_start|>",
        "decode_frame:",
        "decode:",
    ];
    DIAGNOSTIC_PREFIXES
        .iter()
        .any(|prefix| line.starts_with(prefix))
}

/// Pick the most informative line out of runner stderr for an error message.
fn last_error_line(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines
        .iter()
        .rev()
        .find(|line| line.starts_with("ERR") || line.contains("error") || line.contains("Error"))
        .or_else(|| lines.last())
        .map(|line| line.to_string())
        .unwrap_or_else(|| "unknown error".to_string())
}
