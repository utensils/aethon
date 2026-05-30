use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{S_FALSE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Speech::{
    ISpRecoGrammar, ISpRecoResult, ISpRecognizer, ISpStream, SPEI_END_SR_STREAM,
    SPEI_FALSE_RECOGNITION, SPEI_RECOGNITION, SPEVENT, SPFM_OPEN_READONLY, SPLO_STATIC,
    SPRS_ACTIVE, SPRST_ACTIVE_ALWAYS, SPRST_INACTIVE, SpInprocRecognizer, SpStream,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize,
};
use windows::Win32::System::Threading::WaitForSingleObject;
use windows::core::{Interface, PCWSTR, PWSTR};

use super::PlatformSpeechAvailability;

// The SAPI event loop polls for events at ~30 Hz (33 ms wait interval).
// Each iteration: WaitForSingleObject → drain GetEvents → loop. That
// keeps end-of-stream latency low without spinning the CPU.
const EVENT_POLL_WAIT_MS: u32 = 33;
// Hard ceiling on the recognizer event loop. The Rust caller wraps
// `transcribe()` in `tokio::time::timeout(transcription_timeout)`
// (90 s by default), so this is just belt-and-suspenders against an
// engine that never emits SPEI_END_SR_STREAM after consuming the WAV.
const RECOGNITION_DEADLINE: Duration = Duration::from_secs(120);

// SAPI's `SPFEI()` macro maps an event ID to a 64-bit interest mask.
// The two reserved bits below (`SPFEI_FLAGCHECK` in the C++ headers)
// are required so the recognizer can distinguish "no interest set"
// from a literal 0 mask — without them, SetInterest is a no-op.
const SPFEI_FLAGCHECK: u64 = (1u64 << 30) | (1u64 << 33);

/// Convert a `SPEVENTENUM` event id into the bit mask
/// `ISpEventSource::SetInterest` expects. Mirrors the C++ `SPFEI`
/// macro 1-to-1.
const fn spfei(event_id: i32) -> u64 {
    SPFEI_FLAGCHECK | (1u64 << event_id)
}

pub(super) fn availability() -> PlatformSpeechAvailability {
    // SAPI 5.4 is bundled with every Windows install since 7, and the
    // `SpInprocRecognizer` CLSID is registered out of the box. We
    // could probe by calling `CoCreateInstance` here, but that costs
    // ~30 ms of COM initialization on every Settings refresh and the
    // trait contract is "report what looks ready and surface real
    // errors during `transcribe()`." Match the macOS pattern.
    PlatformSpeechAvailability::ready_now(
        "Windows SAPI",
        "Ready via Windows Speech API (SAPI 5.4 — no setup required)",
    )
}

pub(super) fn transcribe_wav_path(wav_path: &Path) -> Result<String, String> {
    // Pre-flight check: if the WAV doesn't exist or is smaller than a
    // minimal RIFF header, the recognizer's error would surface as a
    // generic "audio input unavailable" — fail loudly here instead.
    match std::fs::metadata(wav_path) {
        Ok(metadata) if metadata.len() < 44 => {
            let len = metadata.len();
            tracing::error!(
                target: "aethon::voice::platform_speech::windows",
                wav = %wav_path.display(),
                bytes = len,
                "Recorded WAV is shorter than a RIFF header — audio capture produced no usable data",
            );
            return Err(
                    "Couldn't load the recorded audio. Try recording again — see Settings → Diagnostics for details."
                        .to_string(),
                );
        }
        Err(err) => {
            tracing::error!(
                target: "aethon::voice::platform_speech::windows",
                wav = %wav_path.display(),
                error = %err,
                "Recorded WAV is not readable",
            );
            return Err(
                    "Couldn't load the recorded audio. Try recording again — see Settings → Diagnostics for details."
                        .to_string(),
                );
        }
        _ => {}
    }

    let _com = ComApartment::initialize().map_err(|hr| {
        tracing::error!(
            target: "aethon::voice::platform_speech::windows",
            hresult = %format!("0x{:08x}", hr),
            "CoInitializeEx failed",
        );
        user_facing_error(&format!("CoInitializeEx HRESULT 0x{hr:08x}"))
    })?;

    match unsafe { transcribe_with_sapi(wav_path) } {
        Ok(text) => Ok(text),
        Err(SapiError {
            stage,
            hresult,
            message,
        }) => {
            tracing::error!(
                target: "aethon::voice::platform_speech::windows",
                wav = %wav_path.display(),
                stage = %stage,
                hresult = %format!("0x{hresult:08x}"),
                detail = %message,
                "SAPI transcription failed",
            );
            Err(user_facing_error_for_hresult(stage, hresult))
        }
    }
}

/// Owned COM-apartment guard. `CoInitializeEx` returns `S_FALSE` on
/// nested calls (already initialized on this thread) — we only call
/// `CoUninitialize` when WE were the call that initialized, otherwise
/// we'd tear down a higher caller's apartment. The Drop impl runs on
/// every exit path including panics, which the previous `let _ =
/// CoUninitialize();` at the bottom of a function did NOT.
struct ComApartment {
    owns: bool,
}

impl ComApartment {
    fn initialize() -> Result<Self, u32> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        // `HRESULT::is_ok()` returns true for any non-negative status,
        // which includes both S_OK *and* S_FALSE — the previous
        // ordering made the S_FALSE arm dead code. Check S_FALSE
        // first so a nested-init caller doesn't tear down a parent's
        // apartment when our guard drops.
        if hr == S_FALSE {
            // Apartment was already initialized on this thread by an
            // earlier caller — we ride along without owning the
            // uninit, so Drop becomes a no-op.
            Ok(Self { owns: false })
        } else if hr.is_ok() {
            Ok(Self { owns: true })
        } else {
            Err(hr.0 as u32)
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.owns {
            unsafe { CoUninitialize() };
        }
    }
}

/// Structured error from the SAPI call site — `stage` names which step
/// failed (so the daily log is greppable), `hresult` is the raw COM
/// status, and `message` is the formatted `windows::core::Error`
/// description for the log line.
struct SapiError {
    stage: &'static str,
    hresult: u32,
    message: String,
}

impl SapiError {
    fn from_windows(stage: &'static str, err: windows::core::Error) -> Self {
        Self {
            stage,
            hresult: err.code().0 as u32,
            message: err.message(),
        }
    }
}

/// Drive a single recognition pass against the WAV. All the COM
/// interfaces are kept in scope until the function returns so their
/// Drop calls Release in the correct order: grammar → context →
/// recognizer → stream. The COM apartment guard above outlives all
/// of them via the caller's stack frame.
unsafe fn transcribe_with_sapi(wav_path: &Path) -> Result<String, SapiError> {
    let recognizer: ISpRecognizer =
        unsafe { CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL) }
            .map_err(|e| SapiError::from_windows("CoCreateInstance(SpInprocRecognizer)", e))?;

    let stream: ISpStream = unsafe { CoCreateInstance(&SpStream, None, CLSCTX_ALL) }
        .map_err(|e| SapiError::from_windows("CoCreateInstance(SpStream)", e))?;

    // Bind the stream to the WAV file on disk. Passing `None` for both
    // the format ID and `WAVEFORMATEX` lets SAPI parse the RIFF header
    // itself — exactly the behaviour we want, vs. having to hand-tune
    // a `WAVEFORMATEX` that matches what we wrote.
    let mut path_w: Vec<u16> = OsStr::new(wav_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        stream.BindToFile(
            PCWSTR(path_w.as_mut_ptr()),
            SPFM_OPEN_READONLY,
            None,
            None,
            0,
        )
    }
    .map_err(|e| SapiError::from_windows("ISpStream::BindToFile", e))?;

    unsafe { recognizer.SetInput(&stream, false) }
        .map_err(|e| SapiError::from_windows("ISpRecognizer::SetInput", e))?;

    let context = unsafe { recognizer.CreateRecoContext() }
        .map_err(|e| SapiError::from_windows("ISpRecognizer::CreateRecoContext", e))?;

    unsafe { context.SetNotifyWin32Event() }
        .map_err(|e| SapiError::from_windows("ISpRecoContext::SetNotifyWin32Event", e))?;

    let event_handle = unsafe { context.GetNotifyEventHandle() };
    if event_handle.0.is_null() {
        return Err(SapiError {
            stage: "ISpRecoContext::GetNotifyEventHandle",
            hresult: 0,
            message: "GetNotifyEventHandle returned a null HANDLE".to_string(),
        });
    }

    let interest_mask =
        spfei(SPEI_RECOGNITION.0) | spfei(SPEI_END_SR_STREAM.0) | spfei(SPEI_FALSE_RECOGNITION.0);
    unsafe { context.SetInterest(interest_mask, interest_mask) }
        .map_err(|e| SapiError::from_windows("ISpRecoContext::SetInterest", e))?;

    let grammar: ISpRecoGrammar = unsafe { context.CreateGrammar(0) }
        .map_err(|e| SapiError::from_windows("ISpRecoContext::CreateGrammar", e))?;

    unsafe { grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC) }
        .map_err(|e| SapiError::from_windows("ISpRecoGrammar::LoadDictation", e))?;

    unsafe { grammar.SetDictationState(SPRS_ACTIVE) }
        .map_err(|e| SapiError::from_windows("ISpRecoGrammar::SetDictationState", e))?;

    unsafe { recognizer.SetRecoState(SPRST_ACTIVE_ALWAYS) }
        .map_err(|e| SapiError::from_windows("ISpRecognizer::SetRecoState(ACTIVE)", e))?;

    // Pull the transcript out of the event stream. Each phrase ends
    // with an `SPEI_RECOGNITION` event whose `lParam` is an
    // `ISpRecoResult*`; the WAV-exhausted condition fires
    // `SPEI_END_SR_STREAM`. False recognitions (engine couldn't decide
    // what was said) are gathered by `SPEI_FALSE_RECOGNITION` so we
    // can include them with low confidence rather than dropping
    // mumbled audio entirely.
    let mut transcript = String::new();
    let started = Instant::now();
    loop {
        if started.elapsed() > RECOGNITION_DEADLINE {
            tracing::warn!(
                target: "aethon::voice::platform_speech::windows",
                "SAPI event loop hit RECOGNITION_DEADLINE without SPEI_END_SR_STREAM",
            );
            break;
        }

        let wait = unsafe { WaitForSingleObject(event_handle, EVENT_POLL_WAIT_MS) };
        // Three distinct outcomes:
        //   * WAIT_OBJECT_0 — handle signaled; drain events below.
        //   * WAIT_TIMEOUT  — recognizer is mid-utterance and just
        //                    hasn't emitted yet; loop on the outer
        //                    `RECOGNITION_DEADLINE` budget.
        //   * Anything else — WAIT_FAILED (GetLastError-bearing) or
        //                    WAIT_ABANDONED. Log and bail; spinning
        //                    here would mask a real OS-level fault
        //                    until the deadline.
        match wait {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => continue,
            other => {
                return Err(SapiError {
                    stage: "WaitForSingleObject(ISpRecoContext event)",
                    hresult: if other == WAIT_FAILED { 0 } else { other.0 },
                    message: format!(
                        "WaitForSingleObject returned unexpected status {:#x}",
                        other.0
                    ),
                });
            }
        }

        let mut done = false;
        loop {
            let mut event = SPEVENT::default();
            let mut fetched = 0u32;
            // GetEvents returns Err on a real COM failure; on success
            // (including "no events available right now") it returns
            // Ok and fetched stays 0. Match on the Result directly —
            // the previous chain compared an HRESULT alongside Err
            // which was both redundant and harder to follow.
            if let Err(err) = unsafe { context.GetEvents(1, &mut event, &mut fetched) } {
                return Err(SapiError::from_windows("ISpRecoContext::GetEvents", err));
            }
            if fetched == 0 {
                break;
            }

            // _bitfield packs `eEventId` in the low 16 bits and
            // `elParamType` in the next 16 bits. We only need the
            // event id to dispatch.
            let event_id = (event._bitfield & 0xFFFF) as i32;
            if event_id == SPEI_RECOGNITION.0 || event_id == SPEI_FALSE_RECOGNITION.0 {
                if let Some(text) = unsafe { extract_recognition_text(&event) } {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        if !transcript.is_empty() {
                            transcript.push(' ');
                        }
                        transcript.push_str(trimmed);
                    }
                }
            } else if event_id == SPEI_END_SR_STREAM.0 {
                done = true;
            }

            // Release any lParam that holds an IUnknown*. SAPI's C++
            // SDK ships an `SPCLEAREVENT` macro that does this; we
            // inline the equivalent. `elParamType` lives in the upper
            // 16 bits of `_bitfield`. Type 1 (`SPET_LPARAM_IS_OBJECT`)
            // means lParam is an IUnknown*.
            let elparam_type = (event._bitfield >> 16) & 0xFFFF;
            if elparam_type == 1 && event.lParam.0 != 0 {
                let raw = event.lParam.0 as *mut std::ffi::c_void;
                if !raw.is_null() {
                    let unknown = unsafe { windows::core::IUnknown::from_raw(raw) };
                    drop(unknown); // Release happens via Drop
                }
            }
        }

        if done {
            break;
        }
    }

    // SetRecoState(SPRST_INACTIVE) flushes any in-flight recognizer
    // state so the next call (recognizer/grammar/context drop below)
    // doesn't race against the engine still processing audio.
    let _ = unsafe { recognizer.SetRecoState(SPRST_INACTIVE) };

    // grammar / context / recognizer / stream all drop here in
    // reverse order of construction.
    drop(grammar);
    drop(context);
    drop(recognizer);
    drop(stream);
    // Touch path_w so it stays alive through the `BindToFile` call —
    // BindToFile copies the path, but make the lifetime explicit.
    path_w.clear();

    if transcript.is_empty() {
        // Empty transcript on a successful event loop = recognizer
        // saw audio but couldn't match a phrase. Same UX as the
        // macOS path (`stop_platform_recording` rejects empty).
        // Leave the empty string so `voice.rs` produces the
        // standard "No speech was recognized" error.
    }

    Ok(transcript)
}

/// Pull the recognized text out of an `SPEI_RECOGNITION` /
/// `SPEI_FALSE_RECOGNITION` event. `lParam` holds an
/// `ISpRecoResult*`; `GetText(0, 0xFFFFFFFF, true, ...)` returns the
/// full phrase. Caller is responsible for releasing the result via
/// the SPCLEAREVENT logic in the dispatch loop.
unsafe fn extract_recognition_text(event: &SPEVENT) -> Option<String> {
    if event.lParam.0 == 0 {
        return None;
    }
    let raw = event.lParam.0 as *mut std::ffi::c_void;
    // `from_raw` takes ownership of one reference. We need to keep the
    // event's reference intact for the dispatcher's SPCLEAREVENT
    // cleanup, so AddRef before borrowing.
    let unknown = unsafe { windows::core::IUnknown::from_raw_borrowed(&raw) }?;
    let result: ISpRecoResult = unknown.cast().ok()?;

    let mut text_ptr = PWSTR::null();
    let hr = unsafe { result.GetText(0, u32::MAX, true, &mut text_ptr, None) };
    if hr.is_err() || text_ptr.is_null() {
        return None;
    }

    let text = unsafe { text_ptr.to_string().ok() };
    unsafe { CoTaskMemFree(Some(text_ptr.as_ptr() as *const _)) };
    text
}

/// One-line, actionable user-facing error string. The raw HRESULT and
/// stage name still flow into the daily log via the `tracing::error!`
/// at the call site; this is only the toolbar pill copy.
///
/// Public so the test module can pin the contract that every message
/// is short, single-line, and free of HRESULT codes / type names.
pub(super) fn user_facing_error(detail: &str) -> String {
    // Most callers go through `user_facing_error_for_hresult`; this
    // string-based variant only handles the rare CoInitializeEx
    // failure where we don't yet have a structured stage.
    if detail.contains("CoInitializeEx") {
        "Couldn't initialize Windows COM for speech recognition. Restart Aethon; if it persists, switch to the offline Distil-Whisper provider in Voice settings.".to_string()
    } else {
        "Speech recognition failed. See Settings → Diagnostics → Open log directory for details."
            .to_string()
    }
}

/// Map a SAPI failure stage + HRESULT to a short user-facing string.
/// The most common failures get tailored copy with a concrete next
/// step; everything else falls through to the generic "see
/// diagnostics log" pointer.
pub(super) fn user_facing_error_for_hresult(stage: &str, hresult: u32) -> String {
    // SPERR_NOT_FOUND (0x8004503A) — no recognizer installed for the
    // requested locale. Fires from `CoCreateInstance(SpInprocRecognizer)`
    // when the OS has no speech engine registered.
    const SPERR_NOT_FOUND: u32 = 0x8004503A;
    // SPERR_AUDIO_BUFFER_OVERFLOW (0x8004502A) and friends mean the
    // audio source isn't producing data the recognizer can consume.
    const SPERR_UNINITIALIZED: u32 = 0x80045028;
    // CLASS_E_CLASSNOTAVAILABLE (0x80040111) — SAPI not installed.
    const CLASS_E_CLASSNOTAVAILABLE: u32 = 0x80040111;
    // REGDB_E_CLASSNOTREG (0x80040154) — same as above on most boxes.
    const REGDB_E_CLASSNOTREG: u32 = 0x80040154;
    // E_OUTOFMEMORY (0x8007000E) and E_ACCESSDENIED (0x80070005) get
    // their own messages so users have something to act on.
    const E_OUTOFMEMORY: u32 = 0x8007000E;
    const E_ACCESSDENIED: u32 = 0x80070005;

    match hresult {
            SPERR_NOT_FOUND => {
                "Windows speech recognizer is not installed. Add a Speech Recognizer language pack in Windows Settings → Time & language → Speech.".to_string()
            }
            CLASS_E_CLASSNOTAVAILABLE | REGDB_E_CLASSNOTREG => {
                "Windows Speech API (SAPI) is not registered on this machine. Switch to the offline Distil-Whisper provider in Voice settings.".to_string()
            }
            SPERR_UNINITIALIZED => {
                "Windows speech recognizer reported its audio input was not initialized. Try recording again — see Settings → Diagnostics for details.".to_string()
            }
            E_ACCESSDENIED => {
                "Windows denied access to the recorded audio file. Check antivirus / sandbox settings, then try again.".to_string()
            }
            E_OUTOFMEMORY => {
                "Windows speech recognizer ran out of memory. Try a shorter recording.".to_string()
            }
            _ if stage.starts_with("ISpStream::BindToFile") => {
                "Couldn't load the recorded audio. Try recording again — see Settings → Diagnostics for details.".to_string()
            }
            _ => {
                "Speech recognition failed. See Settings → Diagnostics → Open log directory for details.".to_string()
            }
        }
}
