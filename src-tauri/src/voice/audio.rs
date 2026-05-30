use std::sync::Arc;

use cpal::Sample;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::task::AbortHandle;

use super::{MIN_SIGNAL_PEAK, TARGET_SAMPLE_RATE, VoiceLevelPayload};

#[derive(Debug, Clone)]
pub(crate) struct CapturedAudio {
    pub(crate) samples: Vec<f32>,
    pub(crate) sample_rate: u32,
}

/// Cancels the level-emitter Tokio task when dropped.
pub(crate) struct LevelTask(pub(super) AbortHandle);

impl Drop for LevelTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) struct RecordingSession {
    pub(super) samples: Arc<Mutex<Vec<f32>>>,
    stream_error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
    _stream: Option<cpal::Stream>,
    /// Kept alive to abort the level-emitter task when recording stops.
    pub(super) _level_task: Option<LevelTask>,
}

impl RecordingSession {
    #[cfg(test)]
    pub(super) fn from_samples(samples: Vec<f32>, sample_rate: u32) -> Self {
        Self {
            samples: Arc::new(Mutex::new(samples)),
            stream_error: Arc::new(Mutex::new(None)),
            sample_rate,
            _stream: None,
            _level_task: None,
        }
    }

    #[cfg(test)]
    pub(super) fn from_samples_with_stream_error(
        samples: Vec<f32>,
        sample_rate: u32,
        stream_error: impl Into<String>,
    ) -> Self {
        Self {
            samples: Arc::new(Mutex::new(samples)),
            stream_error: Arc::new(Mutex::new(Some(stream_error.into()))),
            sample_rate,
            _stream: None,
            _level_task: None,
        }
    }

    pub(super) fn finish(self) -> Result<CapturedAudio, String> {
        drop(self._stream);
        if let Some(err) = self.stream_error.lock().clone() {
            return Err(format!("Microphone input failed: {err}"));
        }
        let samples = self.samples.lock().clone();
        Ok(CapturedAudio {
            samples: resample_to_target_rate(&samples, self.sample_rate),
            sample_rate: TARGET_SAMPLE_RATE,
        })
    }
}

pub(crate) trait AudioRecorder: Send + Sync {
    fn start(&self) -> Result<RecordingSession, String>;
}

pub(crate) struct CpalAudioRecorder;

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt().min(1.0)
}

/// Spawn a Tokio task that emits `voice://level` events at ~30 Hz.
///
/// The task reads samples accumulated since its last tick, computes RMS
/// over that window, and emits a normalized [0.0, 1.0] level. The first
/// three ticks are suppressed so the buffer has time to fill before the
/// frontend sees any signal (avoids a flash of empty bars at recording start).
///
/// Returns an `AbortHandle`; store it in a `LevelTask` so the task is
/// cancelled automatically when recording stops.
pub(crate) fn spawn_level_emitter(app: AppHandle, samples: Arc<Mutex<Vec<f32>>>) -> AbortHandle {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(33));
        let mut offset = 0usize;
        let mut tick = 0u8;
        loop {
            interval.tick().await;
            let (level, new_offset) = {
                let s = samples.lock();
                let window = &s[offset.min(s.len())..];
                let rms = compute_rms(window);
                (rms, s.len())
            };
            offset = new_offset;
            tick = tick.saturating_add(1);
            if tick > 3 {
                let _ = app.emit("voice://level", VoiceLevelPayload { level });
            }
        }
    })
    .abort_handle()
}

pub(crate) fn validate_captured_audio(audio: &CapturedAudio) -> Result<(), String> {
    let peak = audio
        .samples
        .iter()
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
    if peak < MIN_SIGNAL_PEAK {
        return Err("No speech was detected. Check microphone input and try again.".to_string());
    }
    Ok(())
}

pub(super) fn normalize_interleaved_f32(input: &[f32], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

pub(super) fn normalize_interleaved_f64(input: &[f64], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i8(input: &[i8], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

pub(super) fn normalize_interleaved_i16(input: &[i16], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i24(input: &[cpal::I24], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

pub(super) fn normalize_interleaved_i32(input: &[i32], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i64(input: &[i64], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

pub(super) fn normalize_interleaved_u8(input: &[u8], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

pub(super) fn normalize_interleaved_u16(input: &[u16], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u24(input: &[cpal::U24], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u32(input: &[u32], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u64(input: &[u64], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_samples<T>(input: &[T], channels: u16) -> Vec<f32>
where
    T: Sample + Copy,
    f64: cpal::FromSample<T>,
{
    mix_interleaved_to_mono(input, channels, |sample| {
        f64::from_sample(sample).clamp(-1.0, 1.0) as f32
    })
}

fn mix_interleaved_to_mono<T>(
    input: &[T],
    channels: u16,
    mut convert: impl FnMut(T) -> f32,
) -> Vec<f32>
where
    T: Copy,
{
    let channel_count = usize::from(channels.max(1));
    input
        .chunks(channel_count)
        .map(|frame| frame.iter().copied().map(&mut convert).sum::<f32>() / frame.len() as f32)
        .collect()
}

pub(super) fn resample_to_target_rate(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() || sample_rate == TARGET_SAMPLE_RATE {
        return samples.to_vec();
    }

    let output_len =
        (samples.len() as u64 * u64::from(TARGET_SAMPLE_RATE) / u64::from(sample_rate)).max(1);
    let ratio = sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
    (0..output_len)
        .map(|out_index| {
            let source = out_index as f64 * ratio;
            let left = source.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let frac = (source - left as f64) as f32;
            samples[left] * (1.0 - frac) + samples[right] * frac
        })
        .collect()
}

impl AudioRecorder for CpalAudioRecorder {
    fn start(&self) -> Result<RecordingSession, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No default microphone input device is available".to_string())?;
        let supported_config = device
            .default_input_config()
            .map_err(|e| format!("Failed to read microphone input config: {e}"))?;
        let sample_rate = supported_config.sample_rate();
        let channels = supported_config.channels();
        let stream_config: cpal::StreamConfig = supported_config.clone().into();
        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let stream_error = Arc::new(Mutex::new(None));

        macro_rules! build_input_stream {
            ($sample_ty:ty, $normalize:path) => {{
                let samples = Arc::clone(&samples);
                let stream_error = Arc::clone(&stream_error);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[$sample_ty], _| {
                        samples.lock().extend($normalize(data, channels));
                    },
                    move |err| {
                        *stream_error.lock() = Some(err.to_string());
                        tracing::warn!(target: "aethon::voice", error = %err, "input stream error");
                    },
                    None,
                )
            }};
        }

        let stream = match supported_config.sample_format() {
            cpal::SampleFormat::I8 => build_input_stream!(i8, normalize_interleaved_i8),
            cpal::SampleFormat::I16 => build_input_stream!(i16, normalize_interleaved_i16),
            cpal::SampleFormat::I24 => build_input_stream!(cpal::I24, normalize_interleaved_i24),
            cpal::SampleFormat::I32 => build_input_stream!(i32, normalize_interleaved_i32),
            cpal::SampleFormat::I64 => build_input_stream!(i64, normalize_interleaved_i64),
            cpal::SampleFormat::U8 => build_input_stream!(u8, normalize_interleaved_u8),
            cpal::SampleFormat::U16 => build_input_stream!(u16, normalize_interleaved_u16),
            cpal::SampleFormat::U24 => build_input_stream!(cpal::U24, normalize_interleaved_u24),
            cpal::SampleFormat::U32 => build_input_stream!(u32, normalize_interleaved_u32),
            cpal::SampleFormat::U64 => build_input_stream!(u64, normalize_interleaved_u64),
            cpal::SampleFormat::F32 => build_input_stream!(f32, normalize_interleaved_f32),
            cpal::SampleFormat::F64 => build_input_stream!(f64, normalize_interleaved_f64),
            other => {
                return Err(format!("Unsupported microphone sample format: {other:?}"));
            }
        }
        .map_err(|e| format!("Failed to open microphone input stream: {e}"))?;
        stream
            .play()
            .map_err(|e| format!("Failed to start microphone input stream: {e}"))?;

        Ok(RecordingSession {
            samples,
            stream_error,
            sample_rate,
            _stream: Some(stream),
            _level_task: None,
        })
    }
}
