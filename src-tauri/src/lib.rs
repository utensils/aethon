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
            //
            // Run `env` instead of trying to `echo $PATH` directly: fish
            // treats $PATH as a list and prints entries space-separated
            // (POSIX wants colons), which would silently corrupt the
            // recovered value. `env` always emits the actual exported
            // environment with PATH= colon-separated, regardless of the
            // shell that runs it.
            let out = Command::new(&shell)
                .args(["-ilc", "env"])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&out.stdout);
            let path_line = stdout.lines().find(|l| l.starts_with("PATH="))?;
            let value = path_line.strip_prefix("PATH=")?.to_string();
            if value.is_empty() { None } else { Some(value) }
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
    tab_id: Option<String>,
    state: State<'_, AgentProcess>,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    ensure_agent_spawned(&mut guard, &app)?;

    let child = guard.as_mut().ok_or("agent not running")?;
    let stdin = child.stdin.as_mut().ok_or("no stdin")?;
    let event_value: serde_json::Value =
        serde_json::from_str(&event).map_err(|e| e.to_string())?;
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

/// Watch source / extension directories for file changes and kill the
/// running agent child so the next request respawns it with fresh code.
/// Held in Tauri state to keep the watcher thread alive for the app's
/// lifetime.
///
/// Watch paths:
///   - `~/.aethon/extensions/` — user-installed Aethon extensions
///   - `~/.pi/agent/extensions/` — pi extensions (loaded via pi's
///     resourceLoader on session create)
///   - `<project>/agent/` — bridge source, dev only
struct AgentWatcher {
    _watcher: notify::RecommendedWatcher,
}

struct DebounceMsg {
    settle_ms: u64,
    paths: Vec<PathBuf>,
}

/// Single-thread debounce worker — collapses bursts of file events
/// into one agent kill after the channel goes quiet for `settle_ms`.
/// Each new message resets the timeout; the largest settle requested
/// across the burst wins (so a node_modules event that arrives during
/// an extension burst doesn't get prematurely fired).
fn run_debounce_worker(rx: std::sync::mpsc::Receiver<DebounceMsg>, app: AppHandle) {
    use std::sync::mpsc::RecvTimeoutError;

    loop {
        // Block until we have at least one event to act on.
        let first = match rx.recv() {
            Ok(m) => m,
            Err(_) => return, // sender dropped — watcher gone
        };
        let mut settle = first.settle_ms;
        let mut last_paths = first.paths;
        // Drain further events until the channel is quiet for `settle` ms.
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(settle)) {
                Ok(next) => {
                    settle = settle.max(next.settle_ms);
                    last_paths = next.paths;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        // Quiet — fire the kill once.
        let state: State<'_, AgentProcess> = app.state();
        if let Ok(mut guard) = state.0.lock()
            && let Some(mut child) = guard.take()
        {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            let _ = app.emit("agent-reloaded", "");
            eprintln!(
                "[agent-watch] killed pid={pid} after {settle}ms settle; will respawn on next request (last paths={last_paths:?})",
            );
        }
    }
}

fn start_agent_watcher(app: AppHandle) -> Option<AgentWatcher> {
    use notify::event::{DataChange, ModifyKind};
    use notify::{EventKind, RecursiveMode, Watcher};

    // Compose the watch list. Each path is included only if it exists
    // — missing extension dirs are normal for fresh installs.
    let home = match app.path().home_dir() {
        Ok(h) => Some(h),
        Err(_) => None,
    };
    let mut watch_paths: Vec<PathBuf> = Vec::new();
    if let Some(h) = home {
        // ~/.aethon/extensions belongs to us — create it on boot so a
        // first-time extension drop fires Create events and the agent
        // hot-reloads without a manual restart.
        let aethon_ext = h.join(".aethon/extensions");
        let _ = std::fs::create_dir_all(&aethon_ext);
        if aethon_ext.exists() { watch_paths.push(aethon_ext); }
        // ~/.pi/agent/extensions is pi's territory — only watch if it
        // already exists. Users on a fresh pi install can `pi install`
        // (or mkdir) and restart Aethon to start watching.
        let pi_ext = h.join(".pi/agent/extensions");
        if pi_ext.exists() { watch_paths.push(pi_ext); }
        // ~/.aethon/skills/node_modules holds npm-distributed skill
        // packages (manifest with `aethon` field). Pre-create so a
        // first `npm install --prefix ~/.aethon/skills <pkg>` triggers
        // a reload without needing to restart the app.
        let skills_modules = h.join(".aethon/skills/node_modules");
        let _ = std::fs::create_dir_all(&skills_modules);
        if skills_modules.exists() { watch_paths.push(skills_modules); }
    }
    // Bridge source dir is dev-only — release ships a compiled sidecar
    // and editing the source has no effect on the running binary.
    if cfg!(debug_assertions) {
        let agent_dir = project_root().join("agent");
        if agent_dir.exists() { watch_paths.push(agent_dir); }
    }
    if watch_paths.is_empty() {
        eprintln!("[agent-watch] nothing to watch — hot reload disabled");
        return None;
    }

    // Trailing-edge debounce backed by a single worker thread (NOT
    // one thread per event). The watcher posts each qualifying event
    // through a channel; the worker's `recv_timeout` resets on each
    // arrival and only fires the kill when the channel goes quiet for
    // the configured settle window. npm install bursts produce
    // thousands of events; spawning a thread per event would exhaust
    // OS resources on the very scenario this is supposed to handle.
    let app_clone = app.clone();
    let (debounce_tx, debounce_rx) = std::sync::mpsc::channel::<DebounceMsg>();
    std::thread::spawn(move || run_debounce_worker(debounce_rx, app_clone.clone()));

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
            // Extensions land in their watched dirs as a Create event when
            // the user copies a new file in. Treat those as reload triggers.
            let is_create =
                matches!(event.kind, EventKind::Create(_));
            // Removing an extension should also trigger reload so the
            // bridge stops loading it on the next spawn.
            let is_remove =
                matches!(event.kind, EventKind::Remove(_));

            if !(is_data_modify || is_atomic_rename || is_create || is_remove) {
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

            // node_modules events get a longer settle window because
            // npm install can produce IO bursts spaced out beyond the
            // editor-save scale. Edits in agent/ or extension dirs
            // use a tighter window so the dev cycle stays snappy.
            let in_node_modules = event.paths.iter().any(|p| {
                p.components()
                    .any(|c| matches!(c.as_os_str().to_str(), Some("node_modules")))
            });
            let settle_ms: u64 = if in_node_modules { 3000 } else { 1000 };
            let _ = debounce_tx.send(DebounceMsg {
                settle_ms,
                paths: event.paths.clone(),
            });
        },
    ) {
        Ok(w) => w,
        Err(err) => {
            eprintln!("[agent-watch] failed to create watcher: {err}");
            return None;
        }
    };

    let mut watching: Vec<PathBuf> = Vec::new();
    for path in &watch_paths {
        if let Err(err) = watcher.watch(path, RecursiveMode::Recursive) {
            eprintln!("[agent-watch] failed to watch {}: {err}", path.display());
        } else {
            watching.push(path.clone());
        }
    }
    if watching.is_empty() {
        return None;
    }

    eprintln!(
        "[agent-watch] watching {} dir(s) for changes: {}",
        watching.len(),
        watching
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    );
    Some(AgentWatcher { _watcher: watcher })
}

/// True when the updater plugin has a usable pubkey configured.
/// Reads tauri.conf.json (the source of truth at runtime via
/// generate_context!) by parsing the embedded JSON. Returns false on
/// missing-or-empty so dev builds can boot without bogus keys and the
/// frontend can surface a clear "updater not configured" message.
fn updater_pubkey_configured() -> bool {
    static CONF: &str = include_str!("../tauri.conf.json");
    let v: serde_json::Value = match serde_json::from_str(CONF) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let pubkey = v
        .get("plugins")
        .and_then(|p| p.get("updater"))
        .and_then(|u| u.get("pubkey"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    !pubkey.trim().is_empty()
}

/// Tauri command the frontend uses to know whether to show the
/// "Check for Updates" UI as enabled or as a "not configured" hint.
#[tauri::command]
fn updater_available() -> bool {
    cfg!(not(any(target_os = "android", target_os = "ios"))) && updater_pubkey_configured()
}

/// Build and attach the native app menu. The frontend listens for a
/// `menu` Tauri event whose payload is the activated item id; both
/// menu clicks and the existing keyboard shortcuts converge on the
/// same React-side dispatcher. Predefined NS items (Quit, Hide, Cut,
/// Copy, Paste, Minimize, ...) get native behavior automatically.
fn install_app_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    use tauri::Emitter;

    let new_tab = MenuItemBuilder::with_id("new_tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next_tab", "Next Tab")
        .accelerator("CmdOrCtrl+]")
        .build(app)?;
    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Previous Tab")
        .accelerator("CmdOrCtrl+[")
        .build(app)?;
    let toggle_terminal =
        MenuItemBuilder::with_id("toggle_terminal", "Toggle Terminal")
            .accelerator("CmdOrCtrl+`")
            .build(app)?;
    let clear_chat =
        MenuItemBuilder::with_id("clear_chat", "Clear Chat").build(app)?;
    let stop_prompt =
        MenuItemBuilder::with_id("stop_prompt", "Stop Current Prompt")
            .accelerator("CmdOrCtrl+.")
            .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check_updates", "Check for Updates…").build(app)?;

    // App submenu (macOS-only first slot — Linux/Windows put these in File).
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "Aethon")
        .item(&PredefinedMenuItem::about(app, Some("About Aethon"), None)?)
        .item(&check_updates)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // Cmd+W is reserved for `close_tab` (browser/IDE convention).
    // Tauri's PredefinedMenuItem::close_window also binds Cmd+W on
    // macOS, so we omit it here — the user closes the window via the
    // red traffic light or Cmd+Q. Adding both would let macOS route
    // Cmd+W to whichever menu item it picks first.
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&close_tab)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // On macOS the App submenu owns "Check for Updates…" (HIG-standard
    // location). Non-macOS desktops put it in View since they have no
    // App submenu and stuffing it into File would clash with tab items.
    let view_menu = {
        let mut b = SubmenuBuilder::new(app, "View")
            .item(&toggle_terminal)
            .item(&clear_chat)
            .item(&stop_prompt);
        #[cfg(not(target_os = "macos"))]
        {
            b = b.separator().item(&check_updates);
        }
        b.build()?
    };

    let tabs_menu = SubmenuBuilder::new(app, "Tabs")
        .item(&new_tab)
        .item(&close_tab)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &tabs_menu, &window_menu])
        .build()?;
    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app)
        .items(&[&file_menu, &edit_menu, &view_menu, &tabs_menu, &window_menu])
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        // Forward as a Tauri event so the React side's centralized
        // dispatcher (mirror of the Cmd+T / Cmd+] / Cmd+W keydown
        // handlers) fires the same code path.
        let _ = app.emit("menu", id);
    });

    Ok(())
}

/// Status-bar / tray icon with a tiny menu (Show, New Tab, Quit).
/// Left-click on the icon focuses the main window so users who hide
/// Aethon (Cmd+H) can re-summon it without going through the dock.
/// Reuses the bundled app icon as the tray glyph; macOS gets the
/// template-image treatment so it adapts to dark/light menu bars.
fn install_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;

    fn focus_main(app: &AppHandle) {
        // Cmd+H on macOS hides the app at the application level —
        // WebviewWindow::show() doesn't unhide that. AppHandle::show()
        // does. Call it first; on other platforms it's effectively a
        // no-op since GUI apps can't be hidden the same way.
        #[cfg(target_os = "macos")]
        let _ = app.show();
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    let show_item = MenuItem::with_id(app, "tray:show", "Show Aethon", true, None::<&str>)?;
    let new_tab_item =
        MenuItem::with_id(app, "tray:new_tab", "New Tab", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray:quit", "Quit Aethon", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &new_tab_item, &quit_item])?;

    let icon = app
        .default_window_icon()
        .ok_or("no default_window_icon — bundle.icon missing?")?
        .clone();

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        // Show Aethon's full-color logo in the tray rather than a
        // monochrome template. The brand mark (cream Æ + orange π) is
        // recognizable at status-bar size; template rendering would
        // strip the orange and lose the identity.
        .icon_as_template(false)
        // macOS HIG: left-click activates, right-click shows the menu.
        // On Linux/Windows the menu opens on left-click by default,
        // which matches their conventions — leave as the platform default.
        .show_menu_on_left_click(!cfg!(target_os = "macos"))
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "tray:show" => focus_main(app),
                "tray:new_tab" => {
                    // Forward as a "menu" event so the React side's
                    // existing dispatcher fires the same handler the
                    // app menu's New Tab uses. Bring the window forward
                    // first so the user sees the new tab.
                    focus_main(app);
                    let _ = tauri::Emitter::emit(app, "menu", "new_tab");
                }
                "tray:quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Single left-click = focus window. Anything else (right
            // click, dragging) is left to the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    builder = builder.plugin(tauri_plugin_process::init());
    // Gate the updater plugin on a configured pubkey. Without one,
    // signature verification can't decode anything and every update
    // would fail post-download — so we just don't register the plugin
    // and the frontend's Check-for-Updates menu reports it cleanly.
    // tauri.conf.json's plugins.updater.pubkey is the source of truth;
    // env override exists for CI / local sigs.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if updater_pubkey_configured() {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        } else {
            eprintln!(
                "[updater] skipping plugin registration — no pubkey set in tauri.conf.json. \
                See RELEASING.md to generate signing keys."
            );
        }
    }
    let builder = builder
        .manage(AgentProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            start_agent,
            send_message,
            agent_command,
            dispatch_a2ui_event,
            read_state,
            write_state,
            read_config,
            updater_available,
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

            // Native menu — replaces Tauri's auto-generated default. Each
            // app-specific item emits a `menu` Tauri event whose payload
            // is the item id; the frontend's listener fans out to the
            // existing Cmd+T / Cmd+] / etc. handlers so the menu and
            // keyboard shortcuts always do the same thing. Predefined
            // macOS items (Quit / Hide / Cut / Copy / Minimize / etc.)
            // get native NS actions for free, no event handler needed.
            install_app_menu(app.handle())?;
            install_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
