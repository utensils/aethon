//! `~/.aethon/` state-file IO + `config.toml` round-trip.
//!
//! `read_state` / `write_state` back the frontend's persisted slices
//! (tabs, projects, themes, …). `read_config` / `write_config` expose
//! `config.toml` as JSON to the Settings panel; the writer round-trips
//! through `toml_edit` so the on-disk file's comments, ordering, and
//! any user-introduced keys outside the Settings UI's surface survive a
//! Save click.

use std::collections::BTreeMap;
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

#[derive(serde::Deserialize, Default)]
struct RawIssueTemplatesConfig {
    issue_templates: Option<BTreeMap<String, RawIssueTemplate>>,
}

#[derive(serde::Deserialize, Default)]
struct RawIssueTemplate {
    label: Option<String>,
    prompt: Option<String>,
    /// Workspace terminology; `new_worktree` is the pre-rename TOML
    /// spelling, still accepted so existing issues.toml files keep working.
    new_workspace: Option<bool>,
    new_worktree: Option<bool>,
    branch: Option<String>,
    branch_prefix: Option<String>,
    when_labels: Option<Vec<String>>,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplatesConfig {
    templates: Vec<IssueTemplate>,
    warning: Option<String>,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplate {
    id: String,
    label: String,
    prompt: String,
    new_workspace: Option<bool>,
    branch: Option<String>,
    branch_prefix: Option<String>,
    when_labels: Vec<String>,
}

/// Read `<project>/.aethon/issues.toml` and return normalized issue-to-agent
/// templates. Missing config is not an error; malformed config returns an
/// empty template list plus a warning so the dashboard can fall back to its
/// built-in prompt without blocking issue launches.
#[tauri::command]
pub fn read_issue_templates(project_path: String) -> Result<IssueTemplatesConfig, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }
    let path = root.join(".aethon").join("issues.toml");
    // Cap the read so a runaway templates file can't pull an unbounded amount
    // of data into memory on the command thread (mirrors `read_config`). This
    // file is user-editable and holds multi-line prompts, so we buffer then parse.
    const MAX_BYTES: u64 = 64 * 1024;
    let mut text = String::new();
    match std::fs::File::open(&path) {
        Ok(file) => {
            if let Err(e) = file.take(MAX_BYTES).read_to_string(&mut text) {
                return Ok(IssueTemplatesConfig {
                    templates: Vec::new(),
                    warning: Some(format!(
                        "Could not read {}; using built-in issue prompt. {e}",
                        path.display()
                    )),
                });
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IssueTemplatesConfig {
                templates: Vec::new(),
                warning: None,
            });
        }
        Err(e) => {
            return Ok(IssueTemplatesConfig {
                templates: Vec::new(),
                warning: Some(format!(
                    "Could not read {}; using built-in issue prompt. {e}",
                    path.display()
                )),
            });
        }
    }
    Ok(parse_issue_templates_toml(&text))
}

pub(crate) fn parse_issue_templates_toml(input: &str) -> IssueTemplatesConfig {
    let parsed = match toml::from_str::<RawIssueTemplatesConfig>(input) {
        Ok(parsed) => parsed,
        Err(e) => {
            return IssueTemplatesConfig {
                templates: Vec::new(),
                warning: Some(format!(
                    "Malformed .aethon/issues.toml; using built-in issue prompt. {e}"
                )),
            };
        }
    };
    let mut warnings = Vec::new();
    let templates = parsed
        .issue_templates
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(id, raw)| {
            let id = id.trim().to_string();
            if id.is_empty() {
                warnings.push("Skipped issue template with an empty id".to_string());
                return None;
            }
            let prompt = raw.prompt.unwrap_or_default();
            if prompt.trim().is_empty() {
                warnings.push(format!(
                    "Skipped issue template `{id}` because prompt is missing or empty"
                ));
                return None;
            }
            let label = raw
                .label
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| id.clone());
            Some(IssueTemplate {
                id,
                label,
                prompt,
                new_workspace: raw.new_workspace.or(raw.new_worktree),
                branch: raw.branch.filter(|s| !s.trim().is_empty()),
                branch_prefix: raw.branch_prefix.filter(|s| !s.trim().is_empty()),
                when_labels: raw
                    .when_labels
                    .unwrap_or_default()
                    .into_iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            })
        })
        .collect();
    IssueTemplatesConfig {
        templates,
        warning: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("; "))
        },
    }
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
    let voice = config.get("voice").and_then(|v| v.as_object());
    let updates = config.get("updates").and_then(|v| v.as_object());
    let devshell = config.get("devshell").and_then(|v| v.as_object());
    let guardrails = config.get("guardrails").and_then(|v| v.as_object());

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
    let thinking_visibility = ui
        .and_then(|m| m.get("thinkingVisibility"))
        .and_then(|v| v.as_str())
        .map(|s| helpers::normalize_visibility(Some(s)));
    let tool_calls_visibility = ui
        .and_then(|m| m.get("toolCallsVisibility"))
        .and_then(|v| v.as_str())
        .map(|s| helpers::normalize_tool_visibility(Some(s)));

    let model = agent
        .and_then(|m| m.get("model"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let provider_timeout_seconds = agent
        .and_then(|m| m.get("providerTimeoutSeconds"))
        .and_then(|v| v.as_u64())
        .and_then(|n| {
            helpers::normalize_optional_timeout_seconds(Some(n.min(u32::MAX as u64) as u32))
        });
    let codex_fast_mode = agent
        .and_then(|m| m.get("codexFastMode"))
        .and_then(|v| v.as_bool());
    let bash_timeout_floor_seconds = agent
        .and_then(|m| m.get("bashTimeoutFloorSeconds"))
        .and_then(|v| v.as_u64())
        .map(|n| helpers::normalize_timeout_seconds(Some(n.min(u32::MAX as u64) as u32)));
    let subagent_timeout_seconds = agent
        .and_then(|m| m.get("subagentTimeoutSeconds"))
        .and_then(|v| v.as_u64())
        .map(|n| helpers::normalize_timeout_seconds(Some(n.min(u32::MAX as u64) as u32)));

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
    let voice_toggle_hotkey = voice
        .and_then(|m| m.get("toggleHotkey"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let voice_hold_hotkey = voice
        .and_then(|m| m.get("holdHotkey"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let voice_speak_agent_replies = voice
        .and_then(|m| m.get("speakAgentReplies"))
        .and_then(|v| v.as_bool());
    let voice_speak_max_chars = voice
        .and_then(|m| m.get("speakMaxChars"))
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(50, 5000) as u32);
    let update_channel = updates
        .and_then(|m| m.get("channel"))
        .and_then(|v| v.as_str())
        .map(|s| helpers::normalize_update_channel(Some(s)));
    let disable_auto_check = updates
        .and_then(|m| m.get("disableAutoCheck"))
        .and_then(|v| v.as_bool());
    let devshell_enabled = devshell
        .and_then(|m| m.get("enabled"))
        .and_then(|v| v.as_str())
        .map(|s| helpers::normalize_devshell_enabled(Some(s)));
    let devshell_mode = devshell
        .and_then(|m| m.get("mode"))
        .and_then(|v| v.as_str())
        .map(|s| helpers::normalize_devshell_mode(Some(s)));
    let devshell_cache_ttl_hours = devshell
        .and_then(|m| m.get("cacheTtlHours"))
        .and_then(|v| v.as_u64())
        .map(|n| n.min(u32::MAX as u64));
    let devshell_refresh_on_lockfile = devshell
        .and_then(|m| m.get("refreshOnLockfileChange"))
        .and_then(|v| v.as_bool());
    let soft_prompt_anchor = guardrails
        .and_then(|m| m.get("softPromptAnchor"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let hard_enforce_project_root = guardrails
        .and_then(|m| m.get("hardEnforceProjectRoot"))
        .and_then(|v| v.as_bool());

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
        match thinking_visibility {
            Some(v) => {
                ui_table.insert("thinking_visibility", toml_edit::value(v));
            }
            None => {
                ui_table.remove("thinking_visibility");
            }
        }
        match tool_calls_visibility {
            Some(v) => {
                ui_table.insert("tool_calls_visibility", toml_edit::value(v));
            }
            None => {
                ui_table.remove("tool_calls_visibility");
            }
        }
    }

    // ── [agent] ──
    {
        let agent_table = ensure_table(&mut doc, "agent");
        set_or_clear_str(agent_table, "model", model);
        set_or_clear_int(
            agent_table,
            "provider_timeout_seconds",
            provider_timeout_seconds,
        );
        set_or_clear_bool(agent_table, "codex_fast_mode", codex_fast_mode);
        set_or_clear_int(
            agent_table,
            "bash_timeout_floor_seconds",
            bash_timeout_floor_seconds,
        );
        set_or_clear_int(
            agent_table,
            "subagent_timeout_seconds",
            subagent_timeout_seconds,
        );
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

    // ── [voice] ──
    {
        let voice_table = ensure_table(&mut doc, "voice");
        set_or_clear_str(voice_table, "toggle_hotkey", voice_toggle_hotkey);
        set_or_clear_str(voice_table, "hold_hotkey", voice_hold_hotkey);
        set_or_clear_bool(
            voice_table,
            "speak_agent_replies",
            voice_speak_agent_replies,
        );
        set_or_clear_int(voice_table, "speak_max_chars", voice_speak_max_chars);
    }

    // ── [updates] ──
    {
        let updates_table = ensure_table(&mut doc, "updates");
        match update_channel {
            Some(channel) => {
                updates_table.insert("channel", toml_edit::value(channel));
            }
            None => {
                updates_table.remove("channel");
            }
        }
        set_or_clear_bool(updates_table, "disable_auto_check", disable_auto_check);
    }

    // ── [devshell] ──
    {
        let devshell_table = ensure_table(&mut doc, "devshell");
        match devshell_enabled {
            Some(v) => {
                devshell_table.insert("enabled", toml_edit::value(v));
            }
            None => {
                devshell_table.remove("enabled");
            }
        }
        match devshell_mode {
            Some(v) => {
                devshell_table.insert("mode", toml_edit::value(v));
            }
            None => {
                devshell_table.remove("mode");
            }
        }
        match devshell_cache_ttl_hours {
            Some(n) => {
                devshell_table.insert("cache_ttl_hours", toml_edit::value(n as i64));
            }
            None => {
                devshell_table.remove("cache_ttl_hours");
            }
        }
        set_or_clear_bool(
            devshell_table,
            "refresh_on_lockfile_change",
            devshell_refresh_on_lockfile,
        );
    }

    // ── [guardrails] ──
    {
        let guardrails_table = ensure_table(&mut doc, "guardrails");
        set_or_clear_str(guardrails_table, "soft_prompt_anchor", soft_prompt_anchor);
        set_or_clear_bool(
            guardrails_table,
            "hard_enforce_project_root",
            hard_enforce_project_root,
        );
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

/// Integer variant of `set_or_clear_str`.
fn set_or_clear_int(table: &mut toml_edit::Table, key: &str, value: Option<u32>) {
    match value {
        Some(v) => {
            table.insert(key, toml_edit::value(v as i64));
        }
        None => {
            table.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_issue_templates_toml_extracts_templates() {
        let parsed = parse_issue_templates_toml(
            r#"
[issue_templates.default]
label = "Default implementation task"
new_worktree = true
branch = "{branchPrefix}/issue-{number}-{slug}"
prompt = """
Work on #{number}: {title}
Labels: {labels}
"""

[issue_templates.docs]
label = "Docs issue"
when_labels = ["documentation"]
prompt = "Document {title}"
"#,
        );

        assert!(parsed.warning.is_none());
        assert_eq!(parsed.templates.len(), 2);
        assert_eq!(parsed.templates[0].id, "default");
        // Legacy `new_worktree` TOML key still maps onto the renamed field.
        assert_eq!(parsed.templates[0].new_workspace, Some(true));
        assert_eq!(
            parsed.templates[0].branch.as_deref(),
            Some("{branchPrefix}/issue-{number}-{slug}")
        );
        assert_eq!(parsed.templates[1].when_labels, vec!["documentation"]);
    }

    #[test]
    fn parse_issue_templates_toml_accepts_new_workspace_key() {
        let parsed = parse_issue_templates_toml(
            r#"
[issue_templates.modern]
label = "Modern"
new_workspace = true
prompt = "Do {title}"
"#,
        );
        assert_eq!(parsed.templates[0].new_workspace, Some(true));
    }

    #[test]
    fn parse_issue_templates_toml_skips_templates_without_prompt() {
        let parsed = parse_issue_templates_toml(
            r#"
[issue_templates.bad]
label = "Bad"

[issue_templates.good]
prompt = "Work on {title}"
"#,
        );

        assert_eq!(parsed.templates.len(), 1);
        assert_eq!(parsed.templates[0].id, "good");
        assert!(parsed.warning.unwrap().contains("bad"));
    }

    #[test]
    fn parse_issue_templates_toml_malformed_falls_back() {
        let parsed = parse_issue_templates_toml("=== broken ===");

        assert!(parsed.templates.is_empty());
        assert!(
            parsed
                .warning
                .unwrap()
                .contains("Malformed .aethon/issues.toml")
        );
    }
}
