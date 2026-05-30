use tauri::{AppHandle, Manager};

use crate::helpers::{self, sanitize_filename_segment};

const MAX_PASTE_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// Persist an image paste from the clipboard to `~/.aethon/pastes/`.
/// Returns the absolute path so the frontend can insert it into the
/// draft as an `@<path>` token and let the agent read it like any other file.
#[tauri::command]
pub(crate) fn save_paste_image(
    bytes: Vec<u8>,
    extension: Option<String>,
    app: AppHandle,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("save_paste_image: empty payload".to_string());
    }
    if bytes.len() as u64 > MAX_PASTE_IMAGE_BYTES {
        return Err("save_paste_image: payload exceeds 32 MiB".to_string());
    }
    let dir = paste_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let ext = sanitize_extension(extension.as_deref());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Read a previously-saved paste image back as base64 for durable chat previews.
/// The requested path must resolve inside `~/.aethon/pastes/`.
#[tauri::command]
pub(crate) fn read_paste_image_base64(path: String, app: AppHandle) -> Result<String, String> {
    use base64::Engine as _;

    let dir = paste_dir(&app)?;
    let dir_canon = dir
        .canonicalize()
        .map_err(|e| format!("paste dir canonicalize: {e}"))?;
    let target = std::path::PathBuf::from(&path);
    let target_canon = target
        .canonicalize()
        .map_err(|e| format!("paste image canonicalize: {e}"))?;
    if !target_canon.starts_with(&dir_canon) {
        return Err("paste image is outside the paste directory".to_string());
    }
    let metadata = std::fs::metadata(&target_canon)
        .map_err(|e| format!("stat {}: {e}", target_canon.display()))?;
    if metadata.is_dir() {
        return Err(format!("not a file: {}", target_canon.display()));
    }
    if metadata.len() > MAX_PASTE_IMAGE_BYTES {
        return Err(format!(
            "paste image too large: {} bytes (cap {MAX_PASTE_IMAGE_BYTES})",
            metadata.len()
        ));
    }
    let bytes = std::fs::read(&target_canon)
        .map_err(|e| format!("read {}: {e}", target_canon.display()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn paste_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    Ok(helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("pastes"))
}

fn sanitize_extension(extension: Option<&str>) -> String {
    extension
        .filter(|e| !e.is_empty())
        .map(sanitize_filename_segment)
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "png".to_string())
}

#[cfg(test)]
mod tests {
    use super::sanitize_extension;

    #[test]
    fn sanitize_extension_defaults_empty_values_to_png() {
        assert_eq!(sanitize_extension(None), "png");
        assert_eq!(sanitize_extension(Some("")), "png");
    }

    #[test]
    fn sanitize_extension_removes_unsafe_path_parts() {
        assert_eq!(sanitize_extension(Some("../jpeg")), "jpeg");
    }
}
