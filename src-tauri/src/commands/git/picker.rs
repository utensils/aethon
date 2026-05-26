use std::path::PathBuf;

use tauri::AppHandle;

/// Pop a native folder picker and return the chosen path (or None if the
/// user cancelled). Wrapping `tauri-plugin-dialog::pick_folder` here keeps
/// the frontend free of a direct dialog dependency — the projects feature
/// is the only place we open native dialogs, so a single command is
/// simpler than wiring the plugin's permissions through the JS side too.
#[tauri::command]
pub async fn pick_project_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_title("Choose project directory")
        .pick_folder(move |path| {
            // FilePath → PathBuf; oneshot send is fire-and-forget — if the
            // receiver dropped (window closed mid-pick) the result is
            // simply discarded.
            let resolved: Option<PathBuf> = match path {
                Some(fp) => fp.into_path().ok(),
                None => None,
            };
            let _ = tx.send(resolved);
        });
    let path = rx.await.map_err(|e| format!("dialog channel: {e}"))?;
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}
