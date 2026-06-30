//! SQLite-backed session search / delete / fork / chat-Markdown export.
//!
//! Pi may still write sidecar transcripts to its own default session
//! directory, but Aethon's application state reads session data from SQLite.
//! Snippet building lives here so UTF-16 / multibyte indexing pitfalls stay
//! Rust-side.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::helpers::sanitize_filename_segment;

const SESSION_PAYLOAD_VERSION: i64 = 3;
const MAX_FORK_LABEL_CHARS: usize = 120;
const MAX_SESSION_LABEL_BASE_CHARS: usize = 120;

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

#[derive(serde::Serialize)]
pub struct ForkSessionResult {
    #[serde(rename = "tabId")]
    tab_id: String,
    #[serde(rename = "newTabId")]
    new_tab_id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    messages: Vec<ForkSessionMessage>,
}

#[derive(serde::Serialize)]
pub struct ForkSessionMessage {
    id: String,
    #[serde(rename = "entryId")]
    entry_id: String,
    role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
}

#[derive(Clone)]
struct SessionEntryRow {
    entry_id: String,
    parent_entry_id: Option<String>,
    entry_type: String,
    role: Option<String>,
    text: Option<String>,
    timestamp: Option<i64>,
    payload_json: String,
}

#[tauri::command]
pub fn fork_session(
    tab_id: String,
    entry_id: String,
    cwd: Option<String>,
    app: AppHandle,
) -> Result<ForkSessionResult, String> {
    validate_session_tab_id(&tab_id)?;
    validate_session_entry_id(&entry_id)?;
    let cwd = normalize_optional_cwd(cwd);
    let mut conn = crate::storage::connect(&app)?;
    let (source_session_id, source_label) =
        select_fork_source_session(&conn, &tab_id, cwd.as_deref())?
            .ok_or_else(|| "fork_session: source session not found".to_string())?;
    let entries = session_entry_rows(&conn, &source_session_id)?;
    let path = entry_path_to_leaf(&entries, &entry_id)
        .ok_or_else(|| format!("fork_session: unknown entry {entry_id}"))?;
    let new_tab_id = uuid::Uuid::new_v4().to_string();
    let new_session_id = uuid::Uuid::new_v4().to_string();
    let label = fork_label(source_label.as_deref());
    let now = now_ms();
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let header = json!({
        "header": {
            "type": "session",
            "version": SESSION_PAYLOAD_VERSION,
            "id": new_session_id,
            "timestamp": timestamp,
            "cwd": cwd.as_deref().unwrap_or(""),
            "parentSession": source_session_id,
        }
    });
    let first_user_message = path
        .iter()
        .find(|row| row.role.as_deref() == Some("user"))
        .and_then(|row| row.text.as_deref())
        .filter(|text| !text.is_empty())
        .map(short_session_label);

    let tx = conn
        .transaction()
        .map_err(|e| format!("sqlite begin fork: {e}"))?;
    tx.execute(
        r#"
        INSERT OR REPLACE INTO session_tabs(
          tab_id, cwd, custom_label, first_user_message, metadata_json, last_modified
        ) VALUES (?1, ?2, ?3, ?4, '{}', ?5)
        "#,
        params![new_tab_id, cwd, label, first_user_message, now],
    )
    .map_err(|e| format!("sqlite fork insert tab: {e}"))?;
    tx.execute(
        r#"
        INSERT INTO sessions(
          session_id, tab_id, cwd, current_leaf_entry_id, payload_json, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        "#,
        params![
            new_session_id,
            new_tab_id,
            cwd,
            entry_id,
            header.to_string(),
            now
        ],
    )
    .map_err(|e| format!("sqlite fork insert session: {e}"))?;
    for (ordinal, row) in path.iter().enumerate() {
        tx.execute(
            r#"
            INSERT OR REPLACE INTO session_entries(
              session_id, entry_id, parent_entry_id, entry_type, role, text, timestamp, payload_json, ordinal
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                new_session_id,
                row.entry_id,
                row.parent_entry_id,
                row.entry_type,
                row.role,
                row.text,
                row.timestamp,
                row.payload_json,
                ordinal as i64,
            ],
        )
        .map_err(|e| format!("sqlite fork insert entry: {e}"))?;
        if let Some(text) = row.text.as_deref().filter(|text| !text.is_empty()) {
            tx.execute(
                "INSERT INTO session_search_fts(tab_id, role, text, timestamp, source) VALUES (?1, ?2, ?3, ?4, 'pi')",
                params![new_tab_id, row.role.as_deref().unwrap_or(""), text, row.timestamp.unwrap_or(now)],
            )
            .map_err(|e| format!("sqlite fork index entry: {e}"))?;
        }
    }
    tx.commit()
        .map_err(|e| format!("sqlite commit fork: {e}"))?;
    let messages = path
        .iter()
        .filter_map(fork_seed_message)
        .collect::<Vec<_>>();
    Ok(ForkSessionResult {
        tab_id,
        new_tab_id,
        label,
        cwd,
        messages,
    })
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

fn validate_session_entry_id(entry_id: &str) -> Result<(), String> {
    if entry_id.is_empty() || entry_id.len() > 128 {
        return Err("entry_id must be 1..=128 chars".to_string());
    }
    if !entry_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("entry_id must match [A-Za-z0-9_-]".to_string());
    }
    Ok(())
}

fn normalize_optional_cwd(cwd: Option<String>) -> Option<String> {
    cwd.and_then(|value| {
        let trimmed = value.trim().trim_end_matches(['/', '\\']).to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn cwd_matches(session_cwd: Option<&str>, expected_cwd: Option<&str>) -> bool {
    let Some(expected) = normalize_optional_cwd(expected_cwd.map(ToOwned::to_owned)) else {
        return true;
    };
    normalize_optional_cwd(session_cwd.map(ToOwned::to_owned)).as_deref() == Some(expected.as_str())
}

fn select_fork_source_session(
    conn: &rusqlite::Connection,
    tab_id: &str,
    cwd: Option<&str>,
) -> Result<Option<(String, Option<String>)>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT s.session_id, s.cwd, st.custom_label
            FROM sessions s
            LEFT JOIN session_tabs st ON st.tab_id = s.tab_id
            WHERE s.tab_id = ?1
            ORDER BY s.updated_at DESC
            "#,
        )
        .map_err(|e| format!("sqlite prepare fork source: {e}"))?;
    let rows = stmt
        .query_map(params![tab_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("sqlite query fork source: {e}"))?;
    for row in rows {
        let (session_id, session_cwd, label) =
            row.map_err(|e| format!("sqlite fork source row: {e}"))?;
        if cwd_matches(session_cwd.as_deref(), cwd) {
            return Ok(Some((session_id, label)));
        }
    }
    Ok(None)
}

fn session_entry_rows(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<SessionEntryRow>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT entry_id, parent_entry_id, entry_type, role, text, timestamp, payload_json
            FROM session_entries
            WHERE session_id = ?1
            ORDER BY ordinal ASC
            "#,
        )
        .map_err(|e| format!("sqlite prepare fork entries: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(SessionEntryRow {
                entry_id: row.get(0)?,
                parent_entry_id: row.get(1)?,
                entry_type: row.get(2)?,
                role: row.get(3)?,
                text: row.get(4)?,
                timestamp: row.get(5)?,
                payload_json: row.get(6)?,
            })
        })
        .map_err(|e| format!("sqlite query fork entries: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("sqlite fork entry row: {e}"))
}

fn entry_path_to_leaf(rows: &[SessionEntryRow], leaf_id: &str) -> Option<Vec<SessionEntryRow>> {
    let by_id: HashMap<&str, &SessionEntryRow> = rows
        .iter()
        .map(|row| (row.entry_id.as_str(), row))
        .collect();
    let mut out = Vec::new();
    let mut current = by_id.get(leaf_id).copied();
    while let Some(row) = current {
        out.push(row.clone());
        current = row
            .parent_entry_id
            .as_deref()
            .and_then(|parent| by_id.get(parent).copied());
    }
    if out.is_empty() {
        None
    } else {
        out.reverse();
        Some(out)
    }
}

fn fork_seed_message(row: &SessionEntryRow) -> Option<ForkSessionMessage> {
    let role = match row.role.as_deref()? {
        "agent" | "assistant" => "agent",
        "user" => "user",
        "system" => "system",
        _ => return None,
    };
    let text = row
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned);
    if text.is_none() {
        return None;
    }
    Some(ForkSessionMessage {
        id: row.entry_id.clone(),
        entry_id: row.entry_id.clone(),
        role: role.to_string(),
        text,
        created_at: row.timestamp,
    })
}

fn fork_label(src_label: Option<&str>) -> String {
    let base = src_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("session");
    format!("Fork of {base}")
        .chars()
        .take(MAX_FORK_LABEL_CHARS)
        .collect()
}

fn short_session_label(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_SESSION_LABEL_BASE_CHARS {
        text.to_string()
    } else {
        let mut label: String = text
            .chars()
            .take(MAX_SESSION_LABEL_BASE_CHARS - 3)
            .collect();
        label.push_str("...");
        label
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
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
