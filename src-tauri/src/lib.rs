//! Aethon's Tauri shell.
//!
//! The thin Rust crust. Owns:
//!
//! - The Tauri builder setup that wires every
//!   command from the [`commands`] submodule + [`shell`] PTY module
//!   into the invoke handler.
//! - The `bun`/sidecar agent child and IPC commands live in
//!   [`agent_process`] + [`agent_commands`].
//! - Clipboard image paste persistence lives in [`paste`].
//! - Tracing/logging initialization lives in [`logging`].
//!
//! Concern-grouped IPC commands live in [`commands`]:
//!
//! - [`commands::config`] — `~/.aethon/` state files + `config.toml`.
//! - [`commands::session`] — pi session search/delete/export.
//! - [`commands::extensions`] — menu items + native menu/tray + agent
//!   file-watcher + npm extension installer.
//! - [`commands::fs`] — project-scoped file-system access for the
//!   Monaco editor + file tree.
//! - [`commands::git`] — git status, worktrees, GitHub data, issues, and folder picker.
//! - [`commands::native_windows`] — restorable A2UI canvas windows.
//! - [`commands::window`] — fullscreen/devtools/updater.
//!
//! Helpers without a Tauri dependency live in [`helpers`]; PTY-backed
//! shell tabs live in [`shell`]; debug-only commands and the eval
//! server live in [`debug`].

use std::sync::Arc;

use tauri::{Emitter, Manager};

mod agent_commands;
pub(crate) mod agent_process;
mod boot_probation;
mod commands;
mod control;
mod devshell;
mod env;
mod helpers;
mod logging;
mod paste;
#[cfg(feature = "voice")]
mod platform_speech;
mod server;
mod shell;
mod storage;
mod updater_state;
#[cfg(feature = "voice")]
mod voice;
mod window_state;

#[cfg(debug_assertions)]
mod debug;

// ─────────────────────────── run ────────────────────────────

/// Pre-Tauri home-dir lookup used by the pre-builder `ProcessStarted` boot
/// stage record. Tauri's `path().home_dir()` needs an `AppHandle` we don't
/// have yet at the very top of `run()`. We fall back to the same env vars
/// Tauri eventually resolves so the recorded path matches.
fn home_dir_for_logging() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        return std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
    }
}

#[cfg(target_os = "linux")]
fn prefer_stable_linux_webview_backend() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        // WebKitGTK's native Wayland backend can report negative viewport
        // dimensions/DPR on Hyprland, collapsing the React grid before the
        // frontend can recover. Prefer XWayland, while preserving a Wayland
        // fallback and respecting explicit user overrides.
        unsafe { std::env::set_var("GDK_BACKEND", "x11,wayland") };
    }
}

#[cfg(not(target_os = "linux"))]
fn prefer_stable_linux_webview_backend() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    prefer_stable_linux_webview_backend();

    // Boot-rollback helper sub-invocation: when the post-update
    // probation timer fires, the parent spawns this same binary with
    // `--boot-rollback-helper <sentinel-path> <parent-pid>`. The
    // helper waits for the parent to exit, restores the previous
    // .app bundle from the backup recorded by `prepare_for_update`,
    // writes a rollback report, and relaunches. We short-circuit
    // BEFORE Tauri builder construction so we don't initialise the
    // webview or tracing in helper mode.
    let args: Vec<String> = std::env::args().collect();
    if let Some(result) = boot_probation::run_helper_from_args(&args) {
        if let Err(e) = result {
            eprintln!("boot rollback helper failed: {e}");
            std::process::exit(1);
        }
        return;
    }

    logging::init_tracing();

    // Record the earliest boot stage on the sentinel (if present). If
    // we crash before the webview ever mounts, the eventual rollback
    // report can still pinpoint how far this launch got. Failure to
    // record is non-fatal — the sentinel either doesn't exist (normal
    // launch) or `start_monitor` will surface the issue.
    if let Some(dir) = helpers::aethon_dir(home_dir_for_logging()) {
        let _ = boot_probation::record_boot_stage(
            &dir,
            boot_probation::BootStage::ProcessStarted,
            None,
        );
    }

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
    let control_state = Arc::new(control::ControlState::default());
    let builder = builder
        .manage(agent_process::AgentProcesses::new())
        .manage(Arc::clone(&control_state))
        .manage(shell::ShellRegistry::new())
        .manage(commands::fs::FsWatchState::default())
        .manage(commands::git::GitFetchState::default())
        .manage(commands::git::GitWatchState::default())
        .manage(commands::native_windows::NativeWindowsState::new())
        .manage(window_state::WindowStateStore::new())
        .manage(updater_state::UpdaterState::new())
        .manage(commands::scheduler::ScheduledTasksState::new())
        .manage(Arc::new(server::ServerState::new()))
        .manage(devshell::DevshellCache::shared())
        .manage(commands::startup::WorkspaceStartupState::default());
    #[cfg(feature = "voice")]
    let builder = builder
        .manage(voice::VoiceProviderRegistry::new(
            voice::VoiceProviderRegistry::default_model_root(),
        ))
        .manage(voice::AudioPlayer::new());
    let builder = builder
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
                commands::native_windows::handle_window_closed(window.app_handle(), window.label());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            agent_commands::start_agent,
            agent_commands::send_message,
            agent_commands::agent_command,
            agent_commands::agent_broadcast_command,
            agent_commands::force_restart_agent,
            agent_commands::reload_agent,
            agent_commands::agent_diagnostics,
            agent_commands::reconcile_agent_workers,
            agent_commands::dispatch_a2ui_event,
            control::control_update_state,
            control::control_request_complete,
            paste::save_paste_image,
            paste::read_paste_image_base64,
            commands::config::read_state,
            commands::config::write_state,
            commands::config::read_config,
            commands::config::write_config,
            commands::config::read_issue_templates,
            commands::config::aethon_home_dir,
            commands::session::search_sessions,
            commands::session::delete_session,
            commands::session::export_chat_markdown,
            commands::scheduler::scheduled_tasks_list,
            commands::scheduler::scheduled_tasks_reconcile_live_tabs,
            commands::scheduler::scheduled_tasks_fail_running_for_tab,
            commands::scheduler::scheduled_task_create,
            commands::scheduler::scheduled_task_update,
            commands::scheduler::scheduled_task_pause,
            commands::scheduler::scheduled_task_resume,
            commands::scheduler::scheduled_task_cancel,
            commands::scheduler::scheduled_task_delete,
            commands::scheduler::scheduled_task_reuse,
            commands::scheduler::scheduled_task_run_now,
            commands::scheduler::scheduled_task_schedule_wakeup,
            commands::scheduler::scheduled_task_complete,
            commands::scheduler::scheduled_task_resolve_loop_prompt,
            commands::subagents::subagents_list,
            commands::subagents::subagents_write,
            commands::subagents::subagents_delete,
            commands::extensions::set_extension_menu_items,
            commands::extensions::install_aethon_extension,
            commands::extensions::watch_project_extensions,
            commands::extensions::unwatch_project_extensions,
            commands::fs::fs_list_dir,
            commands::fs::fs_watch_dirs,
            commands::fs::fs_unwatch_root,
            commands::fs::fs_read_file,
            commands::fs::fs_read_file_base64,
            commands::fs::fs_exists,
            commands::fs::fs_file_mtime,
            commands::fs::fs_discover_project_icon,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_walk_project,
            commands::fs::fs_reveal_in_file_manager,
            commands::fs::fs_open_in_file_manager,
            commands::fs::fs_open_in_default_app,
            commands::git::status::git_status,
            commands::git::status::git_working_context,
            commands::git::status::git_fetch_all,
            commands::git::status::git_file_status,
            commands::git::status::git_ignored_paths,
            commands::git::watch::git_watch_root,
            commands::git::watch::git_unwatch_root,
            commands::git::diff::git_file_diff,
            commands::git::diff::git_file_diff_hunks,
            commands::git::diff::git_file_diff_stat,
            commands::git::diff::git_show_head,
            commands::git::diff::git_diff_stat,
            commands::git::worktrees::git_worktrees,
            commands::git::worktrees::git_worktree_add,
            commands::git::worktrees::git_worktree_remove,
            commands::git::worktrees::git_worktree_remove_orphan,
            commands::git::worktrees::git_branch_list,
            commands::git::github::gh_branch_status,
            commands::git::github::gh_repo_overview,
            commands::git::github::gh_repo_avatar_url,
            commands::git::checks::gh_checks,
            commands::git::issues::gh_issue_list,
            commands::git::issues::gh_issue_view,
            commands::git::picker::pick_project_directory,
            commands::host::host_info,
            commands::mcp::mcp_config_status,
            commands::mcp::mcp_config_approve,
            commands::setup::aethon_setup_status,
            commands::setup::aethon_setup_write_agents,
            commands::setup::aethon_setup_set_host_mcp_policy,
            commands::setup::aethon_setup_import_mcp_json,
            commands::setup::aethon_setup_write_startup_command,
            commands::native_windows::native_window_open_canvas,
            commands::native_windows::native_window_save_canvas,
            commands::native_windows::native_window_get_canvas,
            commands::native_windows::native_window_list,
            commands::native_windows::native_window_focus,
            commands::native_windows::native_window_close,
            commands::native_windows::native_window_set_title,
            commands::server::server_status,
            commands::server::server_start,
            commands::server::server_stop,
            commands::window::updater_available,
            commands::window::toggle_fullscreen,
            commands::window::toggle_devtools,
            commands::updater::check_for_updates_with_channel,
            commands::updater::install_pending_update,
            commands::voice::voice_list_providers,
            commands::voice::voice_set_selected_provider,
            commands::voice::voice_set_provider_enabled,
            commands::voice::voice_prepare_provider,
            commands::voice::voice_remove_provider_model,
            commands::voice::voice_start_recording,
            commands::voice::voice_stop_and_transcribe,
            commands::voice::voice_cancel_recording,
            commands::voice::voice_speak,
            commands::voice::voice_stop_playback,
            commands::boot::boot_stage,
            commands::boot::boot_ok,
            commands::devshell::devshell_status,
            commands::devshell::devshell_prepare_for_path,
            commands::devshell::devshell_env_for_path,
            commands::devshell::devshell_refresh,
            commands::startup::workspace_startup_status,
            commands::startup::workspace_startup_approve,
            commands::startup::workspace_startup_prepare_for_path,
            commands::startup::workspace_startup_retry,
            commands::startup::workspace_startup_continue,
            commands::startup::workspace_startup_set_auto_approve,
            shell::shell_open,
            shell::shell_input,
            shell::shell_resize,
            shell::shell_close,
            shell::shell_is_busy,
            shell::shell_set_share_mode,
            shell::shell_read_scrollback,
            shell::shell_list_shareable,
            shell::shell_write,
            #[cfg(debug_assertions)]
            debug::debug_eval_js,
            #[cfg(debug_assertions)]
            debug::debug_eval_result,
            #[cfg(debug_assertions)]
            debug::debug_shell_snapshot,
            #[cfg(debug_assertions)]
            debug::debug_shell_write_raw,
        ]);

    let app = builder
        .setup(move |app| {
            if let Err(e) = storage::initialize(app.handle()) {
                tracing::warn!(target: "aethon::storage", "initialize sqlite storage: {e}");
            }
            agent_process::cleanup_orphaned_dev_agents();
            if let Some(watcher) = commands::extensions::start_agent_watcher(app.handle().clone()) {
                app.manage(watcher);
            }
            control::start_control_server(app.handle().clone(), Arc::clone(&control_state));
            #[cfg(debug_assertions)]
            debug::start_debug_server(app.handle().clone());

            // Boot-probation wiring. If the last launch was a post-update
            // boot that timed out and rolled back, this surfaces a one-shot
            // dialog explaining what happened. If a probation sentinel
            // exists from a just-installed update, this arms the timeout
            // that the frontend cancels via `boot_ok` once it reaches a
            // healthy render. Both calls are no-ops when there's no
            // sentinel/report on disk — they don't slow normal launches.
            let mut activate_after_update = false;
            if let Ok(home) = app.path().home_dir()
                && let Some(data_dir) = helpers::aethon_dir(Some(home))
            {
                activate_after_update = boot_probation::has_pending_probation(&data_dir);
                boot_probation::show_pending_report(app.handle(), &data_dir);
                let boot_state =
                    Arc::clone(&app.state::<updater_state::UpdaterState>().boot_probation);
                boot_probation::start_monitor(app.handle().clone(), boot_state, data_dir);
            }

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
            if let Err(err) = window_state::restore_on_setup(app.handle(), activate_after_update) {
                tracing::warn!(target: "aethon::window_state", "restore failed: {err}");
                // Best-effort: show the window anyway so a corrupt
                // state file can never strand the user.
                if let Some(w) = app.get_webview_window("main") {
                    if activate_after_update {
                        #[cfg(target_os = "macos")]
                        let _ = app.handle().show();
                        let _ = w.unminimize();
                    }
                    let _ = w.show();
                    if activate_after_update {
                        let _ = w.set_focus();
                    }
                }
            }
            if let Err(err) = commands::native_windows::restore_on_setup(app.handle()) {
                tracing::warn!(target: "aethon::native_windows", "restore failed: {err}");
            }
            // Built-in HTTP + mDNS server. Failures inside `boot` are
            // logged + swallowed so a port collision or LAN hiccup
            // never blocks the UI.
            let server_state = app.state::<Arc<server::ServerState>>().inner().clone();
            server::boot(app.handle().clone(), server_state);

            // Idle per-tab agent worker retirement (#159): a background sweep
            // retires `tab:<id>` workers that have sat idle past the configured
            // TTL; they respawn lazily from their session on next use.
            agent_process::spawn_idle_sweep(app.handle().clone());
            commands::scheduler::boot(app.handle().clone());

            // Release app launches can start with a skeletal PATH. Warm
            // the launch-safe tool path off the setup thread so the
            // first devshell status/probe IPC does not pay for the
            // login-shell PATH lookup.
            tauri::async_runtime::spawn_blocking(env::warm_resolved_tool_path);

            // Devshell cache: point at `~/.aethon/devshell-cache/` and
            // GC anything older than 30 days. The cache is otherwise
            // entirely lazy — no resolves happen until a shell open
            // or agent spawnHook call hits the IPC commands.
            let app_handle = app.handle().clone();
            let cache = app.state::<Arc<devshell::DevshellCache>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                commands::devshell::boot_init_cache(&app_handle, &cache).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app_handle.state::<agent_process::AgentProcesses>();
            agent_process::shutdown_all_agents(&state, "app exit");
        }
    });
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

    #[test]
    fn git_fetch_all_is_wired_to_handler() {
        let src = include_str!("lib.rs");
        assert!(
            src.contains("commands::git::status::git_fetch_all"),
            "git_fetch_all must be registered in the invoke_handler list",
        );
    }

    #[test]
    fn git_diff_commands_are_wired_to_handler() {
        let src = include_str!("lib.rs");
        for command in [
            "commands::git::diff::git_file_diff",
            "commands::git::diff::git_file_diff_hunks",
            "commands::git::diff::git_file_diff_stat",
            "commands::git::diff::git_diff_stat",
            "commands::git::diff::git_show_head",
        ] {
            assert!(
                src.contains(command),
                "{command} must stay registered in the invoke_handler list",
            );
        }
    }

    #[test]
    fn subagents_and_session_branch_commands_are_wired_to_handler() {
        let src = include_str!("lib.rs");
        for command in [
            "commands::subagents::subagents_list",
            "commands::subagents::subagents_write",
            "commands::subagents::subagents_delete",
        ] {
            assert!(
                src.contains(command),
                "{command} must stay registered in the invoke_handler list",
            );
        }
    }

    #[test]
    fn extracted_shell_commands_are_wired_to_handler() {
        let src = include_str!("lib.rs");
        for command in [
            "agent_commands::start_agent",
            "agent_commands::send_message",
            "agent_commands::agent_command",
            "agent_commands::agent_broadcast_command",
            "agent_commands::force_restart_agent",
            "agent_commands::reload_agent",
            "agent_commands::agent_diagnostics",
            "agent_commands::reconcile_agent_workers",
            "agent_commands::dispatch_a2ui_event",
            "paste::save_paste_image",
            "paste::read_paste_image_base64",
        ] {
            assert!(
                src.contains(command),
                "{command} must stay registered in the invoke_handler list",
            );
        }
    }

    #[test]
    fn native_window_commands_are_wired_to_handler_and_lifecycle() {
        let src = include_str!("lib.rs");
        for command in [
            "commands::native_windows::native_window_open_canvas",
            "commands::native_windows::native_window_save_canvas",
            "commands::native_windows::native_window_get_canvas",
            "commands::native_windows::native_window_list",
            "commands::native_windows::native_window_focus",
            "commands::native_windows::native_window_close",
            "commands::native_windows::native_window_set_title",
            "commands::native_windows::handle_window_closed",
            "commands::native_windows::restore_on_setup",
        ] {
            assert!(
                src.contains(command),
                "{command} must stay wired for native canvas windows",
            );
        }
    }

    #[test]
    fn update_probation_launch_activates_restored_window() {
        let src = include_str!("lib.rs");
        let sentinel_pos = src.find("has_pending_probation(&data_dir)").unwrap();
        let restore_pos = src
            .find("restore_on_setup(app.handle(), activate_after_update)")
            .unwrap();

        assert!(
            sentinel_pos < restore_pos,
            "setup must detect a post-update probation launch before restoring the main window so updater relaunches come back to the foreground",
        );
    }
}
