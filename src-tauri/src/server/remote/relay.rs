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
}

impl TauriRelay {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
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
                to_value(crate::agent_commands::start_agent(state.clone(), app.clone())?)
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
                    crate::commands::remote::remote_status(server.clone(), remote.clone())
                        .await?,
                )
            }
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
            .filter(|(_, p)| matches!(p, RemotePolicy::Direct | RemotePolicy::DirectFiltered))
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
