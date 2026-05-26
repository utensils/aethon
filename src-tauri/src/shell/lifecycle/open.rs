//! `shell_open` — the PTY-spawn entry point. Sets up the master/slave
//! pair, configures the command/env/cwd, applies the optional initial
//! share mode *before* the reader thread starts (so a non-private
//! default sees the login banner), then hands off to
//! [`super::reader::spawn_reader_thread`].

use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};

use super::reader::spawn_reader_thread;
use super::registry::{
    ChildHandle, SCROLLBACK_BYTES, ScrollbackHandle, ShareHandle, ShellRegistry, ShellSlot,
};
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
pub fn shell_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ShellRegistry>,
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

    let mut cmd = match args.command.as_deref() {
        Some(c) if !c.is_empty() => CommandBuilder::new(c),
        _ => default_shell_command(),
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
    let display_command = args.command.clone().unwrap_or_else(default_shell_label);
    let slot = ShellSlot {
        writer,
        master: pair.master,
        child: child_handle,
        reader_thread: Some(reader_thread),
        scrollback: scrollback_handle,
        share: share_handle,
        cwd: display_cwd,
        command: display_command,
    };
    state
        .slots
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .insert(args.tab_id, slot);
    Ok(())
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
