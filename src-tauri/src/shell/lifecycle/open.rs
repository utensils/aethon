//! `shell_open` — the PTY-spawn entry point. Sets up the master/slave
//! pair, configures the command/env/cwd, applies the optional initial
//! share mode *before* the reader thread starts (so a non-private
//! default sees the login banner), then hands off to
//! [`super::reader::spawn_reader_thread`].

use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, State};

use super::reader::spawn_reader_thread;
use super::registry::{
    ChildHandle, SCROLLBACK_BYTES, ScrollbackHandle, ShareHandle, ShellRegistry, ShellSlot,
};
use crate::commands::devshell::TauriEmitter;
use crate::devshell::{AppEmitter, DetectMode, DevshellCache, DevshellEmitter};
use crate::shell::scrollback::Scrollback;
use crate::shell::sharemode::{ShareMode, ShareState};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellOpenArgs {
    pub tab_id: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    /// Initial share mode. When non-private, the privacy floor pins at
    /// 0 (the reader hasn't appended anything yet), so the user sees
    /// every byte from the very first prompt onward — closes the
    /// codex-flagged "configured default sharing misses login banner"
    /// race that existed when the seed was applied post-open.
    #[serde(default)]
    pub share_mode: Option<ShareMode>,
    /// When false, clear the inherited process env before applying
    /// `TERM`/`COLORTERM`/`AETHON` and the per-tab `env` table. Defaults
    /// to true (inherit). Mirrors `[shell] inherit_env`.
    #[serde(default)]
    pub inherit_env: Option<bool>,
}

#[tauri::command]
pub async fn shell_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ShellRegistry>,
    devshell: State<'_, Arc<DevshellCache>>,
    args: ShellOpenArgs,
) -> Result<(), String> {
    if args.tab_id.is_empty() {
        return Err("tab_id is required".to_string());
    }
    {
        let guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
        if guard.contains_key(&args.tab_id) {
            return Err(format!("shell already open for tab {}", args.tab_id));
        }
    }

    let pty_system = native_pty_system();
    let cols = args.cols.unwrap_or(80).clamp(4, 1000);
    let rows = args.rows.unwrap_or(24).clamp(4, 500);
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    // Normalize `Some("") → None` once: the runtime command selection
    // below treats an empty string as "no command" (falls back to the
    // default shell), but earlier code derived `display_command`
    // independently and would stamp the empty string into the slot's
    // label — so a default-shell tab spawned with `command: ""` got a
    // blank title. Computing `effective_command` once keeps both
    // derivations in sync.
    let effective_command: Option<&str> = args.command.as_deref().filter(|c| !c.is_empty());

    let mut cmd = match effective_command {
        Some(c) => CommandBuilder::new(c),
        None => default_shell_command(),
    };
    if let Some(extra_args) = args.args {
        for a in extra_args {
            cmd.arg(a);
        }
    }
    if let Some(cwd) = args.cwd.as_ref() {
        cmd.cwd(cwd);
    }
    // Hermetic mode: drop the host env before stamping our own
    // baseline. `TERM`/`COLORTERM`/`AETHON` and the explicit per-tab
    // `env` table still get applied below so the shell remains usable.
    if args.inherit_env == Some(false) {
        cmd.env_clear();
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("AETHON", "1");

    // Devshell wrap: if the cwd has a flake / direnv / shell.nix and
    // the global config doesn't disable the feature, layer the
    // resolved devshell env over the inherited host env. We apply
    // *before* the user's per-tab `env` table so explicit overrides
    // still win.
    //
    // The lookup is intentionally non-blocking: a `Resolving` slot
    // returns immediately with an empty env, the shell spawns
    // unwrapped, and the next shell open in this tab will be
    // wrapped once the background resolver completes. The frontend
    // listens for `devshell-ready` / `devshell-failed` to update
    // the status badge.
    if let Some(cwd) = args.cwd.as_ref() {
        let cwd_path = std::path::PathBuf::from(cwd);
        let (enabled, mode) = devshell_effective_config(&app, &cwd_path);
        if enabled != "never" {
            let emitter: AppEmitter = AppEmitter::new(
                Arc::new(TauriEmitter::new(app.clone())) as Arc<dyn DevshellEmitter>
            );
            let env_response = devshell.env_for(Some(&emitter), &cwd_path, mode).await;
            if !env_response.env.is_empty() {
                tracing::debug!(
                    target: "aethon::devshell",
                    "shell_open: applying {} devshell vars to tab {}",
                    env_response.env.len(),
                    args.tab_id
                );
                for (k, v) in env_response.env {
                    cmd.env(k, v);
                }
            }
        }
    }

    if let Some(env) = args.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {e}"))?;

    let child_handle: ChildHandle = Arc::new(Mutex::new(Some(child)));
    let scrollback_handle: ScrollbackHandle =
        Arc::new(Mutex::new(Scrollback::new(SCROLLBACK_BYTES)));
    // Apply the configured initial share mode *before* the reader thread
    // starts streaming output — pinning the floor at total_appended=0
    // means the user sees every byte from the first prompt onward when
    // they configured a non-private default. Applying post-open would
    // race the early banner / shell prompt and pin them below the floor.
    let initial_share_state = match args.share_mode {
        Some(mode) if mode != ShareMode::Private => {
            let mut s = ShareState::new();
            s.transition(mode, 0);
            s
        }
        _ => ShareState::new(),
    };
    let share_handle: ShareHandle = Arc::new(Mutex::new(initial_share_state));
    let reader_thread = spawn_reader_thread(
        reader,
        Arc::clone(&scrollback_handle),
        Arc::clone(&child_handle),
        app.clone(),
        args.tab_id.clone(),
    );

    let display_cwd = args.cwd.clone().unwrap_or_default();
    let display_command = effective_command
        .map(str::to_string)
        .unwrap_or_else(default_shell_label);
    let mut slot = ShellSlot {
        writer,
        master: pair.master,
        child: child_handle,
        reader_thread: Some(reader_thread),
        scrollback: scrollback_handle,
        share: share_handle,
        cwd: display_cwd,
        command: display_command,
    };

    // Atomic check-and-insert. The pre-flight check at the top of
    // this function is a fast-path — it lets us fail without paying
    // for `openpty` + spawn + reader-thread setup when the id is
    // obviously taken. It is *not* sufficient on its own: two
    // concurrent `shell_open` calls for the same tab_id can both
    // pass the pre-flight before either one inserts. The decisive
    // check is here, under the same lock that performs the insert.
    {
        let mut guard = state.slots.lock().map_err(|e| format!("lock: {e}"))?;
        if !guard.contains_key(&args.tab_id) {
            guard.insert(args.tab_id.clone(), slot);
            return Ok(());
        }
    }

    // Lost the race against a concurrent `shell_open` for the same
    // tab_id. Tear down what we just built so we don't leak a PTY,
    // a detached reader thread, or a zombie child. Order mirrors
    // `shell_close`: kill the child first so EOF unblocks the
    // reader, then drop writer + master, then join.
    if let Ok(mut child_guard) = slot.child.lock()
        && let Some(mut c) = child_guard.take()
    {
        let _ = c.kill();
        let _ = c.wait();
    }
    drop(slot.writer);
    drop(slot.master);
    if let Some(handle) = slot.reader_thread.take() {
        let _ = handle.join();
    }
    Err(format!("shell already open for tab {}", args.tab_id))
}

/// Read `[devshell] enabled` + `mode` from the global config (and any
/// per-project override), returning the normalised pair the cache
/// expects. Duplicates `commands::devshell::effective_config` rather
/// than calling it because that function is `pub(crate)` and lives
/// next to the IPC types — splitting hairs to avoid a circular
/// crate-internal dependency.
fn devshell_effective_config<R: Runtime>(
    app: &AppHandle<R>,
    root: &std::path::Path,
) -> (String, DetectMode) {
    use std::io::Read;

    use crate::helpers::config::{
        normalize_devshell_enabled, normalize_devshell_mode, parse_config_toml,
        parse_project_devshell_override,
    };

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
    let override_path = root.join(".aethon").join("devshell.toml");
    if let Ok(mut text) = std::fs::read_to_string(&override_path) {
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

fn default_shell_command() -> CommandBuilder {
    #[cfg(unix)]
    {
        let mut cmd = CommandBuilder::new(default_shell_label());
        cmd.arg("-il");
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = CommandBuilder::new(default_shell_label());
        cmd.arg("-NoLogo");
        cmd
    }
}

fn default_shell_label() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
}
