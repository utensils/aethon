use super::*;

pub(super) struct PlatformVoiceProvider;

// The platform provider has a real native bridge on macOS (Apple Speech via
// Swift FFI) and on Windows (SAPI 5.4 via the `windows` crate's COM
// bindings). Both platforms ride the `Native` recording-mode path: cpal
// captures the audio, the trait runs transcription on the captured WAV.
// Linux has no native bridge yet and falls back to the webview Web Speech
// API, which is what the `Webview` mode signals to the frontend.
#[cfg(any(target_os = "macos", windows))]
fn platform_recording_mode() -> VoiceRecordingMode {
    VoiceRecordingMode::Native
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_recording_mode() -> VoiceRecordingMode {
    VoiceRecordingMode::Webview
}

#[cfg(target_os = "macos")]
fn platform_description() -> &'static str {
    "Uses native Apple Speech recognition through the operating system. Requires Microphone and Speech Recognition permission."
}

#[cfg(windows)]
fn platform_description() -> &'static str {
    "Uses the Windows Speech API (SAPI 5.4) via in-process COM. \
     Captured audio is transcribed locally — no network round-trip, no extra runtime. \
     Install a Speech Recognizer language pack via Settings → Time & language → Speech \
     if transcription returns no text."
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_description() -> &'static str {
    "Uses the webview or operating system speech recognition surface when available. Requires microphone and speech recognition permission."
}

#[cfg(target_os = "macos")]
fn platform_privacy_label() -> &'static str {
    "Uses Apple Speech services; offline behavior varies by OS language support"
}

#[cfg(windows)]
fn platform_privacy_label() -> &'static str {
    "Local Windows SAPI recognition; audio stays on this machine"
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_privacy_label() -> &'static str {
    "Uses platform services; offline behavior varies by OS"
}

#[cfg(target_os = "macos")]
fn platform_accelerator_label() -> &'static str {
    "Apple Speech"
}

#[cfg(windows)]
fn platform_accelerator_label() -> &'static str {
    "Windows SAPI"
}

#[cfg(not(any(target_os = "macos", windows)))]
fn platform_accelerator_label() -> &'static str {
    "No setup"
}

#[cfg(any(target_os = "macos", windows))]
fn platform_status_from_availability(
    availability: PlatformSpeechAvailability,
) -> (VoiceProviderStatus, String, bool, Option<String>) {
    match availability.status {
        PlatformSpeechAvailabilityStatus::Ready => (
            VoiceProviderStatus::Ready,
            availability.message,
            false,
            None,
        ),
        PlatformSpeechAvailabilityStatus::NeedsMicrophonePermission
        | PlatformSpeechAvailabilityStatus::NeedsSpeechPermission
        | PlatformSpeechAvailabilityStatus::NeedsAssets => (
            VoiceProviderStatus::NeedsSetup,
            availability.message.clone(),
            true,
            Some(availability.message),
        ),
        PlatformSpeechAvailabilityStatus::EngineUnavailable => (
            VoiceProviderStatus::EngineUnavailable,
            "System dictation engine unavailable".to_string(),
            false,
            Some(availability.message),
        ),
        PlatformSpeechAvailabilityStatus::Unavailable => (
            VoiceProviderStatus::Unavailable,
            availability.message.clone(),
            false,
            Some(availability.message),
        ),
    }
}

#[async_trait]
impl VoiceProvider for PlatformVoiceProvider {
    fn id(&self) -> &'static str {
        PLATFORM_ID
    }

    fn metadata(&self, _registry: &VoiceProviderRegistry) -> VoiceProviderMetadata {
        VoiceProviderMetadata {
            id: self.id().to_string(),
            name: "System dictation".to_string(),
            description: platform_description().to_string(),
            kind: VoiceProviderKind::Platform,
            recording_mode: platform_recording_mode(),
            privacy_label: platform_privacy_label().to_string(),
            offline: false,
            download_required: false,
            model_size_label: None,
            cache_path: None,
            accelerator_label: Some(platform_accelerator_label().to_string()),
        }
    }

    fn status(&self, registry: &VoiceProviderRegistry, db: &VoiceSettings) -> VoiceProviderInfo {
        let enabled = registry.enabled(db, self.id());
        // macOS + Windows ride the same trait-based status path: the real
        // engine reports Ready / NeedsSetup / EngineUnavailable from a
        // platform-native check. Linux has no native bridge, so we keep
        // the legacy "ready when the webview's Web Speech API is around"
        // shape — the frontend's `useVoiceInput` sees this and falls
        // through to `webkitSpeechRecognition`.
        #[cfg(any(target_os = "macos", windows))]
        let (status, status_label, setup_required, error) = if !enabled {
            (
                VoiceProviderStatus::Unavailable,
                "Disabled".to_string(),
                false,
                None,
            )
        } else {
            platform_status_from_availability(registry.platform_speech.availability())
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let (status, status_label, setup_required, error) = if enabled {
            (
                VoiceProviderStatus::Ready,
                "Ready when webview speech recognition and OS permissions are available"
                    .to_string(),
                false,
                None,
            )
        } else {
            (
                VoiceProviderStatus::Unavailable,
                "Disabled".to_string(),
                false,
                None,
            )
        };
        VoiceProviderInfo {
            metadata: self.metadata(registry),
            status,
            status_label,
            enabled,
            selected: registry.selected_provider(db).as_deref() == Some(self.id()),
            setup_required,
            can_remove_model: false,
            error,
        }
    }

    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        _app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String> {
        // macOS uses prepare() to drive the TCC permission dialogs;
        // Windows uses it as a (cheap, no-op today) revalidation that
        // SAPI is still reachable. Both go through the trait so tests
        // can substitute a fake engine. Linux has no engine here.
        #[cfg(any(target_os = "macos", windows))]
        {
            let _ = registry.platform_speech.prepare();
        }
        let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
        Ok(self.status(registry, &db))
    }
}

pub(super) struct DeepgramVoiceProvider;

#[async_trait]
impl VoiceProvider for DeepgramVoiceProvider {
    fn id(&self) -> &'static str {
        DEEPGRAM_ID
    }

    fn metadata(&self, _registry: &VoiceProviderRegistry) -> VoiceProviderMetadata {
        VoiceProviderMetadata {
            id: DEEPGRAM_ID.to_string(),
            name: "Deepgram Nova-3 (cloud)".to_string(),
            description: "Cloud dictation via Deepgram's Nova-3 model. Fast and accurate; needs network and the Deepgram API key from the Conversation settings above.".to_string(),
            kind: VoiceProviderKind::External,
            recording_mode: VoiceRecordingMode::Native,
            privacy_label: "Audio is sent to Deepgram for transcription".to_string(),
            offline: false,
            download_required: false,
            model_size_label: None,
            cache_path: None,
            accelerator_label: Some("Deepgram cloud".to_string()),
        }
    }

    fn status(&self, registry: &VoiceProviderRegistry, db: &VoiceSettings) -> VoiceProviderInfo {
        let enabled = registry.enabled(db, self.id());
        let has_key = resolve_deepgram_key().is_some();
        let (status, status_label, setup_required) = if !enabled {
            (
                VoiceProviderStatus::Unavailable,
                "Disabled".to_string(),
                false,
            )
        } else if has_key {
            (
                VoiceProviderStatus::Ready,
                "Ready (cloud)".to_string(),
                false,
            )
        } else {
            (
                VoiceProviderStatus::NeedsSetup,
                "Add a Deepgram API key (Conversation settings above, or DEEPGRAM_API_KEY)"
                    .to_string(),
                true,
            )
        };
        VoiceProviderInfo {
            metadata: self.metadata(registry),
            status,
            status_label,
            enabled,
            selected: registry.selected_provider(db).as_deref() == Some(self.id()),
            setup_required,
            can_remove_model: false,
            error: None,
        }
    }

    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        _app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String> {
        // Nothing to download or authorize locally; "prepare" just re-checks
        // the key so the Settings card refreshes.
        let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
        Ok(self.status(registry, &db))
    }
}

pub(super) struct DistilWhisperCandleProvider;

#[async_trait]
impl VoiceProvider for DistilWhisperCandleProvider {
    fn id(&self) -> &'static str {
        DISTIL_ID
    }

    fn metadata(&self, registry: &VoiceProviderRegistry) -> VoiceProviderMetadata {
        let cache_path = registry.distil_cache_path();
        VoiceProviderMetadata {
            id: self.id().to_string(),
            name: "Distil-Whisper Large v3".to_string(),
            description: "Private offline transcription using distil-whisper/distil-large-v3 through the native provider interface.".to_string(),
            kind: VoiceProviderKind::LocalModel,
            recording_mode: VoiceRecordingMode::Native,
            privacy_label: "Private after download; audio stays local".to_string(),
            offline: true,
            download_required: true,
            model_size_label: Some("About 1.5 GB plus tokenizer/config files".to_string()),
            cache_path: Some(cache_path.display().to_string()),
            accelerator_label: None,
        }
    }

    fn status(&self, registry: &VoiceProviderRegistry, db: &VoiceSettings) -> VoiceProviderInfo {
        let enabled = registry.enabled(db, self.id());
        if !enabled {
            return VoiceProviderInfo {
                metadata: self.metadata(registry),
                status: VoiceProviderStatus::Unavailable,
                status_label: "Disabled".to_string(),
                enabled: false,
                selected: false,
                setup_required: false,
                can_remove_model: false,
                error: None,
            };
        }

        let cache_path = registry.distil_cache_path();
        let model_status = db
            .get_app_setting(&model_status_key(self.id()))
            .ok()
            .flatten();
        let downloading = registry.active_downloads.lock().contains(self.id());
        let installed = distil_model_ready(&cache_path);
        let backend_status = registry.ensure_candle_backend_ready();

        let mut metadata = self.metadata(registry);
        metadata.accelerator_label = Some(match &backend_status {
            Ok(backend) => backend.accelerator_label().to_string(),
            Err(err) => format!("Unavailable: {err}"),
        });

        let (status, status_label, setup_required, error) = if downloading {
            (
                VoiceProviderStatus::Downloading,
                "Downloading model".to_string(),
                true,
                None,
            )
        } else if let Err(err) = &backend_status {
            (
                VoiceProviderStatus::EngineUnavailable,
                "Voice engine unavailable".to_string(),
                false,
                Some(err.clone()),
            )
        } else if installed {
            let backend = backend_status.expect("backend availability checked");
            (
                VoiceProviderStatus::Ready,
                format!("{DISTIL_READY_MESSAGE} ({})", backend.label()),
                false,
                None,
            )
        } else if model_status
            .as_deref()
            .is_some_and(|status| status.starts_with("error:"))
        {
            (
                VoiceProviderStatus::Error,
                "Download failed".to_string(),
                true,
                model_status.map(|s| s.trim_start_matches("error:").to_string()),
            )
        } else {
            (
                VoiceProviderStatus::NeedsSetup,
                "Download required".to_string(),
                true,
                None,
            )
        };

        VoiceProviderInfo {
            metadata,
            status,
            status_label,
            enabled,
            selected: registry.selected_provider(db).as_deref() == Some(self.id()),
            setup_required,
            can_remove_model: installed,
            error,
        }
    }

    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String> {
        let cache_path = registry.distil_cache_path();
        tokio::fs::create_dir_all(&cache_path)
            .await
            .map_err(|e| format!("Failed to create model cache: {e}"))?;
        {
            let mut active_downloads = registry.active_downloads.lock();
            if !active_downloads.insert(self.id().to_string()) {
                let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
                return Ok(self.status(registry, &db));
            }
        }
        let active_download = ActiveDownloadGuard {
            registry,
            provider_id: self.id(),
        };
        {
            let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
            let info = self.status(registry, &db);
            let _ = app.emit("voice-provider-status", &info);
        }

        let result = download_distil_model(app, self.id(), &cache_path).await;
        drop(active_download);
        match result {
            Ok(()) => {
                let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
                db.set_app_setting(&model_status_key(self.id()), "installed")
                    .map_err(|e| e.to_string())?;
                let info = self.status(registry, &db);
                let _ = app.emit("voice-provider-status", &info);
                Ok(info)
            }
            Err(err) => {
                let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
                let _ = db.set_app_setting(&model_status_key(self.id()), &format!("error:{err}"));
                let _ = app.emit(
                    "voice-error",
                    VoiceErrorEvent {
                        provider_id: Some(self.id().to_string()),
                        message: err.clone(),
                    },
                );
                Err(err)
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn lfm2_accelerator_label() -> &'static str {
    "Metal via llama.cpp"
}

#[cfg(not(target_os = "macos"))]
fn lfm2_accelerator_label() -> &'static str {
    "CPU via llama.cpp"
}

pub(super) struct Lfm2AudioProvider;

#[async_trait]
impl VoiceProvider for Lfm2AudioProvider {
    fn id(&self) -> &'static str {
        LFM2_ID
    }

    fn metadata(&self, registry: &VoiceProviderRegistry) -> VoiceProviderMetadata {
        let cache_path = registry.lfm2_cache_path();
        VoiceProviderMetadata {
            id: self.id().to_string(),
            name: "LFM2-Audio (Liquid AI)".to_string(),
            description: "On-device speech recognition powered by Liquid AI's LFM2-Audio 1.5B \
                          through llama.cpp. Audio stays local after the one-time model download."
                .to_string(),
            kind: VoiceProviderKind::LocalModel,
            recording_mode: VoiceRecordingMode::Native,
            privacy_label: "Private after download; audio stays local".to_string(),
            offline: true,
            download_required: true,
            model_size_label: Some("About 1.7 GB (Q8_0)".to_string()),
            cache_path: Some(cache_path.display().to_string()),
            accelerator_label: Some(lfm2_accelerator_label().to_string()),
        }
    }

    fn status(&self, registry: &VoiceProviderRegistry, db: &VoiceSettings) -> VoiceProviderInfo {
        let enabled = registry.enabled(db, self.id());
        let metadata = self.metadata(registry);
        if !enabled {
            return VoiceProviderInfo {
                metadata,
                status: VoiceProviderStatus::Unavailable,
                status_label: "Disabled".to_string(),
                enabled: false,
                selected: false,
                setup_required: false,
                can_remove_model: false,
                error: None,
            };
        }

        let cache_path = registry.lfm2_cache_path();
        let installed = lfm2_model_ready(&cache_path);
        let downloading = registry.active_downloads.lock().contains(self.id());
        let binary_available = registry.lfm2.binary_available();
        let model_status = db
            .get_app_setting(&model_status_key(self.id()))
            .ok()
            .flatten();

        // Precedence: an in-flight download wins; then a missing runtime binary
        // (an install problem the download can't fix); then installed/ready;
        // then a recorded download error; otherwise setup is still required.
        let (status, status_label, setup_required, error) = if downloading {
            (
                VoiceProviderStatus::Downloading,
                "Downloading model".to_string(),
                true,
                None,
            )
        } else if !binary_available {
            (
                VoiceProviderStatus::EngineUnavailable,
                "Runtime unavailable".to_string(),
                false,
                Some(LFM2_BINARY_MISSING.to_string()),
            )
        } else if installed {
            (
                VoiceProviderStatus::Ready,
                LFM2_READY_MESSAGE.to_string(),
                false,
                None,
            )
        } else if model_status
            .as_deref()
            .is_some_and(|status| status.starts_with("error:"))
        {
            (
                VoiceProviderStatus::Error,
                "Download failed".to_string(),
                true,
                model_status.map(|s| s.trim_start_matches("error:").to_string()),
            )
        } else {
            (
                VoiceProviderStatus::NeedsSetup,
                "Download required".to_string(),
                true,
                None,
            )
        };

        VoiceProviderInfo {
            metadata,
            status,
            status_label,
            enabled,
            selected: registry.selected_provider(db).as_deref() == Some(self.id()),
            setup_required,
            can_remove_model: installed,
            error,
        }
    }

    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String> {
        let cache_path = registry.lfm2_cache_path();
        tokio::fs::create_dir_all(&cache_path)
            .await
            .map_err(|e| format!("Failed to create model cache: {e}"))?;
        {
            let mut active_downloads = registry.active_downloads.lock();
            if !active_downloads.insert(self.id().to_string()) {
                let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
                return Ok(self.status(registry, &db));
            }
        }
        let active_download = ActiveDownloadGuard {
            registry,
            provider_id: self.id(),
        };
        {
            let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
            let info = self.status(registry, &db);
            let _ = app.emit("voice-provider-status", &info);
        }

        let result = download_lfm2_model(app, self.id(), &cache_path).await;
        drop(active_download);
        match result {
            Ok(()) => {
                let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
                db.set_app_setting(&model_status_key(self.id()), "installed")
                    .map_err(|e| e.to_string())?;
                let info = self.status(registry, &db);
                let _ = app.emit("voice-provider-status", &info);
                Ok(info)
            }
            Err(err) => {
                let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
                let _ = db.set_app_setting(&model_status_key(self.id()), &format!("error:{err}"));
                let _ = app.emit(
                    "voice-error",
                    VoiceErrorEvent {
                        provider_id: Some(self.id().to_string()),
                        message: err.clone(),
                    },
                );
                Err(err)
            }
        }
    }
}

pub(super) struct ActiveDownloadGuard<'a> {
    registry: &'a VoiceProviderRegistry,
    provider_id: &'static str,
}

impl Drop for ActiveDownloadGuard<'_> {
    fn drop(&mut self) {
        self.registry
            .active_downloads
            .lock()
            .remove(self.provider_id);
    }
}

pub(super) fn enabled_key(provider_id: &str) -> String {
    format!("voice:{provider_id}:enabled")
}

pub(super) fn model_status_key(provider_id: &str) -> String {
    format!("voice:{provider_id}:model_status")
}

/// A model is "ready" when every required file exists and, where a minimum
/// size is known, is at least that large (guards against truncated downloads).
pub(super) fn model_files_ready(cache_path: &Path, files: &[(&str, Option<u64>)]) -> bool {
    files.iter().all(|(filename, min_size)| {
        let path = cache_path.join(filename);
        if let Some(min_size) = min_size {
            path.metadata().is_ok_and(|m| m.len() >= *min_size)
        } else {
            path.is_file()
        }
    })
}

pub(super) fn distil_model_ready(cache_path: &Path) -> bool {
    model_files_ready(cache_path, &DISTIL_MODEL_FILES)
}

pub(super) fn lfm2_model_ready(cache_path: &Path) -> bool {
    model_files_ready(cache_path, &LFM2_MODEL_FILES)
}
