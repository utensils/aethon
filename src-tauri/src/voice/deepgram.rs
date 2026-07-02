//! Batch cloud dictation via Deepgram's prerecorded `listen` API — the
//! dictation counterpart of the conversation engine's streaming Flux socket.
//! Same key resolution as the cascade (env wins over config.toml), same
//! record→stop→transcribe lifecycle as the local providers: the whole clip
//! posts as raw 16 kHz PCM and the transcript comes back in one response.

use super::*;

/// Model for one-shot dictation clips. Nova-3 is Deepgram's general-purpose
/// high-accuracy tier (Flux, used by the conversation engine, is
/// streaming-only).
const DEEPGRAM_BATCH_MODEL: &str = "nova-3";
pub(super) const DEEPGRAM_BATCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Resolve the Deepgram key the same way the conversation cascade does:
/// `DEEPGRAM_API_KEY` env, else `[voice] deepgram_api_key` in config.toml.
/// Read from disk on demand — dictation status checks are infrequent and the
/// key can change under us via Settings.
pub(super) fn resolve_deepgram_key() -> Option<String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    let config = crate::helpers::aethon_dir(home)
        .map(|dir| dir.join("config.toml"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| toml::from_str::<crate::helpers::config::AethonConfig>(&raw).ok())
        .map(|cfg| cfg.voice)
        .unwrap_or_default();
    super::resolve_cascade_keys(&config).deepgram
}

pub(super) async fn deepgram_transcribe_batch(
    api_key: &str,
    audio: CapturedAudio,
) -> Result<String, String> {
    let mut body = Vec::with_capacity(audio.samples.len() * 2);
    for sample in &audio.samples {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
        body.extend_from_slice(&value.to_le_bytes());
    }
    let url = format!(
        "https://api.deepgram.com/v1/listen?model={DEEPGRAM_BATCH_MODEL}&smart_format=true&encoding=linear16&sample_rate={}&channels=1",
        audio.sample_rate
    );
    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .header("Authorization", format!("Token {api_key}"))
        .header("Content-Type", "application/octet-stream")
        .timeout(DEEPGRAM_BATCH_TIMEOUT)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Deepgram request failed: {e}"))?;
    if response.status().as_u16() == 401 {
        return Err("Deepgram rejected the API key".to_string());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Deepgram transcription failed (HTTP {})",
            response.status()
        ));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Deepgram response parse failed: {e}"))?;
    Ok(
        value["results"]["channels"][0]["alternatives"][0]["transcript"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string(),
    )
}
