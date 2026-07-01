//! IPC surface for the streaming conversation engine (cascade voice mode).
//!
//! Mirrors `commands/voice.rs`: real implementations behind the `voice`
//! feature, shims otherwise so the JS binding surface (including parameter
//! names) stays intact and callers get the intended error instead of a Tauri
//! arg-parse failure.

#[cfg(feature = "voice")]
use std::sync::Arc;

#[cfg(feature = "voice")]
use serde::Serialize;
#[cfg(feature = "voice")]
use tauri::{AppHandle, State};

#[cfg(feature = "voice")]
use crate::helpers::config::{AethonConfig, VoiceConfig};
#[cfg(feature = "voice")]
use crate::voice::{
    AudioPlayer, CartesiaConnector, ConversationEngine, ConvoState, DeepgramFluxConnector,
    VoiceProviderRegistry, resolve_cascade_keys,
};

#[cfg(feature = "voice")]
fn load_voice_config(app: &AppHandle) -> VoiceConfig {
    let path = match crate::commands::config::aethon_state_path(app, "config.toml") {
        Ok(path) => path,
        Err(_) => return VoiceConfig::default(),
    };
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    toml::from_str::<AethonConfig>(&raw)
        .unwrap_or_default()
        .voice
}

#[cfg(feature = "voice")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConvoStatus {
    /// Whether the cascade pipeline can start (both provider keys resolve).
    pub available: bool,
    pub state: ConvoState,
    pub stt_provider: String,
    pub tts_provider: String,
    pub deepgram_key_present: bool,
    pub cartesia_key_present: bool,
    pub last_error: Option<String>,
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_status(
    app: AppHandle,
    convo: State<'_, ConversationEngine>,
) -> Result<VoiceConvoStatus, String> {
    let config = load_voice_config(&app);
    let keys = resolve_cascade_keys(&config);
    Ok(VoiceConvoStatus {
        available: keys.complete(),
        state: convo.state(),
        stt_provider: config
            .stt_provider
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "deepgram-flux".to_string()),
        tts_provider: config
            .tts_provider
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "cartesia".to_string()),
        deepgram_key_present: keys.deepgram.is_some(),
        cartesia_key_present: keys.cartesia.is_some(),
        last_error: convo.last_error(),
    })
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_start(
    app: AppHandle,
    voice: State<'_, VoiceProviderRegistry>,
    convo: State<'_, ConversationEngine>,
    player: State<'_, AudioPlayer>,
) -> Result<(), String> {
    if voice.recording_active() {
        return Err("Dictation is using the microphone — stop it first".to_string());
    }
    let config = load_voice_config(&app);
    let keys = resolve_cascade_keys(&config);
    let deepgram = keys.deepgram.ok_or_else(|| {
        "Deepgram API key missing — set DEEPGRAM_API_KEY or add it in Settings → Voice".to_string()
    })?;
    let cartesia = keys.cartesia.ok_or_else(|| {
        "Cartesia API key missing — set CARTESIA_API_KEY or add it in Settings → Voice".to_string()
    })?;

    let stt = Arc::new(DeepgramFluxConnector::new(deepgram));
    let tts = Arc::new(CartesiaConnector::new(cartesia, config.tts_voice.clone()));
    convo
        .start(
            Some(app.clone()),
            stt,
            tts,
            Arc::new(player.inner().clone()),
        )
        .await
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_stop(
    app: AppHandle,
    convo: State<'_, ConversationEngine>,
    player: State<'_, AudioPlayer>,
) -> Result<(), String> {
    convo.stop(Some(&app));
    player.stop();
    Ok(())
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_speak_chunk(
    text: String,
    convo: State<'_, ConversationEngine>,
) -> Result<(), String> {
    convo.speak_chunk(text)
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_speak_end(convo: State<'_, ConversationEngine>) -> Result<(), String> {
    convo.speak_end()
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_cancel_speech(convo: State<'_, ConversationEngine>) -> Result<(), String> {
    convo.cancel_speech()
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_force_end_turn(
    convo: State<'_, ConversationEngine>,
) -> Result<(), String> {
    convo.force_end_turn()
}

// Shim implementations (compiled when the `voice` feature is disabled).
#[cfg(not(feature = "voice"))]
const VOICE_NOT_BUILT: &str = "voice support not built into this binary";

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_status() -> Result<serde_json::Value, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_start() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_stop() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_speak_chunk(
    #[allow(unused_variables)] text: String,
) -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_speak_end() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_cancel_speech() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_force_end_turn() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}
