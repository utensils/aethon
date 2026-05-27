//! Detect which Nix devshell entry path a project root uses.
//!
//! Precedence: Direnv > Flake > Shell. Direnv wins when both an
//! `.envrc` and the `direnv` binary are present because that matches
//! how the user normally enters the env (the global rule
//! `use flake` in `.envrc` already wires it up), and direnv keeps a
//! warm in-process cache pi can't see. Flake comes next so a
//! repo with `flake.nix` + `nix` on PATH transparently lights up
//! without any direnv setup. `shell.nix` is the legacy non-flake
//! fallback.
//!
//! Detection is intentionally *capability-aware*: a `flake.nix`
//! without `nix` on PATH yields `None` rather than `Flake`, because
//! a kind we can't actually resolve would just confuse the caller.

use std::path::{Path, PathBuf};

/// What kind of devshell, if any, a project root has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevshellKind {
    /// `.envrc` + `direnv` binary present. Resolve via
    /// `direnv exec <root> env -0`.
    Direnv,
    /// `flake.nix` + `nix` binary present. Resolve via
    /// `nix print-dev-env --json` from the root.
    Flake,
    /// `shell.nix` + `nix` binary present. Resolve via
    /// `nix-shell --run 'env -0'` from the root.
    Shell,
}

impl DevshellKind {
    /// Stable lowercase identifier suitable for serialization, log
    /// targets, and the frontend status badge label.
    pub fn as_str(self) -> &'static str {
        match self {
            DevshellKind::Direnv => "direnv",
            DevshellKind::Flake => "flake",
            DevshellKind::Shell => "shell",
        }
    }
}

/// Override for `mode` from `[devshell] mode` in `config.toml`. `Auto`
/// keeps the natural precedence; the named variants pin a kind and
/// still gracefully fall back to `None` if the marker file or the
/// required binary is missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DetectMode {
    #[default]
    Auto,
    Direnv,
    Nix,
    NixShell,
}

impl DetectMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "direnv" => DetectMode::Direnv,
            "nix" => DetectMode::Nix,
            "nix-shell" => DetectMode::NixShell,
            _ => DetectMode::Auto,
        }
    }
}

/// Detect with a caller-specified mode override (forces a kind).
/// The IPC + spawn paths always pass an explicit mode (from
/// `[devshell] mode` in config) so we don't expose a separate `Auto`
/// alias — pass `DetectMode::Auto` for the natural precedence.
pub fn detect_mode(root: &Path, mode: DetectMode) -> Option<DevshellKind> {
    detect_with(root, mode, &RealProbe)
}

/// Trait so unit tests can fake binary availability without poking
/// the real PATH. Production callers use `RealProbe`.
pub trait BinProbe {
    fn has_direnv(&self) -> bool;
    fn has_nix(&self) -> bool;
}

pub struct RealProbe;

impl BinProbe for RealProbe {
    fn has_direnv(&self) -> bool {
        which_on_path("direnv").is_some()
    }
    fn has_nix(&self) -> bool {
        which_on_path("nix").is_some()
    }
}

pub(super) fn detect_with(
    root: &Path,
    mode: DetectMode,
    probe: &dyn BinProbe,
) -> Option<DevshellKind> {
    if !root.is_absolute() {
        return None;
    }
    let has_envrc = root.join(".envrc").is_file();
    let has_flake = root.join("flake.nix").is_file();
    let has_shell = root.join("shell.nix").is_file();
    let direnv_ok = has_envrc && probe.has_direnv() && envrc_uses_nix(&root.join(".envrc"));
    let flake_ok = has_flake && probe.has_nix();
    let shell_ok = has_shell && probe.has_nix();

    match mode {
        DetectMode::Auto => {
            if direnv_ok {
                Some(DevshellKind::Direnv)
            } else if flake_ok {
                Some(DevshellKind::Flake)
            } else if shell_ok {
                Some(DevshellKind::Shell)
            } else {
                None
            }
        }
        DetectMode::Direnv => direnv_ok.then_some(DevshellKind::Direnv),
        DetectMode::Nix => flake_ok.then_some(DevshellKind::Flake),
        DetectMode::NixShell => shell_ok.then_some(DevshellKind::Shell),
    }
}

/// Cheaply check whether a `.envrc` actually wires up Nix. A `.envrc`
/// might be doing something unrelated (e.g. `dotenv` for project-local
/// secrets) and forcing every such project through direnv would be
/// surprising. We require a `use_flake` / `use flake` / `use_nix` /
/// `use nix` line so we only intercept envrcs that are *actually*
/// Nix-backed.
fn envrc_uses_nix(envrc: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(envrc) else {
        return false;
    };
    for raw in contents.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        // Tolerate either underscore or space form, both are valid direnv stdlib.
        if line.starts_with("use_flake")
            || line.starts_with("use flake")
            || line.starts_with("use_nix")
            || line.starts_with("use nix")
        {
            return true;
        }
    }
    false
}

/// Minimal `which`. We don't need the full `which` crate's surface —
/// just check whether PATH yields an executable file by name. Returns
/// the resolved path so callers can pin the resolver (avoids picking
/// up a different `nix` mid-session if PATH mutates).
pub fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    struct FakeProbe {
        direnv: bool,
        nix: bool,
    }
    impl BinProbe for FakeProbe {
        fn has_direnv(&self) -> bool {
            self.direnv
        }
        fn has_nix(&self) -> bool {
            self.nix
        }
    }

    fn write(td: &TempDir, name: &str, body: &str) {
        fs::write(td.path().join(name), body).unwrap();
    }

    #[test]
    fn rejects_relative_root() {
        let probe = FakeProbe {
            direnv: true,
            nix: true,
        };
        assert_eq!(
            detect_with(Path::new("relative/path"), DetectMode::Auto, &probe),
            None
        );
    }

    #[test]
    fn empty_dir_yields_none() {
        let td = TempDir::new().unwrap();
        let probe = FakeProbe {
            direnv: true,
            nix: true,
        };
        assert_eq!(detect_with(td.path(), DetectMode::Auto, &probe), None);
    }

    #[test]
    fn flake_without_nix_binary_is_none() {
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        let probe = FakeProbe {
            direnv: false,
            nix: false,
        };
        assert_eq!(detect_with(td.path(), DetectMode::Auto, &probe), None);
    }

    #[test]
    fn flake_with_nix_binary_detects_flake() {
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        let probe = FakeProbe {
            direnv: false,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Flake)
        );
    }

    #[test]
    fn envrc_use_flake_with_direnv_takes_precedence_over_flake() {
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        write(&td, ".envrc", "use flake\n");
        let probe = FakeProbe {
            direnv: true,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Direnv)
        );
    }

    #[test]
    fn envrc_without_use_flake_does_not_count() {
        // An .envrc that only sets dotenv-style vars is not a Nix devshell.
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        write(&td, ".envrc", "dotenv .env\n");
        let probe = FakeProbe {
            direnv: true,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Flake)
        );
    }

    #[test]
    fn envrc_use_flake_without_direnv_falls_through_to_flake() {
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        write(&td, ".envrc", "use flake\n");
        let probe = FakeProbe {
            direnv: false,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Flake)
        );
    }

    #[test]
    fn shell_nix_only_with_nix_binary() {
        let td = TempDir::new().unwrap();
        write(&td, "shell.nix", "{}");
        let probe = FakeProbe {
            direnv: false,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Shell)
        );
    }

    #[test]
    fn flake_wins_over_shell_when_both_present() {
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        write(&td, "shell.nix", "{}");
        let probe = FakeProbe {
            direnv: false,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Flake)
        );
    }

    #[test]
    fn use_nix_underscore_form_also_works() {
        let td = TempDir::new().unwrap();
        write(&td, ".envrc", "use_flake\n");
        write(&td, "flake.nix", "{}");
        let probe = FakeProbe {
            direnv: true,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Direnv)
        );
    }

    #[test]
    fn envrc_comment_is_ignored() {
        let td = TempDir::new().unwrap();
        write(&td, ".envrc", "# use flake\nexport FOO=1\n");
        write(&td, "flake.nix", "{}");
        let probe = FakeProbe {
            direnv: true,
            nix: true,
        };
        // Commented `use flake` should NOT count, so we fall through to Flake.
        assert_eq!(
            detect_with(td.path(), DetectMode::Auto, &probe),
            Some(DevshellKind::Flake)
        );
    }

    #[test]
    fn detect_mode_forces_specific_kind() {
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        write(&td, "shell.nix", "{}");
        write(&td, ".envrc", "use flake\n");
        let probe = FakeProbe {
            direnv: true,
            nix: true,
        };
        assert_eq!(
            detect_with(td.path(), DetectMode::Direnv, &probe),
            Some(DevshellKind::Direnv)
        );
        assert_eq!(
            detect_with(td.path(), DetectMode::Nix, &probe),
            Some(DevshellKind::Flake)
        );
        assert_eq!(
            detect_with(td.path(), DetectMode::NixShell, &probe),
            Some(DevshellKind::Shell)
        );
    }

    #[test]
    fn detect_mode_forced_kind_falls_back_to_none_when_unavailable() {
        let td = TempDir::new().unwrap();
        write(&td, "flake.nix", "{}");
        let probe = FakeProbe {
            direnv: true,
            nix: false,
        };
        // Forced Nix mode but no nix binary on PATH — refuse rather than lie.
        assert_eq!(detect_with(td.path(), DetectMode::Nix, &probe), None);
    }

    #[test]
    fn devshell_kind_as_str_is_stable() {
        assert_eq!(DevshellKind::Direnv.as_str(), "direnv");
        assert_eq!(DevshellKind::Flake.as_str(), "flake");
        assert_eq!(DevshellKind::Shell.as_str(), "shell");
    }

    #[test]
    fn detect_mode_from_str_parses_known() {
        assert_eq!(DetectMode::from_str("direnv"), DetectMode::Direnv);
        assert_eq!(DetectMode::from_str("nix"), DetectMode::Nix);
        assert_eq!(DetectMode::from_str("nix-shell"), DetectMode::NixShell);
        assert_eq!(DetectMode::from_str("auto"), DetectMode::Auto);
        assert_eq!(DetectMode::from_str("yolo"), DetectMode::Auto);
    }
}
