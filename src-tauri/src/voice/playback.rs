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
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::task::AbortHandle;

use super::{LevelTask, StreamResampler, VoiceLevelPayload, compute_rms, resample};

/// Cursor over mono PCM samples, advanced one frame at a time by the audio
/// callback. Factored out so the draining logic is unit-testable without a
/// real output device.
///
/// Two modes share the type: a batch clip (`new`, complete from birth) and a
/// streaming clip (`new_streaming`, fed via `append` while playing and sealed
/// with `mark_complete`). A streaming buffer that runs dry before more audio
/// arrives plays silence (`next_sample` → `None` → EQUILIBRIUM) rather than
/// finishing, so `finished()` only fires after the producer seals it.
pub(super) struct PlaybackBuffer {
    samples: Vec<f32>,
    pos: usize,
    complete: bool,
}

impl PlaybackBuffer {
    pub(super) fn new(samples: Vec<f32>) -> Self {
        Self {
            samples,
            pos: 0,
            complete: true,
        }
    }

    pub(super) fn new_streaming() -> Self {
        Self {
            samples: Vec::new(),
            pos: 0,
            complete: false,
        }
    }

    pub(super) fn append(&mut self, more: &[f32]) {
        self.samples.extend_from_slice(more);
    }

    pub(super) fn mark_complete(&mut self) {
        self.complete = true;
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
        self.complete && self.pos >= self.samples.len()
    }
}

/// Clonable so the conversation engine's driver task can hold its own handle;
/// every clone shares the single playback slot and generation counter.
#[derive(Clone)]
pub(crate) struct AudioPlayer {
    active: Arc<Mutex<Option<PlaybackHandle>>>,
    generation: Arc<AtomicU64>,
}

/// Holds a playing stream and its level/finished watcher. Dropping it stops
/// playback (drops the `cpal::Stream`) and aborts the watcher (`LevelTask`).
/// `generation` tags which `play_samples` call owns the slot so the watcher
/// only clears its own clip on completion.
struct PlaybackHandle {
    _stream: cpal::Stream,
    _watcher: LevelTask,
    generation: u64,
}

impl Default for AudioPlayer {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioPlayer {
    pub(crate) fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    #[cfg(test)]
    pub(super) fn is_playing(&self) -> bool {
        self.active.lock().is_some()
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

        let target = default_output_target()?;
        let resampled = resample(&samples, sample_rate, target.rate);
        let buffer = Arc::new(Mutex::new(PlaybackBuffer::new(resampled)));
        self.start_with_buffer(&target, Arc::clone(&buffer), app)?;
        Ok(())
    }

    /// Open the output device for a streaming clip: audio is fed through the
    /// returned handle's `append` while the device plays, and the clip only
    /// counts as finished (→ `voice://playback-finished`) after
    /// `mark_complete()` + drain. The handle resamples appended audio from
    /// `source_rate` to the device rate with carried state, so chunk
    /// boundaries don't click.
    pub(crate) fn start_stream(
        &self,
        source_rate: u32,
        app: Option<AppHandle>,
    ) -> Result<StreamingPlaybackHandle, String> {
        *self.active.lock() = None;
        let target = default_output_target()?;
        let buffer = Arc::new(Mutex::new(PlaybackBuffer::new_streaming()));
        self.start_with_buffer(&target, Arc::clone(&buffer), app)?;
        Ok(StreamingPlaybackHandle {
            buffer,
            resampler: StreamResampler::new(source_rate, target.rate),
        })
    }

    fn start_with_buffer(
        &self,
        target: &OutputTarget,
        buffer: Arc<Mutex<PlaybackBuffer>>,
        app: Option<AppHandle>,
    ) -> Result<(), String> {
        let stream = build_output_stream(
            &target.device,
            &target.config,
            target.sample_format,
            target.channels,
            Arc::clone(&buffer),
        )?;
        stream
            .play()
            .map_err(|e| format!("Failed to start audio output stream: {e}"))?;

        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let watcher = spawn_playback_watcher(app, buffer, Arc::clone(&self.active), generation);
        *self.active.lock() = Some(PlaybackHandle {
            _stream: stream,
            _watcher: LevelTask(watcher),
            generation,
        });
        Ok(())
    }

    /// Stop any in-flight playback immediately (drops the stream + watcher).
    pub(crate) fn stop(&self) {
        *self.active.lock() = None;
    }
}

struct OutputTarget {
    device: cpal::Device,
    config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    channels: usize,
    rate: u32,
}

fn default_output_target() -> Result<OutputTarget, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "No default audio output device is available".to_string())?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("Failed to read audio output config: {e}"))?;
    let rate = supported.sample_rate();
    let channels = usize::from(supported.channels().max(1));
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    Ok(OutputTarget {
        device,
        config,
        sample_format,
        channels,
        rate,
    })
}

/// Producer side of a streaming playback: append synthesized audio as it
/// arrives, then seal the clip. Dropping the handle does NOT stop playback —
/// the device keeps draining what was appended; call `AudioPlayer::stop()` to
/// cut it off.
pub(crate) struct StreamingPlaybackHandle {
    buffer: Arc<Mutex<PlaybackBuffer>>,
    resampler: StreamResampler,
}

impl StreamingPlaybackHandle {
    /// Append mono samples at the handle's source rate.
    pub(crate) fn append(&mut self, samples: &[f32]) {
        let resampled = self.resampler.process(samples);
        if !resampled.is_empty() {
            self.buffer.lock().append(&resampled);
        }
    }

    /// Seal the clip: once the device drains what's buffered, the watcher
    /// fires `voice://playback-finished` and frees the stream.
    pub(crate) fn mark_complete(&self) {
        self.buffer.lock().mark_complete();
    }

    pub(crate) fn is_drained(&self) -> bool {
        self.buffer.lock().finished()
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
/// speaking meter and a final `voice://playback-finished` once drained. On
/// natural completion it also frees the stream by clearing the active slot —
/// but only if that slot is still *this* clip (`generation`), so a newer clip
/// that replaced it is left untouched.
fn spawn_playback_watcher(
    app: Option<AppHandle>,
    buffer: Arc<Mutex<PlaybackBuffer>>,
    active: Arc<Mutex<Option<PlaybackHandle>>>,
    generation: u64,
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
                // Free the device by dropping our handle (drops the stream).
                // Taken under the lock, dropped after release. Aborting our own
                // watcher this way is harmless — we break immediately after.
                let _stale = {
                    let mut slot = active.lock();
                    if slot
                        .as_ref()
                        .is_some_and(|handle| handle.generation == generation)
                    {
                        slot.take()
                    } else {
                        None
                    }
                };
                if let Some(app) = &app {
                    let _ = app.emit("voice://playback-finished", ());
                }
                break;
            }
        }
    })
    .abort_handle()
}
