//! Config schemas and parsers for `~/.aethon/config.toml`. The structs
//! mirror the user-facing TOML keys; `parse_config_toml` flattens them
//! into the canonical JSON shape the frontend consumes, with all
//! defaults applied and unknown values clamped.
//!
//! Also home to the small numeric clamps the config feeds: the
//! extension state-size limits (`EXT_STATE_*`) and the UI font-size
//! range. These constants live next to the parser that reads them.

use serde::Deserialize;

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
    /// Minutes a per-tab agent worker may sit idle (no prompt in flight, no
    /// traffic) before the background sweep retires it; it respawns lazily from
    /// the persisted session on the next message. `0` disables retirement.
    /// Clamped to 24h. Default 15.
    pub idle_retire_minutes: Option<u32>,
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
pub struct VoiceConfig {
    pub toggle_hotkey: Option<String>,
    pub hold_hotkey: Option<String>,
}

#[derive(Default, Deserialize)]
pub struct UpdatesConfig {
    /// Which release channel the auto-updater checks. Allowed values:
    /// `"stable"` (default) tracks `releases/latest`; `"nightly"`
    /// follows the `nightly` tag for in-development builds. Anything
    /// else falls back to `"stable"`. Mirrored on the frontend so
    /// users get the same channel after a restart.
    pub channel: Option<String>,
    /// Disable the automatic background update check entirely. The
    /// "Check for Updates" menu item still works. Default `false`.
    pub disable_auto_check: Option<bool>,
}

#[derive(Default, Deserialize)]
pub struct ServerConfig {
    /// Whether to advertise this host over mDNS (`_aethon._tcp.local.`) on
    /// boot. Default `true`. Set `false` to stop the LAN announcement — and
    /// the "No route to host" send-failure log churn it can produce on
    /// networks without multicast — while keeping peer *discovery* (the
    /// browser) running, since that's read-only. The `server_start` IPC
    /// (explicit user action) always advertises regardless of this flag.
    pub enabled: Option<bool>,
}

#[derive(Default, Deserialize)]
pub struct DevshellConfig {
    /// Whether to detect + apply a Nix devshell on shell + agent
    /// spawn. Accepted values: `"auto"` (default — detect via marker
    /// files), `"always"` (force detection; resolver failure surfaces
    /// loudly), `"never"` (escape hatch — disable wrapping entirely).
    /// Unknown values fall back to `"auto"` so a typo can't silently
    /// disable the feature.
    pub enabled: Option<String>,
    /// Pin a specific resolver kind. `"auto"` honours the natural
    /// precedence (direnv > flake > shell). The named variants
    /// `"direnv"` / `"nix"` / `"nix-shell"` force a single kind and
    /// fall back to no-wrap if the marker or binary is missing.
    pub mode: Option<String>,
    /// How long a successful on-disk snapshot stays valid before the
    /// next launch ignores it (lockfile-hash mismatches always
    /// invalidate first; this is purely a GC ceiling). Default 720 h
    /// (30 days). 0 disables auto-eviction.
    pub cache_ttl_hours: Option<u32>,
    /// Re-resolve automatically when a watched lockfile / marker file
    /// changes mtime. Default `true`. Disable to require the user
    /// click "Refresh now" in Settings.
    pub refresh_on_lockfile_change: Option<bool>,
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
    pub voice: VoiceConfig,
    #[serde(default)]
    pub extensions: ExtensionsConfig,
    #[serde(default)]
    pub updates: UpdatesConfig,
    #[serde(default)]
    pub devshell: DevshellConfig,
    #[serde(default)]
    pub server: ServerConfig,
}

/// Validate-and-normalize `[devshell] enabled`. Unknown values fall
/// through to `"auto"` so a typo can't silently disable the feature.
pub fn normalize_devshell_enabled(input: Option<&str>) -> &'static str {
    match input {
        Some("always") => "always",
        Some("never") => "never",
        // Includes Some("auto"), Some(<unknown>), and None.
        _ => "auto",
    }
}

/// Validate-and-normalize `[devshell] mode`. Unknown values fall back
/// to `"auto"`. Lives next to the parser so test coverage stays with
/// the other config helpers.
pub fn normalize_devshell_mode(input: Option<&str>) -> &'static str {
    match input {
        Some("direnv") => "direnv",
        Some("nix") => "nix",
        Some("nix-shell") => "nix-shell",
        // Includes Some("auto"), Some(<unknown>), and None.
        _ => "auto",
    }
}

/// Validate-and-normalize `[updates] channel`. Unknown strings, missing
/// values, and parse failures all fall through to `"stable"`. Lives next
/// to the parser so test coverage sits with the other config helpers.
pub fn normalize_update_channel(input: Option<&str>) -> &'static str {
    match input {
        Some("nightly") => "nightly",
        // Includes Some("stable"), Some(<unknown>), and None.
        _ => "stable",
    }
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

pub fn default_voice_hold_hotkey() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        Some("AltRight")
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
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
    let update_channel = normalize_update_channel(cfg.updates.channel.as_deref());
    let disable_auto_check = cfg.updates.disable_auto_check.unwrap_or(false);
    let devshell_enabled = normalize_devshell_enabled(cfg.devshell.enabled.as_deref());
    let devshell_mode = normalize_devshell_mode(cfg.devshell.mode.as_deref());
    let devshell_cache_ttl_hours = cfg.devshell.cache_ttl_hours.unwrap_or(720);
    let devshell_refresh_on_lockfile_change =
        cfg.devshell.refresh_on_lockfile_change.unwrap_or(true);
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
            "idleRetireMinutes": cfg.agent.idle_retire_minutes.map(|n| n.min(1440)).unwrap_or(15),
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
        "voice": {
            "toggleHotkey": cfg.voice.toggle_hotkey.unwrap_or_else(|| "mod+shift+m".to_string()),
            "holdHotkey": cfg.voice.hold_hotkey.or_else(|| default_voice_hold_hotkey().map(str::to_string)),
        },
        "extensions": {
            "stateWarnKb": state_warn_kb,
            "stateHardKb": state_hard_kb,
        },
        "updates": {
            "channel": update_channel,
            "disableAutoCheck": disable_auto_check,
        },
        "devshell": {
            "enabled": devshell_enabled,
            "mode": devshell_mode,
            "cacheTtlHours": devshell_cache_ttl_hours,
            "refreshOnLockfileChange": devshell_refresh_on_lockfile_change,
        },
        "server": {
            "enabled": cfg.server.enabled.unwrap_or(true),
        },
    })
}

/// Per-project devshell override. Loaded from
/// `<project_root>/.aethon/devshell.toml` if present and merged over
/// the global `[devshell]` section. Mirrors the same shape as the
/// global config — anything omitted falls through to the global
/// values applied by `parse_config_toml`. Per-project overrides are a
/// thin convenience over editing the global config, but they let a
/// user mark one repo as `enabled = "never"` while keeping devshell
/// on globally.
#[derive(Default, Deserialize)]
pub struct ProjectDevshellOverride {
    #[serde(default)]
    pub devshell: DevshellConfig,
}

/// Parse the per-project override TOML. Falls back to a fully-empty
/// override on parse error so a malformed `.aethon/devshell.toml`
/// never blocks a shell from opening — we just ignore it.
pub fn parse_project_devshell_override(input: &str) -> ProjectDevshellOverride {
    if input.is_empty() {
        return ProjectDevshellOverride::default();
    }
    toml::from_str(input).unwrap_or_default()
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
    fn server_enabled_defaults_true_and_honors_override() {
        assert_eq!(parse_config_toml("")["server"]["enabled"], true);
        assert_eq!(
            parse_config_toml("[server]\nenabled = false\n")["server"]["enabled"],
            false
        );
    }

    #[test]
    fn idle_retire_minutes_defaults_clamps_and_disables() {
        assert_eq!(parse_config_toml("")["agent"]["idleRetireMinutes"], 15);
        assert_eq!(
            parse_config_toml("[agent]\nidle_retire_minutes = 0\n")["agent"]["idleRetireMinutes"],
            0
        );
        assert_eq!(
            parse_config_toml("[agent]\nidle_retire_minutes = 99999\n")["agent"]["idleRetireMinutes"],
            1440
        );
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
    fn parse_config_toml_voice_defaults_are_stable() {
        let v = parse_config_toml("");
        assert_eq!(v["voice"]["toggleHotkey"], "mod+shift+m");
        #[cfg(target_os = "macos")]
        assert_eq!(v["voice"]["holdHotkey"], "AltRight");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(v["voice"]["holdHotkey"], serde_json::Value::Null);
    }

    #[test]
    fn parse_config_toml_extracts_voice_hotkeys() {
        let v = parse_config_toml(
            r#"[voice]
toggle_hotkey = "mod+alt+v"
hold_hotkey = "AltRight"
"#,
        );
        assert_eq!(v["voice"]["toggleHotkey"], "mod+alt+v");
        assert_eq!(v["voice"]["holdHotkey"], "AltRight");
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

    // ── devshell ──────────────────────────────────────────────────────────

    #[test]
    fn normalize_devshell_enabled_accepts_known() {
        assert_eq!(normalize_devshell_enabled(Some("auto")), "auto");
        assert_eq!(normalize_devshell_enabled(Some("always")), "always");
        assert_eq!(normalize_devshell_enabled(Some("never")), "never");
    }

    #[test]
    fn normalize_devshell_enabled_falls_back_to_auto() {
        // A typo can't silently disable the feature — fall back to "auto".
        assert_eq!(normalize_devshell_enabled(None), "auto");
        assert_eq!(normalize_devshell_enabled(Some("")), "auto");
        assert_eq!(normalize_devshell_enabled(Some("Always")), "auto");
        assert_eq!(normalize_devshell_enabled(Some("disabled")), "auto");
    }

    #[test]
    fn normalize_devshell_mode_accepts_known() {
        assert_eq!(normalize_devshell_mode(Some("auto")), "auto");
        assert_eq!(normalize_devshell_mode(Some("direnv")), "direnv");
        assert_eq!(normalize_devshell_mode(Some("nix")), "nix");
        assert_eq!(normalize_devshell_mode(Some("nix-shell")), "nix-shell");
    }

    #[test]
    fn normalize_devshell_mode_falls_back_to_auto() {
        assert_eq!(normalize_devshell_mode(None), "auto");
        assert_eq!(normalize_devshell_mode(Some("")), "auto");
        assert_eq!(normalize_devshell_mode(Some("NixShell")), "auto");
    }

    #[test]
    fn parse_config_toml_devshell_defaults() {
        let v = parse_config_toml("");
        assert_eq!(v["devshell"]["enabled"], "auto");
        assert_eq!(v["devshell"]["mode"], "auto");
        assert_eq!(v["devshell"]["cacheTtlHours"], 720);
        assert_eq!(v["devshell"]["refreshOnLockfileChange"], true);
    }

    #[test]
    fn parse_config_toml_extracts_devshell_section() {
        let v = parse_config_toml(
            r#"[devshell]
enabled = "always"
mode = "direnv"
cache_ttl_hours = 24
refresh_on_lockfile_change = false
"#,
        );
        assert_eq!(v["devshell"]["enabled"], "always");
        assert_eq!(v["devshell"]["mode"], "direnv");
        assert_eq!(v["devshell"]["cacheTtlHours"], 24);
        assert_eq!(v["devshell"]["refreshOnLockfileChange"], false);
    }

    #[test]
    fn parse_config_toml_devshell_normalizes_unknown_strings() {
        let v = parse_config_toml(
            r#"[devshell]
enabled = "yolo"
mode = "magic"
"#,
        );
        assert_eq!(v["devshell"]["enabled"], "auto");
        assert_eq!(v["devshell"]["mode"], "auto");
    }

    #[test]
    fn parse_project_devshell_override_empty_yields_default() {
        let v = parse_project_devshell_override("");
        assert!(v.devshell.enabled.is_none());
        assert!(v.devshell.mode.is_none());
    }

    #[test]
    fn parse_project_devshell_override_extracts_keys() {
        let v = parse_project_devshell_override(
            r#"[devshell]
enabled = "never"
"#,
        );
        assert_eq!(v.devshell.enabled.as_deref(), Some("never"));
        assert!(v.devshell.mode.is_none());
    }

    #[test]
    fn parse_project_devshell_override_tolerates_garbage() {
        // Malformed TOML must never block a shell open — we just ignore it.
        let v = parse_project_devshell_override("=== broken ===");
        assert!(v.devshell.enabled.is_none());
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
