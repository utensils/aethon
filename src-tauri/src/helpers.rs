//! Pure helpers extracted from `lib.rs` so they're testable without a Tauri
//! `AppHandle` or filesystem. Each function here does one well-defined
//! thing and returns a deterministic result for a given input.
//!
//! Cargo's unit tests live at the bottom of this file (`#[cfg(test)]`).

use serde::Deserialize;

/// Validates a leaf filename used inside `~/.aethon/`. Rejects anything
/// that could escape the directory — empty, slashes, parent-directory
/// references. Used by `read_state` / `write_state` to keep arbitrary
/// callers from writing outside the user dir.
pub fn validate_state_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("invalid state name: (empty)".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!("invalid state name: {name}"));
    }
    if name == ".." || name == "." {
        return Err(format!("invalid state name: {name}"));
    }
    if name.starts_with('\0') || name.contains('\0') {
        return Err(format!("invalid state name: {name}"));
    }
    Ok(())
}

/// Schema for `~/.aethon/config.toml`. Mirrors the `AethonConfig` family
/// in `lib.rs` so the parsing tests can reuse the same shape without
/// pulling in Tauri.
#[derive(Default, Deserialize)]
pub struct UiConfig {
    pub theme: Option<String>,
    pub font_size: Option<u32>,
    pub restore_tabs: Option<bool>,
    /// Fire a native OS notification when an agent turn ends while the
    /// originating tab is unfocused (or the window is unfocused). Default
    /// `true`. Disable for users who run agents in the background and
    /// don't want toasts piling up. Configurable via
    /// `[ui] notify_on_completion`.
    pub notify_on_completion: Option<bool>,
    /// Minimum turn duration (seconds) for the completion notification to
    /// fire. Sub-second turns rarely need a notification. Default 8.
    pub notify_min_duration_seconds: Option<u32>,
}

#[derive(Default, Deserialize)]
pub struct AgentConfig {
    pub model: Option<String>,
}

#[derive(Default, Deserialize)]
pub struct ShellConfig {
    /// Initial share mode for new shell tabs. Allowed values mirror the
    /// `ShareMode` enum in `shell.rs`: "private" (default), "read",
    /// "read-write", "read-write-trusted". Anything else falls back to
    /// "private" so a typo can't accidentally widen exposure.
    pub default_share_mode: Option<String>,
    /// When the bun bridge child crashes unexpectedly, automatically
    /// respawn it. Default `true`. Set `false` to surface the crash
    /// notice without auto-restart (useful when debugging the bridge).
    pub auto_restart_agent: Option<bool>,
    /// Override the program spawned for new shell tabs. Empty string
    /// or omission falls back to `$SHELL` (and the platform default).
    /// e.g. `default_command = "/usr/local/bin/fish"`.
    pub default_command: Option<String>,
    /// Extra argv for the spawned shell. Appended after the platform
    /// default (e.g. `-il` on Unix). Use to pass profile flags or a
    /// `-c <command>` you want every new tab to run.
    pub default_args: Option<Vec<String>>,
    /// Whether new shell tabs inherit the Aethon process's environment
    /// (`PATH`, locale, etc.). Default `true` — shells inherit the
    /// login PATH the bridge already augments. Set `false` for hermetic
    /// shells (the PTY still gets `TERM=xterm-256color` etc.).
    pub inherit_env: Option<bool>,
    /// When closing a shell tab whose foreground job is *not* the shell
    /// itself (e.g. `vim`, `npm test`, `ssh`), prompt before killing.
    /// Default `true`. Cmd+W honours this; the X close button always
    /// honours it. Frontend-side check.
    pub prompt_before_close: Option<bool>,
}

#[derive(Default, Deserialize)]
pub struct ShortcutsConfig {
    /// What `Cmd+T` opens when focus is *outside* the bottom terminal
    /// panel. Allowed values: `"agent"` (default — the focus-aware
    /// behaviour shipped in M6 P1) or `"shell"` (Cmd+T always opens a
    /// new shell sub-tab). Anything else falls back to `"agent"`.
    pub new_tab_kind: Option<String>,
}

#[derive(Default, Deserialize)]
pub struct AethonConfig {
    #[serde(default)]
    pub ui: UiConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub shell: ShellConfig,
    #[serde(default)]
    pub shortcuts: ShortcutsConfig,
}

/// Validate-and-normalize the configured default share mode. Unknown
/// strings, missing values, and parse failures all fall through to
/// `"private"` — the safest possible default. Lives next to the parser
/// so test coverage sits with the other config helpers.
pub fn normalize_default_share_mode(input: Option<&str>) -> &'static str {
    match input {
        Some("read") => "read",
        Some("read-write") => "read-write",
        Some("read-write-trusted") => "read-write-trusted",
        // Includes Some("private"), Some(<unknown>), and None.
        _ => "private",
    }
}

/// Validate-and-normalize the `[shortcuts] new_tab_kind` key. Unknown or
/// missing values fall through to `"agent"` (the focus-aware default).
pub fn normalize_new_tab_kind(input: Option<&str>) -> &'static str {
    match input {
        Some("shell") => "shell",
        // Includes Some("agent"), Some(<unknown>), and None.
        _ => "agent",
    }
}

/// Parse a TOML config string into the canonical JSON shape the frontend
/// consumes. Falls back to defaults on parse error so a malformed user
/// file never blocks app boot. Returns the same shape regardless of what
/// keys are present in the input.
pub fn parse_config_toml(input: &str) -> serde_json::Value {
    let cfg: AethonConfig = if input.is_empty() {
        AethonConfig::default()
    } else {
        toml::from_str(input).unwrap_or_default()
    };
    let default_share_mode = normalize_default_share_mode(cfg.shell.default_share_mode.as_deref());
    let notify_on_completion = cfg.ui.notify_on_completion.unwrap_or(true);
    let notify_min_duration_seconds = cfg
        .ui
        .notify_min_duration_seconds
        .map(|n| n.min(3600))
        .unwrap_or(8);
    let new_tab_kind = normalize_new_tab_kind(cfg.shortcuts.new_tab_kind.as_deref());
    let default_command = cfg
        .shell
        .default_command
        .as_deref()
        .filter(|s| !s.is_empty());
    let default_args: Vec<String> = cfg.shell.default_args.unwrap_or_default();
    serde_json::json!({
        "ui": {
            "theme": cfg.ui.theme,
            "fontSize": cfg.ui.font_size,
            "restoreTabs": cfg.ui.restore_tabs,
            "notifyOnCompletion": notify_on_completion,
            "notifyMinDurationSeconds": notify_min_duration_seconds,
        },
        "agent": {
            "model": cfg.agent.model,
        },
        "shell": {
            "defaultShareMode": default_share_mode,
            "autoRestartAgent": cfg.shell.auto_restart_agent.unwrap_or(true),
            "defaultCommand": default_command,
            "defaultArgs": default_args,
            "inheritEnv": cfg.shell.inherit_env.unwrap_or(true),
            "promptBeforeClose": cfg.shell.prompt_before_close.unwrap_or(true),
        },
        "shortcuts": {
            "newTabKind": new_tab_kind,
        },
    })
}

/// Clamp a configured font size to the range the CSS rule supports.
/// Sizes outside [10, 24] would either be unreadable or break the
/// fixed-row composer layout. Mirrors the frontend clamp so the
/// behavior is consistent regardless of which side enforces it.
pub const FONT_SIZE_MIN: u32 = 10;
pub const FONT_SIZE_MAX: u32 = 24;
pub fn clamp_font_size(size: u32) -> u32 {
    size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_state_name ────────────────────────────────────────────────
    #[test]
    fn validate_state_name_accepts_simple_leaves() {
        assert!(validate_state_name("messages.json").is_ok());
        assert!(validate_state_name("theme").is_ok());
        assert!(validate_state_name("config.toml").is_ok());
        assert!(validate_state_name("state.json").is_ok());
    }

    #[test]
    fn validate_state_name_rejects_empty() {
        assert!(validate_state_name("").is_err());
    }

    #[test]
    fn validate_state_name_rejects_path_separators() {
        assert!(validate_state_name("a/b").is_err());
        assert!(validate_state_name("a\\b").is_err());
        assert!(validate_state_name("/absolute").is_err());
    }

    #[test]
    fn validate_state_name_rejects_dot_traversal() {
        assert!(validate_state_name("..").is_err());
        assert!(validate_state_name(".").is_err());
    }

    #[test]
    fn validate_state_name_rejects_null_bytes() {
        assert!(validate_state_name("foo\0bar").is_err());
    }

    // ── parse_config_toml ──────────────────────────────────────────────────
    #[test]
    fn parse_config_toml_returns_defaults_on_empty_input() {
        let v = parse_config_toml("");
        assert_eq!(v["ui"]["theme"], serde_json::Value::Null);
        assert_eq!(v["ui"]["fontSize"], serde_json::Value::Null);
        assert_eq!(v["ui"]["restoreTabs"], serde_json::Value::Null);
        assert_eq!(v["agent"]["model"], serde_json::Value::Null);
    }

    #[test]
    fn parse_config_toml_returns_defaults_on_malformed_input() {
        // Garbage TOML should never panic — falls back silently.
        let v = parse_config_toml("not = valid = toml ===");
        assert_eq!(v["ui"]["theme"], serde_json::Value::Null);
    }

    #[test]
    fn parse_config_toml_extracts_ui_section() {
        let v = parse_config_toml("[ui]\ntheme = \"dark\"\nfont_size = 16\nrestore_tabs = true\n");
        assert_eq!(v["ui"]["theme"], "dark");
        assert_eq!(v["ui"]["fontSize"], 16);
        assert_eq!(v["ui"]["restoreTabs"], true);
    }

    #[test]
    fn parse_config_toml_extracts_agent_section() {
        let v = parse_config_toml("[agent]\nmodel = \"anthropic/claude-sonnet-4-6\"\n");
        assert_eq!(v["agent"]["model"], "anthropic/claude-sonnet-4-6");
        assert_eq!(v["ui"]["theme"], serde_json::Value::Null);
    }

    #[test]
    fn parse_config_toml_handles_partial_section() {
        // Only theme set — font_size + model stay null.
        let v = parse_config_toml("[ui]\ntheme = \"light\"\n");
        assert_eq!(v["ui"]["theme"], "light");
        assert_eq!(v["ui"]["fontSize"], serde_json::Value::Null);
        assert_eq!(v["agent"]["model"], serde_json::Value::Null);
    }

    // ── normalize_default_share_mode ──────────────────────────────────────
    #[test]
    fn normalize_default_share_mode_accepts_known_values() {
        assert_eq!(normalize_default_share_mode(Some("private")), "private");
        assert_eq!(normalize_default_share_mode(Some("read")), "read");
        assert_eq!(
            normalize_default_share_mode(Some("read-write")),
            "read-write"
        );
        assert_eq!(
            normalize_default_share_mode(Some("read-write-trusted")),
            "read-write-trusted"
        );
    }

    #[test]
    fn normalize_default_share_mode_falls_back_to_private_on_unknown() {
        assert_eq!(normalize_default_share_mode(None), "private");
        assert_eq!(normalize_default_share_mode(Some("")), "private");
        assert_eq!(normalize_default_share_mode(Some("yolo")), "private");
        assert_eq!(normalize_default_share_mode(Some("read-only")), "private");
        // Case-sensitive — uppercase variants should not silently match.
        assert_eq!(normalize_default_share_mode(Some("Read")), "private");
    }

    #[test]
    fn parse_config_toml_extracts_shell_section() {
        let v = parse_config_toml("[shell]\ndefault_share_mode = \"read\"\n");
        assert_eq!(v["shell"]["defaultShareMode"], "read");
    }

    #[test]
    fn parse_config_toml_shell_default_is_private() {
        let v = parse_config_toml("");
        assert_eq!(v["shell"]["defaultShareMode"], "private");
        // And bogus values get clamped on the Rust side, not silently
        // forwarded as the user wrote them — so a typo can't widen access.
        let v = parse_config_toml("[shell]\ndefault_share_mode = \"yolo\"\n");
        assert_eq!(v["shell"]["defaultShareMode"], "private");
    }

    // ── normalize_new_tab_kind ────────────────────────────────────────────
    #[test]
    fn normalize_new_tab_kind_accepts_known_values() {
        assert_eq!(normalize_new_tab_kind(Some("agent")), "agent");
        assert_eq!(normalize_new_tab_kind(Some("shell")), "shell");
    }

    #[test]
    fn normalize_new_tab_kind_falls_back_to_agent() {
        assert_eq!(normalize_new_tab_kind(None), "agent");
        assert_eq!(normalize_new_tab_kind(Some("")), "agent");
        assert_eq!(normalize_new_tab_kind(Some("Agent")), "agent");
        assert_eq!(normalize_new_tab_kind(Some("shells")), "agent");
    }

    // ── parse_config_toml: shortcuts + extended shell keys ────────────────
    #[test]
    fn parse_config_toml_shortcuts_default_is_agent() {
        let v = parse_config_toml("");
        assert_eq!(v["shortcuts"]["newTabKind"], "agent");
    }

    #[test]
    fn parse_config_toml_extracts_shortcuts_section() {
        let v = parse_config_toml("[shortcuts]\nnew_tab_kind = \"shell\"\n");
        assert_eq!(v["shortcuts"]["newTabKind"], "shell");
        let v = parse_config_toml("[shortcuts]\nnew_tab_kind = \"yolo\"\n");
        assert_eq!(v["shortcuts"]["newTabKind"], "agent");
    }

    #[test]
    fn parse_config_toml_extracts_extended_shell_keys() {
        let v = parse_config_toml(
            r#"[shell]
default_command = "/bin/fish"
default_args = ["-l"]
inherit_env = false
prompt_before_close = false
"#,
        );
        assert_eq!(v["shell"]["defaultCommand"], "/bin/fish");
        assert_eq!(v["shell"]["defaultArgs"], serde_json::json!(["-l"]));
        assert_eq!(v["shell"]["inheritEnv"], false);
        assert_eq!(v["shell"]["promptBeforeClose"], false);
    }

    #[test]
    fn parse_config_toml_extended_shell_keys_default() {
        let v = parse_config_toml("");
        assert_eq!(v["shell"]["defaultCommand"], serde_json::Value::Null);
        assert_eq!(v["shell"]["defaultArgs"], serde_json::json!([]));
        assert_eq!(v["shell"]["inheritEnv"], true);
        assert_eq!(v["shell"]["promptBeforeClose"], true);
    }

    #[test]
    fn parse_config_toml_empty_default_command_is_null() {
        // Power users sometimes write `default_command = ""` to mean
        // "fall back to default". Treat empty string the same as omitted.
        let v = parse_config_toml("[shell]\ndefault_command = \"\"\n");
        assert_eq!(v["shell"]["defaultCommand"], serde_json::Value::Null);
    }

    #[test]
    fn parse_config_toml_always_returns_consistent_shape() {
        // No matter what's in the input, the output keys are identical.
        for input in ["", "[ui]\ntheme=\"dark\"\n", "garbage", "[unknown]\nx=1\n"] {
            let v = parse_config_toml(input);
            assert!(v["ui"].is_object());
            assert!(v["agent"].is_object());
            assert!(v["ui"].as_object().unwrap().contains_key("theme"));
            assert!(v["ui"].as_object().unwrap().contains_key("fontSize"));
            assert!(v["ui"].as_object().unwrap().contains_key("restoreTabs"));
            assert!(v["agent"].as_object().unwrap().contains_key("model"));
        }
    }

    // ── clamp_font_size ────────────────────────────────────────────────────
    #[test]
    fn clamp_font_size_passes_in_range() {
        assert_eq!(clamp_font_size(14), 14);
        assert_eq!(clamp_font_size(FONT_SIZE_MIN), FONT_SIZE_MIN);
        assert_eq!(clamp_font_size(FONT_SIZE_MAX), FONT_SIZE_MAX);
    }

    #[test]
    fn clamp_font_size_clamps_low() {
        assert_eq!(clamp_font_size(0), FONT_SIZE_MIN);
        assert_eq!(clamp_font_size(5), FONT_SIZE_MIN);
        assert_eq!(clamp_font_size(FONT_SIZE_MIN - 1), FONT_SIZE_MIN);
    }

    #[test]
    fn clamp_font_size_clamps_high() {
        assert_eq!(clamp_font_size(99), FONT_SIZE_MAX);
        assert_eq!(clamp_font_size(FONT_SIZE_MAX + 1), FONT_SIZE_MAX);
    }
}
