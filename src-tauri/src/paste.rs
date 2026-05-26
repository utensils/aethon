use tauri::{AppHandle, Manager};

use crate::helpers::{self, sanitize_filename_segment};

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
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("save_paste_image: payload exceeds 32 MiB".to_string());
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("pastes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let ext = sanitize_extension(extension.as_deref());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
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
