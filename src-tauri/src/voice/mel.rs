use super::{TARGET_SAMPLE_RATE, whisper};

pub(super) fn build_mel_filters(num_mel_bins: usize) -> Vec<f32> {
    let freq_bins = whisper::N_FFT / 2 + 1;
    let min_mel = hz_to_mel(0.0);
    let max_mel = hz_to_mel(TARGET_SAMPLE_RATE as f32 / 2.0);
    let mel_points = (0..num_mel_bins + 2)
        .map(|index| {
            let fraction = index as f32 / (num_mel_bins + 1) as f32;
            mel_to_hz(min_mel + fraction * (max_mel - min_mel))
        })
        .collect::<Vec<_>>();
    let fft_freqs = (0..freq_bins)
        .map(|index| index as f32 * TARGET_SAMPLE_RATE as f32 / whisper::N_FFT as f32)
        .collect::<Vec<_>>();
    let mut filters = vec![0.0; num_mel_bins * freq_bins];

    for mel_index in 0..num_mel_bins {
        let left = mel_points[mel_index];
        let center = mel_points[mel_index + 1];
        let right = mel_points[mel_index + 2];
        for (freq_index, freq) in fft_freqs.iter().copied().enumerate() {
            let value = if freq < left || freq > right {
                0.0
            } else if freq <= center {
                (freq - left) / (center - left)
            } else {
                (right - freq) / (right - center)
            };
            filters[mel_index * freq_bins + freq_index] = value.max(0.0);
        }
    }

    filters
}

pub(super) fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

pub(super) fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10_f32.powf(mel / 2595.0) - 1.0)
}
