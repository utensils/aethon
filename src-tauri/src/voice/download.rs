use std::path::Path;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use super::{DISTIL_MODEL_FILES, LFM2_HF_REPO, LFM2_MODEL_FILES, VoiceDownloadProgress};

pub(super) async fn download_distil_model(
    app: &AppHandle,
    provider_id: &str,
    cache_path: &Path,
) -> Result<(), String> {
    download_hf_model(
        app,
        provider_id,
        cache_path,
        "distil-whisper/distil-large-v3",
        &DISTIL_MODEL_FILES,
    )
    .await
}

pub(super) async fn download_lfm2_model(
    app: &AppHandle,
    provider_id: &str,
    cache_path: &Path,
) -> Result<(), String> {
    download_hf_model(
        app,
        provider_id,
        cache_path,
        LFM2_HF_REPO,
        &LFM2_MODEL_FILES,
    )
    .await
}

/// Stream a set of files from a Hugging Face repo into `cache_path`, emitting
/// `voice-download-progress` events and writing each file via a `.part`
/// tempfile that is renamed into place only once fully downloaded.
async fn download_hf_model(
    app: &AppHandle,
    provider_id: &str,
    cache_path: &Path,
    repo: &str,
    files: &[(&str, Option<u64>)],
) -> Result<(), String> {
    let known_total = files.iter().filter_map(|(_, size)| *size).sum::<u64>();
    let mut overall_downloaded = 0_u64;
    let client = reqwest::Client::new();

    for (filename, known_size) in files.iter().copied() {
        let destination = cache_path.join(filename);
        if destination.is_file() {
            overall_downloaded += destination.metadata().map(|m| m.len()).unwrap_or(0);
            continue;
        }

        let url = format!("https://huggingface.co/{repo}/resolve/main/{filename}");
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to download {filename}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Failed to download {filename}: {e}"))?;

        let total = response.content_length().or(known_size);
        let part_path = destination.with_extension("part");
        let mut file = tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| format!("Failed to write {filename}: {e}"))?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0_u64;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Failed while downloading {filename}: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write {filename}: {e}"))?;
            downloaded += chunk.len() as u64;
            let denominator = known_total.max(total.unwrap_or(0));
            let percent = if denominator > 0 {
                Some(((overall_downloaded + downloaded) as f64 / denominator as f64).min(1.0))
            } else {
                None
            };
            let _ = app.emit(
                "voice-download-progress",
                VoiceDownloadProgress {
                    provider_id: provider_id.to_string(),
                    filename: filename.to_string(),
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                    overall_downloaded_bytes: overall_downloaded + downloaded,
                    overall_total_bytes: if known_total > 0 {
                        Some(known_total)
                    } else {
                        None
                    },
                    percent,
                },
            );
        }
        file.flush()
            .await
            .map_err(|e| format!("Failed to flush {filename}: {e}"))?;
        tokio::fs::rename(&part_path, &destination)
            .await
            .map_err(|e| format!("Failed to finalize {filename}: {e}"))?;
        overall_downloaded += downloaded;
    }

    Ok(())
}
