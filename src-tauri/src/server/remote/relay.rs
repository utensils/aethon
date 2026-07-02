//! Invoke dispatch for remote clients.
//!
//! Tauri has no "invoke by name" from Rust, so every remotely allowed
//! command gets an explicit dispatch arm calling the underlying command
//! fn (state fetched via `Manager::state`). The arm set is asserted
//! against the policy table by a unit test, so an allowlist entry
//! without a dispatch arm (or vice versa) fails CI.
//!
//! Argument objects use the exact camelCase keys the desktop frontend
//! passes to `invoke(cmd, args)` — the mobile IPC shim forwards its args
//! object untouched.
//!
//! The trait boundary exists so the WS layer is testable with a fake
//! executor (no Tauri runtime).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::policy::{self, RemotePolicy};

#[async_trait]
pub trait RelayExec: Send + Sync {
    async fn invoke(&self, cmd: &str, args: Value) -> Result<Value, String>;
}

pub struct TauriRelay {
    app: AppHandle,
    /// Allowed project roots for `DirectRootChecked` commands, read from
    /// the persisted projects state with a short TTL so a just-added
    /// project becomes reachable without restarting the gateway.
    roots: std::sync::Mutex<Option<(std::time::Instant, Vec<String>)>>,
}

const ROOTS_TTL: std::time::Duration = std::time::Duration::from_secs(5);

impl TauriRelay {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            roots: std::sync::Mutex::new(None),
        }
    }

    fn allowed_roots(&self) -> Vec<String> {
        {
            let cache = self.roots.lock().expect("roots lock");
            if let Some((at, roots)) = cache.as_ref()
                && at.elapsed() < ROOTS_TTL
            {
                return roots.clone();
            }
        }
        let roots = crate::storage::read_state_value(&self.app, "projects.json")
            .ok()
            .flatten()
            .map(|raw| policy::allowed_roots_from_projects_json(&raw))
            .unwrap_or_default();
        *self.roots.lock().expect("roots lock") = Some((std::time::Instant::now(), roots.clone()));
        roots
    }

    fn check_root(&self, cmd: &str, args: &Value) -> Result<(), String> {
        let Some(root) = policy::root_arg_value(cmd, args) else {
            if policy::root_is_optional(cmd) {
                return Ok(());
            }
            return Err(format!("denied: {cmd} requires a project root argument"));
        };
        if policy::root_is_allowed(&root, &self.allowed_roots()) {
            Ok(())
        } else {
            Err(format!(
                "denied: {root} is not a known project or workspace root on this host"
            ))
        }
    }
}

/// Commands with a dispatch arm below. Kept next to the match so the
/// policy-parity test can compare mechanically; not consulted at
/// runtime (the match's fallback arm is the enforcement).
#[cfg_attr(not(test), allow(dead_code))]
pub const DISPATCHABLE: &[&str] = &[
    "host_info",
    "read_state",
    "read_config",
    "aethon_home_dir",
    "search_sessions",
    "delete_session",
    "fork_session",
    "export_chat_markdown",
    "start_agent",
    "send_message",
    "agent_command",
    "dispatch_a2ui_event",
    "agent_diagnostics",
    "scheduled_tasks_list",
    "save_paste_image",
    "read_paste_image_base64",
    "subagents_list",
    "remote_status",
    // terminal / files / git phase
    "shell_open",
    "shell_input",
    "shell_resize",
    "shell_close",
    "shell_is_busy",
    "shell_set_share_mode",
    "shell_read_scrollback",
    "shell_list_shareable",
    "shell_write",
    "fs_list_dir",
    "fs_walk_project",
    "fs_read_file",
    "fs_read_file_base64",
    "fs_exists",
    "fs_file_mtime",
    "fs_write_file",
    "fs_create_file",
    "fs_create_dir",
    "fs_rename",
    "fs_delete",
    "fs_discover_project_icon",
    "git_status",
    "git_working_context",
    "git_fetch_all",
    "git_file_status",
    "git_ignored_paths",
    "git_file_diff",
    "git_file_diff_hunks",
    "git_file_diff_stat",
    "git_show_head",
    "git_diff_stat",
    "git_worktrees",
    "git_worktree_add",
    "git_worktree_remove",
    "git_worktree_remove_orphan",
    "git_branch_list",
    "gh_branch_status",
    "gh_checks",
    "gh_repo_overview",
    "gh_repo_avatar_url",
    "gh_issue_list",
    "gh_issue_view",
    "read_issue_templates",
];

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    let value = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| format!("bad arg `{key}`: {e}"))
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

#[async_trait]
impl RelayExec for TauriRelay {
    async fn invoke(&self, cmd: &str, args: Value) -> Result<Value, String> {
        match policy::policy_for(cmd) {
            RemotePolicy::Deny(reason) => Err(format!("denied: {reason}")),
            RemotePolicy::ForwardToFrontend(method) => {
                let control = self.app.state::<Arc<crate::control::ControlState>>();
                crate::control::forward_ui_method(&self.app, control.inner(), method, args).await
            }
            RemotePolicy::DirectFiltered => {
                let payload: String = arg(&args, "payload")?;
                let parsed: Value = serde_json::from_str(&payload)
                    .map_err(|e| format!("invalid agent command: {e}"))?;
                if let Some(reason) = policy::agent_command_remote_denial(&parsed) {
                    return Err(format!("denied: {reason}"));
                }
                self.dispatch(cmd, args).await
            }
            RemotePolicy::DirectRootChecked => {
                self.check_root(cmd, &args)?;
                self.dispatch(cmd, args).await
            }
            RemotePolicy::Direct => self.dispatch(cmd, args).await,
        }
    }
}

impl TauriRelay {
    async fn dispatch(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let app = self.app.clone();
        match cmd {
            "host_info" => to_value(crate::commands::host::host_info()?),
            "read_state" => to_value(crate::commands::config::read_state(
                arg(&args, "name")?,
                app,
            )?),
            "read_config" => Ok(crate::commands::config::read_config(app)?),
            "aethon_home_dir" => to_value(crate::commands::config::aethon_home_dir(app)?),
            // Scans every session file — keep it off the async workers.
            "search_sessions" => {
                let query: String = arg(&args, "query")?;
                let limit: Option<u32> = arg(&args, "limit")?;
                let hits = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::session::search_sessions(query, limit, app)
                })
                .await
                .map_err(|e| e.to_string())??;
                to_value(hits)
            }
            "delete_session" => to_value(crate::commands::session::delete_session(
                arg(&args, "tabId")?,
                app,
            )?),
            "fork_session" => to_value(crate::commands::session::fork_session(
                arg(&args, "tabId")?,
                arg(&args, "entryId")?,
                arg(&args, "cwd")?,
                app,
            )?),
            "export_chat_markdown" => to_value(crate::commands::session::export_chat_markdown(
                arg(&args, "label")?,
                arg(&args, "content")?,
                app,
            )?),
            "start_agent" => {
                let state = app.state::<crate::agent_process::AgentProcesses>();
                to_value(crate::agent_commands::start_agent(
                    state.clone(),
                    app.clone(),
                )?)
            }
            "send_message" => {
                let state = app.state::<crate::agent_process::AgentProcesses>();
                let devshell = app.state::<Arc<crate::devshell::DevshellCache>>();
                let startup = app.state::<crate::commands::startup::WorkspaceStartupState>();
                to_value(
                    crate::agent_commands::send_message(
                        arg(&args, "request")?,
                        state.clone(),
                        devshell.clone(),
                        startup.clone(),
                        app.clone(),
                    )
                    .await?,
                )
            }
            "agent_command" => {
                let state = app.state::<crate::agent_process::AgentProcesses>();
                let devshell = app.state::<Arc<crate::devshell::DevshellCache>>();
                let startup = app.state::<crate::commands::startup::WorkspaceStartupState>();
                to_value(
                    crate::agent_commands::agent_command(
                        arg(&args, "payload")?,
                        state.clone(),
                        devshell.clone(),
                        startup.clone(),
                        app.clone(),
                    )
                    .await?,
                )
            }
            "dispatch_a2ui_event" => {
                let state = app.state::<crate::agent_process::AgentProcesses>();
                to_value(
                    crate::agent_commands::dispatch_a2ui_event(
                        arg(&args, "event")?,
                        arg(&args, "tabId")?,
                        state.clone(),
                        app.clone(),
                    )
                    .await?,
                )
            }
            "agent_diagnostics" => {
                let state = app.state::<crate::agent_process::AgentProcesses>();
                to_value(crate::agent_commands::agent_diagnostics(state.clone())?)
            }
            "scheduled_tasks_list" => {
                let state = app.state::<crate::commands::scheduler::ScheduledTasksState>();
                to_value(crate::commands::scheduler::scheduled_tasks_list(
                    state.clone(),
                    app.clone(),
                )?)
            }
            "save_paste_image" => to_value(crate::paste::save_paste_image(
                arg(&args, "bytes")?,
                arg(&args, "extension")?,
                app,
            )?),
            "read_paste_image_base64" => to_value(crate::paste::read_paste_image_base64(
                arg(&args, "path")?,
                app,
            )?),
            "subagents_list" => to_value(crate::commands::subagents::subagents_list(
                arg(&args, "projectRoot")?,
                app,
            )?),
            "remote_status" => {
                let server = app.state::<Arc<crate::server::ServerState>>();
                let remote = app.state::<Arc<super::RemoteState>>();
                to_value(
                    crate::commands::remote::remote_status(server.clone(), remote.clone()).await?,
                )
            }
            // ── shells — the user's own interactive terminals ─────────
            "shell_open" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                let devshell = app.state::<Arc<crate::devshell::DevshellCache>>();
                let startup = app.state::<crate::commands::startup::WorkspaceStartupState>();
                to_value(
                    crate::shell::shell_open(
                        app.clone(),
                        state.clone(),
                        devshell.clone(),
                        startup.clone(),
                        arg(&args, "args")?,
                    )
                    .await?,
                )
            }
            "shell_input" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_input(
                    state.clone(),
                    arg(&args, "tabId")?,
                    arg(&args, "data")?,
                )?)
            }
            "shell_resize" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_resize(
                    state.clone(),
                    arg(&args, "tabId")?,
                    arg(&args, "cols")?,
                    arg(&args, "rows")?,
                )?)
            }
            "shell_close" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_close(
                    state.clone(),
                    arg(&args, "tabId")?,
                )?)
            }
            "shell_is_busy" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_is_busy(
                    state.clone(),
                    arg(&args, "tabId")?,
                )?)
            }
            "shell_set_share_mode" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_set_share_mode(
                    state.clone(),
                    arg(&args, "tabId")?,
                    arg(&args, "mode")?,
                )?)
            }
            "shell_read_scrollback" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_read_scrollback(
                    state.clone(),
                    arg(&args, "args")?,
                )?)
            }
            "shell_list_shareable" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_list_shareable(state.clone())?)
            }
            "shell_write" => {
                let state = app.state::<crate::shell::ShellRegistry>();
                to_value(crate::shell::shell_write(
                    state.clone(),
                    arg(&args, "tabId")?,
                    arg(&args, "data")?,
                )?)
            }
            // ── fs — root-validated above; the per-path jail applies
            //    inside each command ─────────────────────────────────
            "fs_list_dir" => to_value(crate::commands::fs::fs_list_dir(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_walk_project" => {
                let root: String = arg(&args, "root")?;
                let files = tauri::async_runtime::spawn_blocking(move || {
                    crate::commands::fs::fs_walk_project(root)
                })
                .await
                .map_err(|e| e.to_string())??;
                to_value(files)
            }
            "fs_read_file" => to_value(crate::commands::fs::fs_read_file(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_read_file_base64" => to_value(crate::commands::fs::fs_read_file_base64(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_exists" => to_value(crate::commands::fs::fs_exists(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_file_mtime" => to_value(crate::commands::fs::fs_file_mtime(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_write_file" => to_value(crate::commands::fs::fs_write_file(
                arg(&args, "root")?,
                arg(&args, "path")?,
                arg(&args, "content")?,
            )?),
            "fs_create_file" => to_value(crate::commands::fs::fs_create_file(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_create_dir" => to_value(crate::commands::fs::fs_create_dir(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_rename" => to_value(crate::commands::fs::fs_rename(
                arg(&args, "root")?,
                arg(&args, "from")?,
                arg(&args, "to")?,
            )?),
            "fs_delete" => to_value(crate::commands::fs::fs_delete(
                arg(&args, "root")?,
                arg(&args, "path")?,
            )?),
            "fs_discover_project_icon" => to_value(
                crate::commands::fs::fs_discover_project_icon(arg(&args, "projectPath")?).await?,
            ),
            // ── git + gh reads ────────────────────────────────────────
            "git_status" => {
                to_value(crate::commands::git::status::git_status(arg(&args, "path")?).await?)
            }
            "git_working_context" => to_value(
                crate::commands::git::status::git_working_context(arg(&args, "cwd")?).await?,
            ),
            "git_fetch_all" => {
                let state = app.state::<crate::commands::git::GitFetchState>();
                to_value(
                    crate::commands::git::status::git_fetch_all(
                        arg(&args, "projectPath")?,
                        state.clone(),
                    )
                    .await?,
                )
            }
            "git_file_status" => {
                to_value(crate::commands::git::status::git_file_status(arg(&args, "root")?).await?)
            }
            "git_ignored_paths" => to_value(
                crate::commands::git::status::git_ignored_paths(arg(&args, "root")?).await?,
            ),
            "git_file_diff" => to_value(
                crate::commands::git::diff::git_file_diff(arg(&args, "root")?, arg(&args, "path")?)
                    .await?,
            ),
            "git_file_diff_hunks" => to_value(
                crate::commands::git::diff::git_file_diff_hunks(
                    arg(&args, "root")?,
                    arg(&args, "path")?,
                )
                .await?,
            ),
            "git_file_diff_stat" => to_value(
                crate::commands::git::diff::git_file_diff_stat(
                    arg(&args, "root")?,
                    arg(&args, "path")?,
                )
                .await?,
            ),
            "git_show_head" => to_value(
                crate::commands::git::diff::git_show_head(arg(&args, "root")?, arg(&args, "path")?)
                    .await?,
            ),
            "git_diff_stat" => {
                to_value(crate::commands::git::diff::git_diff_stat(arg(&args, "root")?).await?)
            }
            "git_worktrees" => to_value(
                crate::commands::git::worktrees::git_worktrees(arg(&args, "projectPath")?).await?,
            ),
            "git_worktree_add" => to_value(
                crate::commands::git::worktrees::git_worktree_add(
                    arg(&args, "projectPath")?,
                    arg(&args, "targetPath")?,
                    arg(&args, "branch")?,
                    arg::<Option<String>>(&args, "base")?,
                )
                .await?,
            ),
            "git_worktree_remove" => to_value(
                crate::commands::git::worktrees::git_worktree_remove(
                    arg(&args, "projectPath")?,
                    arg(&args, "worktreePath")?,
                    arg::<Option<bool>>(&args, "force")?.unwrap_or(false),
                )
                .await?,
            ),
            "git_worktree_remove_orphan" => to_value(
                crate::commands::git::worktrees::git_worktree_remove_orphan(
                    arg(&args, "projectPath")?,
                    arg(&args, "worktreePath")?,
                )
                .await?,
            ),
            "git_branch_list" => to_value(
                crate::commands::git::worktrees::git_branch_list(arg(&args, "projectPath")?)
                    .await?,
            ),
            "gh_branch_status" => to_value(
                crate::commands::git::github::gh_branch_status(
                    arg(&args, "projectPath")?,
                    arg(&args, "branch")?,
                )
                .await?,
            ),
            "gh_checks" => to_value(
                crate::commands::git::checks::gh_checks(
                    arg(&args, "projectPath")?,
                    arg(&args, "branch")?,
                )
                .await?,
            ),
            "gh_repo_overview" => to_value(
                crate::commands::git::github::gh_repo_overview(arg(&args, "projectPath")?).await?,
            ),
            "gh_repo_avatar_url" => to_value(
                crate::commands::git::github::gh_repo_avatar_url(arg(&args, "projectPath")?).await,
            ),
            "gh_issue_list" => to_value(
                crate::commands::git::issues::gh_issue_list(
                    arg(&args, "projectPath")?,
                    arg(&args, "limit")?,
                )
                .await,
            ),
            "gh_issue_view" => to_value(
                crate::commands::git::issues::gh_issue_view(
                    arg(&args, "projectPath")?,
                    arg(&args, "number")?,
                )
                .await?,
            ),
            "read_issue_templates" => to_value(crate::commands::config::read_issue_templates(
                arg(&args, "projectPath")?,
            )?),
            other => Err(format!(
                "no dispatch arm for `{other}` — policy table and relay disagree"
            )),
        }
    }
}

/// Test double: records nothing, denies nothing, answers with a canned
/// value so WS tests can assert plumbing without a Tauri runtime.
#[cfg(test)]
pub struct EchoRelay;

#[cfg(test)]
#[async_trait]
impl RelayExec for EchoRelay {
    async fn invoke(&self, cmd: &str, args: Value) -> Result<Value, String> {
        Ok(serde_json::json!({ "cmd": cmd, "args": args }))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::super::policy::{COMMAND_POLICIES, RemotePolicy};
    use super::*;

    /// The declarative gate (policy.rs) and the dispatch table (this
    /// file) must agree exactly on what executes directly.
    #[test]
    fn dispatch_arms_match_policy_allowlist() {
        let allowed: HashSet<&str> = COMMAND_POLICIES
            .iter()
            .filter(|(_, p)| {
                matches!(
                    p,
                    RemotePolicy::Direct
                        | RemotePolicy::DirectFiltered
                        | RemotePolicy::DirectRootChecked
                )
            })
            .map(|(name, _)| *name)
            .collect();
        let dispatchable: HashSet<&str> = DISPATCHABLE.iter().copied().collect();
        assert_eq!(
            allowed, dispatchable,
            "policy allowlist and relay dispatch arms drifted"
        );
    }

    #[test]
    fn arg_extraction_reports_key_and_reason() {
        let args = serde_json::json!({ "name": 42 });
        let err = arg::<String>(&args, "name").expect_err("type mismatch");
        assert!(err.contains("`name`"), "got: {err}");
        let missing: Option<String> = arg(&args, "absent").expect("optional args parse as None");
        assert!(missing.is_none());
    }
}
