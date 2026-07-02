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
    AudioPlayer, CartesiaConnector, CartesiaVoiceInfo, ConversationEngine, ConvoState,
    DeepgramFluxConnector, LOCAL_STT_PROVIDER, LOCAL_TTS_PROVIDER, Lfm2TtsConnector,
    LocalWhisperConnector, SttConnector, TtsConnector, VoiceProviderRegistry, list_cartesia_voices,
    resolve_cascade_keys,
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
    /// Whether the cascade pipeline can start (each stage resolves to a
    /// usable provider — cloud key or ready local model).
    pub available: bool,
    pub state: ConvoState,
    /// Resolved provider per stage (what a conversation would actually use),
    /// or the configured name when unresolvable.
    pub stt_provider: String,
    pub tts_provider: String,
    /// Why a stage can't run, when it can't.
    pub stt_error: Option<String>,
    pub tts_error: Option<String>,
    pub deepgram_key_present: bool,
    pub cartesia_key_present: bool,
    pub last_error: Option<String>,
}

#[cfg(feature = "voice")]
const DEEPGRAM_PROVIDER: &str = "deepgram-flux";
#[cfg(feature = "voice")]
const CARTESIA_PROVIDER: &str = "cartesia";

/// Resolve the STT stage to a concrete provider. `"auto"` (the default)
/// prefers the cloud provider when its key resolves and falls back to the
/// local model — so a single saved key is enough to light the cascade up.
#[cfg(feature = "voice")]
fn resolve_stt_provider(
    config: &VoiceConfig,
    registry: &VoiceProviderRegistry,
    deepgram_key: bool,
) -> Result<&'static str, String> {
    match config.stt_provider.as_deref().unwrap_or("auto") {
        LOCAL_STT_PROVIDER => {
            if LocalWhisperConnector::ready(registry) {
                Ok(LOCAL_STT_PROVIDER)
            } else {
                Err("the local Whisper model isn't downloaded".to_string())
            }
        }
        DEEPGRAM_PROVIDER => {
            if deepgram_key {
                Ok(DEEPGRAM_PROVIDER)
            } else {
                Err("no Deepgram API key".to_string())
            }
        }
        _ => {
            if deepgram_key {
                Ok(DEEPGRAM_PROVIDER)
            } else if LocalWhisperConnector::ready(registry) {
                Ok(LOCAL_STT_PROVIDER)
            } else {
                Err("no Deepgram API key and the local Whisper model isn't downloaded".to_string())
            }
        }
    }
}

#[cfg(feature = "voice")]
fn resolve_tts_provider(
    config: &VoiceConfig,
    registry: &VoiceProviderRegistry,
    cartesia_key: bool,
) -> Result<&'static str, String> {
    match config.tts_provider.as_deref().unwrap_or("auto") {
        LOCAL_TTS_PROVIDER => {
            if Lfm2TtsConnector::ready(registry) {
                Ok(LOCAL_TTS_PROVIDER)
            } else {
                Err("the LFM2-Audio model isn't ready".to_string())
            }
        }
        CARTESIA_PROVIDER => {
            if cartesia_key {
                Ok(CARTESIA_PROVIDER)
            } else {
                Err("no Cartesia API key".to_string())
            }
        }
        _ => {
            if cartesia_key {
                Ok(CARTESIA_PROVIDER)
            } else if Lfm2TtsConnector::ready(registry) {
                Ok(LOCAL_TTS_PROVIDER)
            } else {
                Err("no Cartesia API key and the LFM2-Audio model isn't ready".to_string())
            }
        }
    }
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_status(
    app: AppHandle,
    voice: State<'_, VoiceProviderRegistry>,
    convo: State<'_, ConversationEngine>,
) -> Result<VoiceConvoStatus, String> {
    let config = load_voice_config(&app);
    let keys = resolve_cascade_keys(&config);
    let stt = resolve_stt_provider(&config, &voice, keys.deepgram.is_some());
    let tts = resolve_tts_provider(&config, &voice, keys.cartesia.is_some());
    Ok(VoiceConvoStatus {
        available: stt.is_ok() && tts.is_ok(),
        state: convo.state(),
        stt_provider: stt
            .as_ref()
            .map(|name| (*name).to_string())
            .unwrap_or_else(|_| config.stt_provider.clone().unwrap_or_else(|| "auto".into())),
        tts_provider: tts
            .as_ref()
            .map(|name| (*name).to_string())
            .unwrap_or_else(|_| config.tts_provider.clone().unwrap_or_else(|| "auto".into())),
        stt_error: stt.err(),
        tts_error: tts.err(),
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

    let stt_choice = resolve_stt_provider(&config, &voice, keys.deepgram.is_some())
        .map_err(|why| format!("Speech-to-text unavailable: {why} (Settings → Voice)"))?;
    let tts_choice = resolve_tts_provider(&config, &voice, keys.cartesia.is_some())
        .map_err(|why| format!("Text-to-speech unavailable: {why} (Settings → Voice)"))?;

    let stt: Arc<dyn SttConnector> = if stt_choice == LOCAL_STT_PROVIDER {
        Arc::new(LocalWhisperConnector::from_registry(&voice))
    } else {
        let deepgram = keys
            .deepgram
            .ok_or_else(|| "Deepgram API key missing".to_string())?;
        Arc::new(DeepgramFluxConnector::new(deepgram))
    };
    let tts: Arc<dyn TtsConnector> = if tts_choice == LOCAL_TTS_PROVIDER {
        Arc::new(Lfm2TtsConnector::from_registry(&voice))
    } else {
        let cartesia = keys
            .cartesia
            .ok_or_else(|| "Cartesia API key missing".to_string())?;
        Arc::new(CartesiaConnector::new(cartesia, config.tts_voice.clone()))
    };

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

#[cfg(feature = "voice")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConvoProviderTest {
    pub deepgram_ok: bool,
    pub deepgram_error: Option<String>,
    pub cartesia_ok: bool,
    pub cartesia_error: Option<String>,
}

/// Settings "Test" button: prove each cascade provider key actually opens a
/// session (connect + immediate close), without starting a conversation.
#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_test_providers(app: AppHandle) -> Result<VoiceConvoProviderTest, String> {
    let config = load_voice_config(&app);
    let keys = resolve_cascade_keys(&config);

    let (deepgram_ok, deepgram_error) = match keys.deepgram {
        None => (false, Some("no API key configured".to_string())),
        Some(key) => match DeepgramFluxConnector::new(key).connect().await {
            Ok((mut stream, _events)) => {
                stream.close().await;
                (true, None)
            }
            Err(err) => (false, Some(err)),
        },
    };
    let (cartesia_ok, cartesia_error) = match keys.cartesia {
        None => (false, Some("no API key configured".to_string())),
        Some(key) => {
            match CartesiaConnector::new(key, config.tts_voice.clone())
                .connect()
                .await
            {
                Ok(mut session) => {
                    session.stream.stop().await;
                    (true, None)
                }
                Err(err) => (false, Some(err)),
            }
        }
    };
    Ok(VoiceConvoProviderTest {
        deepgram_ok,
        deepgram_error,
        cartesia_ok,
        cartesia_error,
    })
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_convo_list_voices(app: AppHandle) -> Result<Vec<CartesiaVoiceInfo>, String> {
    let config = load_voice_config(&app);
    let keys = resolve_cascade_keys(&config);
    let key = keys
        .cartesia
        .ok_or_else(|| "Cartesia API key missing".to_string())?;
    list_cartesia_voices(&key).await
}

// Shim implementations (compiled when the `voice` feature is disabled).
#[cfg(not(feature = "voice"))]
const VOICE_NOT_BUILT: &str = "voice support not built into this binary";

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_test_providers() -> Result<serde_json::Value, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_convo_list_voices() -> Result<Vec<serde_json::Value>, String> {
    Err(VOICE_NOT_BUILT.into())
}

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
