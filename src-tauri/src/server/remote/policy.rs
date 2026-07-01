//! Remote command policy: every Tauri command registered in `lib.rs`
//! has an explicit posture here, plus the `ui.*` virtual methods that
//! forward through the desktop webview. A unit test parses `lib.rs` and
//! fails when the two drift, so adding a command without deciding its
//! remote posture fails CI.
//!
//! Grounding invariants (see the plan in the repo history):
//! - The desktop webview is the sole `*_query` answerer, sole
//!   `mutation_ack` sender, and single writer of persisted state.
//! - Execution-boundary approvals (MCP, workspace startup, extension
//!   install) happen physically at the desktop.
//! - Root-bearing commands (fs/git/shell) stay denied until the phase
//!   that adds `validate_root_arg` enforcement lands.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemotePolicy {
    /// Dispatch straight to the Rust command.
    Direct,
    /// Dispatch after per-command payload inspection (`agent_command`).
    DirectFiltered,
    /// Forward to the desktop webview via the control-plane machinery;
    /// the payload is the `control-request` method name.
    ForwardToFrontend(&'static str),
    /// Refused, with the reason returned to the client.
    Deny(&'static str),
}

use RemotePolicy::*;

const DESKTOP_WRITER: &str = "the desktop webview is the single writer of shared persisted state";
const CONTROL_PLANE: &str = "control-plane internals are not remotely accessible";
const DESKTOP_ONLY: &str = "operates on desktop-local UI or OS surfaces";
const LIFECYCLE: &str = "the desktop owns agent/server process lifecycle";
const APPROVAL: &str = "execution boundary — approve at the desktop";
const DEBUG_ONLY: &str = "debug transport only";
const PHASE_TERMINAL: &str = "not yet exposed remotely (planned: terminal/files/git phase)";
const PHASE_SETTINGS: &str = "not yet exposed remotely (planned: settings/dashboards phase)";
const GATEWAY_ADMIN: &str = "remote gateway administration is desktop-only";

/// The exhaustive table. Keep grouped by module, mirroring the
/// `generate_handler!` order where practical.
pub const COMMAND_POLICIES: &[(&str, RemotePolicy)] = &[
    // agent bridge
    ("start_agent", Direct),
    ("send_message", Direct),
    ("agent_command", DirectFiltered),
    ("agent_broadcast_command", Deny(LIFECYCLE)),
    ("force_restart_agent", Deny(LIFECYCLE)),
    ("reload_agent", Deny(LIFECYCLE)),
    ("agent_diagnostics", Direct),
    ("reconcile_agent_workers", Deny(LIFECYCLE)),
    ("dispatch_a2ui_event", Direct),
    // control plane
    ("control_update_state", Deny(CONTROL_PLANE)),
    ("control_request_complete", Deny(CONTROL_PLANE)),
    // paste (already jailed to ~/.aethon/pastes with a 32 MiB cap)
    ("save_paste_image", Direct),
    ("read_paste_image_base64", Direct),
    // config/state
    ("read_state", Direct),
    ("write_state", Deny(DESKTOP_WRITER)),
    ("read_config", Direct),
    ("write_config", Deny(DESKTOP_WRITER)),
    ("read_issue_templates", Deny(PHASE_TERMINAL)),
    ("aethon_home_dir", Direct),
    // sessions
    ("search_sessions", Direct),
    ("delete_session", Direct),
    ("fork_session", Direct),
    ("export_chat_markdown", Direct),
    // scheduler
    ("scheduled_tasks_list", Direct),
    ("scheduled_tasks_reconcile_live_tabs", Deny(PHASE_SETTINGS)),
    ("scheduled_tasks_fail_running_for_tab", Deny(PHASE_SETTINGS)),
    ("scheduled_task_create", Deny(PHASE_SETTINGS)),
    ("scheduled_task_update", Deny(PHASE_SETTINGS)),
    ("scheduled_task_pause", Deny(PHASE_SETTINGS)),
    ("scheduled_task_resume", Deny(PHASE_SETTINGS)),
    ("scheduled_task_cancel", Deny(PHASE_SETTINGS)),
    ("scheduled_task_delete", Deny(PHASE_SETTINGS)),
    ("scheduled_task_reuse", Deny(PHASE_SETTINGS)),
    ("scheduled_task_run_now", Deny(PHASE_SETTINGS)),
    ("scheduled_task_schedule_wakeup", Deny(PHASE_SETTINGS)),
    ("scheduled_task_complete", Deny(PHASE_SETTINGS)),
    ("scheduled_task_resolve_loop_prompt", Deny(PHASE_SETTINGS)),
    // subagents
    ("subagents_list", Direct),
    ("subagents_write", Deny(PHASE_SETTINGS)),
    ("subagents_delete", Deny(PHASE_SETTINGS)),
    // setup + approvals
    ("aethon_setup_status", Deny(PHASE_SETTINGS)),
    ("aethon_setup_write_agents", Deny(APPROVAL)),
    ("aethon_setup_set_host_mcp_policy", Deny(APPROVAL)),
    ("aethon_setup_import_mcp_json", Deny(APPROVAL)),
    ("aethon_setup_write_startup_command", Deny(APPROVAL)),
    ("mcp_config_status", Deny(PHASE_SETTINGS)),
    ("mcp_config_approve", Deny(APPROVAL)),
    ("workspace_startup_status", Deny(PHASE_SETTINGS)),
    ("workspace_startup_approve", Deny(APPROVAL)),
    ("workspace_startup_continue", Deny(APPROVAL)),
    ("workspace_startup_retry", Deny(APPROVAL)),
    ("workspace_startup_prepare_for_path", Deny(APPROVAL)),
    ("workspace_startup_set_auto_approve", Deny(APPROVAL)),
    // extensions
    ("set_extension_menu_items", Deny(DESKTOP_ONLY)),
    ("set_tray_sessions", Deny(DESKTOP_ONLY)),
    ("install_aethon_extension", Deny(APPROVAL)),
    ("watch_project_extensions", Deny(LIFECYCLE)),
    ("unwatch_project_extensions", Deny(LIFECYCLE)),
    // fs (terminal/files/git phase; will require validate_root_arg)
    ("fs_list_dir", Deny(PHASE_TERMINAL)),
    ("fs_walk_project", Deny(PHASE_TERMINAL)),
    ("fs_read_file", Deny(PHASE_TERMINAL)),
    ("fs_read_file_base64", Deny(PHASE_TERMINAL)),
    ("fs_exists", Deny(PHASE_TERMINAL)),
    ("fs_file_mtime", Deny(PHASE_TERMINAL)),
    ("fs_write_file", Deny(PHASE_TERMINAL)),
    ("fs_create_file", Deny(PHASE_TERMINAL)),
    ("fs_create_dir", Deny(PHASE_TERMINAL)),
    ("fs_rename", Deny(PHASE_TERMINAL)),
    ("fs_delete", Deny(PHASE_TERMINAL)),
    ("fs_watch_dirs", Deny(PHASE_TERMINAL)),
    ("fs_unwatch_root", Deny(PHASE_TERMINAL)),
    ("fs_discover_project_icon", Deny(PHASE_TERMINAL)),
    ("fs_reveal_in_file_manager", Deny(DESKTOP_ONLY)),
    ("fs_open_in_file_manager", Deny(DESKTOP_ONLY)),
    ("fs_open_in_default_app", Deny(DESKTOP_ONLY)),
    // git + gh (terminal/files/git phase)
    ("git_status", Deny(PHASE_TERMINAL)),
    ("git_working_context", Deny(PHASE_TERMINAL)),
    ("git_fetch_all", Deny(PHASE_TERMINAL)),
    ("git_file_status", Deny(PHASE_TERMINAL)),
    ("git_ignored_paths", Deny(PHASE_TERMINAL)),
    ("git_watch_root", Deny(PHASE_TERMINAL)),
    ("git_unwatch_root", Deny(PHASE_TERMINAL)),
    ("git_file_diff", Deny(PHASE_TERMINAL)),
    ("git_file_diff_hunks", Deny(PHASE_TERMINAL)),
    ("git_file_diff_stat", Deny(PHASE_TERMINAL)),
    ("git_show_head", Deny(PHASE_TERMINAL)),
    ("git_diff_stat", Deny(PHASE_TERMINAL)),
    ("git_worktrees", Deny(PHASE_TERMINAL)),
    ("git_worktree_add", Deny(PHASE_TERMINAL)),
    ("git_worktree_remove", Deny(PHASE_TERMINAL)),
    ("git_worktree_remove_orphan", Deny(PHASE_TERMINAL)),
    ("git_branch_list", Deny(PHASE_TERMINAL)),
    ("gh_branch_status", Deny(PHASE_TERMINAL)),
    ("gh_repo_overview", Deny(PHASE_TERMINAL)),
    ("gh_repo_avatar_url", Deny(PHASE_TERMINAL)),
    ("gh_checks", Deny(PHASE_TERMINAL)),
    ("gh_issue_list", Deny(PHASE_TERMINAL)),
    ("gh_issue_view", Deny(PHASE_TERMINAL)),
    ("pick_project_directory", Deny(DESKTOP_ONLY)),
    // shells (terminal/files/git phase)
    ("shell_open", Deny(PHASE_TERMINAL)),
    ("shell_input", Deny(PHASE_TERMINAL)),
    ("shell_resize", Deny(PHASE_TERMINAL)),
    ("shell_close", Deny(PHASE_TERMINAL)),
    ("shell_is_busy", Deny(PHASE_TERMINAL)),
    ("shell_set_share_mode", Deny(PHASE_TERMINAL)),
    ("shell_read_scrollback", Deny(PHASE_TERMINAL)),
    ("shell_list_shareable", Deny(PHASE_TERMINAL)),
    ("shell_write", Deny(PHASE_TERMINAL)),
    // devshell
    ("devshell_status", Deny(PHASE_SETTINGS)),
    ("devshell_prepare_for_path", Deny(PHASE_SETTINGS)),
    ("devshell_env_for_path", Deny(PHASE_SETTINGS)),
    ("devshell_refresh", Deny(PHASE_SETTINGS)),
    // voice (device-local audio)
    ("voice_list_providers", Deny(DESKTOP_ONLY)),
    ("voice_set_selected_provider", Deny(DESKTOP_ONLY)),
    ("voice_set_provider_enabled", Deny(DESKTOP_ONLY)),
    ("voice_prepare_provider", Deny(DESKTOP_ONLY)),
    ("voice_remove_provider_model", Deny(DESKTOP_ONLY)),
    ("voice_start_recording", Deny(DESKTOP_ONLY)),
    ("voice_stop_and_transcribe", Deny(DESKTOP_ONLY)),
    ("voice_cancel_recording", Deny(DESKTOP_ONLY)),
    ("voice_speak", Deny(DESKTOP_ONLY)),
    ("voice_stop_playback", Deny(DESKTOP_ONLY)),
    // native windows
    ("native_window_open_canvas", Deny(DESKTOP_ONLY)),
    ("native_window_save_canvas", Deny(DESKTOP_ONLY)),
    ("native_window_get_canvas", Deny(DESKTOP_ONLY)),
    ("native_window_list", Deny(DESKTOP_ONLY)),
    ("native_window_focus", Deny(DESKTOP_ONLY)),
    ("native_window_close", Deny(DESKTOP_ONLY)),
    ("native_window_set_title", Deny(DESKTOP_ONLY)),
    // host + server + gateway admin
    ("host_info", Direct),
    ("server_status", Deny("use remote_status instead")),
    ("server_start", Deny(LIFECYCLE)),
    ("server_stop", Deny(LIFECYCLE)),
    ("remote_status", Direct),
    ("remote_pairing_begin", Deny(GATEWAY_ADMIN)),
    ("remote_pairing_cancel", Deny(GATEWAY_ADMIN)),
    ("remote_devices_list", Deny(GATEWAY_ADMIN)),
    ("remote_device_revoke", Deny(GATEWAY_ADMIN)),
    ("remote_device_rename", Deny(GATEWAY_ADMIN)),
    // window/updater/boot
    ("updater_available", Deny(DESKTOP_ONLY)),
    ("toggle_fullscreen", Deny(DESKTOP_ONLY)),
    ("toggle_devtools", Deny(DESKTOP_ONLY)),
    ("check_for_updates_with_channel", Deny(DESKTOP_ONLY)),
    ("install_pending_update", Deny(DESKTOP_ONLY)),
    ("boot_stage", Deny(LIFECYCLE)),
    ("boot_ok", Deny(LIFECYCLE)),
    // debug (registered in debug builds only)
    ("debug_eval_js", Deny(DEBUG_ONLY)),
    ("debug_eval_result", Deny(DEBUG_ONLY)),
    ("debug_shell_snapshot", Deny(DEBUG_ONLY)),
    ("debug_shell_write_raw", Deny(DEBUG_ONLY)),
    // ui.* virtual methods — forwarded to the desktop webview through
    // the control plane; the method set useControlRequests.ts handles.
    ("ui.tabs.open", ForwardToFrontend("tabs.open")),
    ("ui.tabs.close", ForwardToFrontend("tabs.close")),
    ("ui.tabs.focus", ForwardToFrontend("tabs.focus")),
    ("ui.chat.send", ForwardToFrontend("chat.send")),
    ("ui.chat.wait", ForwardToFrontend("chat.wait")),
    ("ui.accounts.use", ForwardToFrontend("accounts.use")),
    ("ui.agent.stop", ForwardToFrontend("agent.stop")),
];

pub fn policy_for(cmd: &str) -> RemotePolicy {
    COMMAND_POLICIES
        .iter()
        .find(|(name, _)| *name == cmd)
        .map(|(_, policy)| *policy)
        .unwrap_or(Deny("unknown command"))
}

/// `agent_command` payload filter: the desktop webview is the sole
/// mutation-ack sender and frontend-state mirror — a remote client
/// echoing either would race it (double-ack) or poison the mirror.
pub fn agent_command_remote_denial(payload: &serde_json::Value) -> Option<&'static str> {
    match payload.get("type").and_then(|t| t.as_str()) {
        Some("mutation_ack") => Some("mutation_ack is reserved for the desktop webview"),
        Some("frontend_state_patch") => {
            Some("frontend_state_patch is reserved for the desktop webview")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    /// Pull the command idents out of the `generate_handler![...]` block
    /// in lib.rs. Mirrors the macro's shape: one `path::to::command,`
    /// per line (cfg attributes on their own lines don't match).
    fn registered_commands() -> HashSet<String> {
        let lib = include_str!("../../lib.rs");
        let start = lib
            .find("invoke_handler(tauri::generate_handler![")
            .expect("generate_handler block");
        let end = lib[start..].find("])").expect("block end") + start;
        lib[start..end]
            .lines()
            .filter_map(|line| {
                let line = line.trim().trim_end_matches(',');
                if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
                    return None;
                }
                let ident = line.rsplit("::").next()?;
                ident
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                    .then(|| ident.to_string())
            })
            .filter(|ident| ident != "invoke_handler")
            .collect()
    }

    #[test]
    fn every_registered_command_has_an_explicit_policy() {
        let registered = registered_commands();
        assert!(
            registered.len() > 100,
            "lib.rs parse looks broken: {} commands",
            registered.len()
        );
        let table: HashSet<&str> = COMMAND_POLICIES.iter().map(|(name, _)| *name).collect();
        let missing: Vec<_> = registered
            .iter()
            .filter(|cmd| !table.contains(cmd.as_str()))
            .collect();
        assert!(
            missing.is_empty(),
            "commands registered in lib.rs without a remote policy: {missing:?}"
        );
    }

    #[test]
    fn no_stale_policy_entries() {
        let registered = registered_commands();
        let stale: Vec<_> = COMMAND_POLICIES
            .iter()
            .map(|(name, _)| *name)
            .filter(|name| !name.starts_with("ui.") && !registered.contains(*name))
            .collect();
        assert!(
            stale.is_empty(),
            "policy entries for commands no longer registered: {stale:?}"
        );
    }

    #[test]
    fn no_duplicate_policy_entries() {
        let mut seen = HashSet::new();
        for (name, _) in COMMAND_POLICIES {
            assert!(seen.insert(*name), "duplicate policy entry: {name}");
        }
    }

    #[test]
    fn spot_checks() {
        assert_eq!(policy_for("send_message"), Direct);
        assert_eq!(policy_for("agent_command"), DirectFiltered);
        assert_eq!(policy_for("ui.chat.send"), ForwardToFrontend("chat.send"));
        assert!(matches!(policy_for("write_state"), Deny(_)));
        assert!(matches!(policy_for("shell_write"), Deny(_)));
        assert!(matches!(policy_for("not_a_command"), Deny(_)));
    }

    #[test]
    fn agent_command_filter_blocks_webview_reserved_types() {
        use serde_json::json;
        assert!(
            agent_command_remote_denial(&json!({"type": "mutation_ack", "mutationId": "m1"}))
                .is_some()
        );
        assert!(
            agent_command_remote_denial(&json!({"type": "frontend_state_patch"})).is_some()
        );
        assert!(agent_command_remote_denial(&json!({"type": "set_model"})).is_none());
        assert!(agent_command_remote_denial(&json!({"no": "type"})).is_none());
    }
}
