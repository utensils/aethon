//! Effective `[devshell]` config resolution shared by IPC, startup,
//! agent spawn, and interactive PTY launch paths.
//!
//! The user-facing config can come from two places: the global
//! `~/.aethon/config.toml` `[devshell]` section and an optional
//! `<project>/.aethon/devshell.toml` override. Keep that merge in one
//! non-IPC helper so command status/prepare and shell opens cannot drift.

use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};

use crate::helpers::config::{
    normalize_devshell_enabled, normalize_devshell_mode, parse_project_devshell_override,
};

use super::DetectMode;

const PROJECT_OVERRIDE_READ_LIMIT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveDevshellConfig {
    /// Normalized `"auto" | "always" | "never"` policy.
    pub enabled: String,
    /// Normalized resolver mode as a typed value for cache/detect callers.
    pub mode: DetectMode,
}

impl Default for EffectiveDevshellConfig {
    fn default() -> Self {
        Self {
            enabled: "auto".to_string(),
            mode: DetectMode::Auto,
        }
    }
}

impl EffectiveDevshellConfig {
    pub fn new(enabled: String, mode: DetectMode) -> Self {
        Self { enabled, mode }
    }

    pub fn into_parts(self) -> (String, DetectMode) {
        (self.enabled, self.mode)
    }
}

/// Resolve `[devshell]` config — global TOML merged with the optional
/// `<root>/.aethon/devshell.toml` override. The result is normalized and
/// ready for cache/detect callers.
pub fn effective_config<R: Runtime>(app: &AppHandle<R>, root: &Path) -> EffectiveDevshellConfig {
    // Replicate aethon_state_path's home-dir resolution here instead of using
    // the default-runtime helper, so this stays generic over `Runtime` for
    // tests and alternate app handles.
    let home = match app.path().home_dir() {
        Ok(home) => home,
        Err(_) => return EffectiveDevshellConfig::default(),
    };
    let global_config_path = match crate::helpers::aethon_dir(Some(home)) {
        Some(dir) => dir.join("config.toml"),
        None => return EffectiveDevshellConfig::default(),
    };
    effective_config_from_paths(Some(&global_config_path), root)
}

fn effective_config_from_paths(
    global_config_path: Option<&Path>,
    root: &Path,
) -> EffectiveDevshellConfig {
    let global = global_config_path
        .map(crate::helpers::read_config_snapshot)
        .map(|snapshot| snapshot.parsed)
        .unwrap_or_else(|| crate::helpers::parse_config_toml(""));
    let mut enabled = global["devshell"]["enabled"]
        .as_str()
        .unwrap_or("auto")
        .to_string();
    let mut mode = global["devshell"]["mode"]
        .as_str()
        .unwrap_or("auto")
        .to_string();

    let override_path = root.join(".aethon").join("devshell.toml");
    if let Ok(mut text) = std::fs::read_to_string(&override_path) {
        // Cap the read size for symmetry with the global config.
        if text.len() > PROJECT_OVERRIDE_READ_LIMIT_BYTES {
            text.truncate(PROJECT_OVERRIDE_READ_LIMIT_BYTES);
        }
        let parsed = parse_project_devshell_override(&text);
        if let Some(value) = parsed.devshell.enabled {
            enabled = normalize_devshell_enabled(Some(&value)).to_string();
        }
        if let Some(value) = parsed.devshell.mode {
            mode = normalize_devshell_mode(Some(&value)).to_string();
        }
    }

    EffectiveDevshellConfig::new(enabled, DetectMode::from_str(&mode))
}

#[cfg(test)]
mod tests {
    use super::{EffectiveDevshellConfig, effective_config_from_paths};
    use crate::devshell::DetectMode;

    fn write(path: &std::path::Path, content: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, content).expect("write");
    }

    #[test]
    fn defaults_when_global_config_is_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = effective_config_from_paths(None, dir.path());

        assert_eq!(config, EffectiveDevshellConfig::default());
    }

    #[test]
    fn reads_global_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global_path = dir.path().join("config.toml");
        write(
            &global_path,
            r#"
[devshell]
enabled = "always"
mode = "nix"
"#,
        );

        let config = effective_config_from_paths(Some(&global_path), dir.path());

        assert_eq!(config.enabled, "always");
        assert_eq!(config.mode, DetectMode::Nix);
    }

    #[test]
    fn normalizes_unknown_global_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global_path = dir.path().join("config.toml");
        write(
            &global_path,
            r#"
[devshell]
enabled = "sometimes"
mode = "flake-ish"
"#,
        );

        let config = effective_config_from_paths(Some(&global_path), dir.path());

        assert_eq!(config.enabled, "auto");
        assert_eq!(config.mode, DetectMode::Auto);
    }

    #[test]
    fn project_override_takes_precedence_over_global_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global_path = dir.path().join("config.toml");
        write(
            &global_path,
            r#"
[devshell]
enabled = "always"
mode = "nix"
"#,
        );
        write(
            &dir.path().join("project/.aethon/devshell.toml"),
            r#"
[devshell]
enabled = "never"
mode = "direnv"
"#,
        );

        let config = effective_config_from_paths(Some(&global_path), &dir.path().join("project"));

        assert_eq!(config.enabled, "never");
        assert_eq!(config.mode, DetectMode::Direnv);
    }

    #[test]
    fn malformed_project_override_falls_back_to_global_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global_path = dir.path().join("config.toml");
        write(
            &global_path,
            r#"
[devshell]
enabled = "always"
mode = "nix-shell"
"#,
        );
        write(
            &dir.path().join("project/.aethon/devshell.toml"),
            "=== broken ===",
        );

        let config = effective_config_from_paths(Some(&global_path), &dir.path().join("project"));

        assert_eq!(config.enabled, "always");
        assert_eq!(config.mode, DetectMode::NixShell);
    }

    #[test]
    fn global_config_read_is_truncated_at_64_kib() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global_path = dir.path().join("config.toml");
        let mut content = " ".repeat(64 * 1024);
        content.push_str(
            r#"
[devshell]
enabled = "always"
mode = "nix"
"#,
        );
        write(&global_path, &content);

        let config = effective_config_from_paths(Some(&global_path), dir.path());

        assert_eq!(config, EffectiveDevshellConfig::default());
    }

    #[test]
    fn project_override_read_is_truncated_at_64_kib() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global_path = dir.path().join("config.toml");
        write(
            &global_path,
            r#"
[devshell]
enabled = "always"
mode = "nix"
"#,
        );
        let mut override_content = " ".repeat(64 * 1024);
        override_content.push_str(
            r#"
[devshell]
enabled = "never"
mode = "direnv"
"#,
        );
        write(
            &dir.path().join("project/.aethon/devshell.toml"),
            &override_content,
        );

        let config = effective_config_from_paths(Some(&global_path), &dir.path().join("project"));

        assert_eq!(config.enabled, "always");
        assert_eq!(config.mode, DetectMode::Nix);
    }
}
