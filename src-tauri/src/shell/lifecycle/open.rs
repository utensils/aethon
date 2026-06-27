//! `shell_open` — the PTY-spawn entry point. Sets up the master/slave
//! pair, configures the command/env/cwd, applies the optional initial
//! share mode *before* the reader thread starts (so a non-private
//! default sees the login banner), then hands off to
//! [`super::reader::spawn_reader_thread`].

use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Deserialize;
use tauri::{AppHandle, State};

use super::reader::spawn_reader_thread;
use super::registry::{
    ChildHandle, SCROLLBACK_BYTES, ScrollbackHandle, ShareHandle, ShellRegistry, ShellSlot,
};
use crate::devshell::DevshellCache;
use crate::devshell::detect::DevshellKind;
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
pub async fn shell_open(
    app: AppHandle,
    state: State<'_, ShellRegistry>,
    devshell: State<'_, Arc<DevshellCache>>,
    startup: State<'_, crate::commands::startup::WorkspaceStartupState>,
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

    if let Some(cwd) = args.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        crate::commands::startup::ensure_workspace_startup_ready(&app, &startup, &devshell, cwd)
            .await?;
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

    let command_args = match effective_command {
        Some(_) => args.args.unwrap_or_default(),
        None => default_shell_args(),
    };
    let command_program = effective_command
        .map(str::to_string)
        .unwrap_or_else(default_shell_label);
    let launch_kind: Option<DevshellKind> = None;
    let mut prepared_env: Option<(Option<String>, std::collections::BTreeMap<String, String>)> =
        None;
    let mut detected_launch_kind: Option<DevshellKind> = None;

    if let Some(cwd) = args.cwd.as_ref() {
        let cwd_path = std::path::PathBuf::from(cwd);
        let emitter = crate::devshell::prepare_policy::emitter_for(&app);
        let decision =
            crate::devshell::prepare_env_for_root(&app, &devshell, &cwd_path, Some(&emitter)).await;
        match decision {
            crate::devshell::PrepareDecision::Disabled
            | crate::devshell::PrepareDecision::MissingOptional { .. } => {}
            crate::devshell::PrepareDecision::Prepared { kind, prepared } => {
                detected_launch_kind = Some(kind);
                tracing::debug!(
                    target: "aethon::devshell",
                    "shell_open: prepared {} devshell vars for tab {}",
                    prepared.env.len(),
                    args.tab_id
                );
                prepared_env = Some((prepared.kind, prepared.env));
            }
            crate::devshell::PrepareDecision::DirenvAllowFailedOptional { kind, reason } => {
                detected_launch_kind = Some(kind);
                tracing::warn!(
                    target: "aethon::devshell",
                    "shell_open: direnv allow failed for {}: {reason}; opening host shell",
                    cwd_path.display()
                );
            }
            crate::devshell::PrepareDecision::CachePrepareFailedOptional { kind, reason } => {
                detected_launch_kind = Some(kind);
                tracing::warn!(
                    target: "aethon::devshell",
                    "shell_open: devshell prepare failed for {}: {reason}; opening host shell",
                    cwd_path.display()
                );
            }
            crate::devshell::PrepareDecision::MissingRequired { reason } => {
                return Err(format!(
                    "devshell prepare: {} and [devshell] enabled = \"always\"",
                    reason
                ));
            }
            crate::devshell::PrepareDecision::ForcedModeMismatch { reason }
            | crate::devshell::PrepareDecision::CachePrepareFailedRequired { reason } => {
                return Err(format!("devshell prepare: {reason}"));
            }
            crate::devshell::PrepareDecision::DirenvAllowFailedRequired { reason } => {
                return Err(reason);
            }
        }
    }

    let disable_direnv_hooks = matches!(launch_kind, Some(DevshellKind::Flake))
        || matches!(
            detected_launch_kind,
            Some(DevshellKind::Flake | DevshellKind::Shell)
        )
        || prepared_env
            .as_ref()
            .is_some_and(|(kind, _)| kind.as_deref() != Some("direnv"));
    let launch_kind_for_log = launch_kind;
    tracing::info!(
        target: "aethon::devshell",
        "shell_open: launching tab {} via {:?}: {} {:?}",
        args.tab_id,
        launch_kind_for_log,
        command_program,
        command_args
    );
    let mut cmd = devshell_launch_command(
        launch_kind,
        args.cwd.as_deref(),
        &command_program,
        &command_args,
    )?;
    // Hermetic mode: drop the host env before stamping our own
    // baseline. `TERM`/`COLORTERM`/`AETHON` and the explicit per-tab
    // `env` table still get applied below so the shell remains usable.
    if args.inherit_env == Some(false) {
        cmd.env_clear();
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("AETHON", "1");
    clear_inherited_devshell_identity(&mut cmd);
    cmd.env("PATH", crate::env::resolved_project_path());
    if disable_direnv_hooks {
        cmd.env("DIRENV_DISABLE", "1");
    }

    if let Some((_kind, env)) = prepared_env {
        tracing::debug!(
            target: "aethon::devshell",
            "shell_open: applying {} prepared devshell vars to tab {}",
            env.len(),
            args.tab_id
        );
        for (k, v) in env {
            cmd.env(k, v);
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
    let display_command = command_program.clone();
    // No `effective_command` means we used the system shell — that child
    // *is* an interactive shell and manages a foreground process group.
    // A configured command means the child is the foreground job itself
    // (vim / sleep / npm run dev), so `shell_is_busy` must report busy
    // unconditionally rather than inspecting an empty child list.
    let is_interactive_shell = effective_command.is_none_or(is_known_interactive_shell);
    let mut slot = ShellSlot {
        writer,
        master: pair.master,
        child: child_handle,
        reader_thread: Some(reader_thread),
        scrollback: scrollback_handle,
        share: share_handle,
        cwd: display_cwd,
        command: display_command,
        is_interactive_shell,
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

fn devshell_launch_command(
    launch_kind: Option<DevshellKind>,
    cwd: Option<&str>,
    command: &str,
    args: &[String],
) -> Result<CommandBuilder, String> {
    devshell_launch_command_with_resolver(launch_kind, cwd, command, args, |program| {
        crate::env::resolve_program(program).map(|path| path.to_string_lossy().to_string())
    })
}

fn devshell_launch_command_with_resolver<F>(
    launch_kind: Option<DevshellKind>,
    cwd: Option<&str>,
    command: &str,
    args: &[String],
    resolve_program: F,
) -> Result<CommandBuilder, String>
where
    F: Fn(&str) -> Option<String>,
{
    let mut cmd = match launch_kind {
        Some(DevshellKind::Flake) => {
            let nix = resolve_program("nix")
                .ok_or_else(|| "devshell prepare: nix is not on PATH".to_string())?;
            let mut cmd = CommandBuilder::new(nix);
            cmd.arg("develop");
            cmd.arg("--accept-flake-config");
            cmd.arg("--command");
            cmd.arg(command);
            for arg in args {
                cmd.arg(arg);
            }
            cmd
        }
        Some(DevshellKind::Direnv) => {
            let direnv = resolve_program("direnv")
                .ok_or_else(|| "devshell prepare: direnv is not on PATH".to_string())?;
            let Some(root) = cwd else {
                return Err("devshell prepare: cwd is required for direnv".to_string());
            };
            let mut cmd = CommandBuilder::new(direnv);
            cmd.arg("exec");
            cmd.arg(root);
            cmd.arg(command);
            for arg in args {
                cmd.arg(arg);
            }
            cmd
        }
        Some(DevshellKind::Shell) | None => {
            let mut cmd = CommandBuilder::new(command);
            for arg in args {
                cmd.arg(arg);
            }
            cmd
        }
    };
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    Ok(cmd)
}

fn clear_inherited_devshell_identity(cmd: &mut CommandBuilder) {
    for key in [
        "IN_NIX_SHELL",
        "DEVSHELL_DIR",
        "NIX_BUILD_TOP",
        "NIX_ENFORCE_PURITY",
        "name",
    ] {
        cmd.env(key, "");
    }
}

/// True when `command` names an interactive shell binary whose child
/// PID will manage its own foreground jobs. Used by shell_open to flag
/// the slot so shell_is_busy knows to walk children vs. report busy.
/// Accepts absolute paths (`/bin/zsh`, `/usr/local/bin/fish`) and bare
/// names (`bash`, `zsh -l`). Anything not in the allow-list is treated
/// as a direct command and gets the conservative answer.
pub(super) fn is_known_interactive_shell(command: &str) -> bool {
    const SHELLS: &[&str] = &[
        "sh",
        "bash",
        "zsh",
        "fish",
        "dash",
        "ksh",
        "tcsh",
        "csh",
        "nu",
        "xonsh",
        "elvish",
        "pwsh",
        "powershell",
    ];
    let basename = command.split(['/', '\\']).next_back().unwrap_or(command);
    // Strip any trailing args ("zsh -il") + extension (".exe").
    let basename = basename
        .split_whitespace()
        .next()
        .unwrap_or(basename)
        .trim_end_matches(".exe");
    SHELLS.iter().any(|s| s.eq_ignore_ascii_case(basename))
}

fn default_shell_args() -> Vec<String> {
    #[cfg(unix)]
    {
        vec!["-il".to_string()]
    }
    #[cfg(windows)]
    {
        vec!["-NoLogo".to_string()]
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

#[cfg(test)]
mod shell_classification_tests {
    use std::ffi::OsString;

    use super::{devshell_launch_command_with_resolver, is_known_interactive_shell};
    use crate::devshell::detect::DevshellKind;

    fn argv(cmd: &portable_pty::CommandBuilder) -> Vec<String> {
        cmd.get_argv()
            .iter()
            .map(|item| item.to_string_lossy().to_string())
            .collect()
    }

    fn fake_resolver(program: &str) -> Option<String> {
        match program {
            "nix" => Some("/bin/nix".to_string()),
            "direnv" => Some("/bin/direnv".to_string()),
            _ => None,
        }
    }

    #[test]
    fn classifies_common_unix_shells() {
        for cmd in [
            "bash",
            "/bin/bash",
            "/usr/bin/zsh",
            "fish",
            "dash",
            "/bin/sh",
        ] {
            assert!(
                is_known_interactive_shell(cmd),
                "expected {cmd} to be classified as an interactive shell",
            );
        }
    }

    #[test]
    fn classifies_powershell_with_extension() {
        assert!(is_known_interactive_shell("pwsh.exe"));
        assert!(is_known_interactive_shell("PowerShell.exe"));
    }

    #[test]
    fn ignores_trailing_args_in_the_command_string() {
        assert!(is_known_interactive_shell("zsh -il"));
        assert!(is_known_interactive_shell("/bin/bash --login"));
    }

    #[test]
    fn rejects_direct_commands() {
        for cmd in ["vim", "/usr/bin/vim", "npm", "sleep 30", "node", "python3"] {
            assert!(
                !is_known_interactive_shell(cmd),
                "expected {cmd} to NOT be classified as an interactive shell",
            );
        }
    }

    #[test]
    fn flake_devshell_wraps_shell_in_nix_develop_command() {
        let cmd = devshell_launch_command_with_resolver(
            Some(DevshellKind::Flake),
            Some("/repo/worktree"),
            "/bin/zsh",
            &["-il".to_string()],
            fake_resolver,
        )
        .unwrap();

        assert_eq!(
            argv(&cmd),
            [
                "/bin/nix",
                "develop",
                "--accept-flake-config",
                "--command",
                "/bin/zsh",
                "-il"
            ]
        );
        assert_eq!(cmd.get_cwd(), Some(&OsString::from("/repo/worktree")));
    }

    #[test]
    fn shell_devshell_launches_command_directly_for_env_injection() {
        let cmd = devshell_launch_command_with_resolver(
            Some(DevshellKind::Shell),
            Some("/repo/worktree"),
            "/bin/zsh",
            &["-il".to_string()],
            fake_resolver,
        )
        .unwrap();

        assert_eq!(argv(&cmd), ["/bin/zsh", "-il"]);
        assert_eq!(cmd.get_cwd(), Some(&OsString::from("/repo/worktree")));
    }

    #[test]
    fn direnv_devshell_wraps_command_in_direnv_exec_root() {
        let cmd = devshell_launch_command_with_resolver(
            Some(DevshellKind::Direnv),
            Some("/repo/worktree"),
            "menu",
            &[],
            fake_resolver,
        )
        .unwrap();

        assert_eq!(
            argv(&cmd),
            ["/bin/direnv", "exec", "/repo/worktree", "menu"]
        );
        assert_eq!(cmd.get_cwd(), Some(&OsString::from("/repo/worktree")));
    }

    #[test]
    fn direnv_devshell_requires_a_cwd_for_exec_root() {
        let err = devshell_launch_command_with_resolver(
            Some(DevshellKind::Direnv),
            None,
            "menu",
            &[],
            fake_resolver,
        )
        .unwrap_err();

        assert_eq!(err, "devshell prepare: cwd is required for direnv");
    }
}
