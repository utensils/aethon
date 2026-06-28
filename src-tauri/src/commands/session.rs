//! SQLite-backed session search / delete / chat-Markdown export.
//!
//! Pi may still write sidecar transcripts to its own default session
//! directory, but Aethon's application state reads session data from SQLite.
//! Snippet building lives here so UTF-16 / multibyte indexing pitfalls stay
//! Rust-side.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::helpers::sanitize_filename_segment;

/// Cross-session search over Aethon's SQLite session tables. Capped at `limit`
/// matches.
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
    let conn = crate::storage::connect(&app)?;
    let mut hits: Vec<SearchHit> = Vec::new();
    let like = format!("%{}%", escape_like(&needle));
    let mut stmt = conn
        .prepare(
            r#"
            SELECT tab_id, role, text, timestamp
            FROM session_search_fts
            WHERE lower(text) LIKE ?1 ESCAPE '\'
            ORDER BY CAST(timestamp AS INTEGER) DESC
            LIMIT ?2
            "#,
        )
        .map_err(|e| format!("sqlite prepare search: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![like, cap as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|e| format!("sqlite search: {e}"))?;
    for row in rows {
        let (tab_id, role, content_text, timestamp) =
            row.map_err(|e| format!("sqlite search row: {e}"))?;
        let lower = content_text.to_lowercase();
        let Some(pos) = lower.find(&needle) else {
            continue;
        };
        let (before, match_, after) =
            build_snippet_parts(&content_text, pos, needle.len(), 60, 100);
        hits.push(SearchHit {
            tab_id,
            role,
            snippet_before: before,
            snippet_match: match_,
            snippet_after: after,
            timestamp,
        });
    }
    Ok(hits)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Delete a persisted Aethon session from SQLite. Pi sidecar files are left in
/// pi's default session directory for user pickup / analytics.
#[tauri::command]
pub fn delete_session(tab_id: String, app: AppHandle) -> Result<(), String> {
    validate_session_tab_id(&tab_id)?;
    let conn = crate::storage::connect(&app)?;
    conn.execute(
        "DELETE FROM session_search_fts WHERE tab_id = ?1",
        rusqlite::params![tab_id],
    )
    .map_err(|e| format!("sqlite delete search rows: {e}"))?;
    conn.execute(
        "DELETE FROM session_tabs WHERE tab_id = ?1",
        rusqlite::params![tab_id],
    )
    .map_err(|e| format!("sqlite delete session: {e}"))?;
    tracing::info!(target: "aethon::session_delete", "deleted sqlite session {tab_id}");
    Ok(())
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

#[cfg(test)]
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
    use super::{delete_session_dir, escape_like, validate_session_tab_id};

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

    #[test]
    fn escape_like_escapes_wildcards_and_escape_character() {
        assert_eq!(escape_like(r"a\b%c_d"), r"a\\b\%c\_d");
    }
}
