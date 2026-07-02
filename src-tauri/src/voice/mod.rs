pub(super) use std::path::{Path, PathBuf};
pub(super) use std::sync::atomic::{AtomicBool, Ordering};
pub(super) use std::sync::{Arc, OnceLock};
pub(super) use std::time::{Duration, Instant};

pub(super) use async_trait::async_trait;
pub(super) use candle_core::{D, Device, IndexOp, Tensor};
pub(super) use candle_nn::{VarBuilder, ops::softmax};
pub(super) use candle_transformers::models::whisper::{
    self as whisper, Config, audio as whisper_audio,
};
pub(super) use parking_lot::Mutex;
pub(super) use serde::{Deserialize, Serialize};
pub(super) use tauri::{AppHandle, Emitter};
pub(super) use tokenizers::Tokenizer;

#[cfg(any(target_os = "macos", windows))]
pub(super) use crate::platform_speech::PlatformSpeechAvailability;
pub(super) use crate::platform_speech::{
    DefaultPlatformSpeechEngine, PlatformSpeechAvailabilityStatus, PlatformSpeechEngine,
};

mod audio;

pub(crate) use self::audio::CapturedAudio;
pub(crate) use self::audio::{
    AudioRecorder, CpalAudioRecorder, LevelTask, RecordingSession, spawn_level_emitter,
    validate_captured_audio,
};
// Shared DSP helpers consumed by the playback + conversation modules.
use self::audio::{StreamResampler, compute_rms, resample};
#[cfg(test)]
use self::audio::{
    normalize_interleaved_f32, normalize_interleaved_f64, normalize_interleaved_i16,
    normalize_interleaved_i32, normalize_interleaved_u8, normalize_interleaved_u16,
    resample_to_target_rate,
};

mod convo;
mod deepgram;
mod download;
mod inference;
mod lfm2;
mod mel;
mod playback;
mod providers;
mod registry;
mod settings;
mod types;

pub(crate) use convo::*;

use deepgram::*;

use download::*;
use inference::*;
use lfm2::*;
use mel::*;
pub(crate) use playback::*;
use providers::*;
pub(crate) use registry::*;
pub(crate) use settings::*;
pub(crate) use types::*;

mod catalog;

pub(super) use catalog::*;

#[cfg(test)]
mod tests;
