use std::path::Path;

use super::{PlatformSpeechAvailability, PlatformSpeechAvailabilityStatus};

#[cfg(target_os = "macos")]
pub(super) fn native_status(prepare: bool) -> PlatformSpeechAvailability {
    let mut code = 4_i32;
    let mut engine = 0_i32;
    let mut message = std::ptr::null_mut();
    if prepare {
        unsafe { aethon_platform_speech_prepare(&mut code, &mut engine, &mut message) };
    } else {
        unsafe { aethon_platform_speech_status(&mut code, &mut engine, &mut message) };
    }
    let message = unsafe { take_c_string(message) }
        .unwrap_or_else(|| "Apple speech status unavailable".to_string());
    availability_from_native(code, engine, message)
}

#[cfg(target_os = "macos")]
pub(super) fn transcribe_wav_path(path: &Path) -> Result<String, String> {
    use std::ffi::CString;

    let path = CString::new(path.display().to_string())
        .map_err(|_| "Platform speech audio path contains an interior nul byte".to_string())?;
    let mut code = 4_i32;
    let mut engine = 0_i32;
    let mut text_ptr = std::ptr::null_mut();
    let mut message_ptr = std::ptr::null_mut();
    unsafe {
        aethon_platform_speech_transcribe_file(
            path.as_ptr(),
            &mut code,
            &mut engine,
            &mut text_ptr,
            &mut message_ptr,
        )
    };
    let text = unsafe { take_c_string(text_ptr) }.unwrap_or_default();
    let message =
        unsafe { take_c_string(message_ptr) }.unwrap_or_else(|| engine_label(engine).to_string());

    if code == 0 { Ok(text) } else { Err(message) }
}

#[cfg(target_os = "macos")]
fn availability_from_native(code: i32, engine: i32, message: String) -> PlatformSpeechAvailability {
    let status = match code {
        0 => PlatformSpeechAvailabilityStatus::Ready,
        1 => PlatformSpeechAvailabilityStatus::NeedsMicrophonePermission,
        2 => PlatformSpeechAvailabilityStatus::NeedsSpeechPermission,
        5 => PlatformSpeechAvailabilityStatus::NeedsAssets,
        3 => PlatformSpeechAvailabilityStatus::EngineUnavailable,
        _ => PlatformSpeechAvailabilityStatus::Unavailable,
    };
    PlatformSpeechAvailability {
        status,
        engine_label: match engine {
            1 | 2 => Some(engine_label(engine).to_string()),
            _ => None,
        },
        message,
    }
}

#[cfg(target_os = "macos")]
fn engine_label(engine: i32) -> &'static str {
    match engine {
        1 => "Apple SpeechAnalyzer",
        2 => "Apple Speech",
        _ => "Apple Speech",
    }
}

#[cfg(target_os = "macos")]
unsafe fn take_c_string(pointer: *mut std::ffi::c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let value = unsafe { std::ffi::CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe { aethon_platform_speech_free_string(pointer) };
    Some(value)
}

#[cfg(target_os = "macos")]
pub(crate) fn cancel_active_transcription() {
    unsafe { aethon_platform_speech_cancel() };
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn aethon_platform_speech_status(
        code: *mut i32,
        engine: *mut i32,
        message: *mut *mut std::ffi::c_char,
    );
    fn aethon_platform_speech_prepare(
        code: *mut i32,
        engine: *mut i32,
        message: *mut *mut std::ffi::c_char,
    );
    fn aethon_platform_speech_transcribe_file(
        path: *const std::ffi::c_char,
        code: *mut i32,
        engine: *mut i32,
        text: *mut *mut std::ffi::c_char,
        message: *mut *mut std::ffi::c_char,
    );
    fn aethon_platform_speech_free_string(pointer: *mut std::ffi::c_char);
    fn aethon_platform_speech_cancel();
}
