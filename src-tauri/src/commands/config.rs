//! `~/.aethon/` state-file IO + `config.toml` round-trip.
//!
//! `read_state` / `write_state` back the frontend's persisted slices
//! (tabs, projects, themes, …). `read_config` / `write_config` expose
//! `config.toml` as JSON to the Settings panel; the writer round-trips
//! through `toml_edit` so the on-disk file's comments, ordering, and
//! any user-introduced keys outside the Settings UI's surface survive a
//! Save click.

use std::io::Read;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::helpers::{
    self, FONT_SIZE_MAX, FONT_SIZE_MIN, clamp_font_size, parse_config_toml, validate_state_name,
};

/// Resolve `<home>/.aethon/<name>` after rejecting path-traversal segments.
/// The parent directory is created on demand. Uses Tauri's cross-platform
/// `home_dir()` so Windows (USERPROFILE), macOS, and Linux all resolve
/// without env-var assumptions.
pub(crate) fn aethon_state_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    validate_state_name(name)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(name))
}

/// Read a file from `~/.aethon/`. Returns an empty string when the file
/// doesn't exist so callers can do a "first run" check without distinguishing
/// missing from empty.
#[tauri::command]
pub fn read_state(name: String, app: AppHandle) -> Result<String, String> {
    let path = aethon_state_path(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Write a file to `~/.aethon/`. Creates the directory if missing.
#[tauri::command]
pub fn write_state(name: String, content: String, app: AppHandle) -> Result<(), String> {
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
pub fn read_config(app: AppHandle) -> Result<serde_json::Value, String> {
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
pub fn aethon_home_dir(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
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
pub fn write_config(config: serde_json::Value, app: AppHandle) -> Result<(), String> {
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
        header.parse::<toml_edit::DocumentMut>().unwrap_or_default()
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
                ui_table.insert("notify_min_duration_seconds", toml_edit::value(n as i64));
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
        shell_table.insert("default_share_mode", toml_edit::value(default_share_mode));
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
    std::fs::write(&tmp, serialised).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

/// Get-or-create a `[section]` Table inside a toml_edit document. Used
/// by `write_config` to keep round-trip preservation: an existing
/// table's items + comments survive, a new one starts blank.
fn ensure_table<'a>(doc: &'a mut toml_edit::DocumentMut, name: &str) -> &'a mut toml_edit::Table {
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
