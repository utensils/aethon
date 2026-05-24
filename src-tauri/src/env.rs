//! External command environment helpers.
//!
//! Release builds are often launched by a desktop shell, not a terminal.
//! That means PATH can be missing Homebrew, Nix profiles, cargo bins, and
//! other user-managed tool directories. Keep command lookup here so every
//! Rust IPC command resolves dependencies the same way.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

const COMMON_TOOL_DIRS: &[&str] = &[
    "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

fn push_path(out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    if seen.insert(path.clone()) {
        out.push(path);
    }
}

fn push_path_list(out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, value: &str) {
    for path in std::env::split_paths(value) {
        push_path(out, seen, path);
    }
}

fn home_relative(path: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    Some(home.join(path))
}

fn shell_env_path() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| {
                if cfg!(target_os = "windows") {
                    "cmd".to_string()
                } else {
                    "/bin/sh".to_string()
                }
            });
            if cfg!(target_os = "windows") {
                return None;
            }
            let out = Command::new(&shell).args(["-ilc", "env"]).output().ok()?;
            if !out.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&out.stdout);
            let value = stdout
                .lines()
                .find_map(|line| line.strip_prefix("PATH="))?
                .to_string();
            if value.is_empty() { None } else { Some(value) }
        })
        .clone()
}

pub(crate) fn resolved_tool_path() -> String {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let mut paths = Vec::new();
            let mut seen = HashSet::new();
            if let Ok(path) = std::env::var("PATH") {
                push_path_list(&mut paths, &mut seen, &path);
            }
            if let Some(path) = shell_env_path() {
                push_path_list(&mut paths, &mut seen, &path);
            }
            if let Some(user) = std::env::var_os("USER").and_then(|v| v.into_string().ok()) {
                push_path(
                    &mut paths,
                    &mut seen,
                    PathBuf::from(format!("/etc/profiles/per-user/{user}/bin")),
                );
            }
            for rel in [
                ".nix-profile/bin",
                ".local/state/nix/profile/bin",
                ".local/bin",
                ".cargo/bin",
            ] {
                if let Some(path) = home_relative(rel) {
                    push_path(&mut paths, &mut seen, path);
                }
            }
            for path in COMMON_TOOL_DIRS {
                push_path(&mut paths, &mut seen, PathBuf::from(path));
            }
            std::env::join_paths(paths)
                .map(|v| v.to_string_lossy().to_string())
                .unwrap_or_else(|_| std::env::var("PATH").unwrap_or_default())
        })
        .clone()
}

pub(crate) fn resolved_login_path() -> Option<String> {
    let path = resolved_tool_path();
    if path.is_empty() { None } else { Some(path) }
}

fn has_separator(program: &str) -> bool {
    program.contains('/') || program.contains('\\')
}

pub(crate) fn resolve_program(program: &str) -> Option<PathBuf> {
    if has_separator(program) {
        let path = PathBuf::from(program);
        return path.exists().then_some(path);
    }
    for dir in std::env::split_paths(&resolved_tool_path()) {
        let candidate = dir.join(program);
        if candidate.exists() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{program}.exe"));
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

pub(crate) fn command(program: &str) -> Command {
    let mut command =
        Command::new(resolve_program(program).unwrap_or_else(|| PathBuf::from(program)));
    command.env("PATH", resolved_tool_path());
    command
}

pub(crate) fn tokio_command(program: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(
        resolve_program(program).unwrap_or_else(|| PathBuf::from(program)),
    );
    command.env("PATH", resolved_tool_path());
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_path_includes_common_nix_locations() {
        let path = resolved_tool_path();
        let paths: Vec<_> = std::env::split_paths(&path).collect();
        assert!(paths.contains(&PathBuf::from("/run/current-system/sw/bin")));
        assert!(paths.contains(&PathBuf::from("/nix/var/nix/profiles/default/bin")));
    }

    #[test]
    fn resolve_program_does_not_require_login_shell_for_system_tools() {
        assert!(resolve_program("sh").is_some() || resolve_program("cmd").is_some());
    }
}
