use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProviderKind {
    Platform,
    LocalModel,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProviderStatus {
    Ready,
    NeedsSetup,
    Downloading,
    EngineUnavailable,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceRecordingMode {
    Native,
    Webview,
}

/// Payload emitted on the `voice://level` Tauri event at ~30 Hz during recording.
/// `level` is linear RMS of the mic buffer window, clamped to [0.0, 1.0].
/// Full-scale sine wave ≈ 0.707; typical speech 0.05–0.3; silence < 0.01.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLevelPayload {
    pub level: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProviderMetadata {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: VoiceProviderKind,
    pub recording_mode: VoiceRecordingMode,
    pub privacy_label: String,
    pub offline: bool,
    pub download_required: bool,
    pub model_size_label: Option<String>,
    pub cache_path: Option<String>,
    pub accelerator_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProviderInfo {
    #[serde(flatten)]
    pub metadata: VoiceProviderMetadata,
    pub status: VoiceProviderStatus,
    pub status_label: String,
    pub enabled: bool,
    pub selected: bool,
    pub setup_required: bool,
    pub can_remove_model: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDownloadProgress {
    pub provider_id: String,
    pub filename: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub overall_downloaded_bytes: u64,
    pub overall_total_bytes: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceErrorEvent {
    pub provider_id: Option<String>,
    pub message: String,
}

pub(super) trait VoiceTranscriber: Send + Sync {
    fn transcribe(
        &self,
        cache_path: &Path,
        audio: CapturedAudio,
        cancel: &Arc<AtomicBool>,
    ) -> Result<String, String>;
}

#[async_trait]
pub trait VoiceProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn metadata(&self, registry: &VoiceProviderRegistry) -> VoiceProviderMetadata;
    fn status(&self, registry: &VoiceProviderRegistry, db: &VoiceSettings) -> VoiceProviderInfo;
    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String>;
}

/// Timing data returned from a successful `start_recording` call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartLatency {
    /// Milliseconds spent opening the cpal input stream.
    pub stream_open_ms: u128,
}
