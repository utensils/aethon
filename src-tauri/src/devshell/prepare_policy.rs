use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Runtime};

use super::cache::{AppEmitter, DevshellCache, DevshellEmitter, PreparedEnv};
use super::detect::DevshellKind;

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
        Ok(None) => PrepareDecision::MissingOptional {
            reason: format!("no devshell detected at {root_display}"),
        },
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

    let mismatch = crate::commands::devshell::forced_mode_mismatch_reason(root, configured_mode);
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
        direnv_error = crate::commands::devshell::direnv_allow(root).await.err();
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

pub fn emitter_for<R: Runtime>(app: &AppHandle<R>) -> AppEmitter {
    AppEmitter::new(
        Arc::new(crate::commands::devshell::TauriEmitter::new(app.clone()))
            as Arc<dyn DevshellEmitter>,
    )
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
