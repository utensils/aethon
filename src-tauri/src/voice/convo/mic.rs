//! Streaming microphone capture for the conversation engine.
//!
//! Unlike the batch `CpalAudioRecorder` (record → stop → resample the whole
//! clip), this opens the default input device and delivers mono 16 kHz f32
//! frames continuously over a channel. Resampling happens in the callback via
//! `StreamResampler`, which carries state across chunks so frame boundaries
//! don't click.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tokio::sync::mpsc;

use crate::voice::audio::{
    StreamResampler, normalize_interleaved_f32, normalize_interleaved_f64,
    normalize_interleaved_i8, normalize_interleaved_i16, normalize_interleaved_i24,
    normalize_interleaved_i32, normalize_interleaved_i64, normalize_interleaved_u8,
    normalize_interleaved_u16, normalize_interleaved_u24, normalize_interleaved_u32,
    normalize_interleaved_u64,
};
use crate::voice::catalog::TARGET_SAMPLE_RATE;

/// Keeps the input stream alive; dropping it stops capture and closes the
/// frames channel (the callback's sender fails and is ignored).
pub(crate) struct MicHandle {
    _stream: cpal::Stream,
}

pub(super) fn start_streaming_mic() -> Result<(MicHandle, mpsc::UnboundedReceiver<Vec<f32>>), String>
{
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No default microphone input device is available".to_string())?;
    let supported_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to read microphone input config: {e}"))?;
    let device_rate = supported_config.sample_rate();
    let channels = supported_config.channels();
    let stream_config: cpal::StreamConfig = supported_config.clone().into();
    let (tx, rx) = mpsc::unbounded_channel::<Vec<f32>>();

    macro_rules! build_input_stream {
        ($sample_ty:ty, $normalize:path) => {{
            let tx = tx.clone();
            let mut resampler = StreamResampler::new(device_rate, TARGET_SAMPLE_RATE);
            device.build_input_stream(
                &stream_config,
                move |data: &[$sample_ty], _| {
                    let frame = resampler.process(&$normalize(data, channels));
                    if !frame.is_empty() {
                        // Receiver gone = the driver ended; nothing to do.
                        let _ = tx.send(frame);
                    }
                },
                move |err| {
                    tracing::warn!(target: "aethon::voice::convo", error = %err, "input stream error");
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

    Ok((MicHandle { _stream: stream }, rx))
}
