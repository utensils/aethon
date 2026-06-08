//! Devshell env cache + resolver state machine.
//!
//! Two tiers:
//!
//! - **In-memory `slots` map** keyed by canonical project root path,
//!   tracking the live resolver state (`Idle | Resolving | Ready |
//!   Failed`). PTY-spawn intercepts and the agent spawnHook IPC both
//!   read this — both want a non-blocking answer.
//! - **On-disk JSON snapshot** under
//!   `~/.aethon/devshell-cache/<short-hash>/{env,meta}.json`, keyed
//!   on a hash of the project's lock / marker files. Lets a cold
//!   launch skip the evaluator entirely when the lockfile hasn't
//!   changed since the last successful resolve.
//!
//! The resolver task is launched once per (root, fingerprint) — the
//! second-pass write lock checks whether a matching `Resolving` /
//! `Ready` already exists so concurrent shell opens collapse onto the
//! same in-flight `nix print-dev-env` evaluation instead of fanning
//! out into N parallel resolves.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tokio::sync::{Notify, RwLock};
use tokio::time::timeout;

use super::detect::{DetectMode, DevshellKind, RealProbe, detect_with};
use super::resolve::{ResolveProgress, ResolveProgressSender, ResolvedEnv, resolve};

/// How long we wait before retrying a `Failed` resolve. Without this
/// floor, a hard error (missing `nix` binary, broken flake) would be
/// re-attempted on every shell open and storm the user with errors.
const FAILED_RETRY_AFTER: Duration = Duration::from_secs(30);
const PREPARE_WAIT_TIMEOUT: Duration = Duration::from_secs(125);

/// State of a single resolver slot.
#[derive(Debug, Clone)]
pub enum ResolverState {
    /// Resolver has never been started or was just invalidated.
    Idle,
    /// A resolver task is in-flight; subscribers can wait on `notify`.
    Resolving {
        started_at: SystemTime,
        kind: DevshellKind,
        fingerprint: String,
    },
    /// Last resolve succeeded; env is hot.
    Ready {
        kind: DevshellKind,
        env: BTreeMap<String, String>,
        resolved_at: SystemTime,
        duration_ms: u64,
        fingerprint: String,
    },
    /// Last resolve failed. Retry permitted after FAILED_RETRY_AFTER.
    Failed {
        kind: DevshellKind,
        reason: String,
        failed_at: SystemTime,
        fingerprint: String,
    },
}

/// Snapshot for the IPC `devshell_status` command — flattened for
/// serde and stripped of the in-memory `env` payload so the badge
/// doesn't pay to serialize hundreds of KB on every render.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StatusSnapshot {
    /// No resolver slot exists for this root yet — caller hasn't
    /// asked for an env, or the project doesn't have a devshell.
    None,
    Idle {
        kind: String,
    },
    Resolving {
        kind: String,
        started_at_ms: u64,
    },
    Ready {
        kind: String,
        resolved_at_ms: u64,
        duration_ms: u64,
        var_count: usize,
    },
    Failed {
        kind: String,
        reason: String,
        failed_at_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvForPath {
    /// `Some` when a devshell *kind* was detected — even if the env
    /// isn't ready yet (`env` may be empty).
    pub kind: Option<String>,
    /// `true` when we returned the cached env but a fresh resolve is
    /// also in-flight (caller may surface a "may be stale" hint).
    pub stale: bool,
    /// Empty when state is anything other than `Ready`.
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedEnv {
    pub kind: Option<String>,
    pub stale: bool,
    pub env: BTreeMap<String, String>,
    pub duration_ms: Option<u64>,
}

struct Slot {
    state: ResolverState,
    /// Shared with any waiter that called `wait_for_ready`. Notified
    /// every time the slot transitions to `Ready` or `Failed`.
    notify: Arc<Notify>,
}

/// Process-wide cache. The slots map is held in its own Arc so the
/// spawned resolver task can write back to the same map the calling
/// thread reads from, without unsafe and without forcing every
/// caller to plumb an Arc through.
///
/// Cache keys are always canonicalized at the boundary
/// ([`canonicalize_key`]) so symlinked / `..`-laden / casing-variant
/// paths to the same project map to one slot instead of duplicating
/// resolves.
pub struct DevshellCache {
    slots: Arc<RwLock<BTreeMap<PathBuf, Slot>>>,
    /// `~/.aethon/devshell-cache/` (set once at boot). None in unit
    /// tests so the resolver doesn't try to touch the real home dir.
    disk_root: Arc<RwLock<Option<PathBuf>>>,
}

/// Canonicalize a project root path so callers using different but
/// equivalent paths (symlinks, trailing `/`, `..`, case-variant on
/// case-insensitive FS) all hit the same cache slot. Falls back to
/// the original path when canonicalization fails (caller may have
/// passed a path that doesn't yet exist — fingerprinting will still
/// produce a stable key based on whatever marker files do exist).
fn canonicalize_key(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

impl DevshellCache {
    /// Construct an Arc-shared cache. The Tauri builder stores this
    /// as managed state; all command handlers clone the Arc.
    pub fn shared() -> Arc<Self> {
        Arc::new(DevshellCache {
            slots: Arc::new(RwLock::new(BTreeMap::new())),
            disk_root: Arc::new(RwLock::new(None)),
        })
    }

    /// Point the cache at a `~/.aethon/devshell-cache/` directory.
    /// The directory is created lazily on first snapshot write.
    pub async fn configure_disk_root(&self, root: PathBuf) {
        let mut guard = self.disk_root.write().await;
        *guard = Some(root);
    }

    /// Non-blocking status read. Used by the badge and by the
    /// `devshell_status` IPC. Never spawns a resolver — the badge
    /// would otherwise warm the cache implicitly on every render.
    pub async fn status(&self, root: &Path) -> StatusSnapshot {
        let root = canonicalize_key(root);
        let guard = self.slots.read().await;
        match guard.get(&root).map(|s| &s.state) {
            None => StatusSnapshot::None,
            Some(ResolverState::Idle) => StatusSnapshot::Idle {
                kind: "auto".into(),
            },
            Some(ResolverState::Resolving {
                kind, started_at, ..
            }) => StatusSnapshot::Resolving {
                kind: kind.as_str().into(),
                started_at_ms: to_unix_ms(*started_at),
            },
            Some(ResolverState::Ready {
                kind,
                env,
                resolved_at,
                duration_ms,
                ..
            }) => StatusSnapshot::Ready {
                kind: kind.as_str().into(),
                resolved_at_ms: to_unix_ms(*resolved_at),
                duration_ms: *duration_ms,
                var_count: env.len(),
            },
            Some(ResolverState::Failed {
                kind,
                reason,
                failed_at,
                ..
            }) => StatusSnapshot::Failed {
                kind: kind.as_str().into(),
                reason: reason.clone(),
                failed_at_ms: to_unix_ms(*failed_at),
            },
        }
    }

    /// Non-blocking env lookup. Kicks off a background resolver when
    /// needed but always returns immediately. The PTY spawn path uses
    /// this — a shell open that takes 30 s waiting on nix would be
    /// catastrophic.
    pub async fn env_for(
        &self,
        emitter: Option<&AppEmitter>,
        root: &Path,
        mode: DetectMode,
    ) -> EnvForPath {
        let root = canonicalize_key(root);
        let Some(kind) = detect_with(&root, mode, &RealProbe) else {
            return EnvForPath {
                kind: None,
                stale: false,
                env: BTreeMap::new(),
            };
        };
        let fingerprint = fingerprint_inputs(&root);

        // Cold-start disk pre-warm: no in-memory slot for this root
        // AND a snapshot on disk matches the current fingerprint?
        // Hydrate the slot before deciding whether to spawn a
        // resolver. Saves a full `nix print-dev-env` re-eval on app
        // boot when nothing has changed since the previous session.
        {
            let already_warm = self.slots.read().await.contains_key(&root);
            if !already_warm {
                let disk_root = self.disk_root.read().await.clone();
                if let Some(disk) = disk_root
                    && let Some(snap) = load_disk_snapshot(&disk, &fingerprint)
                {
                    let mut guard = self.slots.write().await;
                    guard.entry(root.clone()).or_insert_with(|| Slot {
                        state: ResolverState::Ready {
                            kind,
                            env: snap.env,
                            resolved_at: SystemTime::now(),
                            duration_ms: snap.duration_ms,
                            fingerprint: fingerprint.clone(),
                        },
                        notify: Arc::new(Notify::new()),
                    });
                }
            }
        }

        // Fast path: already Ready with matching fingerprint.
        {
            let guard = self.slots.read().await;
            if let Some(slot) = guard.get(&root)
                && let ResolverState::Ready {
                    env,
                    fingerprint: fp,
                    ..
                } = &slot.state
                && *fp == fingerprint
            {
                return EnvForPath {
                    kind: Some(kind.as_str().into()),
                    stale: false,
                    env: env.clone(),
                };
            }
        }

        // Slow path: ensure a resolver task exists.
        self.kick_resolve(emitter, root.clone(), kind, fingerprint, false)
            .await;
        // Return what we have right now — even if Ready with a stale
        // fingerprint, hand back the previous env flagged stale, so
        // the shell has *something* to run with while the new resolve
        // is in flight.
        let guard = self.slots.read().await;
        match guard.get(&root).map(|s| &s.state) {
            Some(ResolverState::Ready { env, .. }) => EnvForPath {
                kind: Some(kind.as_str().into()),
                stale: true,
                env: env.clone(),
            },
            _ => EnvForPath {
                kind: Some(kind.as_str().into()),
                stale: false,
                env: BTreeMap::new(),
            },
        }
    }

    /// Blocking preparation for project/worktree provisioning. Unlike
    /// [`env_for`], this waits until the resolver is either `Ready` or
    /// `Failed` so the first agent/tool run does not race a cold Nix/direnv
    /// evaluation.
    pub async fn prepare_for(
        &self,
        emitter: Option<&AppEmitter>,
        root: &Path,
        mode: DetectMode,
    ) -> Result<PreparedEnv, String> {
        let root = canonicalize_key(root);
        let Some(kind) = detect_with(&root, mode, &RealProbe) else {
            return Ok(PreparedEnv {
                kind: None,
                stale: false,
                env: BTreeMap::new(),
                duration_ms: None,
            });
        };
        let fingerprint = fingerprint_inputs(&root);
        self.hydrate_from_disk_if_available(&root, kind, &fingerprint)
            .await;

        if let Some(ready) = self
            .ready_env_for_fingerprint(&root, kind, &fingerprint)
            .await
        {
            return Ok(ready);
        }

        self.kick_resolve(emitter, root.clone(), kind, fingerprint.clone(), false)
            .await;

        let wait = async {
            loop {
                let notify = {
                    let guard = self.slots.read().await;
                    match guard.get(&root) {
                        Some(slot) => match &slot.state {
                            ResolverState::Ready {
                                env,
                                duration_ms,
                                fingerprint: fp,
                                ..
                            } if *fp == fingerprint => {
                                return Ok(PreparedEnv {
                                    kind: Some(kind.as_str().into()),
                                    stale: false,
                                    env: env.clone(),
                                    duration_ms: Some(*duration_ms),
                                });
                            }
                            ResolverState::Failed {
                                reason,
                                fingerprint: fp,
                                ..
                            } if *fp == fingerprint => {
                                return Err(reason.clone());
                            }
                            _ => Arc::clone(&slot.notify),
                        },
                        None => {
                            return Err(format!(
                                "devshell resolver slot disappeared for {}",
                                root.display()
                            ));
                        }
                    }
                };
                let notified = notify.notified();
                if let Some(ready) = self
                    .ready_env_for_fingerprint(&root, kind, &fingerprint)
                    .await
                {
                    return Ok(ready);
                }
                {
                    let guard = self.slots.read().await;
                    if let Some(slot) = guard.get(&root)
                        && let ResolverState::Failed {
                            reason,
                            fingerprint: fp,
                            ..
                        } = &slot.state
                        && *fp == fingerprint
                    {
                        return Err(reason.clone());
                    }
                }
                notified.await;
            }
        };

        match timeout(PREPARE_WAIT_TIMEOUT, wait).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "timed out waiting for devshell at {} after {}s",
                root.display(),
                PREPARE_WAIT_TIMEOUT.as_secs()
            )),
        }
    }

    /// Invalidate the cached state for `root` and kick off a fresh
    /// resolve. Frontend "Refresh now" button reaches here.
    pub async fn refresh(
        &self,
        emitter: Option<&AppEmitter>,
        root: &Path,
        mode: DetectMode,
    ) -> Result<(), String> {
        let root = canonicalize_key(root);
        let Some(kind) = detect_with(&root, mode, &RealProbe) else {
            return Err(format!("no devshell detected at {}", root.display()));
        };
        let fingerprint = fingerprint_inputs(&root);
        self.kick_resolve(emitter, root, kind, fingerprint, true)
            .await;
        Ok(())
    }

    async fn hydrate_from_disk_if_available(
        &self,
        root: &Path,
        kind: DevshellKind,
        fingerprint: &str,
    ) {
        let already_warm = self.slots.read().await.contains_key(root);
        if already_warm {
            return;
        }
        let disk_root = self.disk_root.read().await.clone();
        let Some(disk) = disk_root else {
            return;
        };
        let Some(snap) = load_disk_snapshot(&disk, fingerprint) else {
            return;
        };
        let mut guard = self.slots.write().await;
        guard.entry(root.to_path_buf()).or_insert_with(|| Slot {
            state: ResolverState::Ready {
                kind,
                env: snap.env,
                resolved_at: SystemTime::now(),
                duration_ms: snap.duration_ms,
                fingerprint: fingerprint.to_string(),
            },
            notify: Arc::new(Notify::new()),
        });
    }

    async fn ready_env_for_fingerprint(
        &self,
        root: &Path,
        kind: DevshellKind,
        fingerprint: &str,
    ) -> Option<PreparedEnv> {
        let guard = self.slots.read().await;
        let Some(slot) = guard.get(root) else {
            return None;
        };
        let ResolverState::Ready {
            env,
            duration_ms,
            fingerprint: fp,
            ..
        } = &slot.state
        else {
            return None;
        };
        if fp != fingerprint {
            return None;
        }
        Some(PreparedEnv {
            kind: Some(kind.as_str().into()),
            stale: false,
            env: env.clone(),
            duration_ms: Some(*duration_ms),
        })
    }

    /// Immediate, non-blocking read of a hot env. Used by synchronous
    /// process-spawn paths after the frontend already performed the
    /// blocking prepare step.
    pub fn ready_env_now(&self, root: &Path, mode: DetectMode) -> Option<PreparedEnv> {
        let root = canonicalize_key(root);
        let kind = detect_with(&root, mode, &RealProbe)?;
        let fingerprint = fingerprint_inputs(&root);
        let guard = self.slots.try_read().ok()?;
        let slot = guard.get(&root)?;
        let ResolverState::Ready {
            env,
            duration_ms,
            fingerprint: fp,
            ..
        } = &slot.state
        else {
            return None;
        };
        if *fp != fingerprint {
            return None;
        }
        Some(PreparedEnv {
            kind: Some(kind.as_str().into()),
            stale: false,
            env: env.clone(),
            duration_ms: Some(*duration_ms),
        })
    }

    async fn kick_resolve(
        &self,
        emitter: Option<&AppEmitter>,
        root: PathBuf,
        kind: DevshellKind,
        fingerprint: String,
        force: bool,
    ) {
        let now = SystemTime::now();
        // First pass: decide under read lock whether we need to spawn.
        {
            let guard = self.slots.read().await;
            if let Some(slot) = guard.get(&root) {
                match &slot.state {
                    ResolverState::Resolving {
                        fingerprint: fp, ..
                    } if *fp == fingerprint && !force => {
                        return; // already in-flight for this fingerprint
                    }
                    ResolverState::Ready {
                        fingerprint: fp, ..
                    } if *fp == fingerprint && !force => {
                        return; // already warm
                    }
                    ResolverState::Failed {
                        failed_at,
                        fingerprint: fp,
                        ..
                    } if *fp == fingerprint
                        && !force
                        && now.duration_since(*failed_at).unwrap_or_default()
                            < FAILED_RETRY_AFTER =>
                    {
                        return; // honour backoff
                    }
                    _ => {}
                }
            }
        }

        // Second pass: take write lock, install Resolving, spawn task.
        let _notify = {
            let mut guard = self.slots.write().await;
            let slot = guard.entry(root.clone()).or_insert_with(|| Slot {
                state: ResolverState::Idle,
                notify: Arc::new(Notify::new()),
            });
            slot.state = ResolverState::Resolving {
                started_at: now,
                kind,
                fingerprint: fingerprint.clone(),
            };
            Arc::clone(&slot.notify)
        };

        if let Some(h) = emitter {
            h.emit(
                "devshell-resolving",
                serde_json::json!({
                    "root": root.display().to_string(),
                    "kind": kind.as_str(),
                }),
            );
        }

        let disk_root = self.disk_root.read().await.clone();
        let slots = Arc::clone(&self.slots);
        let emitter_clone = emitter.cloned();
        let fingerprint_owned = fingerprint.clone();
        tokio::spawn(async move {
            let progress = progress_sender(emitter_clone.clone(), root.display().to_string(), kind);
            let outcome = resolve(&root, kind, progress).await;
            let now = SystemTime::now();
            let new_state = match outcome {
                Ok(resolved) => {
                    if let Some(disk) = disk_root.as_ref()
                        && let Err(e) =
                            write_disk_snapshot(disk, &root, kind, &fingerprint_owned, &resolved)
                    {
                        tracing::warn!(
                            target: "aethon::devshell",
                            "snapshot write for {}: {}",
                            root.display(),
                            e
                        );
                    }
                    ResolverState::Ready {
                        kind,
                        env: resolved.env,
                        resolved_at: now,
                        duration_ms: resolved.duration_ms,
                        fingerprint: fingerprint_owned.clone(),
                    }
                }
                Err(reason) => ResolverState::Failed {
                    kind,
                    reason,
                    failed_at: now,
                    fingerprint: fingerprint_owned.clone(),
                },
            };
            let notify_for_waiters;
            {
                let mut guard = slots.write().await;
                let slot = guard.entry(root.clone()).or_insert_with(|| Slot {
                    state: ResolverState::Idle,
                    notify: Arc::new(Notify::new()),
                });
                slot.state = new_state.clone();
                notify_for_waiters = Arc::clone(&slot.notify);
            }
            notify_for_waiters.notify_waiters();

            if let Some(h) = emitter_clone.as_ref() {
                match &new_state {
                    ResolverState::Ready {
                        kind,
                        resolved_at,
                        duration_ms,
                        env,
                        ..
                    } => h.emit(
                        "devshell-ready",
                        serde_json::json!({
                            "root": root.display().to_string(),
                            "kind": kind.as_str(),
                            "resolvedAtMs": to_unix_ms(*resolved_at),
                            "durationMs": duration_ms,
                            "varCount": env.len(),
                        }),
                    ),
                    ResolverState::Failed {
                        kind,
                        reason,
                        failed_at,
                        ..
                    } => h.emit(
                        "devshell-failed",
                        serde_json::json!({
                            "root": root.display().to_string(),
                            "kind": kind.as_str(),
                            "reason": reason,
                            "failedAtMs": to_unix_ms(*failed_at),
                        }),
                    ),
                    _ => {}
                }
            }
        });
    }
}

fn progress_sender(
    emitter: Option<AppEmitter>,
    root: String,
    kind: DevshellKind,
) -> Option<ResolveProgressSender> {
    emitter.map(|emitter| {
        Arc::new(move |progress: ResolveProgress| {
            emitter.emit(
                "devshell-output",
                serde_json::json!({
                    "root": root.as_str(),
                    "kind": kind.as_str(),
                    "stream": progress.stream,
                    "content": progress.content,
                }),
            );
        }) as ResolveProgressSender
    })
}

/// Lightweight emitter trait so the cache doesn't have to depend on
/// `tauri::AppHandle` — unit tests pass `None`, the real handler in
/// `commands/devshell.rs` wraps Tauri's `Emitter::emit`.
pub trait DevshellEmitter: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

#[derive(Clone)]
pub struct AppEmitter(pub Arc<dyn DevshellEmitter>);

impl AppEmitter {
    pub fn new(e: Arc<dyn DevshellEmitter>) -> Self {
        AppEmitter(e)
    }
    pub fn emit(&self, event: &str, payload: serde_json::Value) {
        self.0.emit(event, payload);
    }
}

/// Fingerprint that gates "is the cached env still valid?". Combines
/// the lockfile contents (when present) with (mtime, size) for each
/// marker file. The lock dominates the cost so we only read its
/// bytes once.
pub fn fingerprint_inputs(root: &Path) -> String {
    let mut hasher = Sha1::new();
    if let Ok(bytes) = std::fs::read(root.join("flake.lock")) {
        hasher.update(b"lock:");
        hasher.update(&bytes);
    }
    for name in [".envrc", "flake.nix", "shell.nix"] {
        if let Ok(meta) = std::fs::metadata(root.join(name)) {
            hasher.update(name.as_bytes());
            hasher.update(b":");
            hasher.update(meta.len().to_le_bytes());
            if let Ok(mtime) = meta.modified()
                && let Ok(d) = mtime.duration_since(UNIX_EPOCH)
            {
                hasher.update(d.as_nanos().to_le_bytes());
            }
        }
    }
    let bytes = hasher.finalize();
    let mut out = String::with_capacity(40);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn to_unix_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize)]
struct DiskSnapshot {
    schema_version: u32,
    fingerprint: String,
    kind: String,
    resolved_at_ms: u64,
    duration_ms: u64,
    env: BTreeMap<String, String>,
}

fn write_disk_snapshot(
    disk_root: &Path,
    project_root: &Path,
    kind: DevshellKind,
    fingerprint: &str,
    resolved: &ResolvedEnv,
) -> std::io::Result<()> {
    let dir = disk_root.join(&fingerprint[..fingerprint.len().min(16)]);
    std::fs::create_dir_all(&dir)?;
    let snap = DiskSnapshot {
        schema_version: 1,
        fingerprint: fingerprint.into(),
        kind: kind.as_str().into(),
        resolved_at_ms: to_unix_ms(SystemTime::now()),
        duration_ms: resolved.duration_ms,
        env: resolved.env.clone(),
    };
    let body = serde_json::to_vec_pretty(&snap).map_err(std::io::Error::other)?;
    let env_path = dir.join("env.json");
    let tmp = env_path.with_extension("json.tmp");
    std::fs::write(&tmp, &body)?;
    std::fs::rename(&tmp, &env_path)?;
    let meta_path = dir.join("meta.json");
    let meta_body = serde_json::to_vec_pretty(&serde_json::json!({
        "root": project_root.display().to_string(),
        "kind": kind.as_str(),
        "fingerprint": fingerprint,
    }))
    .map_err(std::io::Error::other)?;
    std::fs::write(meta_path, meta_body)?;
    Ok(())
}

/// Load any previously-written disk snapshot whose fingerprint matches
/// the current marker files. Used as a cold-start pre-warm: the first
/// `env_for` call for a project after app boot pulls the previous
/// session's resolver output from disk (if its fingerprint still
/// matches the current `flake.lock` + marker mtimes), skipping the
/// full `nix print-dev-env` re-eval. Fingerprint mismatch falls
/// through to a fresh resolve.
pub fn load_disk_snapshot(disk_root: &Path, fingerprint: &str) -> Option<ResolvedEnv> {
    let dir = disk_root.join(&fingerprint[..fingerprint.len().min(16)]);
    let env_path = dir.join("env.json");
    let body = std::fs::read(env_path).ok()?;
    let snap: DiskSnapshot = serde_json::from_slice(&body).ok()?;
    if snap.fingerprint != fingerprint {
        return None;
    }
    Some(ResolvedEnv {
        env: snap.env,
        duration_ms: snap.duration_ms,
    })
}

/// Garbage-collect snapshot directories older than `max_age`. Called
/// once at boot to keep `~/.aethon/devshell-cache/` from growing
/// without bound.
pub fn evict_stale_snapshots(disk_root: &Path, max_age: Duration) -> std::io::Result<usize> {
    let mut removed = 0usize;
    let cutoff = SystemTime::now().checked_sub(max_age).unwrap_or(UNIX_EPOCH);
    let entries = match std::fs::read_dir(disk_root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let env_path = path.join("env.json");
        let Ok(meta) = std::fs::metadata(&env_path) else {
            continue;
        };
        if let Ok(modified) = meta.modified()
            && modified < cutoff
            && std::fs::remove_dir_all(&path).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn fingerprint_changes_when_lock_changes() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("flake.nix"), "{}").unwrap();
        let fp1 = fingerprint_inputs(td.path());
        fs::write(td.path().join("flake.lock"), "v1").unwrap();
        let fp2 = fingerprint_inputs(td.path());
        // Sleep briefly so mtime ticks; on filesystems with second-resolution
        // mtimes a fast rewrite would otherwise keep the fingerprint stable.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(td.path().join("flake.lock"), "v2").unwrap();
        let fp3 = fingerprint_inputs(td.path());
        assert_ne!(fp1, fp2);
        assert_ne!(fp2, fp3);
    }

    #[test]
    fn fingerprint_stable_for_unchanged_files() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("flake.nix"), "{}").unwrap();
        fs::write(td.path().join("flake.lock"), "v1").unwrap();
        let a = fingerprint_inputs(td.path());
        let b = fingerprint_inputs(td.path());
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_is_hex() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("flake.nix"), "{}").unwrap();
        let fp = fingerprint_inputs(td.path());
        assert!(
            fp.chars().all(|c| c.is_ascii_hexdigit()),
            "expected hex, got {fp}"
        );
    }

    #[tokio::test]
    async fn status_returns_none_for_unknown_root() {
        let cache = DevshellCache::shared();
        let td = TempDir::new().unwrap();
        let snap = cache.status(td.path()).await;
        assert!(matches!(snap, StatusSnapshot::None));
    }

    #[tokio::test]
    async fn env_for_returns_empty_when_no_devshell() {
        let cache = DevshellCache::shared();
        let td = TempDir::new().unwrap();
        let result = cache.env_for(None, td.path(), DetectMode::Auto).await;
        assert_eq!(result.kind, None);
        assert!(result.env.is_empty());
        assert!(!result.stale);
    }

    #[tokio::test]
    async fn refresh_with_no_devshell_errors() {
        let cache = DevshellCache::shared();
        let td = TempDir::new().unwrap();
        assert!(
            cache
                .refresh(None, td.path(), DetectMode::Auto)
                .await
                .is_err()
        );
    }

    #[test]
    fn disk_snapshot_roundtrip() {
        let td = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        std::fs::write(project.path().join("flake.nix"), "{}").unwrap();
        let fingerprint = fingerprint_inputs(project.path());
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), "/nix/store/abc/bin".into());
        env.insert("RUSTC".into(), "/nix/store/xyz/bin/rustc".into());
        let resolved = ResolvedEnv {
            env: env.clone(),
            duration_ms: 42,
        };
        write_disk_snapshot(
            td.path(),
            project.path(),
            DevshellKind::Flake,
            &fingerprint,
            &resolved,
        )
        .unwrap();

        let loaded = load_disk_snapshot(td.path(), &fingerprint).unwrap();
        assert_eq!(loaded.env, env);
        assert_eq!(loaded.duration_ms, 42);

        // Mismatched fingerprint returns None.
        assert!(load_disk_snapshot(td.path(), "deadbeef").is_none());
    }

    #[test]
    fn evict_stale_snapshots_no_op_when_dir_missing() {
        let td = TempDir::new().unwrap();
        let missing = td.path().join("does-not-exist");
        let removed = evict_stale_snapshots(&missing, Duration::from_secs(1)).unwrap();
        assert_eq!(removed, 0);
    }
}
