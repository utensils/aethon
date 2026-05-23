//! Pure helpers extracted from `lib.rs` so they're testable without a Tauri
//! `AppHandle` or filesystem. Each function here does one well-defined
//! thing and returns a deterministic result for a given input.
//!
//! Cargo's unit tests live at the bottom of this file (`#[cfg(test)]`).

use serde::Deserialize;
use std::path::PathBuf;

/// Resolve the Aethon user directory. Honors the `AETHON_USER_DIR`
/// environment variable when set (used by `scripts/dev.sh --new` to
/// route a session into a per-PID tmp sandbox so first-run UX can be
/// exercised without nuking the real user data). Falls back to
/// `<home>/.aethon` otherwise. Caller is responsible for `home_dir`
/// when no override is set — pass `None` to skip the fallback and get
/// a `None` back when neither the env var nor a usable home is set.
pub fn aethon_dir(home: Option<PathBuf>) -> Option<PathBuf> {
    if let Ok(s) = std::env::var("AETHON_USER_DIR")
        && !s.is_empty()
    {
        return Some(PathBuf::from(s));
    }
    home.map(|h| h.join(".aethon"))
}

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
pub struct ExtensionsConfig {
    /// Soft warning threshold (KB) for an extension's `setState` payload.
    /// Above this, the bridge logs a WARN naming the extension and path.
    /// Default 64. Range clamped to [1, EXT_STATE_MAX_KB].
    pub state_warn_kb: Option<u32>,
    /// Hard rejection threshold (KB) for an extension's `setState`
    /// payload. Above this the write is rejected before it hits stdout
    /// and the extension's mutation Promise resolves to
    /// `{ ok:false, error }`. Default 512. Range clamped to
    /// [1, EXT_STATE_MAX_KB]. The cap exists because a single very
    /// large stdout write can block the bridge's Node event loop.
    pub state_hard_kb: Option<u32>,
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
    #[serde(default)]
    pub extensions: ExtensionsConfig,
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

/// Hard ceiling on the configurable state-payload limits (KB). The bridge
/// writes setState payloads to stdout; a single very large write can block
/// the Node event loop. 8 MiB is well above any sensible UI state but
/// still keeps the bridge responsive on a slow consumer.
pub const EXT_STATE_MAX_KB: u32 = 8 * 1024;
pub const EXT_STATE_WARN_KB_DEFAULT: u32 = 64;
pub const EXT_STATE_HARD_KB_DEFAULT: u32 = 512;

/// Resolve the (warn, hard) state-size limits in KB. Applies defaults for
/// missing values, clamps each to [1, EXT_STATE_MAX_KB], then guarantees
/// `warn <= hard` by raising hard if a user picks a hard < warn (otherwise
/// the WARN tier could never fire). Returns the canonical pair the bridge
/// should use.
pub fn resolve_ext_state_limits(warn: Option<u32>, hard: Option<u32>) -> (u32, u32) {
    let clamp = |n: u32| n.clamp(1, EXT_STATE_MAX_KB);
    let warn_kb = clamp(warn.unwrap_or(EXT_STATE_WARN_KB_DEFAULT));
    let hard_kb_raw = clamp(hard.unwrap_or(EXT_STATE_HARD_KB_DEFAULT));
    let hard_kb = hard_kb_raw.max(warn_kb);
    (warn_kb, hard_kb)
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
    let (state_warn_kb, state_hard_kb) =
        resolve_ext_state_limits(cfg.extensions.state_warn_kb, cfg.extensions.state_hard_kb);
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
        "extensions": {
            "stateWarnKb": state_warn_kb,
            "stateHardKb": state_hard_kb,
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

/// Lexically resolve `..` and `.` segments in `path` and check whether
/// the result is `root` or a descendant. Inputs must be absolute. Returns
/// `Some(resolved)` when the path stays inside `root`, `None` otherwise.
///
/// This is the gatekeeper for the file-system Tauri commands in
/// [`crate::commands::fs`]. Each editor / file-tree operation passes the
/// active project's cwd as `root` and the target path as `path`; the
/// command refuses to touch anything that lexically escapes the root.
///
/// Implementation notes:
///
/// - Pure path arithmetic. We do **not** call `canonicalize` here — for
///   create operations the target path doesn't exist yet, and the helper
///   has to give a stable answer either way. Symlink-aware canonicalization
///   happens once per command, after this check passes, on whichever
///   parent component already exists. That second pass catches symlink
///   escapes that lexical resolution can't see.
/// - Strips `RootDir`/`Prefix` components on Windows so the comparison is
///   structural; the inputs are still required to be absolute.
/// - Both arguments must be normalized to the same prefix style by the
///   caller (the commands convert `tilde` and relative segments before
///   calling).
pub fn resolve_inside_root(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    use std::path::{Component, PathBuf};
    if !root.is_absolute() || !path.is_absolute() {
        return None;
    }
    // Walk `path` lexically; build up the resolved absolute path.
    let mut resolved: Vec<Component<'_>> = Vec::with_capacity(8);
    for component in path.components() {
        match component {
            Component::ParentDir => {
                // Pop the most recent Normal component. If the only thing
                // left is the prefix/root, this attempts to ascend past
                // the filesystem root — refuse.
                if let Some(last) = resolved.last()
                    && matches!(last, Component::Normal(_))
                {
                    resolved.pop();
                    continue;
                }
                return None;
            }
            Component::CurDir => continue,
            other => resolved.push(other),
        }
    }
    let resolved_path: PathBuf = resolved.iter().collect();
    // Same-prefix structural compare. `starts_with` matches Path
    // component-by-component, so `/a/bc` does not start with `/a/b`.
    if resolved_path == root || resolved_path.starts_with(root) {
        Some(resolved_path)
    } else {
        None
    }
}

/// POSIX-friendly filename sanitiser: keeps `[A-Za-z0-9_-]+`, replaces
/// runs of unsafe chars with `_`, trims leading/trailing dots/dashes/
/// underscores, and clamps to 64 chars. Empty input → empty output (the
/// caller substitutes a default stem).
pub fn sanitize_filename_segment(input: &str) -> String {
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
            assert!(v["extensions"].is_object());
            assert!(v["ui"].as_object().unwrap().contains_key("theme"));
            assert!(v["ui"].as_object().unwrap().contains_key("fontSize"));
            assert!(v["ui"].as_object().unwrap().contains_key("restoreTabs"));
            assert!(v["agent"].as_object().unwrap().contains_key("model"));
            assert!(
                v["extensions"]
                    .as_object()
                    .unwrap()
                    .contains_key("stateWarnKb")
            );
            assert!(
                v["extensions"]
                    .as_object()
                    .unwrap()
                    .contains_key("stateHardKb")
            );
        }
    }

    // ── resolve_ext_state_limits ───────────────────────────────────────────

    #[test]
    fn resolve_ext_state_limits_uses_defaults_when_absent() {
        let (warn, hard) = resolve_ext_state_limits(None, None);
        assert_eq!(warn, EXT_STATE_WARN_KB_DEFAULT);
        assert_eq!(hard, EXT_STATE_HARD_KB_DEFAULT);
    }

    #[test]
    fn resolve_ext_state_limits_clamps_min_and_max() {
        // 0 is not a meaningful threshold — clamp up to 1.
        let (warn, hard) = resolve_ext_state_limits(Some(0), Some(0));
        assert_eq!(warn, 1);
        assert_eq!(hard, 1);
        // Above the ceiling clamps down. EXT_STATE_MAX_KB caps a runaway
        // user value so a single stdout write can't OOM the bridge.
        let (warn, hard) = resolve_ext_state_limits(Some(u32::MAX), Some(u32::MAX));
        assert_eq!(warn, EXT_STATE_MAX_KB);
        assert_eq!(hard, EXT_STATE_MAX_KB);
    }

    #[test]
    fn resolve_ext_state_limits_raises_hard_to_warn_floor() {
        // Inverted user input: hard < warn would mean WARN never fires
        // (every WARN-tier write exceeds the HARD-tier reject first).
        // Resolve by raising hard up to warn, keeping warn untouched.
        let (warn, hard) = resolve_ext_state_limits(Some(200), Some(100));
        assert_eq!(warn, 200);
        assert_eq!(hard, 200);
    }

    #[test]
    fn resolve_ext_state_limits_passthrough_valid_pair() {
        let (warn, hard) = resolve_ext_state_limits(Some(32), Some(256));
        assert_eq!(warn, 32);
        assert_eq!(hard, 256);
    }

    #[test]
    fn parse_config_toml_extracts_extensions_section() {
        let v = parse_config_toml(
            r#"[extensions]
state_warn_kb = 128
state_hard_kb = 1024
"#,
        );
        assert_eq!(v["extensions"]["stateWarnKb"], 128);
        assert_eq!(v["extensions"]["stateHardKb"], 1024);
    }

    #[test]
    fn parse_config_toml_extensions_defaults_when_omitted() {
        let v = parse_config_toml("");
        assert_eq!(v["extensions"]["stateWarnKb"], EXT_STATE_WARN_KB_DEFAULT);
        assert_eq!(v["extensions"]["stateHardKb"], EXT_STATE_HARD_KB_DEFAULT);
    }

    #[test]
    fn parse_config_toml_extensions_partial_section_uses_defaults() {
        // Only one key present — the other should fall back to its default.
        let v = parse_config_toml("[extensions]\nstate_hard_kb = 2048\n");
        assert_eq!(v["extensions"]["stateWarnKb"], EXT_STATE_WARN_KB_DEFAULT);
        assert_eq!(v["extensions"]["stateHardKb"], 2048);
    }

    #[test]
    fn parse_config_toml_extensions_inverted_pair_normalized() {
        // hard < warn is normalized so WARN remains reachable.
        let v = parse_config_toml(
            r#"[extensions]
state_warn_kb = 500
state_hard_kb = 100
"#,
        );
        assert_eq!(v["extensions"]["stateWarnKb"], 500);
        assert_eq!(v["extensions"]["stateHardKb"], 500);
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

    // ── resolve_inside_root ────────────────────────────────────────────────
    use std::path::{Path, PathBuf};

    #[test]
    fn resolve_inside_root_accepts_direct_descendant() {
        let root = Path::new("/projects/aethon");
        let target = Path::new("/projects/aethon/src/App.tsx");
        let out = resolve_inside_root(root, target).expect("should resolve");
        assert_eq!(out, PathBuf::from("/projects/aethon/src/App.tsx"));
    }

    #[test]
    fn resolve_inside_root_accepts_root_itself() {
        let root = Path::new("/projects/aethon");
        let out = resolve_inside_root(root, root).expect("root is inside root");
        assert_eq!(out, PathBuf::from("/projects/aethon"));
    }

    #[test]
    fn resolve_inside_root_resolves_inner_parent_segments() {
        // /projects/aethon/src/.. → /projects/aethon, still inside.
        let root = Path::new("/projects/aethon");
        let target = Path::new("/projects/aethon/src/..");
        let out = resolve_inside_root(root, target).expect("inner .. stays inside");
        assert_eq!(out, PathBuf::from("/projects/aethon"));
    }

    #[test]
    fn resolve_inside_root_rejects_traversal_escape() {
        let root = Path::new("/projects/aethon");
        // /projects/aethon/../passwd → /projects/passwd, escapes.
        assert!(resolve_inside_root(root, Path::new("/projects/aethon/../passwd")).is_none());
        // /etc/passwd is plain outside.
        assert!(resolve_inside_root(root, Path::new("/etc/passwd")).is_none());
        // Sibling that shares a prefix is NOT a descendant — `/projects/aethon-other`
        // starts with the same string as `/projects/aethon` but is a sibling
        // dir. starts_with compares components, so this is rejected.
        assert!(resolve_inside_root(root, Path::new("/projects/aethon-other/file")).is_none());
    }

    #[test]
    fn resolve_inside_root_rejects_relative_inputs() {
        // Both args must be absolute. A relative root or path is a caller
        // bug — return None so the command surfaces an error.
        assert!(resolve_inside_root(Path::new("projects/aethon"), Path::new("/x")).is_none());
        assert!(resolve_inside_root(Path::new("/x"), Path::new("projects/aethon")).is_none());
    }

    #[test]
    fn resolve_inside_root_rejects_pop_past_root() {
        // /projects/aethon/../.. ascends above /projects — refuse rather
        // than pop off the prefix component.
        let root = Path::new("/projects/aethon");
        assert!(resolve_inside_root(root, Path::new("/projects/aethon/../..")).is_none());
    }

    /// Tests for `aethon_dir`. The function consults `AETHON_USER_DIR`
    /// at call time, so each test must set+unset the var locally to
    /// stay isolated from sibling tests running in the same process.
    /// We use a global mutex (`ENV_LOCK`) so concurrent test threads
    /// can't observe each other's env mutations.
    mod aethon_dir_tests {
        use super::super::aethon_dir;
        use std::path::PathBuf;
        use std::sync::Mutex;

        static ENV_LOCK: Mutex<()> = Mutex::new(());

        #[test]
        fn returns_home_dotaethon_when_no_override() {
            let _g = ENV_LOCK.lock().unwrap();
            // SAFETY: ENV_LOCK serialises env mutations across tests in
            // this module so concurrent test threads cannot observe a
            // half-written global.
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
            let got = aethon_dir(Some(PathBuf::from("/home/test")));
            assert_eq!(got, Some(PathBuf::from("/home/test/.aethon")));
        }

        #[test]
        fn returns_override_when_env_set() {
            let _g = ENV_LOCK.lock().unwrap();
            unsafe { std::env::set_var("AETHON_USER_DIR", "/tmp/sandbox-42") };
            let got = aethon_dir(Some(PathBuf::from("/home/test")));
            assert_eq!(got, Some(PathBuf::from("/tmp/sandbox-42")));
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
        }

        #[test]
        fn returns_none_when_no_home_and_no_env() {
            let _g = ENV_LOCK.lock().unwrap();
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
            assert_eq!(aethon_dir(None), None);
        }

        #[test]
        fn env_override_wins_even_when_no_home() {
            let _g = ENV_LOCK.lock().unwrap();
            unsafe { std::env::set_var("AETHON_USER_DIR", "/tmp/sandbox-99") };
            let got = aethon_dir(None);
            assert_eq!(got, Some(PathBuf::from("/tmp/sandbox-99")));
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
        }

        #[test]
        fn empty_env_var_falls_back_to_home() {
            let _g = ENV_LOCK.lock().unwrap();
            // Some shells export empty string instead of unsetting. We
            // treat that as "no override" so the user isn't trapped in
            // a broken sandbox at "".
            unsafe { std::env::set_var("AETHON_USER_DIR", "") };
            let got = aethon_dir(Some(PathBuf::from("/h")));
            assert_eq!(got, Some(PathBuf::from("/h/.aethon")));
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
        }
    }
}
