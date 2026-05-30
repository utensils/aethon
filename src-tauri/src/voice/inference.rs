use super::*;

pub(super) struct CandleWhisperTranscriber;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CandleBackend {
    #[cfg(target_os = "macos")]
    Metal,
    #[cfg(not(target_os = "macos"))]
    Cpu,
}

impl CandleBackend {
    pub(super) fn label(self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::Metal => "Metal",
            #[cfg(not(target_os = "macos"))]
            Self::Cpu => "CPU",
        }
    }

    pub(super) fn accelerator_label(self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::Metal => "Metal via Candle",
            #[cfg(not(target_os = "macos"))]
            Self::Cpu => "CPU via Candle",
        }
    }
}

pub(super) trait CandleBackendChecker: Send + Sync {
    fn ready_backend(&self) -> Result<CandleBackend, String>;
}

pub(super) struct DefaultCandleBackendChecker;

impl CandleBackendChecker for DefaultCandleBackendChecker {
    fn ready_backend(&self) -> Result<CandleBackend, String> {
        ensure_candle_backend_ready()
    }
}

#[cfg(target_os = "macos")]
pub(super) fn select_candle_device() -> Result<(Device, CandleBackend), String> {
    if !candle_core::utils::metal_is_available() {
        return Err(
            "Candle Metal is not available in this macOS build. Rebuild the app with candle-core/metal enabled."
                .to_string(),
        );
    }

    let device = Device::new_metal(0)
        .map_err(|e| format!("Failed to initialize Candle Metal device: {e}"))?;
    Ok((device, CandleBackend::Metal))
}

#[cfg(not(target_os = "macos"))]
pub(super) fn select_candle_device() -> Result<(Device, CandleBackend), String> {
    Ok((Device::Cpu, CandleBackend::Cpu))
}

pub(super) fn ensure_candle_backend_ready() -> Result<CandleBackend, String> {
    static BACKEND_READY: OnceLock<Result<CandleBackend, String>> = OnceLock::new();

    BACKEND_READY
        .get_or_init(check_candle_backend_ready)
        .clone()
}

pub(super) fn check_candle_backend_ready() -> Result<CandleBackend, String> {
    let (device, backend) = select_candle_device()?;
    verify_candle_whisper_backend_for(&device, backend)?;
    Ok(backend)
}

fn verify_candle_whisper_backend_for(
    device: &Device,
    backend: CandleBackend,
) -> Result<(), String> {
    verify_candle_whisper_backend(device)
        .map_err(|err| format!("Candle {} Whisper backend failed {err}", backend.label()))
}

pub(super) fn verify_candle_whisper_backend(device: &Device) -> Result<(), String> {
    probe_candle_whisper_op("conv1d", || {
        let input = Tensor::new(
            &[[
                [0.1_f32, 0.2, -0.1, 0.0, 0.3, -0.3, 0.4, 0.5],
                [0.5_f32, -0.4, 0.3, -0.2, 0.1, 0.0, -0.1, 0.2],
            ]],
            device,
        )?;
        let kernel = Tensor::new(
            &[
                [[0.2_f32, 0.1, -0.1], [0.0_f32, 0.3, 0.2]],
                [[-0.2_f32, 0.4, 0.1], [0.1_f32, -0.3, 0.2]],
            ],
            device,
        )?;
        let output = input.conv1d(&kernel, 1, 1, 1, 1)?;
        let _ = output.to_vec3::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("gelu", || {
        let output = Tensor::new(&[-1.0_f32, 0.0, 1.0, 2.0], device)?.gelu()?;
        let _ = output.to_vec1::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("layer_norm", || {
        let xs = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0]], device)?;
        let alpha = Tensor::new(&[1.0_f32, 1.0], device)?;
        let beta = Tensor::new(&[0.0_f32, 0.0], device)?;
        let output = candle_nn::ops::layer_norm(&xs, &alpha, &beta, 1e-5)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("softmax", || {
        let logits = Tensor::new(&[[1.0_f32, 2.0, 3.0]], device)?;
        let output = softmax(&logits, D::Minus1)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("matmul", || {
        let lhs = Tensor::new(&[[1.0_f32, 2.0, 3.0], [4.0, 5.0, 6.0]], device)?;
        let rhs = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0], [5.0, 6.0]], device)?;
        let output = lhs.matmul(&rhs)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("broadcast_add", || {
        let matrix = Tensor::new(&[[1.0_f32, 2.0, 3.0], [4.0, 5.0, 6.0]], device)?;
        let bias = Tensor::new(&[0.5_f32, -0.5, 1.0], device)?;
        let output = matrix.broadcast_add(&bias)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("index_select", || {
        let source = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0], [5.0, 6.0]], device)?;
        let indexes = Tensor::new(&[2_u32, 0], device)?;
        let output = source.index_select(&indexes, 0)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("scalar_readback", || {
        let value = Tensor::new(&[42.0_f32], device)?.i(0)?.to_scalar::<f32>()?;
        if (value - 42.0).abs() > f32::EPSILON {
            return Err(candle_core::Error::Msg(format!(
                "expected 42.0, got {value}"
            )));
        }
        Ok(())
    })
}

fn probe_candle_whisper_op(
    op: &'static str,
    run: impl FnOnce() -> candle_core::Result<()>,
) -> Result<(), String> {
    run().map_err(|e| format!("{op}: {e}"))
}

/// Format the user-visible message when Distil-Whisper hits its
/// hard timeout. On CPU platforms (Linux + Windows) the ceiling is
/// already 5× the macOS Metal default, so a timeout almost certainly
/// means the workload is too big for CPU inference rather than a stuck
/// worker — pivot the user toward the always-faster platform provider
/// (SAPI on Windows, Apple Speech on macOS) instead of asking them to
/// "try again."
pub(super) fn timeout_error_message(timeout: Duration) -> String {
    #[cfg(target_os = "macos")]
    let suggestion = "Try a shorter recording or switch to System dictation in Voice settings.";
    #[cfg(target_os = "windows")]
    let suggestion = "On CPU this model is slow on long clips — try a shorter recording or switch to System dictation (Windows SAPI) in Voice settings.";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let suggestion = "Try a shorter recording or check the selected voice provider.";
    format!(
        "Voice transcription timed out after {} seconds. {}",
        timeout.as_secs(),
        suggestion
    )
}

impl VoiceTranscriber for CandleWhisperTranscriber {
    fn transcribe(
        &self,
        cache_path: &Path,
        captured: CapturedAudio,
        cancel: &Arc<AtomicBool>,
    ) -> Result<String, String> {
        transcribe_distil_whisper(cache_path, captured, cancel)
    }
}

enum WhisperModel {
    Normal(whisper::model::Whisper),
}

impl WhisperModel {
    fn config(&self) -> &Config {
        match self {
            Self::Normal(model) => &model.config,
        }
    }

    fn encoder_forward(&mut self, input: &Tensor, flush: bool) -> candle_core::Result<Tensor> {
        match self {
            Self::Normal(model) => model.encoder.forward(input, flush),
        }
    }

    fn decoder_forward(
        &mut self,
        input: &Tensor,
        audio_features: &Tensor,
        flush: bool,
    ) -> candle_core::Result<Tensor> {
        match self {
            Self::Normal(model) => model.decoder.forward(input, audio_features, flush),
        }
    }

    fn decoder_final_linear(&self, input: &Tensor) -> candle_core::Result<Tensor> {
        match self {
            Self::Normal(model) => model.decoder.final_linear(input),
        }
    }
}

struct WhisperDecoder {
    model: WhisperModel,
    tokenizer: Tokenizer,
    suppress_tokens: Tensor,
    sot_token: u32,
    transcribe_token: u32,
    eot_token: u32,
    no_speech_token: Option<u32>,
    no_timestamps_token: u32,
    language_token: Option<u32>,
}

struct WhisperDecodingResult {
    text: String,
    avg_logprob: f64,
    no_speech_prob: f64,
}

impl WhisperDecoder {
    fn new(model: WhisperModel, tokenizer: Tokenizer, device: &Device) -> Result<Self, String> {
        let no_timestamps_token = token_id(&tokenizer, whisper::NO_TIMESTAMPS_TOKEN)?;
        let suppress_tokens = (0..model.config().vocab_size as u32)
            .map(|index| {
                if model.config().suppress_tokens.contains(&index) {
                    f32::NEG_INFINITY
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>();
        let suppress_tokens = Tensor::new(suppress_tokens.as_slice(), device)
            .map_err(|e| format!("Failed to build Whisper token suppression mask: {e}"))?;

        Ok(Self {
            sot_token: token_id(&tokenizer, whisper::SOT_TOKEN)?,
            transcribe_token: token_id(&tokenizer, whisper::TRANSCRIBE_TOKEN)?,
            eot_token: token_id(&tokenizer, whisper::EOT_TOKEN)?,
            no_speech_token: whisper::NO_SPEECH_TOKENS
                .iter()
                .find_map(|token| token_id(&tokenizer, token).ok()),
            no_timestamps_token,
            language_token: None,
            model,
            tokenizer,
            suppress_tokens,
        })
    }

    fn run(&mut self, mel: &Tensor, cancel: &Arc<AtomicBool>) -> Result<String, String> {
        if self.language_token.is_none() {
            self.language_token = self.detect_language_token(mel)?;
        }
        let (_, _, content_frames) = mel
            .dims3()
            .map_err(|e| format!("Invalid Whisper mel tensor: {e}"))?;
        let mut seek = 0;
        let mut text = String::new();

        while seek < content_frames {
            if cancel.load(Ordering::Relaxed) {
                return Err("Transcription cancelled.".to_string());
            }
            let segment_size = usize::min(content_frames - seek, whisper::N_FRAMES);
            let segment = mel
                .narrow(2, seek, segment_size)
                .map_err(|e| format!("Failed to slice Whisper mel segment: {e}"))?;
            let decoded = self.decode(&segment, cancel)?;
            if decoded.no_speech_prob > whisper::NO_SPEECH_THRESHOLD
                && decoded.avg_logprob < whisper::LOGPROB_THRESHOLD
            {
                seek += segment_size;
                continue;
            }
            if !decoded.text.trim().is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(decoded.text.trim());
            }
            seek += segment_size;
        }

        Ok(text.trim().to_string())
    }

    fn detect_language_token(&mut self, mel: &Tensor) -> Result<Option<u32>, String> {
        let language_token_ids = WHISPER_LANGUAGE_CODES
            .iter()
            .filter_map(|code| self.tokenizer.token_to_id(&format!("<|{code}|>")))
            .collect::<Vec<_>>();
        if language_token_ids.is_empty() {
            return Ok(None);
        }

        let (_, _, seq_len) = mel
            .dims3()
            .map_err(|e| format!("Invalid Whisper mel tensor: {e}"))?;
        let mel = mel
            .narrow(
                2,
                0,
                usize::min(seq_len, self.model.config().max_source_positions),
            )
            .map_err(|e| format!("Failed to slice Whisper language mel segment: {e}"))?;
        let audio_features = self
            .model
            .encoder_forward(&mel, true)
            .map_err(|e| format!("Whisper language encoder failed: {e}"))?;
        let tokens = Tensor::new(&[[self.sot_token]], mel.device())
            .map_err(|e| format!("Failed to build Whisper language token tensor: {e}"))?;
        let token_ids = Tensor::new(language_token_ids.as_slice(), mel.device())
            .map_err(|e| format!("Failed to build Whisper language token list: {e}"))?;
        let decoded = self
            .model
            .decoder_forward(&tokens, &audio_features, true)
            .map_err(|e| format!("Whisper language decoder failed: {e}"))?;
        let logits = self
            .model
            .decoder_final_linear(
                &decoded
                    .i(..1)
                    .map_err(|e| format!("Failed to slice Whisper language logits: {e}"))?,
            )
            .and_then(|logits| logits.i(0))
            .and_then(|logits| logits.i(0))
            .and_then(|logits| logits.index_select(&token_ids, 0))
            .map_err(|e| format!("Whisper language logits failed: {e}"))?;
        let probs = softmax(&logits, D::Minus1)
            .map_err(|e| format!("Whisper language softmax failed: {e}"))?;
        let values = probs
            .to_vec1::<f32>()
            .map_err(|e| format!("Failed to read Whisper language probabilities: {e}"))?;
        values
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map(|(index, _)| Some(language_token_ids[index]))
            .ok_or_else(|| "Whisper returned no language probabilities".to_string())
    }

    fn decode(
        &mut self,
        mel: &Tensor,
        cancel: &Arc<AtomicBool>,
    ) -> Result<WhisperDecodingResult, String> {
        let audio_features = self
            .model
            .encoder_forward(mel, true)
            .map_err(|e| format!("Whisper encoder failed: {e}"))?;
        let mut tokens = decoder_prompt_tokens(
            self.sot_token,
            self.language_token,
            self.transcribe_token,
            self.no_timestamps_token,
        );
        let sample_len = self.model.config().max_target_positions / 2;
        let mut sum_logprob = 0.0_f64;
        let mut generated_tokens = 0_usize;
        let mut no_speech_prob = f64::NAN;

        for index in 0..sample_len {
            if cancel.load(Ordering::Relaxed) {
                return Err("Transcription cancelled.".to_string());
            }
            let tokens_tensor = Tensor::new(tokens.as_slice(), mel.device())
                .and_then(|tensor| tensor.unsqueeze(0))
                .map_err(|e| format!("Failed to build Whisper token tensor: {e}"))?;
            let decoded = self
                .model
                .decoder_forward(&tokens_tensor, &audio_features, index == 0)
                .map_err(|e| format!("Whisper decoder failed: {e}"))?;
            if index == 0
                && let Some(no_speech_token) = self.no_speech_token
            {
                let logits =
                    self.model
                        .decoder_final_linear(&decoded.i(..1).map_err(|e| {
                            format!("Failed to slice Whisper no-speech logits: {e}")
                        })?)
                        .and_then(|logits| logits.i(0))
                        .and_then(|logits| logits.i(0))
                        .map_err(|e| format!("Whisper no-speech logits failed: {e}"))?;
                no_speech_prob = softmax(&logits, D::Minus1)
                    .and_then(|probs| probs.i(no_speech_token as usize))
                    .and_then(|prob| prob.to_scalar::<f32>())
                    .map_err(|e| format!("Whisper no-speech probability failed: {e}"))?
                    as f64;
            }
            let (_, seq_len, _) = decoded
                .dims3()
                .map_err(|e| format!("Invalid Whisper decoder output: {e}"))?;
            let logits = self
                .model
                .decoder_final_linear(
                    &decoded
                        .i((..1, seq_len - 1..))
                        .map_err(|e| format!("Failed to slice Whisper logits: {e}"))?,
                )
                .and_then(|logits| logits.i(0))
                .and_then(|logits| logits.i(0))
                .and_then(|logits| logits.broadcast_add(&self.suppress_tokens))
                .map_err(|e| format!("Whisper logits failed: {e}"))?;
            let (next_token, next_prob) = greedy_token_with_prob(&logits)?;
            tokens.push(next_token);
            if next_token == self.eot_token {
                break;
            }
            generated_tokens += 1;
            if next_prob > 0.0 {
                sum_logprob += next_prob.ln();
            }
        }

        let text = self
            .tokenizer
            .decode(&tokens, true)
            .map(|text| text.trim().to_string())
            .map_err(|e| format!("Failed to decode Whisper tokens: {e}"))?;
        Ok(WhisperDecodingResult {
            text,
            avg_logprob: sum_logprob / generated_tokens.max(1) as f64,
            no_speech_prob,
        })
    }
}

pub(super) fn decoder_prompt_tokens(
    sot_token: u32,
    language_token: Option<u32>,
    transcribe_token: u32,
    no_timestamps_token: u32,
) -> Vec<u32> {
    let mut tokens = vec![sot_token];
    if let Some(language_token) = language_token {
        tokens.push(language_token);
    }
    tokens.push(transcribe_token);
    tokens.push(no_timestamps_token);
    tokens
}

fn greedy_token_with_prob(logits: &Tensor) -> Result<(u32, f64), String> {
    let probs = softmax(logits, D::Minus1).map_err(|e| format!("Whisper softmax failed: {e}"))?;
    let values = probs
        .to_vec1::<f32>()
        .map_err(|e| format!("Failed to read Whisper logits: {e}"))?;
    values
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| left.total_cmp(right))
        .map(|(index, prob)| (index as u32, f64::from(*prob)))
        .ok_or_else(|| "Whisper returned no token logits".to_string())
}

fn token_id(tokenizer: &Tokenizer, token: &str) -> Result<u32, String> {
    tokenizer
        .token_to_id(token)
        .ok_or_else(|| format!("Whisper tokenizer is missing token {token}"))
}

pub(super) fn transcribe_distil_whisper(
    cache_path: &Path,
    captured: CapturedAudio,
    cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    if captured.sample_rate != TARGET_SAMPLE_RATE {
        return Err(format!(
            "Expected {TARGET_SAMPLE_RATE} Hz audio, got {} Hz",
            captured.sample_rate
        ));
    }
    if !distil_model_ready(cache_path) {
        return Err("Distil-Whisper model files are incomplete".to_string());
    }

    let config_path = cache_path.join("config.json");
    let tokenizer_path = cache_path.join("tokenizer.json");
    let weights_path = cache_path.join("model.safetensors");
    let config: Config = serde_json::from_str(
        &std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read Whisper config: {e}"))?,
    )
    .map_err(|e| format!("Failed to parse Whisper config: {e}"))?;
    let tokenizer = Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| format!("Failed to load tokenizer: {e}"))?;
    let backend = ensure_candle_backend_ready()?;
    let (device, _) = select_candle_device()?;
    let backend_label = backend.label();
    let mel_filters = build_mel_filters(config.num_mel_bins);
    let mel = whisper_audio::pcm_to_mel(&config, &captured.samples, &mel_filters);
    let mel_len = mel.len() / config.num_mel_bins;
    let mel = Tensor::from_vec(mel, (1, config.num_mel_bins, mel_len), &device)
        .map_err(|e| format!("Failed to build Whisper mel tensor on {backend_label}: {e}"))?;
    let var_builder =
        unsafe { VarBuilder::from_mmaped_safetensors(&[weights_path], whisper::DTYPE, &device) }
            .map_err(|e| format!("Failed to load Whisper weights on {backend_label}: {e}"))?;
    let model = whisper::model::Whisper::load(&var_builder, config)
        .map_err(|e| format!("Failed to initialize Whisper model on {backend_label}: {e}"))?;
    let mut decoder = WhisperDecoder::new(WhisperModel::Normal(model), tokenizer, &device)?;
    decoder
        .run(&mel, cancel)
        .map_err(|e| format!("Whisper transcription failed on {backend_label}: {e}"))
}
