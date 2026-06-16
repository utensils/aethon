//! Audio output for synthesized speech.
//!
//! Aethon's voice stack was capture-only until LFM2-Audio added text-to-speech.
//! This module plays a block of mono PCM (the TTS result) through the default
//! output device, resampling to the device rate and fanning the mono signal
//! out to every channel. It deliberately reuses the existing `cpal` dependency
//! rather than pulling in a playback crate.
//!
//! The recorder uses the default *input* device and the player the default
//! *output* device, so the two never contend; the conversation state machine
//! is what enforces "listen XOR speak" so the agent never hears itself.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::task::AbortHandle;

use super::{LevelTask, VoiceLevelPayload, compute_rms, resample};

/// Cursor over mono PCM samples, advanced one frame at a time by the audio
/// callback. Factored out so the draining logic is unit-testable without a
/// real output device.
pub(super) struct PlaybackBuffer {
    samples: Vec<f32>,
    pos: usize,
}

impl PlaybackBuffer {
    pub(super) fn new(samples: Vec<f32>) -> Self {
        Self { samples, pos: 0 }
    }

    /// The next mono sample, or `None` once the buffer is drained.
    pub(super) fn next_sample(&mut self) -> Option<f32> {
        let sample = self.samples.get(self.pos).copied();
        if sample.is_some() {
            self.pos += 1;
        }
        sample
    }

    pub(super) fn finished(&self) -> bool {
        self.pos >= self.samples.len()
    }
}

pub(crate) struct AudioPlayer {
    active: Mutex<Option<PlaybackHandle>>,
}

/// Holds a playing stream and its level/finished watcher. Dropping it stops
/// playback (drops the `cpal::Stream`) and aborts the watcher (`LevelTask`).
struct PlaybackHandle {
    _stream: cpal::Stream,
    _watcher: LevelTask,
}

impl Default for AudioPlayer {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioPlayer {
    pub(crate) fn new() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }

    /// Resample `samples` (recorded at `sample_rate`) to the default output
    /// device and start playing. Any in-flight playback is stopped first.
    pub(crate) fn play_samples(
        &self,
        samples: Vec<f32>,
        sample_rate: u32,
        app: Option<AppHandle>,
    ) -> Result<(), String> {
        // Stop any current playback (drops its stream + aborts its watcher).
        *self.active.lock() = None;
        if samples.is_empty() {
            // Nothing to play; still signal completion so callers advance.
            if let Some(app) = &app {
                let _ = app.emit("voice://playback-finished", ());
            }
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "No default audio output device is available".to_string())?;
        let supported = device
            .default_output_config()
            .map_err(|e| format!("Failed to read audio output config: {e}"))?;
        let device_rate = supported.sample_rate();
        let channels = usize::from(supported.channels().max(1));
        let config: cpal::StreamConfig = supported.clone().into();

        let resampled = resample(&samples, sample_rate, device_rate);
        let buffer = Arc::new(Mutex::new(PlaybackBuffer::new(resampled)));

        let stream = build_output_stream(
            &device,
            &config,
            supported.sample_format(),
            channels,
            Arc::clone(&buffer),
        )?;
        stream
            .play()
            .map_err(|e| format!("Failed to start audio output stream: {e}"))?;

        let watcher = spawn_playback_watcher(app, buffer);
        *self.active.lock() = Some(PlaybackHandle {
            _stream: stream,
            _watcher: LevelTask(watcher),
        });
        Ok(())
    }

    /// Stop any in-flight playback immediately (drops the stream + watcher).
    pub(crate) fn stop(&self) {
        *self.active.lock() = None;
    }
}

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    channels: usize,
    buffer: Arc<Mutex<PlaybackBuffer>>,
) -> Result<cpal::Stream, String> {
    // Each match arm is mutually exclusive, so moving `buffer` into the
    // per-type helper in every arm is fine.
    let stream = match sample_format {
        cpal::SampleFormat::I8 => typed_output_stream::<i8>(device, config, channels, buffer),
        cpal::SampleFormat::I16 => typed_output_stream::<i16>(device, config, channels, buffer),
        cpal::SampleFormat::I24 => {
            typed_output_stream::<cpal::I24>(device, config, channels, buffer)
        }
        cpal::SampleFormat::I32 => typed_output_stream::<i32>(device, config, channels, buffer),
        cpal::SampleFormat::I64 => typed_output_stream::<i64>(device, config, channels, buffer),
        cpal::SampleFormat::U8 => typed_output_stream::<u8>(device, config, channels, buffer),
        cpal::SampleFormat::U16 => typed_output_stream::<u16>(device, config, channels, buffer),
        cpal::SampleFormat::U24 => {
            typed_output_stream::<cpal::U24>(device, config, channels, buffer)
        }
        cpal::SampleFormat::U32 => typed_output_stream::<u32>(device, config, channels, buffer),
        cpal::SampleFormat::U64 => typed_output_stream::<u64>(device, config, channels, buffer),
        cpal::SampleFormat::F32 => typed_output_stream::<f32>(device, config, channels, buffer),
        cpal::SampleFormat::F64 => typed_output_stream::<f64>(device, config, channels, buffer),
        other => return Err(format!("Unsupported audio output sample format: {other:?}")),
    };
    stream.map_err(|e| format!("Failed to open audio output stream: {e}"))
}

/// Build an output stream for a concrete sample type, fanning the mono buffer
/// out to every channel. Completion is observed by the watcher polling the
/// shared buffer cursor, so the callback needs no extra signaling.
fn typed_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    buffer: Arc<Mutex<PlaybackBuffer>>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let mut buf = buffer.lock();
            for frame in data.chunks_mut(channels) {
                let converted = match buf.next_sample() {
                    Some(value) => <T as cpal::Sample>::from_sample(value),
                    None => <T as cpal::Sample>::EQUILIBRIUM,
                };
                for slot in frame.iter_mut() {
                    *slot = converted;
                }
            }
        },
        |err| {
            tracing::warn!(target: "aethon::voice", error = %err, "output stream error");
        },
        None,
    )
}

/// Poll the playback buffer at ~20 Hz, emitting `voice://playback-level` for a
/// speaking meter and a final `voice://playback-finished` once drained.
fn spawn_playback_watcher(
    app: Option<AppHandle>,
    buffer: Arc<Mutex<PlaybackBuffer>>,
) -> AbortHandle {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(50));
        let mut last_pos = 0usize;
        loop {
            interval.tick().await;
            let (level, done, pos) = {
                let buf = buffer.lock();
                let end = buf.pos.min(buf.samples.len());
                let start = last_pos.min(end);
                (
                    compute_rms(&buf.samples[start..end]),
                    buf.finished(),
                    buf.pos,
                )
            };
            last_pos = pos;
            if let Some(app) = &app {
                let _ = app.emit("voice://playback-level", VoiceLevelPayload { level });
            }
            if done {
                if let Some(app) = &app {
                    let _ = app.emit("voice://playback-finished", ());
                }
                break;
            }
        }
    })
    .abort_handle()
}
