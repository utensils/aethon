use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};

use super::cache::{AppEmitter, DevshellCache, DevshellEmitter, PreparedEnv};
use super::detect::{DetectMode, DevshellKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareDecision {
    Disabled,
    MissingOptional {
        reason: String,
    },
    MissingRequired {
        reason: String,
    },
    ForcedModeMismatch {
        reason: String,
    },
    DirenvAllowFailedOptional {
        kind: DevshellKind,
        reason: String,
    },
    DirenvAllowFailedRequired {
        reason: String,
    },
    CachePrepareFailedOptional {
        kind: DevshellKind,
        reason: String,
    },
    CachePrepareFailedRequired {
        reason: String,
    },
    Prepared {
        kind: DevshellKind,
        prepared: PreparedEnv,
    },
}

pub(crate) fn prepare_is_required(enabled: &str) -> bool {
    enabled == "always"
}

pub(crate) fn required_devshell_missing_error(enabled: &str, reason: String) -> Option<String> {
    prepare_is_required(enabled).then(|| format!("{reason} and [devshell] enabled = \"always\""))
}

pub(crate) fn mode_str(mode: DetectMode) -> &'static str {
    match mode {
        DetectMode::Auto => "auto",
        DetectMode::Direnv => "direnv",
        DetectMode::Nix => "nix",
        DetectMode::NixShell => "nix-shell",
    }
}

fn expected_marker(mode: DetectMode) -> &'static str {
    match mode {
        DetectMode::Auto => "devshell",
        DetectMode::Direnv => ".envrc with use flake/use nix",
        DetectMode::Nix => "flake.nix",
        DetectMode::NixShell => "flake.nix or shell.nix",
    }
}

pub(crate) fn forced_mode_mismatch_reason(
    root: &Path,
    configured_mode: DetectMode,
) -> Option<String> {
    let natural = crate::devshell::forced_mode_mismatch(root, configured_mode)?;
    Some(format!(
        "configured [devshell].mode = \"{}\", but {} is detected as a {} devshell. Aethon will not fall back to a different resolver; change Resolver mode or add the expected {} marker.",
        mode_str(configured_mode),
        root.display(),
        natural.as_str(),
        expected_marker(configured_mode)
    ))
}

pub fn decide_prepare_policy(
    enabled: &str,
    forced_mismatch: Option<String>,
    detected_kind: Option<DevshellKind>,
    root_display: &str,
    direnv_allow_error: Option<String>,
    cache_prepare: Result<Option<PreparedEnv>, String>,
) -> PrepareDecision {
    if enabled == "never" {
        return PrepareDecision::Disabled;
    }
    if let Some(reason) = forced_mismatch {
        return PrepareDecision::ForcedModeMismatch { reason };
    }
    let Some(kind) = detected_kind else {
        let reason = format!("no devshell detected at {root_display}");
        return if prepare_is_required(enabled) {
            PrepareDecision::MissingRequired { reason }
        } else {
            PrepareDecision::MissingOptional { reason }
        };
    };
    if let Some(reason) = direnv_allow_error {
        return if prepare_is_required(enabled) {
            PrepareDecision::DirenvAllowFailedRequired { reason }
        } else {
            PrepareDecision::DirenvAllowFailedOptional { kind, reason }
        };
    }
    match cache_prepare {
        Ok(Some(prepared)) => PrepareDecision::Prepared { kind, prepared },
        Ok(None) => {
            let reason = format!("no devshell detected at {root_display}");
            if prepare_is_required(enabled) {
                PrepareDecision::MissingRequired { reason }
            } else {
                PrepareDecision::MissingOptional { reason }
            }
        }
        Err(reason) => {
            if prepare_is_required(enabled) {
                PrepareDecision::CachePrepareFailedRequired { reason }
            } else {
                PrepareDecision::CachePrepareFailedOptional { kind, reason }
            }
        }
    }
}

pub async fn prepare_env_for_root<R: Runtime>(
    app: &AppHandle<R>,
    cache: &Arc<DevshellCache>,
    root: &Path,
    emitter: Option<&AppEmitter>,
) -> PrepareDecision {
    let (enabled, configured_mode) = crate::devshell::effective_config(app, root).into_parts();
    if enabled == "never" {
        return decide_prepare_policy(
            &enabled,
            None,
            None,
            &root.display().to_string(),
            None,
            Ok(None),
        );
    }

    let mismatch = forced_mode_mismatch_reason(root, configured_mode);
    if mismatch.is_some() {
        return decide_prepare_policy(
            &enabled,
            mismatch,
            None,
            &root.display().to_string(),
            None,
            Ok(None),
        );
    }

    let detected_kind = crate::devshell::detect_mode(root, configured_mode);
    let mut direnv_error = None;
    if matches!(detected_kind, Some(DevshellKind::Direnv)) {
        direnv_error = direnv_allow(root).await.err();
    }
    if direnv_error.is_some() || detected_kind.is_none() {
        return decide_prepare_policy(
            &enabled,
            None,
            detected_kind,
            &root.display().to_string(),
            direnv_error,
            Ok(None),
        );
    }

    let prepared = cache
        .prepare_for(emitter, root, configured_mode)
        .await
        .map(Some);
    decide_prepare_policy(
        &enabled,
        None,
        detected_kind,
        &root.display().to_string(),
        None,
        prepared,
    )
}

/// Adapter so the devshell cache can emit Tauri events without taking
/// a direct dependency on `tauri::AppHandle`. The cache calls
/// [`DevshellEmitter::emit`]; we forward to the real Tauri emitter here.
struct TauriEmitter<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriEmitter<R> {
    fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> DevshellEmitter for TauriEmitter<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.app.emit(event, payload) {
            tracing::warn!(
                target: "aethon::devshell",
                "emit {event} failed: {e}"
            );
        }
    }
}

pub fn emitter_for<R: Runtime>(app: &AppHandle<R>) -> AppEmitter {
    AppEmitter::new(Arc::new(TauriEmitter::new(app.clone())) as Arc<dyn DevshellEmitter>)
}

pub(crate) async fn direnv_allow(root: &Path) -> Result<(), String> {
    let Some(bin) = crate::env::resolve_program("direnv") else {
        return Err("direnv binary not found on Aethon tool PATH".to_string());
    };
    let mut command = tokio::process::Command::new(bin);
    command
        .arg("allow")
        .arg(root)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| format!("direnv allow {} timed out after 30s", root.display()))?
        .map_err(|e| format!("direnv allow {} failed to start: {e}", root.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "direnv allow {} exited with {}{}",
        root.display(),
        output.status,
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn prepared(kind: &str) -> PreparedEnv {
        PreparedEnv {
            kind: Some(kind.to_string()),
            stale: false,
            env: BTreeMap::from([("A".to_string(), "B".to_string())]),
            duration_ms: Some(1),
        }
    }

    #[test]
    fn decision_disabled_when_enabled_never() {
        assert_eq!(
            decide_prepare_policy(
                "never",
                None,
                Some(DevshellKind::Flake),
                "/repo",
                None,
                Ok(Some(prepared("flake"))),
            ),
            PrepareDecision::Disabled
        );
    }

    #[test]
    fn decision_auto_missing_devshell_is_optional() {
        assert_eq!(
            decide_prepare_policy("auto", None, None, "/repo", None, Ok(None)),
            PrepareDecision::MissingOptional {
                reason: "no devshell detected at /repo".to_string()
            }
        );
    }

    #[test]
    fn decision_always_missing_devshell_is_required() {
        assert_eq!(
            decide_prepare_policy("always", None, None, "/repo", None, Ok(None)),
            PrepareDecision::MissingRequired {
                reason: "no devshell detected at /repo".to_string()
            }
        );
    }

    #[test]
    fn decision_always_cache_none_is_required() {
        assert_eq!(
            decide_prepare_policy(
                "always",
                None,
                Some(DevshellKind::Flake),
                "/repo",
                None,
                Ok(None),
            ),
            PrepareDecision::MissingRequired {
                reason: "no devshell detected at /repo".to_string()
            }
        );
    }

    #[test]
    fn decision_forced_mode_mismatch_is_hard_error() {
        assert_eq!(
            decide_prepare_policy(
                "auto",
                Some("configured devshell mode direnv does not match flake project".to_string()),
                Some(DevshellKind::Flake),
                "/repo",
                None,
                Ok(Some(prepared("flake"))),
            ),
            PrepareDecision::ForcedModeMismatch {
                reason: "configured devshell mode direnv does not match flake project".to_string()
            }
        );
    }

    #[test]
    fn decision_direnv_allow_failure_respects_required_policy() {
        assert_eq!(
            decide_prepare_policy(
                "auto",
                None,
                Some(DevshellKind::Direnv),
                "/repo",
                Some("direnv failed".to_string()),
                Ok(None),
            ),
            PrepareDecision::DirenvAllowFailedOptional {
                kind: DevshellKind::Direnv,
                reason: "direnv failed".to_string()
            }
        );
        assert_eq!(
            decide_prepare_policy(
                "always",
                None,
                Some(DevshellKind::Direnv),
                "/repo",
                Some("direnv failed".to_string()),
                Ok(None),
            ),
            PrepareDecision::DirenvAllowFailedRequired {
                reason: "direnv failed".to_string()
            }
        );
    }

    #[test]
    fn decision_cache_prepare_failure_respects_required_policy() {
        assert_eq!(
            decide_prepare_policy(
                "auto",
                None,
                Some(DevshellKind::Flake),
                "/repo",
                None,
                Err("nix failed".to_string()),
            ),
            PrepareDecision::CachePrepareFailedOptional {
                kind: DevshellKind::Flake,
                reason: "nix failed".to_string()
            }
        );
        assert_eq!(
            decide_prepare_policy(
                "always",
                None,
                Some(DevshellKind::Flake),
                "/repo",
                None,
                Err("nix failed".to_string()),
            ),
            PrepareDecision::CachePrepareFailedRequired {
                reason: "nix failed".to_string()
            }
        );
    }
}
