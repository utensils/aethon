use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

mod helpers;
mod shell;
use helpers::{
    FONT_SIZE_MAX, FONT_SIZE_MIN, clamp_font_size, parse_config_toml, validate_state_name,
};

/// Extension-registered menu item. Mirrors the shape the bridge ships
/// in `extension_menu_items` events so deserialization is direct.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtensionMenuItem {
    pub id: String,
    pub label: String,
    pub action: String,
    pub location: String, // "app" | "tray"
    pub parent: Option<String>,
}

/// App-state container for extension menu items. The bridge can register
/// items at any time; the frontend forwards each delta into
/// `set_extension_menu_items`, which persists the latest list here and
/// rebuilds the native menu.
#[derive(Default)]
pub struct ExtensionMenuStore(pub Mutex<Vec<ExtensionMenuItem>>);

/// Resolve `<home>/.aethon/<name>` after rejecting path-traversal segments.
/// The parent directory is created on demand. Uses Tauri's cross-platform
/// `home_dir()` so Windows (USERPROFILE), macOS, and Linux all resolve
/// without env-var assumptions.
fn aethon_state_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    validate_state_name(name)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = home.join(".aethon");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(name))
}

/// Read a file from `~/.aethon/`. Returns an empty string when the file
/// doesn't exist so callers can do a "first run" check without distinguishing
/// missing from empty.
#[tauri::command]
fn read_state(name: String, app: AppHandle) -> Result<String, String> {
    let path = aethon_state_path(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Write a file to `~/.aethon/`. Creates the directory if missing.
#[tauri::command]
fn write_state(name: String, content: String, app: AppHandle) -> Result<(), String> {
    let path = aethon_state_path(&app, &name)?;
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Read `~/.aethon/config.toml` and return its parsed contents as JSON. Missing
/// file → defaults (no fields). Malformed TOML → defaults + stderr warning so
/// a bad user config never blocks app boot. File size capped at 64 KiB to
/// guard against accidental gigantic configs.
///
/// The actual parsing lives in `helpers::parse_config_toml` (unit-tested);
/// this function only handles the I/O wrapper.
#[tauri::command]
fn read_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = aethon_state_path(&app, "config.toml")?;
    const MAX_BYTES: u64 = 64 * 1024;
    let mut buf = String::new();
    match std::fs::File::open(&path) {
        Ok(file) => {
            // Cap the read so a runaway config can't pull a huge file into memory.
            if let Err(e) = file.take(MAX_BYTES).read_to_string(&mut buf) {
                tracing::warn!(target: "aethon::config", "read {}: {e}; using defaults", path.display());
                buf.clear();
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => { /* defaults */ }
        Err(e) => {
            tracing::warn!(target: "aethon::config", "open {}: {e}; using defaults", path.display());
        }
    }
    let mut value = parse_config_toml(&buf);
    // Clamp font_size in-place so the JSON the frontend reads is already
    // safe — keeps the clamp policy in one place (helpers) and out of the
    // CSS rule.
    if let Some(n) = value
        .get("ui")
        .and_then(|u| u.get("fontSize"))
        .and_then(serde_json::Value::as_u64)
    {
        let clamped = clamp_font_size(n.min(u32::MAX as u64) as u32);
        value["ui"]["fontSize"] = serde_json::json!(clamped);
        // Surface a warning if the user's value was outside the supported
        // range — easier to discover than silently rewriting it.
        if u64::from(clamped) != n {
            tracing::warn!(
                target: "aethon::config",
                "font_size {n} outside [{FONT_SIZE_MIN}, {FONT_SIZE_MAX}]; using {clamped}"
            );
        }
    }
    Ok(value)
}

/// Return the absolute path of `~/.aethon/`. Used by the Settings UI's
/// "Open config.toml" button so the JS side doesn't have to encode the
/// home-dir lookup. The directory is created on demand.
#[tauri::command]
fn aethon_home_dir(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = home.join(".aethon");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Write a JSON-shaped config object back to `~/.aethon/config.toml`.
/// Used by the Settings UI (M6 P3). Minimal scope: only the keys the
/// Settings panel exposes get serialized; unknown keys in the on-disk
/// TOML are dropped because we full-rewrite (the toml crate doesn't
/// preserve comments/ordering on round-trip without `toml_edit`, which
/// would balloon dependencies). Power users edit config.toml directly
/// via the panel's "Open config.toml" button — the file isn't deleted,
/// just rewritten with the canonical key set.
///
/// Payload shape mirrors what `read_config` returns (camelCase JSON).
/// Anything missing falls back to the existing helpers default; values
/// outside their known range fall back too (e.g. an unknown share mode
/// snaps to "private"). Atomic-write via tempfile + rename so a crash
/// mid-write doesn't leave a half-written config.
///
/// Round-trips through `toml_edit` so the on-disk file's leading
/// header comment, ordering of unrelated sections, blank lines, and
/// any user-introduced keys outside the Settings UI's surface (think
/// `[experimental]` or comment-banded reminders) survive a Save click.
/// The previous implementation rewrote from scratch and silently
/// dropped any TOML the panel didn't know about — confusing for power
/// users who hand-edit the file.
#[tauri::command]
fn write_config(config: serde_json::Value, app: AppHandle) -> Result<(), String> {
    let path = aethon_state_path(&app, "config.toml")?;

    // Pull each known key from the JSON payload. Verbose but explicit
    // — no surprise keys leak through from a malicious caller.
    let ui = config.get("ui").and_then(|v| v.as_object());
    let agent = config.get("agent").and_then(|v| v.as_object());
    let shell = config.get("shell").and_then(|v| v.as_object());
    let shortcuts = config.get("shortcuts").and_then(|v| v.as_object());

    let theme = ui
        .and_then(|m| m.get("theme"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let font_size = ui
        .and_then(|m| m.get("fontSize"))
        .and_then(|v| v.as_u64())
        .map(|n| clamp_font_size(n.min(u32::MAX as u64) as u32));
    let restore_tabs = ui
        .and_then(|m| m.get("restoreTabs"))
        .and_then(|v| v.as_bool());
    let notify_on_completion = ui
        .and_then(|m| m.get("notifyOnCompletion"))
        .and_then(|v| v.as_bool());
    let notify_min_duration = ui
        .and_then(|m| m.get("notifyMinDurationSeconds"))
        .and_then(|v| v.as_u64())
        .map(|n| n.min(3600));

    let model = agent
        .and_then(|m| m.get("model"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    let default_share_mode = shell
        .and_then(|m| m.get("defaultShareMode"))
        .and_then(|v| v.as_str())
        .map(|s| helpers::normalize_default_share_mode(Some(s)))
        .unwrap_or("private");
    let auto_restart_agent = shell
        .and_then(|m| m.get("autoRestartAgent"))
        .and_then(|v| v.as_bool());
    let default_command = shell
        .and_then(|m| m.get("defaultCommand"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let default_args = shell
        .and_then(|m| m.get("defaultArgs"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<String>>()
        });
    let inherit_env = shell
        .and_then(|m| m.get("inheritEnv"))
        .and_then(|v| v.as_bool());
    let prompt_before_close = shell
        .and_then(|m| m.get("promptBeforeClose"))
        .and_then(|v| v.as_bool());
    let new_tab_kind = shortcuts
        .and_then(|m| m.get("newTabKind"))
        .and_then(|v| v.as_str())
        .map(|s| helpers::normalize_new_tab_kind(Some(s)));

    // Load the existing file (or seed a fresh document with our header
    // banner) and edit the known keys. toml_edit preserves comments,
    // ordering, and unrelated sections by design — that's the round-
    // trip guarantee.
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = if existing.trim().is_empty() {
        let header = "# ~/.aethon/config.toml — managed by Aethon Settings.\n\
                      # Keys not exposed in the Settings UI are preserved verbatim;\n\
                      # the round-trip parser keeps your hand-edits intact on Save.\n\n";
        header
            .parse::<toml_edit::DocumentMut>()
            .unwrap_or_default()
    } else {
        existing
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("parse existing config: {e}"))?
    };

    // ── [ui] ──
    {
        let ui_table = ensure_table(&mut doc, "ui");
        set_or_clear_str(ui_table, "theme", theme);
        match font_size {
            Some(n) => {
                ui_table.insert("font_size", toml_edit::value(n as i64));
            }
            None => {
                ui_table.remove("font_size");
            }
        }
        set_or_clear_bool(ui_table, "restore_tabs", restore_tabs);
        set_or_clear_bool(ui_table, "notify_on_completion", notify_on_completion);
        match notify_min_duration {
            Some(n) => {
                ui_table.insert(
                    "notify_min_duration_seconds",
                    toml_edit::value(n as i64),
                );
            }
            None => {
                ui_table.remove("notify_min_duration_seconds");
            }
        }
    }

    // ── [agent] ──
    {
        let agent_table = ensure_table(&mut doc, "agent");
        set_or_clear_str(agent_table, "model", model);
    }

    // ── [shell] ──
    {
        let shell_table = ensure_table(&mut doc, "shell");
        // default_share_mode always emitted — the privacy floor logic
        // pins to it at shell_open time, so leaving it out and falling
        // back to the implicit Rust default would silently drop a
        // user-set value if the JSON payload lost the field.
        shell_table.insert(
            "default_share_mode",
            toml_edit::value(default_share_mode),
        );
        set_or_clear_bool(shell_table, "auto_restart_agent", auto_restart_agent);
        set_or_clear_str(shell_table, "default_command", default_command);
        match default_args {
            Some(args) => {
                let mut arr = toml_edit::Array::new();
                for s in args {
                    arr.push(s);
                }
                shell_table.insert("default_args", toml_edit::value(arr));
            }
            None => {
                shell_table.remove("default_args");
            }
        }
        set_or_clear_bool(shell_table, "inherit_env", inherit_env);
        set_or_clear_bool(shell_table, "prompt_before_close", prompt_before_close);
    }

    // ── [shortcuts] ──
    {
        let shortcuts_table = ensure_table(&mut doc, "shortcuts");
        match new_tab_kind {
            Some(kind) => {
                shortcuts_table.insert("new_tab_kind", toml_edit::value(kind));
            }
            None => {
                shortcuts_table.remove("new_tab_kind");
            }
        }
    }

    // Atomic-write: write to <path>.tmp, then rename. fs::rename is
    // atomic within the same filesystem on Unix and Windows, so a
    // crash mid-write either leaves the old file untouched or the
    // fully-written new one — never a half-state.
    let serialised = doc.to_string();
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, serialised)
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

/// Get-or-create a `[section]` Table inside a toml_edit document. Used
/// by `write_config` to keep round-trip preservation: an existing
/// table's items + comments survive, a new one starts blank.
fn ensure_table<'a>(
    doc: &'a mut toml_edit::DocumentMut,
    name: &str,
) -> &'a mut toml_edit::Table {
    if !doc.contains_key(name) {
        doc.insert(name, toml_edit::Item::Table(toml_edit::Table::new()));
    }
    doc.get_mut(name)
        .and_then(|item| item.as_table_mut())
        .expect("section was just inserted")
}

/// Insert / remove a string-typed leaf key. `None` removes; `Some(value)`
/// writes (overwriting any previous comment-bearing item — the comment
/// on the *table line* is preserved either way).
fn set_or_clear_str(table: &mut toml_edit::Table, key: &str, value: Option<&str>) {
    match value {
        Some(v) => {
            table.insert(key, toml_edit::value(v));
        }
        None => {
            table.remove(key);
        }
    }
}

/// Bool variant of `set_or_clear_str`.
fn set_or_clear_bool(table: &mut toml_edit::Table, key: &str, value: Option<bool>) {
    match value {
        Some(v) => {
            table.insert(key, toml_edit::value(v));
        }
        None => {
            table.remove(key);
        }
    }
}

/// Cross-session search (M6 P6). Walks `~/.aethon/sessions/<tabId>/*.jsonl`
/// and returns user / assistant messages whose text content contains
/// the query (case-insensitive substring match — no regex parsing,
/// keeps the bar low). Capped at `limit` matches.
#[derive(serde::Serialize)]
struct SearchHit {
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
fn search_sessions(
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
    let sessions = home.join(".aethon").join("sessions");
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

#[cfg(debug_assertions)]
mod debug;

/// Pop a native folder picker and return the chosen path (or None if the
/// user cancelled). Wrapping `tauri-plugin-dialog::pick_folder` here keeps
/// the frontend free of a direct dialog dependency — the projects feature
/// is the only place we open native dialogs, so a single command is
/// simpler than wiring the plugin's permissions through the JS side too.
/// Read minimal git status for a project directory. Used by the
/// sidebar to surface a branch chip + dirty dot per project. Returns
/// `None` when the path isn't a git repository so the caller can
/// gracefully render nothing instead of bouncing through an error path.
///
/// The call shells out to `git` because reimplementing the parts we
/// need (HEAD ref read, porcelain status, upstream tracking) duplicates
/// the corner cases git already handles correctly (worktrees, detached
/// HEAD, packed refs, submodules). We only run two git commands:
/// `symbolic-ref --short HEAD` for the branch (or `rev-parse --short
/// HEAD` when detached) and `status --porcelain=v1 --branch` for the
/// dirty/ahead/behind triple. Total wall time on a clean repo is well
/// under 50ms; we cache results on the frontend so the sidebar's
/// per-project poll runs at a sane cadence.
#[derive(serde::Serialize, Default)]
struct GitStatus {
    branch: Option<String>,
    dirty: bool,
    ahead: u32,
    behind: u32,
}

#[tauri::command]
async fn git_status(path: String) -> Result<Option<GitStatus>, String> {
    use std::process::Command;
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Ok(None);
    }
    // Quick presence check — `git rev-parse --is-inside-work-tree`.
    // Saves spawning the porcelain pass on a non-git directory.
    let inside = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();
    let inside_ok = match inside {
        Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true",
        Err(_) => false,
    };
    if !inside_ok {
        return Ok(None);
    }
    // Branch: prefer the symbolic name. Falls back to a short SHA on
    // detached HEAD so the chip still says something useful.
    let branch_out = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .ok();
    let branch = match branch_out {
        Some(o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()),
    };
    // Porcelain v1 with --branch gives us:
    //   ## branch...origin/branch [ahead 2, behind 1]
    //   <X><Y> path
    //   …
    // The header line is parsed for ahead/behind (when an upstream is
    // configured). Any subsequent line means the worktree is dirty.
    let porcelain = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["status", "--porcelain=v1", "--branch"])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    if !porcelain.status.success() {
        return Ok(Some(GitStatus {
            branch,
            ..Default::default()
        }));
    }
    let text = String::from_utf8_lossy(&porcelain.stdout);
    let mut dirty = false;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // Optional `[ahead N, behind M]` tail in any combination.
            if let Some(start) = rest.find('[')
                && let Some(end) = rest[start..].find(']')
            {
                let inner = &rest[start + 1..start + end];
                for part in inner.split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") {
                        ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
        } else if !line.is_empty() {
            // Any non-header line = a tracked / untracked change.
            dirty = true;
        }
    }
    Ok(Some(GitStatus {
        branch,
        dirty,
        ahead,
        behind,
    }))
}

#[tauri::command]
async fn pick_project_directory(app: AppHandle) -> Result<Option<String>, String> {
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

struct AgentProcess(Mutex<Option<Child>>);

/// Shared atomic flag set by the file-watcher debounce worker just
/// before it kills the bun child for a hot-reload. The stdout reader
/// checks this on EOF: if true, the kill was intentional (`agent-reloaded`
/// was already emitted) — reset and stay silent. If false, the child
/// died unexpectedly and we emit `agent-crashed` so the frontend can
/// surface a notice + offer auto-restart.
struct AgentReloadFlag(Arc<AtomicBool>);

fn agent_reload_in_progress(app: &AppHandle) -> Arc<AtomicBool> {
    Arc::clone(&app.state::<AgentReloadFlag>().0)
}

/// Find the project root (the directory containing `agent/main.ts`). Tauri
/// launches the dev binary with cwd set to `src-tauri/`, but our agent script
/// lives one level up, so a naive relative path resolves to the wrong place.
/// Walk up from cwd until we find the marker; fall back to cwd if nothing
/// matches.
fn project_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir: &Path = &cwd;
    for _ in 0..6 {
        if dir.join("agent").join("main.ts").exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => break,
        }
    }
    cwd
}

/// Capture the user's login-shell PATH so the sidecar can find tools that
/// live outside launchd's minimal `/usr/bin:/bin:/usr/sbin:/sbin`. macOS
/// .app launches inherit that minimal PATH and lose Homebrew, Nix profile
/// dirs, `~/.npm-global/bin`, etc. — pi's package resolver hits this
/// immediately with `npm root -g` when settings.json declares any npm
/// package source. Mirrors the workaround VS Code / Sublime / iTerm use.
///
/// Cached forever once computed (the shell hop costs ~50–200 ms). Only
/// runs on macOS in release builds — Linux/Windows GUI launchers preserve
/// the inherited environment, and dev launches happen from a terminal that
/// already has the right PATH.
fn resolved_login_path() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            if !cfg!(target_os = "macos") {
                return None;
            }
            // SHELL points at the user's login shell; fall back to zsh
            // (the macOS default since 10.15) when unset.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            // -i forces interactive mode so ~/.zshrc / ~/.bashrc /
            // ~/.config/fish/config.fish are sourced. -l makes it a
            // login shell so ~/.zprofile / ~/.bash_profile fire too.
            //
            // Run `env` instead of trying to `echo $PATH` directly: fish
            // treats $PATH as a list and prints entries space-separated
            // (POSIX wants colons), which would silently corrupt the
            // recovered value. `env` always emits the actual exported
            // environment with PATH= colon-separated, regardless of the
            // shell that runs it.
            let out = Command::new(&shell).args(["-ilc", "env"]).output().ok()?;
            if !out.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&out.stdout);
            let path_line = stdout.lines().find(|l| l.starts_with("PATH="))?;
            let value = path_line.strip_prefix("PATH=")?.to_string();
            if value.is_empty() { None } else { Some(value) }
        })
        .clone()
}

/// Locate the bundled `aethon-agent` sidecar binary. Tauri's externalBin
/// mechanism places sidecars next to the main executable on each platform
/// (e.g. `Aethon.app/Contents/MacOS/aethon-agent-aarch64-apple-darwin`).
/// Returns Err with a descriptive message when none of the candidate paths
/// exist — the caller falls back to `bun run` in dev or surfaces the error
/// in release.
///
/// The sidecar suffix is the host's Rust target triple at build time; we
/// read it from the `TARGET` env var Cargo sets during `build.rs` (see
/// `src-tauri/build.rs`) so the same binary works no matter what triple
/// the running machine reports.
fn find_sidecar_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or("current_exe has no parent dir")?
        .to_path_buf();
    let triple = env!("AETHON_TARGET_TRIPLE");
    // Tauri's externalBin strips the triple suffix before placing the file
    // alongside the main exe (so users see `aethon-agent`, not the full
    // triple name). On Windows both the stripped and triple-suffixed
    // names get a `.exe` extension. Check the stripped variant first
    // (the one the bundler actually produces), then the raw triple
    // form as a fallback for builds where the script ran but bundling
    // didn't (e.g. running the dev exe straight out of target/release).
    let ext = std::env::consts::EXE_SUFFIX; // "" on unix, ".exe" on windows
    let candidates = [
        exe_dir.join(format!("aethon-agent{ext}")),
        exe_dir.join(format!("aethon-agent-{triple}{ext}")),
    ];
    for path in &candidates {
        if path.exists() {
            return Ok(path.clone());
        }
    }
    Err(format!(
        "aethon-agent sidecar not found next to {} (looked for: {})",
        exe.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    ))
}

/// Spawn the agent if no live child is held. Idempotent. Callers own the
/// mutex around this. In dev (`debug_assertions`) we run `bun run
/// agent/main.ts` from the project root so source edits hot-reload via
/// the watcher in `debug.rs`. In release we run the compiled
/// `aethon-agent` sidecar bundled by Tauri, with `PI_PACKAGE_DIR` set to
/// the shipped pi metadata so `pi-coding-agent`'s package.json read at
/// module load doesn't fail, plus an enriched PATH (see
/// `resolved_login_path`) so pi can find npm/git when scanning user
/// packages from `~/.pi/agent/settings.json`. Stdout is read on a
/// background thread; each line is emitted as an `agent-response`
/// Tauri event.
fn ensure_agent_spawned(guard: &mut Option<Child>, app: &AppHandle) -> Result<(), String> {
    // Reap a dead child if present — try_wait returns Ok(Some(_)) when exited.
    if let Some(child) = guard.as_mut()
        && let Ok(Some(status)) = child.try_wait()
    {
        tracing::info!(target: "aethon::agent", "previous child exited with {status:?}; respawning");
        *guard = None;
    }

    if guard.is_some() {
        return Ok(());
    }

    // Docs live under `<project>/docs/aethon-agent/` in dev and under
    // `<resource_dir>/docs/aethon-agent/` in release (declared as a Tauri
    // resource bundle entry). The agent reads them via its `read` tool to
    // get an authoritative reference for the A2UI primitives and the
    // globalThis.aethon API surface — without them, the model would have to
    // rely on training data, which lags this codebase.
    let mut command = if cfg!(debug_assertions) {
        let root = project_root();
        let docs_dir = root.join("docs").join("aethon-agent");
        let boot_layout_file = root
            .join("src")
            .join("skills")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = root
            .join("src")
            .join("skills")
            .join("default-layout")
            .join("slots.json");
        let mut c = Command::new("bun");
        c.current_dir(&root).arg("run").arg("agent/main.ts");
        c.env("AETHON_RELEASE_MODE", "0");
        c.env("AETHON_PROJECT_ROOT", &root);
        c.env("AETHON_DOCS_DIR", &docs_dir);
        c.env("AETHON_BOOT_LAYOUT_FILE", &boot_layout_file);
        c.env("AETHON_LAYOUT_SLOTS_FILE", &layout_slots_file);
        c
    } else {
        let bin = find_sidecar_binary()?;
        // pi-coding-agent reads its own package.json at module load. The
        // shipped copy lives in Tauri's resource dir at `pi/package.json`
        // (see tauri.conf.json `bundle.resources`); pi honors
        // PI_PACKAGE_DIR for the lookup, so point it there.
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?;
        let pi_dir = resource_dir.join("pi");
        let docs_dir = resource_dir.join("docs").join("aethon-agent");
        let boot_layout_file = resource_dir
            .join("skills")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = resource_dir
            .join("skills")
            .join("default-layout")
            .join("slots.json");
        let mut c = Command::new(&bin);
        c.env("PI_PACKAGE_DIR", &pi_dir);
        c.env("AETHON_RELEASE_MODE", "1");
        c.env("AETHON_DOCS_DIR", &docs_dir);
        c.env("AETHON_BOOT_LAYOUT_FILE", &boot_layout_file);
        c.env("AETHON_LAYOUT_SLOTS_FILE", &layout_slots_file);
        // Bundled .app launches inherit launchd's minimal PATH on macOS, so
        // pi's `npm root -g` (run when resolving user packages from
        // ~/.pi/agent/settings.json) fails with ENOENT. Source the user's
        // login shell once to recover the real PATH and inject it.
        if let Some(path) = resolved_login_path() {
            c.env("PATH", path);
        }
        c
    };
    // User dir is the same in both modes; the bridge writes its live state
    // snapshot here so a `cat $AETHON_STATE_FILE` always reflects the
    // current registrations without having to evaluate JS in the webview.
    if let Ok(home) = app.path().home_dir() {
        let user_dir = home.join(".aethon");
        let state_file = user_dir.join("state.json");
        let sessions_dir = user_dir.join("sessions");
        command.env("AETHON_USER_DIR", &user_dir);
        command.env("AETHON_STATE_FILE", &state_file);
        command.env("AETHON_SESSIONS_DIR", &sessions_dir);
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn agent: {e}"))?;

    let pid = child.id();
    tracing::info!(target: "aethon::agent", "spawned pid={pid}");

    // Tail-buffer of recent stderr lines. When the bun child crashes
    // unexpectedly, the supervisor emits an `agent-crashed` event with
    // the last few lines so the frontend can surface a useful error
    // notice rather than a generic "process exited" toast.
    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(32)));
    const STDERR_TAIL_CAP: usize = 32;

    let stdout = child.stdout.take().ok_or("no stdout on spawned agent")?;
    let app_stdout = app.clone();
    let reload_flag_stdout = agent_reload_in_progress(app);
    let stderr_tail_for_supervisor = Arc::clone(&stderr_tail);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let _ = app_stdout.emit("agent-response", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", "stdout reader for pid={pid} exited");
        // Stdout reader exits when the child closes stdout — i.e. the
        // child has died. Distinguish intentional kills (hot-reload via
        // the file watcher, which sets `agent_reload_in_progress` first)
        // from unexpected crashes. Reset the flag for the next cycle.
        if reload_flag_stdout.swap(false, std::sync::atomic::Ordering::AcqRel) {
            // Intentional kill — `agent-reloaded` was already emitted by
            // the watcher; nothing more to do.
            return;
        }
        // Unexpected exit. Surface a notice with stderr tail so the
        // user sees something actionable.
        let tail: Vec<String> = match stderr_tail_for_supervisor.lock() {
            Ok(g) => g.iter().cloned().collect(),
            Err(_) => Vec::new(),
        };
        let _ = app_stdout.emit(
            "agent-crashed",
            serde_json::json!({
                "pid": pid,
                "stderrTail": tail,
            }),
        );
    });

    // Capture stderr too — when the agent crashes inside Tauri's spawn env,
    // stderr is the only visible signal. Lines are mirrored to Rust's stderr
    // and forwarded to the frontend as `agent-stderr` events for the
    // aethon-debug skill / status bar to surface.
    let stderr = child.stderr.take().ok_or("no stderr on spawned agent")?;
    let app_stderr = app.clone();
    let stderr_tail_writer = Arc::clone(&stderr_tail);
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    // Bridge stderr — already prefixed by the bridge's logger
                    // since it now emits structured `LEVEL scope: msg` lines.
                    // We forward at info level and let the env filter throttle.
                    tracing::info!(target: "aethon::agent::stderr", pid = pid, "{text}");
                    if let Ok(mut g) = stderr_tail_writer.lock() {
                        if g.len() >= STDERR_TAIL_CAP {
                            g.pop_front();
                        }
                        g.push_back(text.clone());
                    }
                    let _ = app_stderr.emit("agent-stderr", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", "stderr reader for pid={pid} exited");
    });

    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn start_agent(state: State<'_, AgentProcess>, app: AppHandle) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)
}

#[tauri::command]
fn send_message(
    message: String,
    tab_id: Option<String>,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    // tabId routes to a specific pi session; the bridge defaults to
    // "default" when omitted so legacy single-tab callers keep working.
    let payload = serde_json::json!({
        "type": "chat",
        "content": message,
        "tabId": tab_id.unwrap_or_else(|| "default".to_string()),
    });
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Forward an arbitrary JSON command (e.g. `{"type":"set_model","id":"..."}`)
/// to the agent's stdin. Used by the model picker and any future runtime
/// controls that aren't wrapped in `dispatch_a2ui_event`.
#[tauri::command]
fn agent_command(
    payload: String,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn dispatch_a2ui_event(
    event: String,
    tab_id: Option<String>,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    let event_value: serde_json::Value = serde_json::from_str(&event).map_err(|e| e.to_string())?;
    // tabId routes the event (and any handler-fired pi.prompt()) to the
    // originating tab's session instead of always defaulting to "default".
    let payload = serde_json::json!({
        "type": "a2ui_event",
        "event": event_value,
        "tabId": tab_id.unwrap_or_else(|| "default".to_string()),
    });
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Watch source / extension directories for file changes and kill the
/// running agent child so the next request respawns it with fresh code.
/// Held in Tauri state to keep the watcher thread alive for the app's
/// lifetime.
///
/// Watch paths:
///   - `~/.aethon/extensions/` — user-installed Aethon extensions
///   - `~/.pi/agent/extensions/` — pi extensions (loaded via pi's
///     resourceLoader on session create)
///   - `<project>/agent/` — bridge source, dev only
struct AgentWatcher {
    /// The notify watcher itself. Held in `Arc<Mutex<>>` because the
    /// watch list is mutable post-construction — `watch_project_extensions`
    /// adds the active project's `.aethon/extensions/` dir on the fly so a
    /// project the user opens after boot still gets hot-reload.
    watcher: Arc<Mutex<notify::RecommendedWatcher>>,
    /// Currently-watched paths. Exists so `watch_project_extensions` is
    /// idempotent (never double-registers a path) and so unwatch can
    /// dedupe. Bookkeeping mirror of what's actually in the watcher.
    watched: Arc<Mutex<HashSet<PathBuf>>>,
}

struct DebounceMsg {
    settle_ms: u64,
    paths: Vec<PathBuf>,
}

/// Single-thread debounce worker — collapses bursts of file events
/// into one agent kill after the channel goes quiet for `settle_ms`.
/// Each new message resets the timeout; the largest settle requested
/// across the burst wins (so a node_modules event that arrives during
/// an extension burst doesn't get prematurely fired).
fn run_debounce_worker(rx: std::sync::mpsc::Receiver<DebounceMsg>, app: AppHandle) {
    use std::sync::mpsc::RecvTimeoutError;

    loop {
        // Block until we have at least one event to act on.
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return, // sender dropped — watcher gone
        };
        let mut settle = first.settle_ms;
        let mut last_paths = first.paths;
        // Drain further events until the channel is quiet for `settle` ms.
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(settle)) {
                Ok(next) => {
                    settle = settle.max(next.settle_ms);
                    last_paths = next.paths;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        // Quiet — fire the kill once.
        let state: State<'_, AgentProcess> = app.state();
        if let Ok(mut guard) = state.0.lock()
            && let Some(mut child) = guard.take()
        {
            let pid = child.id();
            // Mark this kill as intentional so the stdout reader
            // doesn't surface it as a crash. The reader resets the
            // flag on EOF.
            let reload_flag = agent_reload_in_progress(&app);
            reload_flag.store(true, std::sync::atomic::Ordering::Release);
            let _ = child.kill();
            let _ = child.wait();
            let _ = app.emit("agent-reloaded", "");
            tracing::info!(
                target: "aethon::agent_watch",
                "killed pid={pid} after {settle}ms settle; will respawn on next request (last paths={last_paths:?})",
            );
        }
    }
}

fn start_agent_watcher(app: AppHandle) -> Option<AgentWatcher> {
    use notify::event::{DataChange, ModifyKind};
    use notify::{EventKind, RecursiveMode, Watcher};

    // Compose the watch list. Each path is included only if it exists
    // — missing extension dirs are normal for fresh installs.
    let home = app.path().home_dir().ok();
    let mut watch_paths: Vec<PathBuf> = Vec::new();
    if let Some(h) = home {
        // ~/.aethon/extensions belongs to us — create it on boot so a
        // first-time extension drop fires Create events and the agent
        // hot-reloads without a manual restart.
        let aethon_ext = h.join(".aethon/extensions");
        let _ = std::fs::create_dir_all(&aethon_ext);
        if aethon_ext.exists() {
            watch_paths.push(aethon_ext);
        }
        // ~/.pi/agent/extensions is pi's territory but Aethon needs to
        // watch it so an extension dropped in there hot-reloads without a
        // manual app restart. Pre-create the directory if missing so the
        // watcher fires Create events on the first installed extension.
        // Failure is non-fatal — pi's installer will create it later and
        // the next app launch will pick it up.
        let pi_ext = h.join(".pi/agent/extensions");
        let _ = std::fs::create_dir_all(&pi_ext);
        if pi_ext.exists() {
            watch_paths.push(pi_ext);
        }
        // ~/.aethon/skills/node_modules holds npm-distributed skill
        // packages (manifest with `aethon` field). Pre-create so a
        // first `npm install --prefix ~/.aethon/skills <pkg>` triggers
        // a reload without needing to restart the app.
        let skills_modules = h.join(".aethon/skills/node_modules");
        let _ = std::fs::create_dir_all(&skills_modules);
        if skills_modules.exists() {
            watch_paths.push(skills_modules);
        }
        // ~/.aethon/themes holds loose-file JSON themes (no extension /
        // skill packaging required). Pre-create so the first theme drop
        // fires Create events and triggers an agent respawn that picks it
        // up via loadAethonThemeDirectory.
        let themes_dir = h.join(".aethon/themes");
        let _ = std::fs::create_dir_all(&themes_dir);
        if themes_dir.exists() {
            watch_paths.push(themes_dir);
        }
    }
    // Bridge source dir is dev-only — release ships a compiled sidecar
    // and editing the source has no effect on the running binary.
    if cfg!(debug_assertions) {
        let agent_dir = project_root().join("agent");
        if agent_dir.exists() {
            watch_paths.push(agent_dir);
        }
    }
    if watch_paths.is_empty() {
        tracing::warn!(target: "aethon::agent_watch", "nothing to watch — hot reload disabled");
        return None;
    }

    // Trailing-edge debounce backed by a single worker thread (NOT
    // one thread per event). The watcher posts each qualifying event
    // through a channel; the worker's `recv_timeout` resets on each
    // arrival and only fires the kill when the channel goes quiet for
    // the configured settle window. npm install bursts produce
    // thousands of events; spawning a thread per event would exhaust
    // OS resources on the very scenario this is supposed to handle.
    let app_clone = app.clone();
    let (debounce_tx, debounce_rx) = std::sync::mpsc::channel::<DebounceMsg>();
    std::thread::spawn(move || run_debounce_worker(debounce_rx, app_clone.clone()));

    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(ev) => ev,
                Err(err) => {
                    tracing::warn!(target: "aethon::agent_watch", "error: {err}");
                    return;
                }
            };

            // Only react to actual content writes — `Modify(Data(_))` is the
            // editor-saved-the-file event. Everything else (metadata, opens,
            // creates from build-tool atime updates, etc.) is ignored to
            // avoid spurious respawns at app startup.
            let is_data_modify = matches!(
                event.kind,
                EventKind::Modify(ModifyKind::Data(DataChange::Any | DataChange::Content))
            );
            // Some platforms (macOS fsevents) report renames from atomic
            // editors as `Modify(Name(_))`. Treat those as content changes too.
            let is_atomic_rename = matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)));
            // Extensions land in their watched dirs as a Create event when
            // the user copies a new file in. Treat those as reload triggers.
            let is_create = matches!(event.kind, EventKind::Create(_));
            // Removing an extension should also trigger reload so the
            // bridge stops loading it on the next spawn.
            let is_remove = matches!(event.kind, EventKind::Remove(_));

            if !(is_data_modify || is_atomic_rename || is_create || is_remove) {
                return;
            }

            // Only kill on changes to source files we actually care about.
            let touched_source = event.paths.iter().any(|p| {
                matches!(
                    p.extension().and_then(|s| s.to_str()),
                    Some("ts" | "tsx" | "json" | "mjs" | "js")
                )
            });
            if !touched_source {
                return;
            }

            // node_modules events get a longer settle window because
            // npm install can produce IO bursts spaced out beyond the
            // editor-save scale. Edits in agent/ or extension dirs
            // use a tighter window so the dev cycle stays snappy.
            let in_node_modules = event.paths.iter().any(|p| {
                p.components()
                    .any(|c| matches!(c.as_os_str().to_str(), Some("node_modules")))
            });
            let settle_ms: u64 = if in_node_modules { 3000 } else { 1000 };
            let _ = debounce_tx.send(DebounceMsg {
                settle_ms,
                paths: event.paths.clone(),
            });
        }) {
            Ok(w) => w,
            Err(err) => {
                tracing::error!(target: "aethon::agent_watch", "failed to create watcher: {err}");
                return None;
            }
        };

    let mut watching: HashSet<PathBuf> = HashSet::new();
    for path in &watch_paths {
        if let Err(err) = watcher.watch(path, RecursiveMode::Recursive) {
            tracing::warn!(target: "aethon::agent_watch", "failed to watch {}: {err}", path.display());
        } else {
            watching.insert(path.clone());
        }
    }
    if watching.is_empty() {
        return None;
    }

    tracing::info!(
        target: "aethon::agent_watch",
        "watching {} dir(s) for changes: {}",
        watching.len(),
        watching
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    );
    Some(AgentWatcher {
        watcher: Arc::new(Mutex::new(watcher)),
        watched: Arc::new(Mutex::new(watching)),
    })
}

/// Add a project's `.aethon/extensions/` dir to the watch list so edits
/// fire the same kill-and-respawn flow as edits in `~/.aethon/extensions/`.
/// Idempotent — re-adding a watched path is a no-op. Called by the frontend
/// after the user opens or activates a project; without this the only
/// hot-reloaded extension dirs are the user-level + skill ones, and a
/// project's `.aethon/extensions/` requires a manual agent restart.
#[tauri::command]
fn watch_project_extensions(
    state: State<'_, AgentWatcher>,
    project_path: String,
) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};
    let project = PathBuf::from(&project_path);
    let ext_dir = project.join(".aethon").join("extensions");
    if !ext_dir.exists() {
        // Pre-create so the first extension drop fires Create events
        // and the watcher already has the path in scope. Same logic as
        // ~/.aethon/extensions at boot.
        let _ = std::fs::create_dir_all(&ext_dir);
    }
    if !ext_dir.exists() {
        return Err(format!("cannot watch {}: dir missing", ext_dir.display()));
    }
    let mut watched = state.watched.lock().map_err(|e| e.to_string())?;
    if watched.contains(&ext_dir) {
        return Ok(()); // already watching
    }
    let mut watcher = state.watcher.lock().map_err(|e| e.to_string())?;
    watcher
        .watch(&ext_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", ext_dir.display()))?;
    watched.insert(ext_dir.clone());
    tracing::info!(target: "aethon::agent_watch", "now watching project ext dir {}", ext_dir.display());
    Ok(())
}

/// Drop a previously-watched project extensions dir. Called by the
/// frontend when the user removes a project or switches to a different
/// active project. Missing paths are silently ignored.
#[tauri::command]
fn unwatch_project_extensions(
    state: State<'_, AgentWatcher>,
    project_path: String,
) -> Result<(), String> {
    use notify::Watcher;
    let project = PathBuf::from(&project_path);
    let ext_dir = project.join(".aethon").join("extensions");
    let mut watched = state.watched.lock().map_err(|e| e.to_string())?;
    if !watched.contains(&ext_dir) {
        return Ok(());
    }
    let mut watcher = state.watcher.lock().map_err(|e| e.to_string())?;
    let _ = watcher.unwatch(&ext_dir);
    watched.remove(&ext_dir);
    tracing::info!(target: "aethon::agent_watch", "stopped watching project ext dir {}", ext_dir.display());
    Ok(())
}

/// True when the updater plugin has a usable pubkey configured.
/// Reads tauri.conf.json (the source of truth at runtime via
/// generate_context!) by parsing the embedded JSON. Returns false on
/// missing-or-empty so dev builds can boot without bogus keys and the
/// frontend can surface a clear "updater not configured" message.
fn updater_pubkey_configured() -> bool {
    static CONF: &str = include_str!("../tauri.conf.json");
    let v: serde_json::Value = match serde_json::from_str(CONF) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let pubkey = v
        .get("plugins")
        .and_then(|p| p.get("updater"))
        .and_then(|u| u.get("pubkey"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    !pubkey.trim().is_empty()
}

/// Tauri command the frontend uses to know whether to show the
/// "Check for Updates" UI as enabled or as a "not configured" hint.
#[tauri::command]
fn updater_available() -> bool {
    cfg!(not(any(target_os = "android", target_os = "ios"))) && updater_pubkey_configured()
}

/// Toggle main-window fullscreen. Mac uses `Cmd+Ctrl+F`, others use `F11`;
/// the menu accelerator + frontend keybindings both flow through here so
/// behaviour stays consistent. No-op (returns Ok) when no main window.
#[tauri::command]
fn toggle_fullscreen(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cur = win.is_fullscreen().map_err(|e| format!("is_fullscreen: {e}"))?;
    win.set_fullscreen(!cur)
        .map_err(|e| format!("set_fullscreen: {e}"))?;
    Ok(())
}

/// Toggle WebKit DevTools on the main window. Debug builds only — release
/// builds get a stub that errors so frontend code can show a "devtools
/// not available" toast. This matches the security stance of stripping
/// devtools from shipping bundles.
#[cfg(debug_assertions)]
#[tauri::command]
fn toggle_devtools(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    if win.is_devtools_open() {
        win.close_devtools();
    } else {
        win.open_devtools();
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
fn toggle_devtools(_app: AppHandle) -> Result<(), String> {
    Err("devtools are unavailable in release builds".to_string())
}

/// Write a Markdown export of an active chat to `~/Downloads/`. The
/// frontend formats the body (so non-text primitives can be filtered
/// agnostically of their primitive layout); this command only owns the
/// path resolution + atomic file write. Returns the absolute path so
/// the caller can show it in a "Saved to …" toast.
#[tauri::command]
fn export_chat_markdown(
    label: String,
    content: String,
    app: AppHandle,
) -> Result<String, String> {
    // Prefer the platform's user Downloads dir (XDG_DOWNLOAD_DIR on
    // Linux, ~/Downloads on macOS, %USERPROFILE%\Downloads on Windows),
    // fall back to ~/Downloads. Either way, create_dir_all is safe — if
    // the user nuked Downloads we recreate it before writing.
    let downloads = app
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

/// Persist an image paste from the clipboard to `~/.aethon/pastes/`.
/// Returns the absolute path so the frontend can insert it into the
/// draft as an `@<path>` token — the agent's existing read tool can
/// then pick the image up via the path. Why not pass bytes inline to
/// the agent: pi's bridge protocol is line-delimited JSON over stdin;
/// shipping a 1–2 MiB base64 blob per paste would balloon a single
/// message into a multi-MB write that competes with normal traffic.
/// Persisting + path-passing is the same pattern the agent uses for
/// any other read input.
#[tauri::command]
fn save_paste_image(
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
    let dir = home.join(".aethon").join("pastes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let ext = extension
        .as_deref()
        .filter(|e| !e.is_empty())
        .map(sanitize_filename_segment)
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "png".to_string());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// POSIX-friendly filename sanitiser: keeps `[A-Za-z0-9_-]+`, replaces
/// runs of unsafe chars with `_`, trims leading/trailing dots/dashes/
/// underscores, and clamps to 64 chars. Empty input → empty output (the
/// caller substitutes a default stem).
fn sanitize_filename_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_was_underscore = false;
    for c in input.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if ok {
            out.push(c);
            last_was_underscore = false;
        } else if !last_was_underscore && !out.is_empty() {
            out.push('_');
            last_was_underscore = true;
        }
    }
    let trimmed = out
        .trim_matches(|c: char| c == '_' || c == '-' || c == '.')
        .to_string();
    if trimmed.len() > 64 {
        trimmed.chars().take(64).collect()
    } else {
        trimmed
    }
}

fn validate_skill_install_spec(spec: &str) -> Result<String, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("skill install spec is required".to_string());
    }
    if trimmed.len() > 512 {
        return Err("skill install spec is too long".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("skill install spec cannot start with '-'".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("skill install spec must be a single package or git URL".to_string());
    }
    Ok(trimmed.to_string())
}

fn output_tail(stdout: &[u8], stderr: &[u8]) -> String {
    let mut text = String::new();
    let out = String::from_utf8_lossy(stdout);
    let err = String::from_utf8_lossy(stderr);
    if !out.trim().is_empty() {
        text.push_str(out.trim());
    }
    if !err.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err.trim());
    }
    const MAX: usize = 4000;
    if text.len() <= MAX {
        text
    } else {
        let mut tail = text.chars().rev().take(MAX).collect::<Vec<_>>();
        tail.reverse();
        tail.into_iter().collect()
    }
}

/// Install an Aethon npm skill package from inside the app. The spec can be
/// a normal npm package name, tarball URL, GitHub shorthand, or git URL —
/// exactly what `npm install <spec>` accepts. Running this in the Tauri shell
/// avoids the agent sidecar being killed mid-install by the existing
/// node_modules watcher. On success we still terminate the current agent so
/// the next request respawns with the freshly installed package loaded.
#[tauri::command]
async fn install_aethon_skill(
    spec: String,
    app: AppHandle,
    state: State<'_, AgentProcess>,
    reload_flag: State<'_, AgentReloadFlag>,
) -> Result<String, String> {
    let spec = validate_skill_install_spec(&spec)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let skills_dir = home.join(".aethon").join("skills");
    let install_dir = skills_dir.clone();
    let install_spec = spec.clone();
    let path_override = resolved_login_path();

    let install_result = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("create {}: {e}", install_dir.display()))?;
        let mut command = Command::new("npm");
        command
            .arg("install")
            .arg("--prefix")
            .arg(&install_dir)
            .arg(&install_spec)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = path_override {
            command.env("PATH", path);
        }
        let output = command
            .output()
            .map_err(|e| format!("npm install failed to start: {e}"))?;
        let tail = output_tail(&output.stdout, &output.stderr);
        if !output.status.success() {
            let status = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            return Err(format!("npm install exited {status}: {tail}"));
        }
        Ok(tail)
    })
    .await
    .map_err(|e| format!("install task failed: {e}"))?;

    let install_output = install_result?;
    if let Ok(mut guard) = state.0.lock()
        && let Some(mut child) = guard.take()
    {
        let pid = child.id();
        // Mark this kill as intentional BEFORE the actual kill — the
        // stdout reader's EOF handler reads this flag to decide whether
        // to fire `agent-crashed`. Without the flag, the EOF supervisor
        // misclassifies the skill-install reload as a crash and the
        // user sees both a crash toast and the auto-restart on top of
        // the deliberate `agent-reloaded` flow.
        reload_flag.0.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = child.kill();
        let _ = child.wait();
        let _ = app.emit("agent-reloaded", "");
        tracing::info!(target: "aethon::skill_install", "killed pid={pid}; will respawn with {spec}");
    }

    Ok(if install_output.trim().is_empty() {
        format!("Installed {spec}")
    } else {
        install_output
    })
}

/// Replace the persisted set of extension-registered menu items and
/// rebuild both the App menu and the tray menu so the new entries
/// appear. Idempotent — the frontend re-invokes this on every
/// `extension_menu_items` event from the bridge, including the empty
/// list case (extensions all unregistered).
#[tauri::command]
fn set_extension_menu_items(
    items: Vec<ExtensionMenuItem>,
    app: AppHandle,
    store: State<'_, ExtensionMenuStore>,
) -> Result<(), String> {
    {
        let mut guard = store.0.lock().map_err(|e| format!("lock: {e}"))?;
        *guard = items.clone();
    }
    install_app_menu(&app, &items).map_err(|e| format!("install_app_menu: {e}"))?;
    install_tray(&app, &items).map_err(|e| format!("install_tray: {e}"))?;
    Ok(())
}

/// Build and attach the native app menu. The frontend listens for a
/// `menu` Tauri event whose payload is the activated item id; both
/// menu clicks and the existing keyboard shortcuts converge on the
/// same React-side dispatcher. Predefined NS items (Quit, Hide, Cut,
/// Copy, Paste, Minimize, ...) get native behavior automatically.
///
/// `extension_items` carries any `aethon.registerMenuItem` entries from
/// extensions tagged `location: "app"`. They appear under an
/// "Extensions" submenu and emit `menu` events with id `ext:<action>`
/// so the frontend dispatcher can route them via `a2ui_event` to a
/// paired `aethon.onEvent({componentType:"menu-item", descendantId})`
/// matcher.
fn install_app_menu(
    app: &AppHandle,
    extension_items: &[ExtensionMenuItem],
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Emitter;
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    // M6 restructure: Cmd+T is focus-aware in the webview keydown
    // handler — it spawns an agent tab when focus is outside the bottom
    // terminal panel and a shell sub-tab when focus is inside. The
    // native menu can't observe webview focus, so the menu item
    // triggers an explicit "open new agent tab" action (the unambiguous
    // default users expect from "File → New Tab" everywhere). Cmd+T as
    // an accelerator still exists ONLY on this menu item — when the OS
    // delivers Cmd+T to the menu, the menu fires `new_tab` which the JS
    // router maps to `newTab()` (agent). When the user presses Cmd+T
    // with focus in the panel, the keydown handler intercepts and
    // calls `newShellTab()` instead. To prevent the menu from also
    // firing in that case we'd ideally suppress it via JS, but Tauri's
    // accelerator handling is OS-level — keeping the menu item as the
    // agent-tab path means the worst-case race spawns an agent tab,
    // which is the safer default than a surprise PTY.
    let new_tab = MenuItemBuilder::with_id("new_tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    // Cmd+Shift+T is the explicit "always shell" entry. The webview
    // handler routes it to newShellTab regardless of focus and
    // auto-opens the bottom panel. The menu mirrors that behavior.
    let new_agent_tab = MenuItemBuilder::with_id("new_shell_tab", "New Shell Tab")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next_tab", "Next Tab")
        .accelerator("CmdOrCtrl+]")
        .build(app)?;
    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Previous Tab")
        .accelerator("CmdOrCtrl+[")
        .build(app)?;
    let toggle_terminal = MenuItemBuilder::with_id("toggle_terminal", "Toggle Terminal")
        .accelerator("CmdOrCtrl+`")
        .build(app)?;
    let clear_chat = MenuItemBuilder::with_id("clear_chat", "Clear Chat")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let stop_prompt = MenuItemBuilder::with_id("stop_prompt", "Stop Current Prompt")
        .accelerator("CmdOrCtrl+.")
        .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check_updates", "Check for Updates…").build(app)?;

    // App submenu (macOS-only first slot — Linux/Windows put these in File).
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "Aethon")
        .item(&PredefinedMenuItem::about(app, Some("About Aethon"), None)?)
        .item(&check_updates)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // Cmd+W is reserved for `close_tab` (browser/IDE convention).
    // Tauri's PredefinedMenuItem::close_window also binds Cmd+W on
    // macOS, so we omit it here — the user closes the window via the
    // red traffic light or Cmd+Q. Adding both would let macOS route
    // Cmd+W to whichever menu item it picks first.
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&new_agent_tab)
        .item(&close_tab)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // On macOS the App submenu owns "Check for Updates…" (HIG-standard
    // location). Non-macOS desktops put it in View since they have no
    // App submenu and stuffing it into File would clash with tab items.
    #[cfg(target_os = "macos")]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_terminal)
        .item(&clear_chat)
        .item(&stop_prompt)
        .build()?;
    #[cfg(not(target_os = "macos"))]
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_terminal)
        .item(&clear_chat)
        .item(&stop_prompt)
        .separator()
        .item(&check_updates)
        .build()?;

    let tabs_menu = SubmenuBuilder::new(app, "Tabs")
        .item(&new_tab)
        .item(&new_agent_tab)
        .item(&close_tab)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let docs_item = MenuItemBuilder::with_id("help_docs", "Aethon Documentation").build(app)?;
    let issues_item = MenuItemBuilder::with_id("help_issues", "Report an Issue…").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&docs_item)
        .item(&issues_item)
        .build()?;

    // Build the extension submenu. Each extension item id is prefixed
    // with `ext:` so the React-side menu dispatcher can route it to
    // a2ui_event without colliding with built-in ids. Items with
    // `location: "tray"` are deferred to the tray builder below.
    let app_extension_items: Vec<&ExtensionMenuItem> = extension_items
        .iter()
        .filter(|i| i.location == "app")
        .collect();
    let extensions_submenu = if !app_extension_items.is_empty() {
        let mut b = SubmenuBuilder::new(app, "Extensions");
        for item in &app_extension_items {
            let id = format!("ext:{}", item.action);
            let mb = MenuItemBuilder::with_id(&id, &item.label).build(app)?;
            b = b.item(&mb);
        }
        Some(b.build()?)
    } else {
        None
    };

    #[cfg(target_os = "macos")]
    let menu = {
        let mut b = MenuBuilder::new(app)
            .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &tabs_menu]);
        if let Some(ref s) = extensions_submenu {
            b = b.item(s);
        }
        b.items(&[&window_menu, &help_menu]).build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let mut b = MenuBuilder::new(app).items(&[&file_menu, &edit_menu, &view_menu, &tabs_menu]);
        if let Some(ref s) = extensions_submenu {
            b = b.item(s);
        }
        b.items(&[&window_menu, &help_menu]).build()?
    };

    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        // Forward as a Tauri event so the React side's centralized
        // dispatcher (mirror of the Cmd+T / Cmd+] / Cmd+W keydown
        // handlers) fires the same code path.
        let _ = app.emit("menu", id);
    });

    Ok(())
}

/// Status-bar / tray icon with a tiny menu (Show, New Tab, Quit).
/// Left-click on the icon focuses the main window so users who hide
/// Aethon (Cmd+H) can re-summon it without going through the dock.
/// Reuses the bundled app icon as the tray glyph; macOS gets the
/// template-image treatment so it adapts to dark/light menu bars.
///
/// `extension_items` carries any `aethon.registerMenuItem` entries
/// from extensions tagged `location: "tray"`. They appear after the
/// built-in items and dispatch `menu` events with id `ext:<action>`.
///
/// The tray's `with_id` / `remove_tray_by_id` keys must match — they
/// share `TRAY_ID` so a refactor renaming one doesn't silently break
/// the idempotency contract.
const TRAY_ID: &str = "main-tray";

fn install_tray(
    app: &AppHandle,
    extension_items: &[ExtensionMenuItem],
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    fn focus_main(app: &AppHandle) {
        // Cmd+H on macOS hides the app at the application level —
        // WebviewWindow::show() doesn't unhide that. AppHandle::show()
        // does. Call it first; on other platforms it's effectively a
        // no-op since GUI apps can't be hidden the same way.
        #[cfg(target_os = "macos")]
        let _ = app.show();
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    let show_item = MenuItem::with_id(app, "tray:show", "Show Aethon", true, None::<&str>)?;
    let new_tab_item = MenuItem::with_id(app, "tray:new_tab", "New Tab", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray:quit", "Quit Aethon", true, None::<&str>)?;
    // Extension-supplied tray items (location: "tray") appear after the
    // built-ins. Each id is prefixed `ext:` so the click handler below
    // can route them through Tauri's `menu` event with the existing
    // dispatcher pattern.
    let mut extension_menu_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for item in extension_items.iter().filter(|i| i.location == "tray") {
        let id = format!("ext:{}", item.action);
        let mi = MenuItem::with_id(app, &id, &item.label, true, None::<&str>)?;
        extension_menu_items.push(mi);
    }
    // Build the menu's item slice. Mix built-ins with extension entries.
    let mut item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        vec![&show_item, &new_tab_item, &quit_item];
    for ext in &extension_menu_items {
        item_refs.push(ext);
    }
    let menu = Menu::with_items(app, &item_refs)?;

    let icon = app
        .default_window_icon()
        .ok_or("no default_window_icon — bundle.icon missing?")?
        .clone();

    // Idempotent: remove any prior tray with this id before building.
    // `install_tray` runs at boot AND every time the frontend pushes
    // `extension_menu_items` via `set_extension_menu_items` (so an
    // extension-registered tray entry actually appears in the menu).
    // Without this remove, `TrayIconBuilder.build()` registers a NEW
    // tray each call — and macOS happily shows BOTH icons in the menu
    // bar, which is the user-reported "two Æ icons" bug.
    let _ = app.remove_tray_by_id(TRAY_ID);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        // Show Aethon's full-color logo in the tray rather than a
        // monochrome template. The brand mark (cream Æ + orange π) is
        // recognizable at status-bar size; template rendering would
        // strip the orange and lose the identity.
        .icon_as_template(false)
        // macOS HIG: left-click activates, right-click shows the menu.
        // On Linux/Windows the menu opens on left-click by default,
        // which matches their conventions — leave as the platform default.
        .show_menu_on_left_click(!cfg!(target_os = "macos"))
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "tray:show" => focus_main(app),
                "tray:new_tab" => {
                    // Forward as a "menu" event so the React side's
                    // existing dispatcher fires the same handler the
                    // app menu's New Tab uses. Bring the window forward
                    // first so the user sees the new tab.
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", "new_tab");
                }
                "tray:quit" => app.exit(0),
                other if other.starts_with("ext:") => {
                    // Extension item — bring window forward so the
                    // handler's UI changes are visible, then forward
                    // through the same `menu` event the app menu uses.
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", other);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Single left-click = focus window. Anything else (right
            // click, dragging) is left to the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Keep the non-blocking file appender's WorkerGuard alive for the
/// process lifetime. Dropping the guard flushes pending writes; when
/// `init_tracing` returns, the local guard would be dropped and the
/// background thread would exit before any non-trivial logging
/// happens. Stash it here.
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> =
    OnceLock::new();

/// `~/.aethon/logs/` — same parent as state.json + projects.json so a
/// user troubleshooting an issue finds everything in one place. Created
/// at boot so the appender doesn't fail on a fresh install.
fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let dir = home.join(".aethon").join("logs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[init_tracing] mkdir {}: {e}", dir.display());
        return None;
    }
    Some(dir)
}

/// Prune log files older than `RETENTION_DAYS`. `tracing-appender`'s
/// daily rotation produces files named `aethon.YYYY-MM-DD`; matching by
/// that prefix lets us coexist with the bridge's own log files in the
/// same directory without touching them.
const RETENTION_DAYS: u64 = 7;
fn prune_old_logs(dir: &Path) {
    let cutoff = match std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(RETENTION_DAYS * 24 * 60 * 60))
    {
        Some(t) => t,
        None => return,
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        // Only prune our own log files — leave bridge logs and anything
        // else alone.
        if !name_str.starts_with("aethon.") {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok());
        if let Some(t) = modified
            && t < cutoff
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Initialize the `tracing` subscriber. Called from `run()` before any
/// log call so module-load output is captured. Honors `AETHON_LOG`
/// (preferred — keeps the namespace ours) and falls back to `RUST_LOG`.
/// Default level is `info` in dev and `warn` in release so noisy
/// `[agent-watch]` chatter doesn't show in shipped binaries.
///
/// Logs go to BOTH stderr (so the dev terminal sees them in real time)
/// AND a daily-rotating file at `~/.aethon/logs/aethon.YYYY-MM-DD` (so
/// release users have a paper trail for crashes / weird behavior).
/// Files older than `RETENTION_DAYS` are pruned at startup.
fn init_tracing() {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
    let default_level = if cfg!(debug_assertions) { "info" } else { "warn" };
    let filter = EnvFilter::try_from_env("AETHON_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new(default_level));

    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_writer(std::io::stderr);

    // File layer is best-effort: if the home dir isn't reachable or the
    // appender fails to start, we still get stderr logging.
    let file_layer = log_dir().and_then(|dir| {
        prune_old_logs(&dir);
        let file_appender = tracing_appender::rolling::daily(&dir, "aethon");
        let (writer, guard) = tracing_appender::non_blocking(file_appender);
        // Stash the guard so writes don't get lost on shutdown.
        LOG_GUARD.set(guard).ok()?;
        Some(
            fmt::layer()
                .with_target(true)
                .with_ansi(false) // No color codes in the file
                .with_writer(writer),
        )
    });

    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer);
    let _ = if let Some(file) = file_layer {
        subscriber.with(file).try_init()
    } else {
        subscriber.try_init()
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    let mut builder = tauri::Builder::default();
    builder = builder.plugin(tauri_plugin_process::init());
    builder = builder.plugin(tauri_plugin_opener::init());
    builder = builder.plugin(tauri_plugin_dialog::init());
    builder = builder.plugin(tauri_plugin_notification::init());
    // Gate the updater plugin on a configured pubkey. Without one,
    // signature verification can't decode anything and every update
    // would fail post-download — so we just don't register the plugin
    // and the frontend's Check-for-Updates menu reports it cleanly.
    // tauri.conf.json's plugins.updater.pubkey is the source of truth;
    // env override exists for CI / local sigs.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if updater_pubkey_configured() {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        } else {
            tracing::warn!(
                target: "aethon::updater",
                "skipping plugin registration — no pubkey set in tauri.conf.json. \
                See RELEASING.md to generate signing keys."
            );
        }
    }
    let builder = builder
        .manage(AgentProcess(Mutex::new(None)))
        .manage(AgentReloadFlag(Arc::new(AtomicBool::new(false))))
        .manage(shell::ShellRegistry::new())
        .invoke_handler(tauri::generate_handler![
            start_agent,
            send_message,
            agent_command,
            dispatch_a2ui_event,
            read_state,
            write_state,
            read_config,
            write_config,
            aethon_home_dir,
            search_sessions,
            updater_available,
            toggle_fullscreen,
            toggle_devtools,
            export_chat_markdown,
            save_paste_image,
            install_aethon_skill,
            set_extension_menu_items,
            pick_project_directory,
            git_status,
            watch_project_extensions,
            unwatch_project_extensions,
            shell::shell_open,
            shell::shell_input,
            shell::shell_resize,
            shell::shell_close,
            shell::shell_set_share_mode,
            shell::shell_read_scrollback,
            shell::shell_list_shareable,
            shell::shell_write,
            #[cfg(debug_assertions)]
            debug::debug_eval_js,
            #[cfg(debug_assertions)]
            debug::debug_eval_result,
        ]);

    builder
        .setup(|app| {
            if let Some(watcher) = start_agent_watcher(app.handle().clone()) {
                app.manage(watcher);
            }
            #[cfg(debug_assertions)]
            debug::start_debug_server(app.handle().clone());

            // Native menu — replaces Tauri's auto-generated default. Each
            // app-specific item emits a `menu` Tauri event whose payload
            // is the item id; the frontend's listener fans out to the
            // existing Cmd+T / Cmd+] / etc. handlers so the menu and
            // keyboard shortcuts always do the same thing. Predefined
            // macOS items (Quit / Hide / Cut / Copy / Minimize / etc.)
            // get native NS actions for free, no event handler needed.
            install_app_menu(app.handle(), &[])?;
            install_tray(app.handle(), &[])?;
            // Initialize the extension menu store empty; the bridge
            // ships items via `extension_menu_items` events that the
            // frontend forwards to `set_extension_menu_items`, which
            // re-runs both installers with the persisted list.
            app.manage(ExtensionMenuStore::default());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    //! Source-level regression tests for code paths whose behavior is
    //! easier to assert by structure than by spinning up a Tauri runtime.
    //! For full behavioral coverage of tray idempotency we'd need
    //! `tauri::test::mock_app` (not currently wired into the crate's
    //! test feature), so we lock the contract via shape: the source
    //! must contain the `remove_tray_by_id` call before the build.

    use super::TRAY_ID;

    /// The tray id is a single source of truth shared by the build
    /// and the cleanup. If someone changes one without the other, the
    /// idempotency call becomes a no-op and the double-icon bug
    /// returns silently. This test asserts the value hasn't drifted —
    /// any rename should land in both call sites.
    #[test]
    fn tray_id_is_main_tray() {
        assert_eq!(TRAY_ID, "main-tray");
    }

    /// Regression for the "two Æ tray icons" bug.
    ///
    /// `install_tray` is called at boot AND every time the frontend
    /// pushes `extension_menu_items` via `set_extension_menu_items`,
    /// because an extension that registers a `location: "tray"` item
    /// needs the tray rebuilt to appear. Without removing the prior
    /// tray with the same id, `TrayIconBuilder.build` registers a
    /// SECOND OS-level tray (NSStatusItem on macOS) — both icons
    /// stay visible in the menu bar.
    ///
    /// The fix is `app.remove_tray_by_id(TRAY_ID)` before the
    /// builder runs. We assert it's still there: deleting the line
    /// would silently re-introduce the regression and a unit test
    /// catches that at `cargo test --lib` time.
    #[test]
    fn install_tray_calls_remove_tray_by_id_for_idempotency() {
        let src = include_str!("lib.rs");
        let needle = "remove_tray_by_id(TRAY_ID)";
        assert!(
            src.contains(needle),
            "install_tray must remove the prior tray before rebuilding so calling it twice doesn't leave two OS-level tray icons. Looking for `{needle}` in lib.rs.",
        );
        // Also assert the call ORDER: the remove must precede the
        // build, not follow it.
        let remove_pos = src.find(needle).unwrap();
        let build_pos = src.find("TrayIconBuilder::with_id(TRAY_ID)").unwrap();
        assert!(
            remove_pos < build_pos,
            "remove_tray_by_id must run BEFORE TrayIconBuilder::with_id, otherwise the new tray gets removed instead of the old one.",
        );
    }

    /// `set_extension_menu_items` is the frontend → Rust path that
    /// rebuilds the menu + tray when an extension registers a menu
    /// item. If it stops calling `install_tray`, the extension item
    /// silently never shows up. If it stops being wired into
    /// `invoke_handler!`, the frontend invoke fails. Either failure
    /// mode is loud at runtime but easy to introduce in a refactor.
    #[test]
    fn set_extension_menu_items_calls_install_tray_and_is_wired_to_handler() {
        let src = include_str!("lib.rs");
        assert!(
            src.contains("fn set_extension_menu_items("),
            "the Tauri command must exist",
        );
        // The handler invocation list registers the command — without
        // this entry, the frontend's invoke('set_extension_menu_items')
        // returns "command not found".
        assert!(
            src.contains("set_extension_menu_items,"),
            "set_extension_menu_items must be registered in the invoke_handler list",
        );
        // And it must call install_tray so the rebuild path covers
        // tray entries (location: "tray"), not just the app menu.
        let body_start = src.find("fn set_extension_menu_items(").unwrap();
        let body_end = src[body_start..]
            .find("\nfn ")
            .map(|n| body_start + n)
            .unwrap_or(src.len());
        let body = &src[body_start..body_end];
        assert!(
            body.contains("install_tray("),
            "set_extension_menu_items must call install_tray so location: \"tray\" extension items appear",
        );
    }
}
