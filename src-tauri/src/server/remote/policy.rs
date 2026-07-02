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
//! - Root-bearing commands (fs/git/shell) are `DirectRootChecked`: the
//!   relay validates their root/cwd/projectPath arg against the host's
//!   known project roots before dispatch, and the per-path fs jail still
//!   applies beneath.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemotePolicy {
    /// Dispatch straight to the Rust command.
    Direct,
    /// Dispatch after validating the command's root/cwd/projectPath arg
    /// against the host's known project roots (fs/git/shell surfaces).
    DirectRootChecked,
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
    // Read-only project-file read (<root>/.aethon/issues.toml) — same
    // risk class as the gh_* reads below; the companion's issue rows
    // need it for template-aware dispatch.
    ("read_issue_templates", DirectRootChecked),
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
    // fs — reads/writes jailed to a validated project root (the
    // existing helpers::resolve_inside_root + canonicalize guard still
    // applies beneath). Watch/discover/tab-id ops don't carry a root or
    // touch desktop-local surfaces, so they stay denied.
    ("fs_list_dir", DirectRootChecked),
    ("fs_walk_project", DirectRootChecked),
    ("fs_read_file", DirectRootChecked),
    ("fs_read_file_base64", DirectRootChecked),
    ("fs_exists", DirectRootChecked),
    ("fs_file_mtime", DirectRootChecked),
    ("fs_write_file", DirectRootChecked),
    ("fs_create_file", DirectRootChecked),
    ("fs_create_dir", DirectRootChecked),
    ("fs_rename", DirectRootChecked),
    ("fs_delete", DirectRootChecked),
    ("fs_watch_dirs", Deny(DESKTOP_ONLY)),
    ("fs_unwatch_root", Deny(DESKTOP_ONLY)),
    ("fs_discover_project_icon", DirectRootChecked),
    ("fs_reveal_in_file_manager", Deny(DESKTOP_ONLY)),
    ("fs_open_in_file_manager", Deny(DESKTOP_ONLY)),
    ("fs_open_in_default_app", Deny(DESKTOP_ONLY)),
    // git + gh — read surfaces scoped to a validated root. Worktree
    // add/remove mutate the repo layout but are root-checked against a
    // known project and are what the companion's issue-dispatch /
    // new-workspace flows run; a paired device already holds shell
    // access to these roots, so this is not an escalation.
    ("git_status", DirectRootChecked),
    ("git_working_context", DirectRootChecked),
    ("git_fetch_all", DirectRootChecked),
    ("git_file_status", DirectRootChecked),
    ("git_ignored_paths", DirectRootChecked),
    ("git_watch_root", Deny(DESKTOP_ONLY)),
    ("git_unwatch_root", Deny(DESKTOP_ONLY)),
    ("git_file_diff", DirectRootChecked),
    ("git_file_diff_hunks", DirectRootChecked),
    ("git_file_diff_stat", DirectRootChecked),
    ("git_show_head", DirectRootChecked),
    ("git_diff_stat", DirectRootChecked),
    ("git_worktrees", DirectRootChecked),
    ("git_worktree_add", DirectRootChecked),
    ("git_worktree_remove", DirectRootChecked),
    ("git_worktree_remove_orphan", DirectRootChecked),
    ("git_branch_list", DirectRootChecked),
    ("gh_branch_status", DirectRootChecked),
    ("gh_repo_overview", DirectRootChecked),
    ("gh_repo_avatar_url", DirectRootChecked),
    ("gh_checks", DirectRootChecked),
    ("gh_issue_list", DirectRootChecked),
    ("gh_issue_view", DirectRootChecked),
    ("pick_project_directory", Deny(DESKTOP_ONLY)),
    // shells — the user's own interactive terminals. Per-tab ShareMode
    // in shell/sharemode.rs gates *agent* access and is untouched; a
    // paired device driving its own shell is the user, not the agent.
    // shell_open validates its cwd; the rest key by an already-open tab.
    ("shell_open", DirectRootChecked),
    ("shell_input", Direct),
    ("shell_resize", Direct),
    ("shell_close", Direct),
    ("shell_is_busy", Direct),
    ("shell_set_share_mode", Direct),
    ("shell_read_scrollback", Direct),
    ("shell_list_shareable", Direct),
    ("shell_write", Direct),
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
    // voice conversation engine (device-local mic + speakers)
    ("voice_convo_start", Deny(DESKTOP_ONLY)),
    ("voice_convo_stop", Deny(DESKTOP_ONLY)),
    ("voice_convo_status", Deny(DESKTOP_ONLY)),
    ("voice_convo_force_end_turn", Deny(DESKTOP_ONLY)),
    ("voice_convo_speak_chunk", Deny(DESKTOP_ONLY)),
    ("voice_convo_speak_end", Deny(DESKTOP_ONLY)),
    ("voice_convo_cancel_speech", Deny(DESKTOP_ONLY)),
    ("voice_convo_test_providers", Deny(DESKTOP_ONLY)),
    ("voice_convo_list_voices", Deny(DESKTOP_ONLY)),
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
    ("ui.theme.set", ForwardToFrontend("theme.set")),
    // Companion Settings edits: the desktop webview applies + persists,
    // preserving the single-writer invariant on config.toml.
    ("ui.config.write", ForwardToFrontend("config.write")),
];

pub fn policy_for(cmd: &str) -> RemotePolicy {
    COMMAND_POLICIES
        .iter()
        .find(|(name, _)| *name == cmd)
        .map(|(_, policy)| *policy)
        .unwrap_or(Deny("unknown command"))
}

/// The arg holding a project root for a root-checked command. Names
/// vary across the command surface (`root` / `cwd` / `path` /
/// `projectPath`), and `shell_open` nests its `cwd` inside `args`.
/// Returns `None` when the command carries no root arg — for
/// `shell_open` that means "open in the default cwd" (allowed); for
/// everything else a missing root is a malformed call (denied).
pub fn root_arg_value(cmd: &str, args: &serde_json::Value) -> Option<String> {
    if cmd == "shell_open" {
        return args
            .get("args")
            .and_then(|a| a.get("cwd"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    let key = match cmd {
        "git_status" => "path",
        "git_working_context" => "cwd",
        "git_worktrees"
        | "git_worktree_add"
        | "git_worktree_remove"
        | "git_worktree_remove_orphan"
        | "git_branch_list"
        | "git_fetch_all"
        | "gh_branch_status"
        | "gh_checks"
        | "gh_repo_overview"
        | "gh_repo_avatar_url"
        | "gh_issue_list"
        | "gh_issue_view"
        | "read_issue_templates"
        | "fs_discover_project_icon" => "projectPath",
        // fs_* + git diff/status/show family all name it `root`.
        _ => "root",
    };
    args.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// `shell_open` may omit its cwd (defaults to home); every other
/// root-checked command requires one.
pub fn root_is_optional(cmd: &str) -> bool {
    cmd == "shell_open"
}

/// Extract the canonical project roots from a `projects.json` document:
/// `projects[].path` ∪ `workspacesByProject[*][].path` (plus the pre-v5
/// `worktreesByProject` spelling). Pure so it's unit-testable without a
/// running app.
pub fn allowed_roots_from_projects_json(raw: &str) -> Vec<String> {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    let mut push_paths = |arr: Option<&Vec<serde_json::Value>>| {
        if let Some(items) = arr {
            for item in items {
                if let Some(p) = item.get("path").and_then(|v| v.as_str()) {
                    roots.push(p.to_string());
                }
            }
        }
    };
    push_paths(doc.get("projects").and_then(|v| v.as_array()));
    for key in ["workspacesByProject", "worktreesByProject"] {
        if let Some(map) = doc.get(key).and_then(|v| v.as_object()) {
            for group in map.values() {
                push_paths(group.as_array());
            }
        }
    }
    roots
}

/// Whether `candidate` resolves to one of the allowed roots. Both sides
/// are canonicalized so `..`/symlinks can't dress a non-root up as one;
/// a candidate that can't canonicalize (missing dir) never matches.
pub fn root_is_allowed(candidate: &str, allowed: &[String]) -> bool {
    let Ok(candidate) = std::fs::canonicalize(candidate) else {
        return false;
    };
    allowed
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| r == candidate)
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
        Some("boot_layout") => Some("boot_layout is reserved for the desktop webview"),
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
        assert_eq!(policy_for("ui.theme.set"), ForwardToFrontend("theme.set"));
        assert!(matches!(policy_for("write_state"), Deny(_)));
        assert_eq!(policy_for("shell_write"), Direct);
        assert_eq!(policy_for("shell_open"), DirectRootChecked);
        assert_eq!(policy_for("fs_read_file"), DirectRootChecked);
        assert_eq!(policy_for("git_status"), DirectRootChecked);
        assert_eq!(policy_for("git_worktree_add"), DirectRootChecked);
        assert_eq!(policy_for("git_worktree_remove"), DirectRootChecked);
        assert_eq!(policy_for("read_issue_templates"), DirectRootChecked);
        assert!(matches!(policy_for("not_a_command"), Deny(_)));
    }

    #[test]
    fn agent_command_filter_blocks_webview_reserved_types() {
        use serde_json::json;
        assert!(
            agent_command_remote_denial(&json!({"type": "mutation_ack", "mutationId": "m1"}))
                .is_some()
        );
        assert!(agent_command_remote_denial(&json!({"type": "frontend_state_patch"})).is_some());
        assert!(agent_command_remote_denial(&json!({"type": "boot_layout"})).is_some());
        assert!(agent_command_remote_denial(&json!({"type": "set_model"})).is_none());
        assert!(agent_command_remote_denial(&json!({"no": "type"})).is_none());
    }

    #[test]
    fn root_arg_value_reads_the_right_key_per_command() {
        use serde_json::json;
        assert_eq!(
            root_arg_value("fs_read_file", &json!({"root": "/a", "path": "b"})).as_deref(),
            Some("/a")
        );
        assert_eq!(
            root_arg_value("git_status", &json!({"path": "/repo"})).as_deref(),
            Some("/repo")
        );
        assert_eq!(
            root_arg_value("git_working_context", &json!({"cwd": "/w"})).as_deref(),
            Some("/w")
        );
        assert_eq!(
            root_arg_value("gh_checks", &json!({"projectPath": "/p", "branch": "main"})).as_deref(),
            Some("/p")
        );
        assert_eq!(
            root_arg_value(
                "git_worktree_add",
                &json!({"projectPath": "/p", "targetPath": "/elsewhere", "branch": "b"})
            )
            .as_deref(),
            Some("/p")
        );
        assert_eq!(
            root_arg_value("read_issue_templates", &json!({"projectPath": "/p"})).as_deref(),
            Some("/p")
        );
        assert_eq!(
            root_arg_value(
                "shell_open",
                &json!({"args": {"tabId": "t", "cwd": "/proj"}})
            )
            .as_deref(),
            Some("/proj")
        );
        // shell_open with no cwd → None (allowed default); others → None
        // (missing required root).
        assert!(root_arg_value("shell_open", &json!({"args": {"tabId": "t"}})).is_none());
        assert!(root_is_optional("shell_open"));
        assert!(!root_is_optional("fs_read_file"));
    }

    #[test]
    fn allowed_roots_collects_projects_and_workspaces() {
        let raw = r#"{
            "projects": [{"path": "/a"}, {"path": "/b"}],
            "workspacesByProject": {"p1": [{"path": "/a/wt"}]},
            "worktreesByProject": {"p2": [{"path": "/legacy"}]}
        }"#;
        let mut roots = allowed_roots_from_projects_json(raw);
        roots.sort();
        assert_eq!(roots, vec!["/a", "/a/wt", "/b", "/legacy"]);
        assert!(allowed_roots_from_projects_json("not json").is_empty());
    }

    #[test]
    fn root_is_allowed_matches_only_canonical_known_roots() {
        let root = tempfile::tempdir().unwrap();
        let sub = root.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let allowed = vec![root.path().to_string_lossy().into_owned()];

        assert!(root_is_allowed(root.path().to_str().unwrap(), &allowed));
        // A traversal that resolves back to the root still matches (both
        // canonicalized); a genuine subdir does not (roots are exact).
        let via_dotdot = sub.join("..");
        assert!(root_is_allowed(via_dotdot.to_str().unwrap(), &allowed));
        assert!(!root_is_allowed(sub.to_str().unwrap(), &allowed));
        assert!(!root_is_allowed("/nonexistent/path", &allowed));
    }
}
