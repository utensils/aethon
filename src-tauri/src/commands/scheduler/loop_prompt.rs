use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::LOOP_PROMPT_MAX_BYTES;
use super::types::LoopPromptResolution;

pub(super) fn resolve_loop_prompt(
    cwd: Option<&str>,
    app: &AppHandle,
) -> Result<LoopPromptResolution, String> {
    let mut candidates: Vec<(PathBuf, &str)> = Vec::new();
    if let Some(cwd) = cwd.filter(|s| !s.trim().is_empty()) {
        let root = PathBuf::from(cwd);
        candidates.push((
            root.join(".aethon").join("loop.md"),
            "projectAethonLoopFile",
        ));
        candidates.push((
            root.join(".claude").join("loop.md"),
            "projectClaudeLoopFile",
        ));
    }
    if let Ok(home) = app.path().home_dir() {
        candidates.push((home.join(".aethon").join("loop.md"), "userAethonLoopFile"));
        candidates.push((home.join(".claude").join("loop.md"), "userClaudeLoopFile"));
    }
    for (path, source) in candidates {
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let limited = if bytes.len() > LOOP_PROMPT_MAX_BYTES {
            &bytes[..LOOP_PROMPT_MAX_BYTES]
        } else {
            &bytes
        };
        let prompt = String::from_utf8_lossy(limited).trim().to_string();
        if !prompt.is_empty() {
            return Ok(LoopPromptResolution {
                prompt,
                source: source.to_string(),
            });
        }
    }

    Ok(LoopPromptResolution {
        prompt: "Review the current project for useful next steps, check status, run lightweight verification if appropriate, and report or act only on actionable work.".to_string(),
        source: "builtInMaintenance".to_string(),
    })
}
