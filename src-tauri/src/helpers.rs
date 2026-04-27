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
}

#[derive(Default, Deserialize)]
pub struct AgentConfig {
    pub model: Option<String>,
}

#[derive(Default, Deserialize)]
pub struct AethonConfig {
    #[serde(default)]
    pub ui: UiConfig,
    #[serde(default)]
    pub agent: AgentConfig,
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
    serde_json::json!({
        "ui": {
            "theme": cfg.ui.theme,
            "fontSize": cfg.ui.font_size,
        },
        "agent": {
            "model": cfg.agent.model,
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
        let v = parse_config_toml("[ui]\ntheme = \"dark\"\nfont_size = 16\n");
        assert_eq!(v["ui"]["theme"], "dark");
        assert_eq!(v["ui"]["fontSize"], 16);
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

    #[test]
    fn parse_config_toml_always_returns_consistent_shape() {
        // No matter what's in the input, the output keys are identical.
        for input in ["", "[ui]\ntheme=\"dark\"\n", "garbage", "[unknown]\nx=1\n"] {
            let v = parse_config_toml(input);
            assert!(v["ui"].is_object());
            assert!(v["agent"].is_object());
            assert!(v["ui"].as_object().unwrap().contains_key("theme"));
            assert!(v["ui"].as_object().unwrap().contains_key("fontSize"));
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
