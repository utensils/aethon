use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Resolve `<home>/.aethon/<name>` after rejecting path-traversal segments.
/// The parent directory is created on demand. Uses Tauri's cross-platform
/// `home_dir()` so Windows (USERPROFILE), macOS, and Linux all resolve
/// without env-var assumptions.
fn aethon_state_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == ".." {
        return Err(format!("invalid state name: {name}"));
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = home.join(".aethon");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(name))
}

/// Read a file from `~/.aethon/`. Returns an empty string when the file
/// doesn't exist so callers can do a "first run" check without distinguishing
/// missing from empty.
#[tauri::command]
fn read_state(name: String, app: AppHandle) -> Result<String, String> {
    let path = aethon_state_path(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Write a file to `~/.aethon/`. Creates the directory if missing.
#[tauri::command]
fn write_state(name: String, content: String, app: AppHandle) -> Result<(), String> {
    let path = aethon_state_path(&app, &name)?;
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Schema for `~/.aethon/config.toml`. All fields optional with sane defaults
/// — the file is read-only from Aethon's perspective and intended as a
/// single place for user-level overrides (theme, model, etc.).
#[derive(Default, Deserialize)]
struct UiConfig {
    theme: Option<String>,
    font_size: Option<u32>,
}

#[derive(Default, Deserialize)]
struct AgentConfig {
    model: Option<String>,
}

#[derive(Default, Deserialize)]
struct AethonConfig {
    #[serde(default)]
    ui: UiConfig,
    #[serde(default)]
    agent: AgentConfig,
}

/// Read `~/.aethon/config.toml` and return its parsed contents as JSON. Missing
/// file → defaults (no fields). Malformed TOML → defaults + stderr warning so
/// a bad user config never blocks app boot. File size capped at 64 KiB to
/// guard against accidental gigantic configs.
#[tauri::command]
fn read_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = aethon_state_path(&app, "config.toml")?;
    const MAX_BYTES: u64 = 64 * 1024;
    let mut buf = String::new();
    match std::fs::File::open(&path) {
        Ok(file) => {
            // Cap the read so a runaway config can't pull a huge file into memory.
            if let Err(e) = file.take(MAX_BYTES).read_to_string(&mut buf) {
                eprintln!("[config] read {}: {e}; using defaults", path.display());
                buf.clear();
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => { /* defaults */ }
        Err(e) => {
            eprintln!("[config] open {}: {e}; using defaults", path.display());
        }
    }
    let cfg: AethonConfig = if buf.is_empty() {
        AethonConfig::default()
    } else {
        match toml::from_str(&buf) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[config] parse {}: {e}; using defaults", path.display());
                AethonConfig::default()
            }
        }
    };
    Ok(serde_json::json!({
        "ui": {
            "theme": cfg.ui.theme,
            "fontSize": cfg.ui.font_size,
        },
        "agent": {
            "model": cfg.agent.model,
        },
    }))
}

#[cfg(debug_assertions)]
mod debug;

struct AgentProcess(Mutex<Option<Child>>);

/// Find the project root (the directory containing `agent/main.ts`). Tauri
/// launches the dev binary with cwd set to `src-tauri/`, but our agent script
/// lives one level up, so a naive relative path resolves to the wrong place.
/// Walk up from cwd until we find the marker; fall back to cwd if nothing
/// matches.
fn project_root() -> PathBuf {
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

/// Capture the user's login-shell PATH so the sidecar can find tools that
/// live outside launchd's minimal `/usr/bin:/bin:/usr/sbin:/sbin`. macOS
/// .app launches inherit that minimal PATH and lose Homebrew, Nix profile
/// dirs, `~/.npm-global/bin`, etc. — pi's package resolver hits this
/// immediately with `npm root -g` when settings.json declares any npm
/// package source. Mirrors the workaround VS Code / Sublime / iTerm use.
///
/// Cached forever once computed (the shell hop costs ~50–200 ms). Only
/// runs on macOS in release builds — Linux/Windows GUI launchers preserve
/// the inherited environment, and dev launches happen from a terminal that
/// already has the right PATH.
fn resolved_login_path() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            if !cfg!(target_os = "macos") {
                return None;
            }
            // SHELL points at the user's login shell; fall back to zsh
            // (the macOS default since 10.15) when unset.
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            // -i forces interactive mode so ~/.zshrc / ~/.bashrc /
            // ~/.config/fish/config.fish are sourced. -l makes it a
            // login shell so ~/.zprofile / ~/.bash_profile fire too.
            // `printf %s "$PATH"` works in zsh, bash, and fish.
            let out = Command::new(&shell)
                .args(["-ilc", "printf %s \"$PATH\""])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        })
        .clone()
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
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?;
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
/// the watcher in `debug.rs`. In release we run the compiled
/// `aethon-agent` sidecar bundled by Tauri, with `PI_PACKAGE_DIR` set to
/// the shipped pi metadata so `pi-coding-agent`'s package.json read at
/// module load doesn't fail, plus an enriched PATH (see
/// `resolved_login_path`) so pi can find npm/git when scanning user
/// packages from `~/.pi/agent/settings.json`. Stdout is read on a
/// background thread; each line is emitted as an `agent-response`
/// Tauri event.
fn ensure_agent_spawned(
    guard: &mut Option<Child>,
    app: &AppHandle,
) -> Result<(), String> {
    // Reap a dead child if present — try_wait returns Ok(Some(_)) when exited.
    if let Some(child) = guard.as_mut()
        && let Ok(Some(status)) = child.try_wait()
    {
        eprintln!("[agent] previous child exited with {status:?}; respawning");
        *guard = None;
    }

    if guard.is_some() {
        return Ok(());
    }

    let mut command = if cfg!(debug_assertions) {
        let root = project_root();
        let mut c = Command::new("bun");
        c.current_dir(&root).arg("run").arg("agent/main.ts");
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
        let mut c = Command::new(&bin);
        c.env("PI_PACKAGE_DIR", &pi_dir);
        // Bundled .app launches inherit launchd's minimal PATH on macOS, so
        // pi's `npm root -g` (run when resolving user packages from
        // ~/.pi/agent/settings.json) fails with ENOENT. Source the user's
        // login shell once to recover the real PATH and inject it.
        if let Some(path) = resolved_login_path() {
            c.env("PATH", path);
        }
        c
    };

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn agent: {e}"))?;

    let pid = child.id();
    eprintln!("[agent] spawned pid={pid}");

    let stdout = child.stdout.take().ok_or("no stdout on spawned agent")?;
    let app_stdout = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let _ = app_stdout.emit("agent-response", text);
                }
                Err(_) => break,
            }
        }
        eprintln!("[agent] stdout reader for pid={pid} exited");
    });

    // Capture stderr too — when the agent crashes inside Tauri's spawn env,
    // stderr is the only visible signal. Lines are mirrored to Rust's stderr
    // and forwarded to the frontend as `agent-stderr` events for the
    // aethon-debug skill / status bar to surface.
    let stderr = child.stderr.take().ok_or("no stderr on spawned agent")?;
    let app_stderr = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    eprintln!("[agent stderr pid={pid}] {text}");
                    let _ = app_stderr.emit("agent-stderr", text);
                }
                Err(_) => break,
            }
        }
        eprintln!("[agent] stderr reader for pid={pid} exited");
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
        "tabId": tab_id.unwrap_or_else(|| "default".to_string()),
    });
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Forward an arbitrary JSON command (e.g. `{"type":"set_model","id":"..."}`)
/// to the agent's stdin. Used by the model picker and any future runtime
/// controls that aren't wrapped in `dispatch_a2ui_event`.
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
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    let event_value: serde_json::Value =
        serde_json::from_str(&event).map_err(|e| e.to_string())?;
    let payload = serde_json::json!({"type": "a2ui_event", "event": event_value});
    writeln!(stdin, "{}", payload).map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// In debug builds, watch `agent/` for file changes and kill the running
/// agent child so the next request respawns it with fresh code. Held in
/// Tauri state to keep the watcher thread alive for the app's lifetime.
struct AgentWatcher {
    _watcher: notify::RecommendedWatcher,
}

#[cfg(debug_assertions)]
fn start_agent_watcher(app: AppHandle) -> Option<AgentWatcher> {
    use notify::event::{DataChange, ModifyKind};
    use notify::{EventKind, RecursiveMode, Watcher};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    let agent_dir = project_root().join("agent");
    if !agent_dir.exists() {
        eprintln!(
            "[agent-watch] {} does not exist; hot reload disabled",
            agent_dir.display()
        );
        return None;
    }

    let last_fire = Arc::new(AtomicU64::new(0));
    let app_clone = app.clone();
    let last_fire_clone = last_fire.clone();

    let mut watcher = match notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(ev) => ev,
                Err(err) => {
                    eprintln!("[agent-watch] error: {err}");
                    return;
                }
            };

            // Only react to actual content writes — `Modify(Data(_))` is the
            // editor-saved-the-file event. Everything else (metadata, opens,
            // creates from build-tool atime updates, etc.) is ignored to
            // avoid spurious respawns at app startup.
            let is_data_modify = matches!(
                event.kind,
                EventKind::Modify(ModifyKind::Data(DataChange::Any | DataChange::Content))
            );
            // Some platforms (macOS fsevents) report renames from atomic
            // editors as `Modify(Name(_))`. Treat those as content changes too.
            let is_atomic_rename =
                matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)));

            if !(is_data_modify || is_atomic_rename) {
                return;
            }

            // Only kill on changes to source files we actually care about.
            let touched_source = event.paths.iter().any(|p| {
                matches!(
                    p.extension().and_then(|s| s.to_str()),
                    Some("ts" | "tsx" | "json" | "mjs" | "js")
                )
            });
            if !touched_source {
                return;
            }

            // Debounce — editors fire several events per save (1.5s window).
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let last = last_fire_clone.load(Ordering::Relaxed);
            if now.saturating_sub(last) < 1500 {
                return;
            }
            last_fire_clone.store(now, Ordering::Relaxed);

            // Kill the current child; the next inbound message will respawn.
            let state: State<'_, AgentProcess> = app_clone.state();
            if let Ok(mut guard) = state.0.lock()
                && let Some(mut child) = guard.take()
            {
                let pid = child.id();
                let _ = child.kill();
                let _ = child.wait();
                let _ = app_clone.emit("agent-reloaded", "");
                eprintln!(
                    "[agent-watch] killed pid={pid}; will respawn on next request (paths={:?})",
                    event.paths
                );
            }
        },
    ) {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[agent-watch] failed to create watcher: {err}");
            return None;
        }
    };

    if let Err(err) = watcher.watch(&agent_dir, RecursiveMode::Recursive) {
        eprintln!("[agent-watch] failed to watch {}: {err}", agent_dir.display());
        return None;
    }

    eprintln!("[agent-watch] watching {} for changes", agent_dir.display());
    Some(AgentWatcher { _watcher: watcher })
}

#[cfg(not(debug_assertions))]
fn start_agent_watcher(_app: AppHandle) -> Option<AgentWatcher> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(AgentProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            start_agent,
            send_message,
            agent_command,
            dispatch_a2ui_event,
            read_state,
            write_state,
            read_config,
            #[cfg(debug_assertions)]
            debug::debug_eval_js,
            #[cfg(debug_assertions)]
            debug::debug_eval_result,
        ]);

    builder
        .setup(|app| {
            if let Some(watcher) = start_agent_watcher(app.handle().clone()) {
                app.manage(watcher);
            }
            #[cfg(debug_assertions)]
            debug::start_debug_server(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
