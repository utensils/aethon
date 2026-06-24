//! Tauri IPC commands for the Nix devshell feature.
//!
//! The frontend (badge + settings) and the agent bridge (spawnHook)
//! both reach the same in-memory + on-disk cache through this surface.
//! Three calls:
//!
//! - [`devshell_status`] — non-blocking snapshot; what the badge renders.
//! - [`devshell_env_for_path`] — non-blocking env lookup; the spawnHook
//!   uses this to mutate pi's bash invocation. Also returns the
//!   resolved kind so the agent can log "running inside flake devshell".
//! - [`devshell_refresh`] — invalidate cache and re-resolve. Settings
//!   "Refresh now" button and the future file-watcher reach here.
//!
//! All three honour `[devshell] enabled = "never"` by returning an
//! empty snapshot / env / no-op refresh without touching the cache —
//! the escape hatch must really mean "don't do anything", not "just
//! don't apply the env".

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::devshell::prepare_policy::{
    emitter_for, forced_mode_mismatch_reason, mode_str, prepare_is_required,
    required_devshell_missing_error,
};
use crate::devshell::{DevshellCache, EnvForPath, StatusSnapshot};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusArgs {
    pub root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    /// Resolved config flag. `"never"` means the caller should not
    /// apply any devshell env even if the cache holds one.
    pub enabled: String,
    /// `"auto" | "direnv" | "nix" | "nix-shell"`, normalised.
    pub mode: String,
    pub snapshot: StatusSnapshot,
    /// What `detect()` returns *right now*, ignoring resolver state.
    /// Lets the badge distinguish "we found a flake but haven't
    /// started resolving" from "no devshell here".
    pub detected_kind: Option<String>,
}

/// Non-blocking status read. Never spawns a resolver — the badge
/// would otherwise warm the cache on every render.
///
/// `enabled = "always"` semantics: any project that *can't* surface
/// a devshell becomes a hard error (returned via `StatusSnapshot::
/// Failed`), so the user sees a loud signal on the badge instead of
/// the silent no-op the original `"auto"` policy would produce. The
/// caller (PTY intercept, agent provisioning) treats the same
/// condition as a hard prepare failure, so `"always"` means "do not
/// silently open outside the devshell".
#[tauri::command]
pub async fn devshell_status<R: Runtime>(
    app: AppHandle<R>,
    cache: State<'_, Arc<DevshellCache>>,
    args: StatusArgs,
) -> Result<StatusResponse, String> {
    let root = PathBuf::from(&args.root);
    let (enabled, configured_mode) = crate::devshell::effective_config(&app, &root).into_parts();
    let detected_kind = if enabled == "never" {
        None
    } else {
        crate::devshell::detect_mode(&root, configured_mode).map(|k| k.as_str().to_string())
    };
    let mismatch = if enabled == "never" {
        None
    } else {
        forced_mode_mismatch_reason(&root, configured_mode)
    };
    let snapshot = match enabled.as_str() {
        "never" => StatusSnapshot::None,
        _ if mismatch.is_some() => StatusSnapshot::Failed {
            kind: mode_str(configured_mode).to_string(),
            reason: mismatch.unwrap(),
            failed_at_ms: 0,
        },
        "always" if detected_kind.is_none() => StatusSnapshot::Failed {
            kind: mode_str(configured_mode).to_string(),
            reason: format!(
                "no devshell detected at {} and [devshell] enabled = \"always\"",
                root.display()
            ),
            failed_at_ms: 0,
        },
        _ => cache.status(&root).await,
    };
    Ok(StatusResponse {
        enabled,
        mode: mode_str(configured_mode).to_string(),
        snapshot,
        detected_kind,
    })
}

fn devshell_prepare_is_required(enabled: &str) -> bool {
    prepare_is_required(enabled)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvForPathArgs {
    /// The cwd the spawned process will run in. The intercept uses
    /// this to look up which project's devshell to apply — different
    /// tabs in different projects must see different envs.
    pub cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvForPathResponse {
    pub enabled: String,
    pub kind: Option<String>,
    pub stale: bool,
    pub env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareForPathArgs {
    /// The project/worktree cwd that is about to be provisioned.
    pub cwd: String,
    /// Agent-side callers set this so the prepared env can seed their
    /// synchronous spawn-hook cache. Frontend tab-open callers leave it false.
    pub include_env: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareForPathResponse {
    pub enabled: String,
    pub mode: String,
    pub state: String,
    pub kind: Option<String>,
    pub stale: bool,
    pub duration_ms: Option<u64>,
    pub var_count: usize,
    pub direnv_allowed: bool,
    pub reason: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
}

/// Blocking prepare for explicit project/worktree roots. This is intentionally
/// separate from `devshell_env_for_path`: agent/session provisioning should
/// wait for the env so the first tool call is correct, while PTY opens still
/// use the non-blocking path.
#[tauri::command]
pub async fn devshell_prepare_for_path<R: Runtime>(
    app: AppHandle<R>,
    cache: State<'_, Arc<DevshellCache>>,
    args: PrepareForPathArgs,
) -> Result<PrepareForPathResponse, String> {
    let cwd = PathBuf::from(&args.cwd);
    let include_env = args.include_env.unwrap_or(false);
    let (enabled, configured_mode) = crate::devshell::effective_config(&app, &cwd).into_parts();
    let emitter = crate::devshell::prepare_policy::emitter_for(&app);
    let decision = crate::devshell::prepare_env_for_root(&app, &cache, &cwd, Some(&emitter)).await;

    let empty_env = || include_env.then(BTreeMap::new);
    match decision {
        crate::devshell::PrepareDecision::Disabled => Ok(PrepareForPathResponse {
            enabled,
            mode: mode_str(configured_mode).to_string(),
            state: "disabled".to_string(),
            kind: None,
            stale: false,
            duration_ms: None,
            var_count: 0,
            direnv_allowed: false,
            reason: None,
            env: empty_env(),
        }),
        crate::devshell::PrepareDecision::MissingOptional { reason } => {
            Ok(PrepareForPathResponse {
                enabled,
                mode: mode_str(configured_mode).to_string(),
                state: "none".to_string(),
                kind: None,
                stale: false,
                duration_ms: None,
                var_count: 0,
                direnv_allowed: false,
                reason: Some(reason),
                env: empty_env(),
            })
        }
        crate::devshell::PrepareDecision::Prepared { kind, prepared } => {
            let var_count = prepared.env.len();
            Ok(PrepareForPathResponse {
                enabled,
                mode: mode_str(configured_mode).to_string(),
                state: "ready".to_string(),
                kind: prepared.kind,
                stale: prepared.stale,
                duration_ms: prepared.duration_ms,
                var_count,
                direnv_allowed: kind == crate::devshell::detect::DevshellKind::Direnv,
                reason: None,
                env: include_env.then_some(prepared.env),
            })
        }
        crate::devshell::PrepareDecision::DirenvAllowFailedOptional { kind, reason }
        | crate::devshell::PrepareDecision::CachePrepareFailedOptional { kind, reason } => {
            Ok(PrepareForPathResponse {
                enabled,
                mode: mode_str(configured_mode).to_string(),
                state: "failed".to_string(),
                kind: Some(kind.as_str().to_string()),
                stale: false,
                duration_ms: None,
                var_count: 0,
                direnv_allowed: false,
                reason: Some(reason),
                env: empty_env(),
            })
        }
        crate::devshell::PrepareDecision::MissingRequired { reason } => {
            Err(required_devshell_missing_error(&enabled, reason)
                .unwrap_or_else(|| format!("no devshell detected at {}", cwd.display())))
        }
        crate::devshell::PrepareDecision::ForcedModeMismatch { reason } => {
            if devshell_prepare_is_required(&enabled) {
                Err(required_devshell_missing_error(&enabled, reason)
                    .unwrap_or_else(|| "required devshell mode mismatch".to_string()))
            } else {
                Ok(PrepareForPathResponse {
                    enabled,
                    mode: mode_str(configured_mode).to_string(),
                    state: "failed".to_string(),
                    kind: None,
                    stale: false,
                    duration_ms: None,
                    var_count: 0,
                    direnv_allowed: false,
                    reason: Some(reason),
                    env: empty_env(),
                })
            }
        }
        crate::devshell::PrepareDecision::DirenvAllowFailedRequired { reason }
        | crate::devshell::PrepareDecision::CachePrepareFailedRequired { reason } => Err(reason),
    }
}

/// Non-blocking env lookup. Returns immediately even if a resolver is
/// in-flight; the agent spawnHook + PTY intercept both use this and
/// must never block the user's tool call on Nix evaluation.
#[tauri::command]
pub async fn devshell_env_for_path<R: Runtime>(
    app: AppHandle<R>,
    cache: State<'_, Arc<DevshellCache>>,
    args: EnvForPathArgs,
) -> Result<EnvForPathResponse, String> {
    let cwd = PathBuf::from(&args.cwd);
    let (enabled, configured_mode) = crate::devshell::effective_config(&app, &cwd).into_parts();
    if enabled == "never" {
        return Ok(EnvForPathResponse {
            enabled,
            kind: None,
            stale: false,
            env: BTreeMap::new(),
        });
    }
    let emitter = emitter_for(&app);
    let EnvForPath { kind, stale, env } =
        cache.env_for(Some(&emitter), &cwd, configured_mode).await;
    Ok(EnvForPathResponse {
        enabled,
        kind,
        stale,
        env,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshArgs {
    pub root: String,
}

/// Invalidate the cache for `root` and kick off a fresh resolve.
/// Honours `enabled = "never"` by no-op'ing — Settings can still call
/// this safely even when the feature is off.
///
/// Under `enabled = "always"`, a missing devshell is escalated to a
/// hard error so the user sees a loud failure instead of a silent
/// "nothing to refresh" no-op.
#[tauri::command]
pub async fn devshell_refresh<R: Runtime>(
    app: AppHandle<R>,
    cache: State<'_, Arc<DevshellCache>>,
    args: RefreshArgs,
) -> Result<(), String> {
    let root = PathBuf::from(&args.root);
    let (enabled, configured_mode) = crate::devshell::effective_config(&app, &root).into_parts();
    if enabled == "never" {
        return Ok(());
    }
    if let Some(reason) = forced_mode_mismatch_reason(&root, configured_mode) {
        return Err(reason);
    }
    let emitter = emitter_for(&app);
    match cache.refresh(Some(&emitter), &root, configured_mode).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // "auto" silently no-ops when there's no devshell to
            // refresh (a project without a flake is fine to refresh);
            // "always" treats the same condition as a hard error.
            if devshell_prepare_is_required(&enabled) {
                Err(e)
            } else {
                Ok(())
            }
        }
    }
}

/// Boot-time helper: configure the cache's on-disk root and GC stale
/// snapshots once. Called from `lib::run()` `setup()` so the cache is
/// usable from the first IPC call.
pub async fn boot_init_cache<R: Runtime>(app: &AppHandle<R>, cache: &DevshellCache) {
    let Ok(home) = app.path().home_dir() else {
        return;
    };
    let Some(aethon_dir) = crate::helpers::aethon_dir(Some(home)) else {
        return;
    };
    let disk_root = aethon_dir.join("devshell-cache");
    cache.configure_disk_root(disk_root.clone()).await;
    // GC stale snapshots. Best-effort — failures are logged, not fatal.
    if let Err(e) = crate::devshell::evict_stale_snapshots(
        &disk_root,
        std::time::Duration::from_secs(60 * 60 * 24 * 30),
    ) {
        tracing::warn!(
            target: "aethon::devshell",
            "evict_stale_snapshots({}): {}",
            disk_root.display(),
            e
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{devshell_prepare_is_required, required_devshell_missing_error};

    #[test]
    fn only_always_requires_devshell_preparation() {
        assert!(devshell_prepare_is_required("always"));
        assert!(!devshell_prepare_is_required("auto"));
        assert!(!devshell_prepare_is_required("never"));
    }

    #[test]
    fn required_devshell_missing_error_preserves_the_detected_reason() {
        assert_eq!(
            required_devshell_missing_error("always", "configured mode mismatch".to_string())
                .as_deref(),
            Some("configured mode mismatch and [devshell] enabled = \"always\""),
        );
        assert!(required_devshell_missing_error("auto", "missing".to_string()).is_none());
    }
}
