use super::*;

pub struct VoiceProviderRegistry {
    model_root: PathBuf,
    active_recording: Mutex<Option<RecordingSession>>,
    recorder: Arc<dyn AudioRecorder>,
    transcriber: Arc<dyn VoiceTranscriber>,
    pub(super) platform_speech: Arc<dyn PlatformSpeechEngine>,
    pub(super) lfm2: Arc<dyn Lfm2Backend>,
    backend_checker: Arc<dyn CandleBackendChecker>,
    transcription_timeout: Duration,
    active_distil_cancel: Mutex<Option<Arc<AtomicBool>>>,
    active_lfm2_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub(super) active_downloads: Mutex<std::collections::HashSet<String>>,
}

impl VoiceProviderRegistry {
    pub fn new(model_root: PathBuf) -> Self {
        Self::with_runtime(
            model_root,
            Arc::new(CpalAudioRecorder),
            Arc::new(CandleWhisperTranscriber),
        )
    }

    pub(super) fn with_runtime(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
    ) -> Self {
        Self::with_runtime_and_timeout(
            model_root,
            recorder,
            transcriber,
            DISTIL_TRANSCRIPTION_TIMEOUT,
        )
    }

    pub(super) fn with_runtime_and_timeout(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        transcription_timeout: Duration,
    ) -> Self {
        Self::with_runtime_backend_and_timeout(
            model_root,
            recorder,
            transcriber,
            Arc::new(DefaultPlatformSpeechEngine::new()),
            Arc::new(DefaultCandleBackendChecker),
            transcription_timeout,
        )
    }

    // Consumed only by the macOS/Windows-gated platform-speech tests;
    // gate the helper the same way so it isn't dead code on Linux, where
    // `cargo test --no-run` compiles test targets under `-Dwarnings`.
    #[cfg(all(test, any(target_os = "macos", windows)))]
    pub(super) fn with_platform_runtime(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        platform_speech: Arc<dyn PlatformSpeechEngine>,
    ) -> Self {
        Self::with_runtime_backend_and_timeout(
            model_root,
            recorder,
            transcriber,
            platform_speech,
            Arc::new(DefaultCandleBackendChecker),
            DISTIL_TRANSCRIPTION_TIMEOUT,
        )
    }

    #[cfg(test)]
    pub(super) fn with_runtime_and_backend(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        backend_checker: Arc<dyn CandleBackendChecker>,
    ) -> Self {
        Self::with_runtime_backend_and_timeout(
            model_root,
            recorder,
            transcriber,
            Arc::new(DefaultPlatformSpeechEngine::new()),
            backend_checker,
            DISTIL_TRANSCRIPTION_TIMEOUT,
        )
    }

    fn with_runtime_backend_and_timeout(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        platform_speech: Arc<dyn PlatformSpeechEngine>,
        backend_checker: Arc<dyn CandleBackendChecker>,
        transcription_timeout: Duration,
    ) -> Self {
        let lfm2: Arc<dyn Lfm2Backend> = Arc::new(Lfm2CliBackend::new(model_root.clone()));
        Self {
            model_root,
            active_recording: Mutex::new(None),
            recorder,
            transcriber,
            platform_speech,
            lfm2,
            backend_checker,
            transcription_timeout,
            active_distil_cancel: Mutex::new(None),
            active_lfm2_cancel: Mutex::new(None),
            active_downloads: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Swap in a fake LFM2 backend for tests, leaving the rest of the runtime
    /// intact. Mirrors the recorder/transcriber substitution helpers above.
    #[cfg(test)]
    pub(super) fn with_lfm2_backend(mut self, lfm2: Arc<dyn Lfm2Backend>) -> Self {
        self.lfm2 = lfm2;
        self
    }

    pub fn default_model_root() -> PathBuf {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from);
        crate::helpers::aethon_dir(home)
            .unwrap_or_else(|| PathBuf::from(".aethon"))
            .join("models")
            .join("voice")
    }

    pub fn distil_cache_path(&self) -> PathBuf {
        self.model_root.join(DISTIL_CACHE_DIR)
    }

    pub fn lfm2_cache_path(&self) -> PathBuf {
        self.model_root.join(LFM2_CACHE_DIR)
    }

    pub fn list_providers(&self, db: &VoiceSettings) -> Vec<VoiceProviderInfo> {
        vec![
            PlatformVoiceProvider.status(self, db),
            DistilWhisperCandleProvider.status(self, db),
            Lfm2AudioProvider.status(self, db),
        ]
    }

    pub fn set_selected_provider(
        &self,
        db: &VoiceSettings,
        provider_id: Option<&str>,
    ) -> Result<(), String> {
        if let Some(provider_id) = provider_id {
            self.ensure_known(provider_id)?;
            db.set_app_setting(SELECTED_PROVIDER_KEY, provider_id)
                .map_err(|e| e.to_string())?;
        } else {
            db.delete_app_setting(SELECTED_PROVIDER_KEY)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn set_enabled(
        &self,
        db: &VoiceSettings,
        provider_id: &str,
        enabled: bool,
    ) -> Result<(), String> {
        self.ensure_known(provider_id)?;
        db.set_app_setting(
            &enabled_key(provider_id),
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
    }

    pub async fn prepare_provider(
        &self,
        app: &AppHandle,
        db_path: &Path,
        provider_id: &str,
    ) -> Result<VoiceProviderInfo, String> {
        match provider_id {
            PLATFORM_ID => PlatformVoiceProvider.prepare(self, app, db_path).await,
            DISTIL_ID => {
                DistilWhisperCandleProvider
                    .prepare(self, app, db_path)
                    .await
            }
            LFM2_ID => Lfm2AudioProvider.prepare(self, app, db_path).await,
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    pub async fn remove_provider_model(
        &self,
        db_path: &Path,
        provider_id: &str,
    ) -> Result<VoiceProviderInfo, String> {
        self.ensure_known(provider_id)?;
        let cache_path = match provider_id {
            DISTIL_ID => self.distil_cache_path(),
            LFM2_ID => self.lfm2_cache_path(),
            _ => return Err("This provider does not use a removable local model".to_string()),
        };

        if tokio::fs::try_exists(&cache_path)
            .await
            .map_err(|e| e.to_string())?
        {
            tokio::fs::remove_dir_all(&cache_path)
                .await
                .map_err(|e| format!("Failed to remove model cache: {e}"))?;
        }
        let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
        db.set_app_setting(&model_status_key(provider_id), "not-installed")
            .map_err(|e| e.to_string())?;
        let info = match provider_id {
            LFM2_ID => Lfm2AudioProvider.status(self, &db),
            _ => DistilWhisperCandleProvider.status(self, &db),
        };
        Ok(info)
    }

    pub async fn start_recording(
        &self,
        db_path: &Path,
        provider_id: &str,
        app: Option<AppHandle>,
    ) -> Result<VoiceStartLatency, String> {
        self.ensure_known(provider_id)?;
        let stream_open_ms = match provider_id {
            PLATFORM_ID => self.start_platform_recording(db_path, app).await,
            DISTIL_ID => self.start_distil_recording(db_path, app).await,
            LFM2_ID => self.start_lfm2_recording(db_path, app).await,
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }?;
        Ok(VoiceStartLatency { stream_open_ms })
    }

    pub async fn stop_and_transcribe(&self, provider_id: &str) -> Result<String, String> {
        self.ensure_known(provider_id)?;
        match provider_id {
            PLATFORM_ID => self.stop_platform_recording().await,
            DISTIL_ID => self.stop_distil_recording().await,
            LFM2_ID => self.stop_lfm2_recording().await,
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    pub async fn cancel_recording(&self, provider_id: &str) -> Result<(), String> {
        self.ensure_known(provider_id)?;
        match provider_id {
            PLATFORM_ID => self.cancel_platform_recording().await,
            DISTIL_ID => self.cancel_distil_recording().await,
            LFM2_ID => self.cancel_lfm2_recording().await,
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    async fn start_platform_recording(
        &self,
        db_path: &Path,
        app: Option<AppHandle>,
    ) -> Result<u128, String> {
        {
            let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
            if !self.enabled(&db, PLATFORM_ID) {
                return Err("System dictation is disabled".to_string());
            }
            let platform_speech = Arc::clone(&self.platform_speech);
            let availability = tokio::task::spawn_blocking(move || platform_speech.prepare())
                .await
                .map_err(|e| format!("System dictation permission task failed: {e}"))?;
            if availability.status != PlatformSpeechAvailabilityStatus::Ready {
                return Err(availability.message);
            }
        }

        let mut active = self.active_recording.lock();
        if active.is_some() {
            return Err("Voice recording is already active".to_string());
        }
        let t_stream = Instant::now();
        let mut session = self.recorder.start()?;
        let stream_open_ms = t_stream.elapsed().as_millis();
        if let Some(app) = app {
            let abort = spawn_level_emitter(app, Arc::clone(&session.samples));
            session._level_task = Some(LevelTask(abort));
        }
        *active = Some(session);
        Ok(stream_open_ms)
    }

    async fn stop_platform_recording(&self) -> Result<String, String> {
        let session = self
            .active_recording
            .lock()
            .take()
            .ok_or_else(|| "No voice recording is active".to_string())?;
        let audio = session.finish()?;
        if audio.samples.is_empty() {
            return Err("No audio was captured".to_string());
        }
        validate_captured_audio(&audio)?;

        let platform_speech = Arc::clone(&self.platform_speech);
        let timeout = self.transcription_timeout;
        let task = tokio::task::spawn_blocking(move || platform_speech.transcribe(audio));
        let transcript = tokio::time::timeout(timeout, task)
            .await
            .map_err(|_| {
                format!(
                    "System dictation timed out after {} seconds. Try a shorter recording.",
                    timeout.as_secs()
                )
            })?
            .map_err(|e| format!("System dictation task failed: {e}"))??;
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err(
                "No speech was recognized. Try again closer to the microphone.".to_string(),
            );
        }
        Ok(transcript)
    }

    async fn cancel_platform_recording(&self) -> Result<(), String> {
        let _ = self.active_recording.lock().take();
        // Each platform with a real engine bridge gets a chance to drop any
        // in-flight recognition request. macOS forwards to the Speech
        // framework's `taskHint` cancel API; the Windows bridge has no
        // cooperative cancel hook, so it's a no-op there. Linux currently
        // has no native bridge at all.
        #[cfg(target_os = "macos")]
        crate::platform_speech::cancel_active_transcription();
        #[cfg(windows)]
        crate::platform_speech::cancel_active_transcription();
        Ok(())
    }

    async fn start_distil_recording(
        &self,
        db_path: &Path,
        app: Option<AppHandle>,
    ) -> Result<u128, String> {
        {
            let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
            if !self.enabled(&db, DISTIL_ID) {
                return Err("Distil-Whisper voice input is disabled".to_string());
            }
            if !distil_model_ready(&self.distil_cache_path()) {
                return Err("Download the Distil-Whisper model before recording".to_string());
            }
            self.ensure_candle_backend_ready()?;
        }

        let mut active = self.active_recording.lock();
        if active.is_some() {
            return Err("Voice recording is already active".to_string());
        }
        let t_stream = Instant::now();
        let mut session = self.recorder.start()?;
        let stream_open_ms = t_stream.elapsed().as_millis();
        if let Some(app) = app {
            let abort = spawn_level_emitter(app, Arc::clone(&session.samples));
            session._level_task = Some(LevelTask(abort));
        }
        *active = Some(session);
        Ok(stream_open_ms)
    }

    async fn stop_distil_recording(&self) -> Result<String, String> {
        let session = self
            .active_recording
            .lock()
            .take()
            .ok_or_else(|| "No voice recording is active".to_string())?;
        let audio = session.finish()?;
        if audio.samples.is_empty() {
            return Err("No audio was captured".to_string());
        }
        validate_captured_audio(&audio)?;

        let cancel = Arc::new(AtomicBool::new(false));
        *self.active_distil_cancel.lock() = Some(Arc::clone(&cancel));

        let cache_path = self.distil_cache_path();
        let transcriber = Arc::clone(&self.transcriber);
        let timeout = self.transcription_timeout;
        let cancel_for_task = Arc::clone(&cancel);
        let task = tokio::task::spawn_blocking(move || {
            transcriber.transcribe(&cache_path, audio, &cancel_for_task)
        });
        let result = tokio::time::timeout(timeout, task).await;

        // On timeout, signal the worker to bail at its next cancel poll so it
        // doesn't keep grinding on a transcript that's already been discarded.
        if result.is_err() {
            cancel.store(true, Ordering::Relaxed);
        }

        // Vacate our slot in the registry, but only if a newer transcription
        // hasn't already replaced it.
        {
            let mut active = self.active_distil_cancel.lock();
            if active.as_ref().is_some_and(|a| Arc::ptr_eq(a, &cancel)) {
                *active = None;
            }
        }

        let transcript = result
            .map_err(|_| timeout_error_message(timeout))?
            .map_err(|e| format!("Voice transcription task failed: {e}"))??;
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err(
                "No speech was recognized. Try again closer to the microphone.".to_string(),
            );
        }
        Ok(transcript)
    }

    async fn cancel_distil_recording(&self) -> Result<(), String> {
        if let Some(cancel) = self.active_distil_cancel.lock().clone() {
            cancel.store(true, Ordering::Relaxed);
        }
        let _ = self.active_recording.lock().take();
        Ok(())
    }

    async fn start_lfm2_recording(
        &self,
        db_path: &Path,
        app: Option<AppHandle>,
    ) -> Result<u128, String> {
        {
            let db = VoiceSettings::open(db_path).map_err(|e| e.to_string())?;
            if !self.enabled(&db, LFM2_ID) {
                return Err("LFM2-Audio voice input is disabled".to_string());
            }
            if !lfm2_model_ready(&self.lfm2_cache_path()) {
                return Err("Download the LFM2-Audio model before recording".to_string());
            }
            if !self.lfm2.binary_available() {
                return Err(LFM2_BINARY_MISSING.to_string());
            }
        }

        let mut active = self.active_recording.lock();
        if active.is_some() {
            return Err("Voice recording is already active".to_string());
        }
        let t_stream = Instant::now();
        let mut session = self.recorder.start()?;
        let stream_open_ms = t_stream.elapsed().as_millis();
        if let Some(app) = app {
            let abort = spawn_level_emitter(app, Arc::clone(&session.samples));
            session._level_task = Some(LevelTask(abort));
        }
        *active = Some(session);
        Ok(stream_open_ms)
    }

    async fn stop_lfm2_recording(&self) -> Result<String, String> {
        let session = self
            .active_recording
            .lock()
            .take()
            .ok_or_else(|| "No voice recording is active".to_string())?;
        let audio = session.finish()?;
        if audio.samples.is_empty() {
            return Err("No audio was captured".to_string());
        }
        validate_captured_audio(&audio)?;

        let cancel = Arc::new(AtomicBool::new(false));
        *self.active_lfm2_cancel.lock() = Some(Arc::clone(&cancel));

        let timeout = self.transcription_timeout;
        let lfm2 = Arc::clone(&self.lfm2);
        let cancel_for_task = Arc::clone(&cancel);
        // The runner is a subprocess, so the work is naturally async (no
        // blocking pool needed). On timeout we both drop the future
        // (`kill_on_drop` reaps the child) and flip the cancel flag.
        let result = tokio::time::timeout(timeout, lfm2.asr(audio, cancel_for_task)).await;
        if result.is_err() {
            cancel.store(true, Ordering::Relaxed);
        }

        {
            let mut active = self.active_lfm2_cancel.lock();
            if active.as_ref().is_some_and(|a| Arc::ptr_eq(a, &cancel)) {
                *active = None;
            }
        }

        let transcript = result.map_err(|_| timeout_error_message(timeout))??;
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err(
                "No speech was recognized. Try again closer to the microphone.".to_string(),
            );
        }
        Ok(transcript)
    }

    async fn cancel_lfm2_recording(&self) -> Result<(), String> {
        if let Some(cancel) = self.active_lfm2_cancel.lock().clone() {
            cancel.store(true, Ordering::Relaxed);
        }
        let _ = self.active_recording.lock().take();
        Ok(())
    }

    fn ensure_known(&self, provider_id: &str) -> Result<(), String> {
        match provider_id {
            PLATFORM_ID | DISTIL_ID | LFM2_ID => Ok(()),
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    pub(super) fn selected_provider(&self, db: &VoiceSettings) -> Option<String> {
        db.get_app_setting(SELECTED_PROVIDER_KEY).ok().flatten()
    }

    fn auto_provider_enabled(&self, db: &VoiceSettings) -> bool {
        db.get_app_setting(AUTO_PROVIDER_KEY)
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    }

    pub(super) fn enabled(&self, db: &VoiceSettings, provider_id: &str) -> bool {
        db.get_app_setting(&enabled_key(provider_id))
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    }

    pub(super) fn ensure_candle_backend_ready(&self) -> Result<CandleBackend, String> {
        self.backend_checker.ready_backend()
    }

    pub(crate) fn resolve_provider_id(
        &self,
        db: &VoiceSettings,
        requested: Option<&str>,
    ) -> Result<String, String> {
        if let Some(requested) = requested {
            self.ensure_known(requested)?;
            return Ok(requested.to_string());
        }
        if let Some(selected) = self.selected_provider(db) {
            self.ensure_known(&selected)?;
            return Ok(selected);
        }
        if self.auto_provider_enabled(db) {
            return Ok(PLATFORM_ID.to_string());
        }
        Err("No voice provider is selected".to_string())
    }
}
