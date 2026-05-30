// The platform speech bridge gives the cross-platform `voice.rs` a single
// trait it can lean on regardless of whether the host OS exposes a native
// recognizer (macOS Apple Speech, Windows SAPI 5.4), or only a stub
// fallback (Linux for now). Each `#[cfg(...)]` impl block below shares the
// trait definition so callers in voice.rs do not need any per-OS branching
// once they hold a `&dyn PlatformSpeechEngine`.
//
// The macOS path links to a small Swift static library (see build.rs) that
// drives `SFSpeechRecognizer` / `SpeechAnalyzer`. The Windows path drives
// SAPI 5.4 directly via COM through the `windows` crate — no .NET, no
// PowerShell shell-out, no extra runtime. Both feed the same captured-
// audio buffer produced by `CpalAudioRecorder`, written to a temporary
// 16-bit PCM WAV before the engine reads it back.

#[cfg(any(target_os = "macos", windows))]
use std::path::Path;

use crate::voice::CapturedAudio;

// The non-Ready/non-Unavailable variants are only constructed on macOS via
// availability_from_native(). Keeping the full enum cross-platform avoids
// cfg-gating every match arm in voice.rs.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlatformSpeechAvailabilityStatus {
    Ready,
    NeedsMicrophonePermission,
    NeedsSpeechPermission,
    NeedsAssets,
    EngineUnavailable,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformSpeechAvailability {
    pub status: PlatformSpeechAvailabilityStatus,
    pub engine_label: Option<String>,
    pub message: String,
}

impl PlatformSpeechAvailability {
    // Test constructors used only by the macOS/Windows-gated
    // platform-speech tests — gate them the same way so they aren't dead
    // code on Linux, where `cargo test --no-run` compiles test targets
    // under `-Dwarnings`.
    #[cfg(all(test, any(target_os = "macos", windows)))]
    pub(crate) fn ready(engine_label: &str) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::Ready,
            engine_label: Some(engine_label.to_string()),
            message: format!("Ready via {engine_label}"),
        }
    }

    #[cfg(all(test, any(target_os = "macos", windows)))]
    pub(crate) fn needs_speech_permission(message: &str) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::NeedsSpeechPermission,
            engine_label: None,
            message: message.to_string(),
        }
    }

    // Windows-only — the SAPI bridge advertises Ready up front; the
    // EngineUnavailable variants are reserved for the macOS native
    // status path or future probes that decide they need to gate the
    // provider before the user clicks the mic.
    #[cfg(windows)]
    fn ready_now(engine_label: &str, message: impl Into<String>) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::Ready,
            engine_label: Some(engine_label.to_string()),
            message: message.into(),
        }
    }

    // Only the Linux/other-OS stub uses this — both macOS and Windows have
    // real engines that surface concrete states. Gated tightly so dead-code
    // lint stays quiet under `-Dwarnings` on platforms that never reach it.
    #[cfg(not(any(target_os = "macos", windows)))]
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::Unavailable,
            engine_label: None,
            message: message.into(),
        }
    }
}

pub(crate) trait PlatformSpeechEngine: Send + Sync {
    fn availability(&self) -> PlatformSpeechAvailability;
    // Only the macOS implementation actually triggers TCC permission prompts;
    // the Windows + cross-platform fallbacks reuse availability(). Allowed-as-
    // dead in the test build path that exercises only macOS-style flows.
    #[allow(dead_code)]
    fn prepare(&self) -> PlatformSpeechAvailability;
    fn transcribe(&self, audio: CapturedAudio) -> Result<String, String>;
}

#[derive(Debug, Default)]
pub(crate) struct DefaultPlatformSpeechEngine;

impl DefaultPlatformSpeechEngine {
    pub(crate) fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "macos")]
impl PlatformSpeechEngine for DefaultPlatformSpeechEngine {
    fn availability(&self) -> PlatformSpeechAvailability {
        macos::native_status(false)
    }

    fn prepare(&self) -> PlatformSpeechAvailability {
        macos::native_status(true)
    }

    fn transcribe(&self, audio: CapturedAudio) -> Result<String, String> {
        let wav_path = temp_wav_path();
        write_wav(&wav_path, &audio)?;
        let result = macos::transcribe_wav_path(&wav_path);
        let _ = std::fs::remove_file(&wav_path);
        result
    }
}

#[cfg(windows)]
impl PlatformSpeechEngine for DefaultPlatformSpeechEngine {
    fn availability(&self) -> PlatformSpeechAvailability {
        windows_speech::availability()
    }

    fn prepare(&self) -> PlatformSpeechAvailability {
        // Windows does not have a TCC-style "prepare" prompt the way macOS
        // does — microphone permission is granted/denied at the OS level
        // through Settings → Privacy → Microphone, and SAPI consumes the
        // WAV file directly without re-asking. Returning the static
        // availability keeps the trait shape symmetric with macOS.
        windows_speech::availability()
    }

    fn transcribe(&self, audio: CapturedAudio) -> Result<String, String> {
        let wav_path = temp_wav_path();
        write_wav(&wav_path, &audio)?;
        let sample_count = audio.samples.len();
        let sample_rate = audio.sample_rate;
        let result = windows_speech::transcribe_wav_path(&wav_path);
        if let Err(error) = &result {
            // Funnel everything we know about the failure through the global
            // tracing pipeline (`aethon::logging`). The daily-rotated log
            // file under Settings → Diagnostics → Open log directory captures
            // the structured fields, so no parallel debug-file scheme.
            tracing::warn!(
                target: "aethon::voice::platform_speech::windows",
                sample_count,
                sample_rate,
                wav = %wav_path.display(),
                error = %error,
                "Windows system dictation failed",
            );
        }
        // Always clean up the temp WAV. The daily log holds the diagnostic
        // context now that we route through tracing — keeping multi-MB WAVs
        // around per failure was a debugging crutch, not a feature.
        let _ = std::fs::remove_file(&wav_path);
        result
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
impl PlatformSpeechEngine for DefaultPlatformSpeechEngine {
    fn availability(&self) -> PlatformSpeechAvailability {
        PlatformSpeechAvailability::unavailable(
            "Native platform dictation is not implemented on this OS yet. Use the offline Distil-Whisper provider in Voice settings.",
        )
    }

    fn prepare(&self) -> PlatformSpeechAvailability {
        self.availability()
    }

    fn transcribe(&self, _audio: CapturedAudio) -> Result<String, String> {
        Err("Native platform dictation is not implemented on this OS yet.".to_string())
    }
}

#[cfg(any(target_os = "macos", windows))]
fn temp_wav_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "aethon-platform-speech-{}-{}.wav",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[cfg(any(target_os = "macos", windows))]
fn write_wav(path: &Path, audio: &CapturedAudio) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("Failed to create platform speech audio file: {e}"))?;
    for sample in &audio.samples {
        let sample = sample.clamp(-1.0, 1.0);
        let pcm = (sample * i16::MAX as f32).round() as i16;
        writer
            .write_sample(pcm)
            .map_err(|e| format!("Failed to write platform speech audio: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize platform speech audio: {e}"))
}

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub(crate) use macos::cancel_active_transcription;

// Windows speech recognition bridge — drives SAPI 5.4's in-process
// recognizer (`SpInprocRecognizer`) directly via COM through the
// `windows` crate. SAPI 5.4 ships with every Windows install since 7
// (no .NET, no PowerShell, no extra runtime), accepts arbitrary WAV
// files via `ISpStream::BindToFile`, and surfaces real HRESULT codes
// for diagnosis.
//
// Earlier iterations shelled out to `powershell.exe` +
// `System.Speech.Recognition.SpeechRecognitionEngine`, but the .NET
// path on Windows ARM64 / under emulation was unreliable: the
// recognizer would throw "No audio input is supplied to this
// recognizer" mid-call after a successful `SetInputToWaveFile`,
// because the implicitly-opened FileStream got closed before
// `Recognize()` consumed it. Owning the COM lifecycle ourselves
// removes that whole class of bug — we keep `ISpStream` alive across
// the full recognition loop and the recognizer can't lose it.
//
// Threading: COM is initialized as Apartment Threaded (STA) on the
// caller thread. Voice transcription runs inside `tokio::task::
// spawn_blocking` (see `voice.rs::stop_platform_recording`), so this
// thread is dedicated to the call and tearing it down on return is
// safe. The COM cleanup sentinel below ensures `CoUninitialize` runs
// on every exit path including panics.
#[cfg(windows)]
mod windows_speech;

// On Windows, voice.rs reaches for `cancel_active_transcription` from the
// shared platform-speech surface. The native SAPI path has no cooperative-
// cancel hook reachable from outside the recognition thread — the
// `RECOGNITION_DEADLINE` event-loop ceiling and the outer `transcription_
// timeout` in `voice.rs::stop_platform_recording` together cover the
// runaway-engine case.
#[cfg(windows)]
pub(crate) fn cancel_active_transcription() {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn platform_speech_bridge_reports_status_without_prompt() {
        let availability = DefaultPlatformSpeechEngine::new().availability();

        assert!(!availability.message.trim().is_empty());
    }

    #[test]
    fn platform_speech_bridge_refuses_unbundled_permission_prompts() {
        let availability = DefaultPlatformSpeechEngine::new().prepare();

        assert_eq!(
            availability.status,
            PlatformSpeechAvailabilityStatus::EngineUnavailable
        );
        assert!(availability.message.contains(".app bundle"));
    }

    #[test]
    #[ignore = "requires AETHON_PLATFORM_SPEECH_SAMPLE_WAV and macOS speech permissions"]
    fn ignored_platform_speech_transcribes_fixture_wav() {
        let sample_path = std::env::var_os("AETHON_PLATFORM_SPEECH_SAMPLE_WAV")
            .map(std::path::PathBuf::from)
            .expect("set AETHON_PLATFORM_SPEECH_SAMPLE_WAV to a short speech WAV");

        let transcript = macos::transcribe_wav_path(&sample_path).expect("transcribe fixture");

        assert!(!transcript.trim().is_empty());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_availability_reports_ready_via_sapi() {
        // SAPI 5.4 is bundled with every Windows install; the trait
        // contract is "advertise Ready and let `transcribe()` surface
        // real failures." Nothing to probe here.
        let availability = DefaultPlatformSpeechEngine::new().availability();

        assert_eq!(
            availability.status,
            PlatformSpeechAvailabilityStatus::Ready,
            "expected Ready on Windows (got {availability:?})",
        );
        assert_eq!(availability.engine_label.as_deref(), Some("Windows SAPI"));
        assert!(
            !availability.message.is_empty(),
            "availability message must populate the toolbar / Voice panel",
        );
    }

    #[test]
    fn windows_user_facing_messages_are_short_and_clean() {
        // The toolbar pill renders the user-facing string verbatim. Every
        // message we can produce must stay one line and short enough to
        // fit the 280px / 32vw error pill without ellipsizing the
        // actionable bit. HRESULT codes and stage names belong in the
        // tracing log, never the pill.
        let hresults = [
            ("CoCreateInstance(SpInprocRecognizer)", 0x8004503Au32), // SPERR_NOT_FOUND
            ("CoCreateInstance(SpInprocRecognizer)", 0x80040111u32), // CLASS_E_CLASSNOTAVAILABLE
            ("CoCreateInstance(SpInprocRecognizer)", 0x80040154u32), // REGDB_E_CLASSNOTREG
            ("ISpStream::BindToFile", 0x80070003u32),                // ERROR_PATH_NOT_FOUND
            ("ISpStream::BindToFile", 0x80070005u32),                // E_ACCESSDENIED
            ("ISpRecognizer::SetInput", 0x80045028u32),              // SPERR_UNINITIALIZED
            ("ISpRecognizer::SetRecoState(ACTIVE)", 0x8007000Eu32),  // E_OUTOFMEMORY
            ("ISpRecoContext::CreateGrammar", 0x8000_0000u32),       // unknown HRESULT
        ];
        for (stage, hr) in hresults {
            let pill = windows_speech::user_facing_error_for_hresult(stage, hr);
            assert!(
                !pill.contains('\n'),
                "user-facing message must be single line: {pill:?}",
            );
            assert!(
                pill.len() < 220,
                "user-facing message too long ({}): {pill:?}",
                pill.len(),
            );
            assert!(
                !pill.contains("0x") && !pill.contains("HRESULT"),
                "user-facing message leaked HRESULT detail: {pill:?}",
            );
            assert!(
                !pill.contains("ISp") && !pill.contains("CoCreateInstance"),
                "user-facing message leaked SAPI/COM symbol names: {pill:?}",
            );
        }
    }

    #[test]
    fn windows_user_facing_messages_match_known_hresults() {
        // Pin the specific copy for the user-impacting failures so a
        // refactor doesn't silently replace the actionable hint with the
        // generic fallback. Anything not pinned here is allowed to drift
        // — these three are the failures users can fix themselves.
        let pill = windows_speech::user_facing_error_for_hresult(
            "CoCreateInstance(SpInprocRecognizer)",
            0x8004503A, // SPERR_NOT_FOUND
        );
        assert!(
            pill.contains("Speech Recognizer language pack"),
            "missing recognizer must point users at the language-pack install: {pill:?}",
        );

        let pill = windows_speech::user_facing_error_for_hresult(
            "CoCreateInstance(SpInprocRecognizer)",
            0x80040154, // REGDB_E_CLASSNOTREG
        );
        assert!(
            pill.contains("Distil-Whisper"),
            "SAPI-not-registered must offer the offline fallback: {pill:?}",
        );

        let pill =
            windows_speech::user_facing_error_for_hresult("ISpStream::BindToFile", 0x80070005);
        assert!(
            pill.contains("denied"),
            "E_ACCESSDENIED on the WAV must mention access denial: {pill:?}",
        );
    }

    #[test]
    fn windows_unknown_hresult_falls_back_to_diagnostics_pointer() {
        // Anything we haven't mapped should still send the user to
        // Settings → Diagnostics rather than dump the raw error. Pin
        // this so a future contributor adding HRESULT cases doesn't
        // accidentally remove the safety net.
        let pill =
            windows_speech::user_facing_error_for_hresult("ISpRecoContext::GetEvents", 0xDEADBEEF);
        assert!(pill.contains("Settings → Diagnostics"));
    }

    #[test]
    fn windows_coinit_failure_message_mentions_distil_whisper_fallback() {
        // CoInitializeEx failure is unrecoverable from inside the
        // recognizer call, so the only useful next step is the offline
        // provider. Pin the copy that says so.
        let pill = windows_speech::user_facing_error("CoInitializeEx HRESULT 0x80004005");
        assert!(pill.contains("Distil-Whisper"));
        assert!(!pill.contains("HRESULT"));
    }
}
