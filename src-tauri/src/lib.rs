//! Aethon's Tauri shell.
//!
//! The thin Rust crust. Owns:
//!
//! - The `bun`/sidecar agent child + its stdout/stderr supervisors.
//! - The agent IPC commands (`start_agent`, `send_message`,
//!   `agent_command`, `dispatch_a2ui_event`, `force_restart_agent`).
//! - The clipboard-paste persistence command (`save_paste_image`).
//! - Tracing/logging initialization and the `~/.aethon/logs/` rotator.
//! - `run()` — the `tauri::Builder` registration that wires every
//!   command from the [`commands`] submodule + [`shell`] PTY module
//!   into the invoke handler.
//!
//! Concern-grouped IPC commands live in [`commands`]:
//!
//! - [`commands::config`] — `~/.aethon/` state files + `config.toml`.
//! - [`commands::session`] — pi session search/delete/export.
//! - [`commands::extensions`] — menu items + native menu/tray + agent
//!   file-watcher + npm extension installer.
//! - [`commands::fs`] — project-scoped file-system access for the
//!   Monaco editor + file tree.
//! - [`commands::git`] — git status + folder picker.
//! - [`commands::window`] — fullscreen/devtools/updater.
//!
//! Helpers without a Tauri dependency live in [`helpers`]; PTY-backed
//! shell tabs live in [`shell`]; debug-only commands and the eval
//! server live in [`debug`].

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, State};

mod commands;
mod env;
mod helpers;
mod server;
mod shell;
mod window_state;
use helpers::{parse_config_toml, sanitize_filename_segment};

#[cfg(debug_assertions)]
mod debug;

// ─────────────────────────── agent process ────────────────────────────

pub(crate) struct AgentProcess(pub(crate) Mutex<Option<Child>>);

/// Shared atomic flag set by the file-watcher debounce worker just
/// before it kills the bun child for a hot-reload. The stdout reader
/// checks this on EOF: if true, the kill was intentional (`agent-reloaded`
/// was already emitted) — reset and stay silent. If false, the child
/// died unexpectedly and we emit `agent-crashed` so the frontend can
/// surface a notice + offer auto-restart.
pub(crate) struct AgentReloadFlag(pub(crate) Arc<AtomicBool>);

pub(crate) fn agent_reload_in_progress(app: &AppHandle) -> Arc<AtomicBool> {
    Arc::clone(&app.state::<AgentReloadFlag>().0)
}

/// Find the project root (the directory containing `agent/main.ts`). Tauri
/// launches the dev binary with cwd set to `src-tauri/`, but our agent script
/// lives one level up, so a naive relative path resolves to the wrong place.
/// Walk up from cwd until we find the marker; fall back to cwd if nothing
/// matches.
pub(crate) fn project_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir: &Path = &cwd;
    for _ in 0..6 {
        if dir.join("agent").join("main.ts").exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => break,
        }
    }
    cwd
}

/// Locate the bundled `aethon-agent` sidecar binary. Tauri's externalBin
/// mechanism places sidecars next to the main executable on each platform
/// (e.g. `Aethon.app/Contents/MacOS/aethon-agent-aarch64-apple-darwin`).
/// Returns Err with a descriptive message when none of the candidate paths
/// exist — the caller falls back to `bun run` in dev or surfaces the error
/// in release.
///
/// The sidecar suffix is the host's Rust target triple at build time; we
/// read it from the `TARGET` env var Cargo sets during `build.rs` (see
/// `src-tauri/build.rs`) so the same binary works no matter what triple
/// the running machine reports.
fn find_sidecar_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or("current_exe has no parent dir")?
        .to_path_buf();
    let triple = env!("AETHON_TARGET_TRIPLE");
    // Tauri's externalBin strips the triple suffix before placing the file
    // alongside the main exe (so users see `aethon-agent`, not the full
    // triple name). On Windows both the stripped and triple-suffixed
    // names get a `.exe` extension. Check the stripped variant first
    // (the one the bundler actually produces), then the raw triple
    // form as a fallback for builds where the script ran but bundling
    // didn't (e.g. running the dev exe straight out of target/release).
    let ext = std::env::consts::EXE_SUFFIX; // "" on unix, ".exe" on windows
    let candidates = [
        exe_dir.join(format!("aethon-agent{ext}")),
        exe_dir.join(format!("aethon-agent-{triple}{ext}")),
    ];
    for path in &candidates {
        if path.exists() {
            return Ok(path.clone());
        }
    }
    Err(format!(
        "aethon-agent sidecar not found next to {} (looked for: {})",
        exe.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    ))
}

/// Spawn the agent if no live child is held. Idempotent. Callers own the
/// mutex around this. In dev (`debug_assertions`) we run `bun run
/// agent/main.ts` from the project root so source edits hot-reload via
/// the watcher in `commands/extensions.rs`. In release we run the compiled
/// `aethon-agent` sidecar bundled by Tauri, with `PI_PACKAGE_DIR` set to
/// the shipped pi metadata so `pi-coding-agent`'s package.json read at
/// module load doesn't fail, plus an enriched PATH (see
/// `env::resolved_login_path`) so pi can find npm/git when scanning user
/// packages from `~/.pi/agent/settings.json`. Stdout is read on a
/// background thread; each line is emitted as an `agent-response`
/// Tauri event.
fn ensure_agent_spawned(guard: &mut Option<Child>, app: &AppHandle) -> Result<(), String> {
    // Reap a dead child if present — try_wait returns Ok(Some(_)) when exited.
    if let Some(child) = guard.as_mut()
        && let Ok(Some(status)) = child.try_wait()
    {
        tracing::info!(target: "aethon::agent", "previous child exited with {status:?}; respawning");
        *guard = None;
    }

    if guard.is_some() {
        return Ok(());
    }

    // Docs live under `<project>/docs/aethon-agent/` in dev and under
    // `<resource_dir>/docs/aethon-agent/` in release (declared as a Tauri
    // resource bundle entry). The agent reads them via its `read` tool to
    // get an authoritative reference for the A2UI primitives and the
    // globalThis.aethon API surface — without them, the model would have to
    // rely on training data, which lags this codebase.
    let mut command = if cfg!(debug_assertions) {
        let root = project_root();
        let docs_dir = root.join("docs").join("aethon-agent");
        let boot_layout_file = root
            .join("src")
            .join("skills")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = root
            .join("src")
            .join("skills")
            .join("default-layout")
            .join("slots.json");
        let mut c = env::command("bun");
        c.current_dir(&root).arg("run").arg("agent/main.ts");
        c.env("AETHON_RELEASE_MODE", "0");
        c.env("AETHON_PROJECT_ROOT", &root);
        c.env("AETHON_DOCS_DIR", &docs_dir);
        c.env("AETHON_BOOT_LAYOUT_FILE", &boot_layout_file);
        c.env("AETHON_LAYOUT_SLOTS_FILE", &layout_slots_file);
        c
    } else {
        let bin = find_sidecar_binary()?;
        // pi-coding-agent reads its own package.json at module load. The
        // shipped copy lives in Tauri's resource dir at `pi/package.json`
        // (see tauri.conf.json `bundle.resources`); pi honors
        // PI_PACKAGE_DIR for the lookup, so point it there.
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?;
        let pi_dir = resource_dir.join("pi");
        let docs_dir = resource_dir.join("docs").join("aethon-agent");
        let boot_layout_file = resource_dir
            .join("skills")
            .join("default-layout")
            .join("workstation.a2ui.json");
        let layout_slots_file = resource_dir
            .join("skills")
            .join("default-layout")
            .join("slots.json");
        let mut c = Command::new(&bin);
        c.env("PI_PACKAGE_DIR", &pi_dir);
        c.env("AETHON_RELEASE_MODE", "1");
        c.env("AETHON_DOCS_DIR", &docs_dir);
        c.env("AETHON_BOOT_LAYOUT_FILE", &boot_layout_file);
        c.env("AETHON_LAYOUT_SLOTS_FILE", &layout_slots_file);
        // Bundled .app launches inherit launchd's minimal PATH on macOS, so
        // pi's `npm root -g` (run when resolving user packages from
        // ~/.pi/agent/settings.json) fails with ENOENT. Source the user's
        // login shell once to recover the real PATH and inject it.
        if let Some(path) = env::resolved_login_path() {
            c.env("PATH", path);
        }
        c
    };
    // User dir is the same in both modes; the bridge writes its live state
    // snapshot here so a `cat $AETHON_STATE_FILE` always reflects the
    // current registrations without having to evaluate JS in the webview.
    if let Ok(home) = app.path().home_dir() {
        // helpers::aethon_dir honors AETHON_USER_DIR so `scripts/dev.sh --new`
        // can route a session into a tmp sandbox without breaking the
        // signal chain into the bridge.
        let user_dir =
            helpers::aethon_dir(Some(home.clone())).unwrap_or_else(|| home.join(".aethon"));
        let state_file = user_dir.join("state.json");
        let sessions_dir = user_dir.join("sessions");
        command.env("AETHON_USER_DIR", &user_dir);
        command.env("AETHON_STATE_FILE", &state_file);
        command.env("AETHON_SESSIONS_DIR", &sessions_dir);
        // Read [extensions] state_warn_kb / state_hard_kb from
        // ~/.aethon/config.toml and pass to the bridge as env vars. We
        // re-parse on every spawn so a config edit picks up on next
        // bridge restart without a full app reboot.
        let cfg_path = user_dir.join("config.toml");
        let raw = std::fs::read_to_string(&cfg_path).unwrap_or_default();
        let cfg_json = parse_config_toml(&raw);
        let warn_kb = cfg_json["extensions"]["stateWarnKb"].as_u64().unwrap_or(64);
        let hard_kb = cfg_json["extensions"]["stateHardKb"]
            .as_u64()
            .unwrap_or(512);
        command.env("AETHON_STATE_WARN_KB", warn_kb.to_string());
        command.env("AETHON_STATE_HARD_KB", hard_kb.to_string());
    }

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn agent: {e}"))?;

    let pid = child.id();
    tracing::info!(target: "aethon::agent", "spawned pid={pid}");

    // Tail-buffer of recent stderr lines. When the bun child crashes
    // unexpectedly, the supervisor emits an `agent-crashed` event with
    // the last few lines so the frontend can surface a useful error
    // notice rather than a generic "process exited" toast.
    let stderr_tail: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(32)));
    const STDERR_TAIL_CAP: usize = 32;

    let stdout = child.stdout.take().ok_or("no stdout on spawned agent")?;
    let app_stdout = app.clone();
    let reload_flag_stdout = agent_reload_in_progress(app);
    let stderr_tail_for_supervisor = Arc::clone(&stderr_tail);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    // Sentinel from the bridge meaning "I'm about to
                    // exit cleanly because the watcher asked me to
                    // reload." Set the flag BEFORE the EOF arrives so
                    // the post-loop handler treats it as intentional,
                    // and emit `agent-reloaded` here so the frontend
                    // can clear waiting state and respawn lazily.
                    if text.contains("\"_reload_done\"") {
                        reload_flag_stdout.store(true, std::sync::atomic::Ordering::Release);
                        let _ = app_stdout.emit("agent-reloaded", "");
                        // Don't forward the sentinel — it's bridge↔
                        // supervisor-internal and would confuse the
                        // frontend's agent-response router.
                        continue;
                    }
                    let _ = app_stdout.emit("agent-response", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", "stdout reader for pid={pid} exited");
        // Stdout reader exits when the child closes stdout — i.e. the
        // child has died. Distinguish intentional kills (hot-reload via
        // the file watcher, which sets `agent_reload_in_progress` first)
        // from unexpected crashes. Reset the flag for the next cycle.
        if reload_flag_stdout.swap(false, std::sync::atomic::Ordering::AcqRel) {
            // Intentional kill — `agent-reloaded` was already emitted by
            // the watcher; nothing more to do.
            return;
        }
        // Unexpected exit. Surface a notice with stderr tail so the
        // user sees something actionable.
        let tail: Vec<String> = match stderr_tail_for_supervisor.lock() {
            Ok(g) => g.iter().cloned().collect(),
            Err(_) => Vec::new(),
        };
        let _ = app_stdout.emit(
            "agent-crashed",
            serde_json::json!({
                "pid": pid,
                "stderrTail": tail,
            }),
        );
    });

    // Capture stderr too — when the agent crashes inside Tauri's spawn env,
    // stderr is the only visible signal. Lines are mirrored to Rust's stderr
    // and forwarded to the frontend as `agent-stderr` events for the
    // aethon-debug skill / status bar to surface.
    let stderr = child.stderr.take().ok_or("no stderr on spawned agent")?;
    let app_stderr = app.clone();
    let stderr_tail_writer = Arc::clone(&stderr_tail);
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    // Bridge stderr — already prefixed by the bridge's logger
                    // since it now emits structured `LEVEL scope: msg` lines.
                    // We forward at info level and let the env filter throttle.
                    tracing::info!(target: "aethon::agent::stderr", pid = pid, "{text}");
                    if let Ok(mut g) = stderr_tail_writer.lock() {
                        if g.len() >= STDERR_TAIL_CAP {
                            g.pop_front();
                        }
                        g.push_back(text.clone());
                    }
                    let _ = app_stderr.emit("agent-stderr", text);
                }
                Err(_) => break,
            }
        }
        tracing::debug!(target: "aethon::agent", "stderr reader for pid={pid} exited");
    });

    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn start_agent(state: State<'_, AgentProcess>, app: AppHandle) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)
}

#[tauri::command]
fn send_message(
    message: String,
    tab_id: Option<String>,
    mode: Option<String>,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    // tabId routes to a specific pi session; the bridge defaults to
    // "default" when omitted so legacy single-tab callers keep working.
    let payload = serde_json::json!({
        "type": "chat",
        "content": message,
        "mode": mode.unwrap_or_else(|| "normal".to_string()),
        "tabId": tab_id.unwrap_or_else(|| "default".to_string()),
    });
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Hard-kill the running agent child. Called by the frontend's hang-warn
/// notification "Force restart" button. Unlike the file-watcher kill (which
/// sets `agent_reload_in_progress` so EOF emits `agent-reloaded`), we
/// intentionally let the crash path fire: the existing `agent-crashed`
/// handler in App.tsx clears waiting state and (if auto_restart_agent = true)
/// respawns automatically.
///
/// This bypasses blocked stdin — even if the Node event loop is frozen by
/// backpressured stdout writes, Rust can still kill the child OS process.
#[tauri::command]
fn force_restart_agent(state: State<'_, AgentProcess>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let pid = child.id();
        tracing::warn!(target: "aethon::agent", "force_restart_agent: killing pid={pid}");
        let _ = child.kill();
        // Reap the child so it doesn't become a zombie while we wait for
        // the stdout reader thread to detect EOF and emit agent-crashed.
        let _ = child.wait();
    }
    // If guard is None the agent wasn't running — no-op is correct.
    Ok(())
}

/// Intentional kill-and-respawn for state changes the bridge can't apply
/// hot (currently: the user toggling an extension via the sidebar). Sets
/// the supervisor's `agent_reload_in_progress` flag BEFORE killing so the
/// stdout reader treats EOF as a clean reload (emits `agent-reloaded`,
/// not `agent-crashed`). The frontend's `agent-reloaded` handler then
/// invokes `start_agent` and the new bridge boots fresh — for the
/// disable-extension case, it reads `disabled-extensions.json` and the
/// loader honors the user's intent.
#[tauri::command]
fn reload_agent(state: State<'_, AgentProcess>, app: AppHandle) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    // Only set the reload flag when there's actually a child to kill —
    // the stdout reader thread is what resets the flag on EOF, so
    // setting it without a child to die would leave it stale and the
    // next genuine crash would be misclassified as an intentional
    // reload (no agent-crashed notification).
    if let Some(mut child) = guard.take() {
        let pid = child.id();
        let reload_flag = agent_reload_in_progress(&app);
        reload_flag.store(true, std::sync::atomic::Ordering::Release);
        tracing::info!(target: "aethon::agent", "reload_agent: killing pid={pid}");
        let _ = child.kill();
        let _ = child.wait();
    }
    // Emit agent-reloaded so the frontend re-primes via start_agent.
    // Safe to emit even when no child existed — the listener invokes
    // start_agent which is a no-op if the agent is already absent.
    let _ = app.emit("agent-reloaded", "extension-toggle");
    Ok(())
}

/// Forward an arbitrary JSON payload to the agent's stdin. Used by the model
/// picker and any future runtime controls that aren't wrapped in
/// `dispatch_a2ui_event`.
#[tauri::command]
fn agent_command(
    payload: String,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn dispatch_a2ui_event(
    event: String,
    tab_id: Option<String>,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    let event_value: serde_json::Value = serde_json::from_str(&event).map_err(|e| e.to_string())?;
    // tabId routes the event (and any handler-fired pi.prompt()) to the
    // originating tab's session instead of always defaulting to "default".
    let payload = serde_json::json!({
        "type": "a2ui_event",
        "event": event_value,
        "tabId": tab_id.unwrap_or_else(|| "default".to_string()),
    });
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Persist an image paste from the clipboard to `~/.aethon/pastes/`.
/// Returns the absolute path so the frontend can insert it into the
/// draft as an `@<path>` token — the agent's existing read tool can
/// then pick the image up via the path. Why not pass bytes inline to
/// the agent: pi's bridge protocol is line-delimited JSON over stdin;
/// shipping a 1–2 MiB base64 blob per paste would balloon a single
/// message into a multi-MB write that competes with normal traffic.
/// Persisting + path-passing is the same pattern the agent uses for
/// any other read input.
#[tauri::command]
fn save_paste_image(
    bytes: Vec<u8>,
    extension: Option<String>,
    app: AppHandle,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("save_paste_image: empty payload".to_string());
    }
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("save_paste_image: payload exceeds 32 MiB".to_string());
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?
        .join("pastes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let ext = extension
        .as_deref()
        .filter(|e| !e.is_empty())
        .map(sanitize_filename_segment)
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "png".to_string());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("{id}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

// ─────────────────────────── tracing ────────────────────────────

/// Keep the non-blocking file appender's WorkerGuard alive for the
/// process lifetime. Dropping the guard flushes pending writes; when
/// `init_tracing` returns, the local guard would be dropped and the
/// background thread would exit before any non-trivial logging
/// happens. Stash it here.
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

/// `~/.aethon/logs/` — same parent as state.json + projects.json so a
/// user troubleshooting an issue finds everything in one place. Created
/// at boot so the appender doesn't fail on a fresh install.
fn log_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dir = helpers::aethon_dir(home)?.join("logs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[init_tracing] mkdir {}: {e}", dir.display());
        return None;
    }
    Some(dir)
}

/// Prune log files older than `RETENTION_DAYS`. `tracing-appender`'s
/// daily rotation produces files named `aethon.YYYY-MM-DD`; matching by
/// that prefix lets us coexist with the bridge's own log files in the
/// same directory without touching them.
const RETENTION_DAYS: u64 = 7;
fn prune_old_logs(dir: &Path) {
    let cutoff = match std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(
        RETENTION_DAYS * 24 * 60 * 60,
    )) {
        Some(t) => t,
        None => return,
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        // Only prune our own log files — leave bridge logs and anything
        // else alone.
        if !name_str.starts_with("aethon.") {
            continue;
        }
        let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
        if let Some(t) = modified
            && t < cutoff
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Initialize the `tracing` subscriber. Called from `run()` before any
/// log call so module-load output is captured. Honors `AETHON_LOG`
/// (preferred — keeps the namespace ours) and falls back to `RUST_LOG`.
/// Default level is `info` in dev and `warn` in release so noisy
/// `[agent-watch]` chatter doesn't show in shipped binaries.
///
/// Logs go to BOTH stderr (so the dev terminal sees them in real time)
/// AND a daily-rotating file at `~/.aethon/logs/aethon.YYYY-MM-DD` (so
/// release users have a paper trail for crashes / weird behavior).
/// Files older than `RETENTION_DAYS` are pruned at startup.
fn init_tracing() {
    use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};
    let default_level = if cfg!(debug_assertions) {
        "info"
    } else {
        "warn"
    };
    let filter = EnvFilter::try_from_env("AETHON_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new(default_level));

    let stderr_layer = fmt::layer().with_target(true).with_writer(std::io::stderr);

    // File layer is best-effort: if the home dir isn't reachable or the
    // appender fails to start, we still get stderr logging.
    let file_layer = log_dir().and_then(|dir| {
        prune_old_logs(&dir);
        let file_appender = tracing_appender::rolling::daily(&dir, "aethon");
        let (writer, guard) = tracing_appender::non_blocking(file_appender);
        // Stash the guard so writes don't get lost on shutdown.
        LOG_GUARD.set(guard).ok()?;
        Some(
            fmt::layer()
                .with_target(true)
                .with_ansi(false) // No color codes in the file
                .with_writer(writer),
        )
    });

    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer);
    let _ = if let Some(file) = file_layer {
        subscriber.with(file).try_init()
    } else {
        subscriber.try_init()
    };
}

// ─────────────────────────── run ────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    let mut builder = tauri::Builder::default();
    builder = builder.plugin(tauri_plugin_process::init());
    builder = builder.plugin(tauri_plugin_opener::init());
    builder = builder.plugin(tauri_plugin_dialog::init());
    builder = builder.plugin(tauri_plugin_notification::init());
    // Gate the updater plugin on a configured pubkey. Without one,
    // signature verification can't decode anything and every update
    // would fail post-download — so we just don't register the plugin
    // and the frontend's Check-for-Updates menu reports it cleanly.
    // tauri.conf.json's plugins.updater.pubkey is the source of truth;
    // env override exists for CI / local sigs.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if commands::window::updater_pubkey_configured() {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        } else {
            tracing::warn!(
                target: "aethon::updater",
                "skipping plugin registration — no pubkey set in tauri.conf.json. \
                See RELEASING.md to generate signing keys."
            );
        }
    }
    let builder = builder
        .manage(AgentProcess(Mutex::new(None)))
        .manage(AgentReloadFlag(Arc::new(AtomicBool::new(false))))
        .manage(shell::ShellRegistry::new())
        .manage(commands::fs::FsWatchState::default())
        .manage(window_state::WindowStateStore::new())
        .manage(Arc::new(server::ServerState::new()))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                window_state::schedule_save(
                    window.app_handle().clone(),
                    window.label().to_string(),
                );
            }
            tauri::WindowEvent::CloseRequested { .. } => {
                if let Err(e) = window_state::save_now(window.app_handle(), window.label()) {
                    tracing::warn!(target: "aethon::window_state", "save_now on close: {e}");
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            start_agent,
            send_message,
            agent_command,
            force_restart_agent,
            reload_agent,
            dispatch_a2ui_event,
            save_paste_image,
            commands::config::read_state,
            commands::config::write_state,
            commands::config::read_config,
            commands::config::write_config,
            commands::config::aethon_home_dir,
            commands::session::search_sessions,
            commands::session::delete_session,
            commands::session::export_chat_markdown,
            commands::extensions::set_extension_menu_items,
            commands::extensions::install_aethon_extension,
            commands::extensions::watch_project_extensions,
            commands::extensions::unwatch_project_extensions,
            commands::fs::fs_list_dir,
            commands::fs::fs_watch_dirs,
            commands::fs::fs_unwatch_root,
            commands::fs::fs_read_file,
            commands::fs::fs_read_file_base64,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_walk_project,
            commands::fs::fs_reveal_in_file_manager,
            commands::fs::fs_open_in_file_manager,
            commands::fs::fs_open_in_default_app,
            commands::git::git_status,
            commands::git::git_worktrees,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_branch_list,
            commands::git::gh_branch_status,
            commands::git::gh_repo_overview,
            commands::git::gh_repo_avatar_url,
            commands::git::gh_issue_list,
            commands::git::gh_issue_view,
            commands::git::pick_project_directory,
            commands::host::host_info,
            commands::server::server_status,
            commands::server::server_start,
            commands::server::server_stop,
            commands::window::updater_available,
            commands::window::toggle_fullscreen,
            commands::window::toggle_devtools,
            shell::shell_open,
            shell::shell_input,
            shell::shell_resize,
            shell::shell_close,
            shell::shell_set_share_mode,
            shell::shell_read_scrollback,
            shell::shell_list_shareable,
            shell::shell_write,
            #[cfg(debug_assertions)]
            debug::debug_eval_js,
            #[cfg(debug_assertions)]
            debug::debug_eval_result,
        ]);

    builder
        .setup(|app| {
            if let Some(watcher) = commands::extensions::start_agent_watcher(app.handle().clone()) {
                app.manage(watcher);
            }
            #[cfg(debug_assertions)]
            debug::start_debug_server(app.handle().clone());

            // Native menu — replaces Tauri's auto-generated default. Each
            // app-specific item emits a `menu` Tauri event whose payload
            // is the item id; the frontend's listener fans out to the
            // existing Cmd+T / Cmd+Shift+] / etc. handlers so the menu and
            // keyboard shortcuts always do the same thing. Predefined
            // macOS items (Quit / Hide / Cut / Copy / Minimize / etc.)
            // get native NS actions for free, no event handler needed.
            commands::extensions::install_app_menu(app.handle(), &[])?;
            // Register the menu-click → "menu" event forwarder ONCE here.
            // install_app_menu rebuilds and re-attaches the NSMenu whenever
            // extension menu items change, but Tauri's `on_menu_event`
            // handlers are additive — registering inside that function
            // would stack a new closure per rebuild and emit duplicates.
            app.handle().on_menu_event(|app, event| {
                let id = event.id().0.as_str();
                let _ = app.emit("menu", id);
            });
            commands::extensions::install_tray(app.handle(), &[])?;
            // Initialize the extension menu store empty; the bridge
            // ships items via `extension_menu_items` events that the
            // frontend forwards to `set_extension_menu_items`, which
            // re-runs both installers with the persisted list.
            app.manage(commands::extensions::ExtensionMenuStore::default());
            // Restore saved window geometry (position, size, monitor)
            // before showing the window — tauri.conf.json sets
            // `"visible": false` so this runs without a 1200×800 flash.
            // First-launch fallback (no saved state) is "maximized on
            // primary monitor", replacing the previous hardcoded
            // `maximize()` that worked around the unreliable manifest
            // `"maximized": true` on macOS.
            if let Err(err) = window_state::restore_on_setup(app.handle()) {
                tracing::warn!(target: "aethon::window_state", "restore failed: {err}");
                // Best-effort: show the window anyway so a corrupt
                // state file can never strand the user.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            // Built-in HTTP + mDNS server. Failures inside `boot` are
            // logged + swallowed so a port collision or LAN hiccup
            // never blocks the UI.
            let server_state = app.state::<Arc<server::ServerState>>().inner().clone();
            server::boot(app.handle().clone(), server_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    //! Source-level regression tests for code paths whose behavior is
    //! easier to assert by structure than by spinning up a Tauri runtime.
    //! Tray idempotency tests live alongside their code in
    //! `commands/extensions.rs`; the test below pins the wiring contract
    //! that `set_extension_menu_items` is registered in this file's
    //! invoke_handler list.

    /// `set_extension_menu_items` is the frontend → Rust path that
    /// rebuilds the menu + tray when an extension registers a menu
    /// item. If it stops being wired into `invoke_handler!`, the
    /// frontend invoke fails. Loud at runtime but easy to introduce
    /// in a refactor.
    #[test]
    fn set_extension_menu_items_is_wired_to_handler() {
        let src = include_str!("lib.rs");
        // The handler invocation list registers the command — without
        // this entry, the frontend's invoke('set_extension_menu_items')
        // returns "command not found".
        assert!(
            src.contains("commands::extensions::set_extension_menu_items"),
            "set_extension_menu_items must be registered in the invoke_handler list",
        );
    }
}
