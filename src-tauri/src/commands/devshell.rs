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
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::devshell::{
    AppEmitter, DetectMode, DevshellCache, DevshellEmitter, EnvForPath, StatusSnapshot,
};
use crate::helpers::config::{
    normalize_devshell_enabled, normalize_devshell_mode, parse_config_toml,
    parse_project_devshell_override,
};

/// Adapter so the devshell cache can emit Tauri events without taking
/// a direct dependency on `tauri::AppHandle`. The cache calls
/// [`DevshellEmitter::emit`]; we forward to the real Tauri emitter
/// here.
pub struct TauriEmitter<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriEmitter<R> {
    pub fn new(app: AppHandle<R>) -> Self {
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

fn emitter_for<R: Runtime>(app: &AppHandle<R>) -> AppEmitter {
    AppEmitter::new(Arc::new(TauriEmitter::new(app.clone())) as Arc<dyn DevshellEmitter>)
}

/// Resolve `[devshell]` config — global toml merged with the
/// optional `<root>/.aethon/devshell.toml` override. Returns the
/// effective `(enabled, mode)` strings already normalised.
fn effective_config<R: Runtime>(app: &AppHandle<R>, root: &Path) -> (String, DetectMode) {
    use std::io::Read;

    // 1) Global config. Replicate aethon_state_path's home-dir
    // resolution inline because the helper is bound to the default
    // Tauri runtime and we want this command surface to be
    // generic-runtime so tests can swap in a mock.
    let home = match app.path().home_dir() {
        Ok(h) => h,
        Err(_) => return ("auto".into(), DetectMode::Auto),
    };
    let global_path = match crate::helpers::aethon_dir(Some(home)) {
        Some(dir) => dir.join("config.toml"),
        None => return ("auto".into(), DetectMode::Auto),
    };
    let mut buf = String::new();
    if let Ok(file) = std::fs::File::open(&global_path) {
        let _ = file.take(64 * 1024).read_to_string(&mut buf);
    }
    let global = parse_config_toml(&buf);
    let mut enabled = global["devshell"]["enabled"]
        .as_str()
        .unwrap_or("auto")
        .to_string();
    let mut mode_str = global["devshell"]["mode"]
        .as_str()
        .unwrap_or("auto")
        .to_string();

    // 2) Per-project override (best-effort — malformed files are ignored).
    let override_path = root.join(".aethon").join("devshell.toml");
    if let Ok(mut text) = std::fs::read_to_string(&override_path) {
        // Cap the read size for symmetry with the global config.
        if text.len() > 64 * 1024 {
            text.truncate(64 * 1024);
        }
        let parsed = parse_project_devshell_override(&text);
        if let Some(e) = parsed.devshell.enabled {
            enabled = normalize_devshell_enabled(Some(&e)).to_string();
        }
        if let Some(m) = parsed.devshell.mode {
            mode_str = normalize_devshell_mode(Some(&m)).to_string();
        }
    }
    (enabled, DetectMode::from_str(&mode_str))
}

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
/// caller (PTY intercept, agent spawnHook) still falls through to
/// the host env so shells continue to work — `"always"` only changes
/// what the UI shows, not whether the shell opens.
#[tauri::command]
pub async fn devshell_status<R: Runtime>(
    app: AppHandle<R>,
    cache: State<'_, Arc<DevshellCache>>,
    args: StatusArgs,
) -> Result<StatusResponse, String> {
    let root = PathBuf::from(&args.root);
    let (enabled, mode) = effective_config(&app, &root);
    let detected_kind = if enabled == "never" {
        None
    } else {
        crate::devshell::detect_mode(&root, mode).map(|k| k.as_str().to_string())
    };
    let snapshot = match enabled.as_str() {
        "never" => StatusSnapshot::None,
        "always" if detected_kind.is_none() => StatusSnapshot::Failed {
            kind: mode_str(mode).to_string(),
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
        mode: mode_str(mode).to_string(),
        snapshot,
        detected_kind,
    })
}

fn mode_str(mode: DetectMode) -> &'static str {
    match mode {
        DetectMode::Auto => "auto",
        DetectMode::Direnv => "direnv",
        DetectMode::Nix => "nix",
        DetectMode::NixShell => "nix-shell",
    }
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

/// Non-blocking env lookup. Returns immediately even if a resolver is
/// in-flight; the agent spawnHook + PTY intercept both use this and
/// must never block the user's tool call on `nix print-dev-env`.
#[tauri::command]
pub async fn devshell_env_for_path<R: Runtime>(
    app: AppHandle<R>,
    cache: State<'_, Arc<DevshellCache>>,
    args: EnvForPathArgs,
) -> Result<EnvForPathResponse, String> {
    let cwd = PathBuf::from(&args.cwd);
    let (enabled, mode) = effective_config(&app, &cwd);
    if enabled == "never" {
        return Ok(EnvForPathResponse {
            enabled,
            kind: None,
            stale: false,
            env: BTreeMap::new(),
        });
    }
    let emitter = emitter_for(&app);
    let EnvForPath { kind, stale, env } = cache.env_for(Some(&emitter), &cwd, mode).await;
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
    let (enabled, mode) = effective_config(&app, &root);
    if enabled == "never" {
        return Ok(());
    }
    let emitter = emitter_for(&app);
    match cache.refresh(Some(&emitter), &root, mode).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // "auto" silently no-ops when there's no devshell to
            // refresh (a project without a flake is fine to refresh);
            // "always" treats the same condition as a hard error.
            if enabled == "always" { Err(e) } else { Ok(()) }
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
