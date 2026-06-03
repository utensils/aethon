//! Pi session search / delete / chat-Markdown export.
//!
//! Pi persists each tab's transcript at
//! `~/.aethon/sessions/<tabId>/*.jsonl`. These commands let the
//! frontend search across all tabs, delete a tab's session, and write
//! a rendered chat to `~/Downloads/`. Snippet building lives here too
//! so UTF-16 / multibyte indexing pitfalls stay Rust-side.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::helpers::{resolve_inside_root, sanitize_filename_segment};

/// Cross-session search (M6 P6). Walks `~/.aethon/sessions/<tabId>/*.jsonl`
/// and returns user / assistant messages whose text content contains
/// the query (case-insensitive substring match — no regex parsing,
/// keeps the bar low). Capped at `limit` matches.
#[derive(serde::Serialize)]
pub struct SearchHit {
    #[serde(rename = "tabId")]
    tab_id: String,
    role: String,
    /// Snippet split into the three regions around the matched needle —
    /// `before`, the match itself, and `after`. The frontend wraps the
    /// middle piece in `<mark>` for visual emphasis. Splitting Rust-side
    /// avoids any UTF-16 / code-point indexing pitfalls JS would hit if
    /// it tried to index into a single concatenated snippet.
    #[serde(rename = "snippetBefore")]
    snippet_before: String,
    #[serde(rename = "snippetMatch")]
    snippet_match: String,
    #[serde(rename = "snippetAfter")]
    snippet_after: String,
    timestamp: Option<i64>,
}

#[tauri::command]
pub fn search_sessions(
    query: String,
    limit: Option<u32>,
    app: AppHandle,
) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(200).min(5000) as usize;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let sessions = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("sessions");
    if !sessions.is_dir() {
        return Ok(Vec::new());
    }

    let mut hits: Vec<SearchHit> = Vec::new();
    let entries = match std::fs::read_dir(&sessions) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    'tab_loop: for tab_entry in entries.flatten() {
        let tab_dir = tab_entry.path();
        if !tab_dir.is_dir() {
            continue;
        }
        let tab_id = tab_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let files = match std::fs::read_dir(&tab_dir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file_entry in files.flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let v: serde_json::Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // Pi session JSONL envelope is `{type:"message", message:{role, content}}`
                // (matches the restore path in `agent/session-history.ts`).
                // Older v1 reads at the top level, which never matches —
                // fall through to that as a tolerant fallback so any
                // non-pi sources (e.g. a future raw export) still index.
                if v.get("type").and_then(|t| t.as_str()) != Some("message") {
                    continue;
                }
                let inner = match v.get("message") {
                    Some(m) if m.is_object() => m,
                    _ => continue,
                };
                let role = inner
                    .get("role")
                    .and_then(|r| r.as_str())
                    .unwrap_or("")
                    .to_string();
                if role != "user" && role != "assistant" {
                    continue;
                }
                let content_text = extract_text_from_content(inner);
                if content_text.is_empty() {
                    continue;
                }
                let lower = content_text.to_lowercase();
                let pos = match lower.find(&needle) {
                    Some(p) => p,
                    None => continue,
                };
                let (before, match_, after) =
                    build_snippet_parts(&content_text, pos, needle.len(), 60, 100);
                // Timestamp lives on the outer envelope, not the message.
                let timestamp = v.get("timestamp").and_then(|t| t.as_i64());
                hits.push(SearchHit {
                    tab_id: tab_id.clone(),
                    role: role.clone(),
                    snippet_before: before,
                    snippet_match: match_,
                    snippet_after: after,
                    timestamp,
                });
                if hits.len() >= cap {
                    break 'tab_loop;
                }
            }
        }
    }
    Ok(hits)
}

/// Delete a persisted session directory at `~/.aethon/sessions/<tab_id>/`.
/// `tab_id` must match the bridge's `discoverPersistedTabs` regex
/// (`^[A-Za-z0-9_-]{1,128}$`) so a malicious caller can't path-traverse
/// out of the sessions directory. `default` is intentionally allowed:
/// it is a bootstrap implementation detail, not a protected user
/// session.
#[tauri::command]
pub fn delete_session(tab_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_tab_id(&tab_id)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let sessions_root = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("sessions");
    let target = sessions_root.join(&tab_id);
    delete_session_dir(target, sessions_root)
}

/// Move a freshly-branched session file (produced by `createBranchedSession`
/// into the *source* tab's dir) into a new tab's session directory, so the
/// per-tab layout the bridge expects holds for the fork. Used by `fork_session`.
///
/// `source_path` is supplied by the bridge; we trust nothing about it — it must
/// canonicalize to a real file that already lives under `~/.aethon/sessions`
/// (blocking a spoofed path at `/etc/...`), and the destination is pinned to
/// `<sessions>/<dest_tab_id>/` with a validated tab id + lexical inside-root
/// check. Returns the absolute destination path.
#[tauri::command]
pub fn copy_session_file(
    source_path: String,
    dest_tab_id: String,
    app: AppHandle,
) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let sessions_root = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("sessions");
    let dest = copy_session_into_tab(Path::new(&source_path), &sessions_root, &dest_tab_id)?;
    Ok(dest.to_string_lossy().into_owned())
}

fn copy_session_into_tab(
    source_path: &Path,
    sessions_root: &Path,
    dest_tab_id: &str,
) -> Result<PathBuf, String> {
    validate_session_tab_id(dest_tab_id)?;
    // The source must exist and live under the sessions root (it was produced by
    // createBranchedSession into a tab dir). Canonicalize both so a symlink or
    // `..` can't smuggle a path outside the tree past the prefix check.
    let canonical_root = std::fs::canonicalize(sessions_root)
        .map_err(|e| format!("canonicalize sessions root: {e}"))?;
    let canonical_source =
        std::fs::canonicalize(source_path).map_err(|e| format!("canonicalize source: {e}"))?;
    if !canonical_source.starts_with(&canonical_root) {
        return Err("refusing to copy: source escapes the sessions root".to_string());
    }
    if !canonical_source.is_file() {
        return Err("source is not a file".to_string());
    }
    let file_name = canonical_source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "source has no file name".to_string())?;
    let dest_dir = canonical_root.join(dest_tab_id);
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("create_dir_all {}: {e}", dest_dir.display()))?;
    let dest_path = dest_dir.join(file_name);
    if resolve_inside_root(&dest_dir, &dest_path).is_none() {
        return Err("refusing to copy: dest escapes the tab dir".to_string());
    }
    // Rename when same-filesystem (atomic); copy + remove for cross-device.
    if std::fs::rename(&canonical_source, &dest_path).is_err() {
        std::fs::copy(&canonical_source, &dest_path)
            .map_err(|e| format!("copy {}: {e}", dest_path.display()))?;
        let _ = std::fs::remove_file(&canonical_source);
    }
    Ok(dest_path)
}

fn validate_session_tab_id(tab_id: &str) -> Result<(), String> {
    if tab_id.is_empty() || tab_id.len() > 128 {
        return Err("tab_id must be 1..=128 chars".to_string());
    }
    if !tab_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("tab_id must match [A-Za-z0-9_-]".to_string());
    }
    Ok(())
}

fn delete_session_dir(target: PathBuf, sessions_root: PathBuf) -> Result<(), String> {
    // Defense in depth: even though the regex above forbids '/' and '..',
    // canonicalize and verify the result still lives directly under
    // sessions_root. A symlink replacing <tab_id>/ could otherwise
    // redirect remove_dir_all elsewhere.
    if !target.exists() {
        return Ok(()); // already gone — treat as success
    }
    let canonical_root = match std::fs::canonicalize(&sessions_root) {
        Ok(p) => p,
        Err(e) => return Err(format!("canonicalize sessions root: {e}")),
    };
    let canonical_target = match std::fs::canonicalize(&target) {
        Ok(p) => p,
        Err(e) => return Err(format!("canonicalize target: {e}")),
    };
    if canonical_target.parent() != Some(canonical_root.as_path()) {
        return Err("refusing to delete: target escapes sessions root".to_string());
    }
    std::fs::remove_dir_all(&canonical_target)
        .map_err(|e| format!("remove_dir_all {}: {e}", canonical_target.display()))?;
    tracing::info!(target: "aethon::session_delete", "deleted {}", canonical_target.display());
    Ok(())
}

fn extract_text_from_content(v: &serde_json::Value) -> String {
    let content = match v.get("content") {
        Some(c) => c,
        None => return String::new(),
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let mut chunks: Vec<String> = Vec::new();
        for part in arr {
            if let Some(s) = part.as_str() {
                chunks.push(s.to_string());
            } else if part.get("type").and_then(|t| t.as_str()) == Some("text")
                && let Some(t) = part.get("text").and_then(|t| t.as_str())
            {
                chunks.push(t.to_string());
            }
        }
        return chunks.join("\n");
    }
    String::new()
}

/// Build a three-way split snippet around the matched needle.
///
/// `byte_pos` is the byte offset of the match start in `text`,
/// `match_byte_len` is the byte length of the match. Returns
/// `(before, match, after)` after:
///   * char-boundary-safe slicing of the surrounding context
///   * leading `…` when the snippet starts mid-text
///   * trailing `…` when it ends mid-text
///   * newline → space normalisation so each row stays one line
///
/// The match piece is the verbatim slice from `text` (preserves the
/// user's case / accents) so the highlight reads naturally. Only the
/// before/after pieces get the truncation marks.
fn build_snippet_parts(
    text: &str,
    byte_pos: usize,
    match_byte_len: usize,
    before: usize,
    after: usize,
) -> (String, String, String) {
    let match_end_raw = byte_pos.saturating_add(match_byte_len).min(text.len());
    // Snap to char boundaries — the search uses to_lowercase().find()
    // which returns byte positions that line up for ASCII but can
    // straddle codepoints when the lowercase folding changes byte
    // length (e.g. `ß → ss`). Rather than panic on `text[byte_pos..]`,
    // walk to the nearest valid boundary and emit a slightly wider
    // match. The user still sees the right region; only the highlight
    // bounds drift by 1-3 bytes.
    let match_start = floor_char_boundary(text, byte_pos);
    let match_end = ceil_char_boundary(text, match_end_raw);
    let start = text
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| byte_pos.saturating_sub(before) <= i)
        .unwrap_or(0);
    let end_target = match_end.saturating_add(after);
    let end = text
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .find(|&i| i >= end_target)
        .unwrap_or(text.len());
    let normalize = |s: &str| s.replace('\n', " ").replace('\r', "");
    let before_part = {
        let mut piece = String::new();
        if start > 0 {
            piece.push('…');
        }
        piece.push_str(&text[start..match_start]);
        normalize(&piece)
    };
    let match_part = normalize(&text[match_start..match_end]);
    let after_part = {
        let mut piece = String::new();
        piece.push_str(&text[match_end..end]);
        if end < text.len() {
            piece.push('…');
        }
        normalize(&piece)
    };
    (before_part, match_part, after_part)
}

/// Greatest char boundary `<= byte`. Walks backward until `is_char_boundary`.
fn floor_char_boundary(text: &str, byte: usize) -> usize {
    let mut b = byte.min(text.len());
    while b > 0 && !text.is_char_boundary(b) {
        b -= 1;
    }
    b
}

/// Smallest char boundary `>= byte`. Walks forward until `is_char_boundary`.
fn ceil_char_boundary(text: &str, byte: usize) -> usize {
    let mut b = byte.min(text.len());
    while b < text.len() && !text.is_char_boundary(b) {
        b += 1;
    }
    b
}

/// Write a Markdown export of an active chat to `~/Downloads/`. The
/// frontend formats the body (so non-text primitives can be filtered
/// agnostically of their primitive layout); this command only owns the
/// path resolution + atomic file write. Returns the absolute path so
/// the caller can show it in a "Saved to …" toast.
#[tauri::command]
pub fn export_chat_markdown(
    label: String,
    content: String,
    app: AppHandle,
) -> Result<String, String> {
    // Prefer the platform's user Downloads dir (XDG_DOWNLOAD_DIR on
    // Linux, ~/Downloads on macOS, %USERPROFILE%\Downloads on Windows),
    // fall back to ~/Downloads. Either way, create_dir_all is safe — if
    // the user nuked Downloads we recreate it before writing.
    let downloads: PathBuf = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Downloads")))
        .map_err(|e| format!("download_dir: {e}"))?;
    std::fs::create_dir_all(&downloads).map_err(|e| format!("create_dir_all: {e}"))?;
    let safe_label = sanitize_filename_segment(&label);
    let stem = if safe_label.is_empty() {
        "aethon-chat".to_string()
    } else {
        safe_label
    };
    // No chrono dependency — millis-since-epoch is a perfectly fine
    // suffix for export uniqueness. The user sees the file mtime in
    // their downloads folder so the human-readable timestamp sits
    // outside the filename.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut path = downloads.join(format!("{stem}-{ts}.md"));
    // Avoid clobber: if the path somehow exists (concurrent exports),
    // append an `_N` suffix until free. Bounded — we'd never hit 100
    // and bailing is preferable to looping forever.
    let mut suffix = 1u32;
    while path.exists() && suffix < 100 {
        path = downloads.join(format!("{stem}-{ts}_{suffix}.md"));
        suffix += 1;
    }
    std::fs::write(&path, content).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{copy_session_into_tab, delete_session_dir, validate_session_tab_id};
    use std::path::PathBuf;

    #[test]
    fn validate_session_tab_id_allows_default() {
        assert!(validate_session_tab_id("default").is_ok());
    }

    #[test]
    fn validate_session_tab_id_rejects_path_traversal() {
        assert!(validate_session_tab_id("../default").is_err());
        assert!(validate_session_tab_id("nested/default").is_err());
        assert!(validate_session_tab_id("").is_err());
    }

    #[test]
    fn delete_session_dir_removes_default_directory() {
        let root =
            std::env::temp_dir().join(format!("aethon-session-delete-{}", uuid::Uuid::new_v4()));
        let sessions = root.join("sessions");
        let default_dir = sessions.join("default");
        std::fs::create_dir_all(&default_dir).expect("create default session dir");
        std::fs::write(default_dir.join("aethon-chat.jsonl"), "{}\n").expect("write local log");

        delete_session_dir(default_dir.clone(), sessions).expect("delete default session");
        assert!(!default_dir.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    fn copy_test_root() -> PathBuf {
        std::env::temp_dir().join(format!("aethon-session-copy-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn copy_session_into_tab_moves_file_and_preserves_header() {
        let root = copy_test_root();
        let sessions = root.join("sessions");
        let src_dir = sessions.join("tab-a");
        std::fs::create_dir_all(&src_dir).expect("create src tab dir");
        let header = "{\"type\":\"session\",\"id\":\"s1\",\"cwd\":\"/proj\"}\n{\"type\":\"message\",\"id\":\"m1\"}\n";
        let src = src_dir.join("123_branch.jsonl");
        std::fs::write(&src, header).expect("write source session");

        let dest = copy_session_into_tab(&src, &sessions, "tab-b").expect("copy into tab-b");

        assert!(dest.ends_with("123_branch.jsonl"));
        assert!(dest.starts_with(std::fs::canonicalize(&sessions).unwrap().join("tab-b")));
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), header);
        // Move semantics: the branched source is gone.
        assert!(!src.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_session_into_tab_rejects_source_outside_sessions_root() {
        let root = copy_test_root();
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions root");
        // A real file, but outside the sessions tree.
        let outside = root.join("outside.jsonl");
        std::fs::write(&outside, "{}\n").expect("write outside file");

        let err = copy_session_into_tab(&outside, &sessions, "tab-b").unwrap_err();
        assert!(err.contains("escapes the sessions root"), "got: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_session_into_tab_rejects_invalid_dest_tab_id() {
        let root = copy_test_root();
        let sessions = root.join("sessions");
        let src_dir = sessions.join("tab-a");
        std::fs::create_dir_all(&src_dir).expect("create src tab dir");
        let src = src_dir.join("x.jsonl");
        std::fs::write(&src, "{}\n").expect("write source");

        assert!(copy_session_into_tab(&src, &sessions, "../escape").is_err());
        assert!(copy_session_into_tab(&src, &sessions, "nested/id").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
