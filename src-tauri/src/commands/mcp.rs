//! MCP configuration approval commands.
//!
//! The agent side resolves host/project MCP config and writes a generated
//! pi-mcp-adapter config. These commands expose the same project trust
//! decision to the frontend without letting repo-controlled files approve
//! themselves.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::AppHandle;

const MCP_CONFIG_MAX_BYTES: usize = 256 * 1024;
const MCP_APPROVALS_FILE: &str = "mcp-approvals.json";

const PROJECT_CONFIGS: [(&str, &str); 3] = [
    ("claude-json", ".mcp.json"),
    ("pi-json", ".pi/mcp.json"),
    ("aethon-toml", ".aethon/mcp.toml"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectSource {
    pub kind: String,
    pub relative_path: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub name: String,
    pub source_kind: String,
    pub source_path: String,
    pub transport: String,
    pub command: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigStatus {
    pub root: String,
    pub fingerprint: Option<String>,
    pub state: String,
    pub required: bool,
    pub approved: bool,
    pub enabled: bool,
    pub project_config_mode: String,
    pub sources: Vec<McpProjectSource>,
    pub servers: Vec<McpServerSummary>,
    pub warning: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct ApprovalStore {
    #[serde(default)]
    approvals: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct ProjectSource {
    kind: &'static str,
    relative_path: &'static str,
    path: PathBuf,
    text: String,
}

#[derive(Debug, Clone)]
struct DiscoveredServer {
    name: String,
    source_kind: String,
    source_path: String,
    transport: String,
    command: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectConfigMode {
    RequireApproval,
    AutoLoad,
    Never,
}

impl ProjectConfigMode {
    fn as_str(self) -> &'static str {
        match self {
            ProjectConfigMode::RequireApproval => "require-approval",
            ProjectConfigMode::AutoLoad => "auto-load",
            ProjectConfigMode::Never => "never",
        }
    }
}

#[derive(Debug, Clone)]
struct HostMcpPolicy {
    enabled: bool,
    project_config_mode: ProjectConfigMode,
}

impl Default for HostMcpPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            project_config_mode: ProjectConfigMode::RequireApproval,
        }
    }
}

#[tauri::command]
pub fn mcp_config_status(root: String, app: AppHandle) -> Result<McpConfigStatus, String> {
    let root = canonicalize_root(Path::new(&root));
    let host_text = read_host_mcp_text(&app)?;
    let host_policy = parse_host_mcp_policy(&host_text);
    let store = read_approval_store(&app)?;
    Ok(status_for_root(&root, &host_policy, &store, &host_text))
}

#[tauri::command]
pub fn mcp_config_approve(
    root: String,
    fingerprint: String,
    app: AppHandle,
) -> Result<McpConfigStatus, String> {
    let root = canonicalize_root(Path::new(&root));
    let host_text = read_host_mcp_text(&app)?;
    let host_policy = parse_host_mcp_policy(&host_text);
    let sources = discover_project_sources(&root);
    let current = project_fingerprint(&root, &sources);
    if current.as_deref() != Some(fingerprint.as_str()) {
        return Err(
            "MCP project config changed; review the current config before approving".into(),
        );
    }

    let mut store = read_approval_store(&app)?;
    if let Some(current) = current {
        store
            .approvals
            .insert(root.display().to_string(), current.to_string());
    }
    write_approval_store(&app, &store)?;
    Ok(status_for_root(&root, &host_policy, &store, &host_text))
}

fn status_for_root(
    root: &Path,
    host_policy: &HostMcpPolicy,
    store: &ApprovalStore,
    host_text: &str,
) -> McpConfigStatus {
    let sources = discover_project_sources(root);
    let fingerprint = project_fingerprint(root, &sources);
    let key = root.display().to_string();
    let stored = store.approvals.get(&key);
    let approved = host_policy.project_config_mode == ProjectConfigMode::AutoLoad
        || fingerprint
            .as_ref()
            .zip(stored)
            .is_some_and(|(current, stored)| current == stored);
    let required = host_policy.enabled
        && host_policy.project_config_mode != ProjectConfigMode::Never
        && !sources.is_empty();
    let state = if !host_policy.enabled {
        "disabled"
    } else if sources.is_empty() {
        "no_config"
    } else if host_policy.project_config_mode == ProjectConfigMode::Never {
        "ignored"
    } else if approved {
        "approved"
    } else {
        "approval_required"
    };
    let servers = effective_servers(host_policy, approved, host_text, &sources);

    McpConfigStatus {
        root: key,
        fingerprint,
        state: state.to_string(),
        required,
        approved: required && approved,
        enabled: host_policy.enabled,
        project_config_mode: host_policy.project_config_mode.as_str().to_string(),
        sources: sources
            .iter()
            .map(|source| McpProjectSource {
                kind: source.kind.to_string(),
                relative_path: source.relative_path.to_string(),
                path: source.path.display().to_string(),
            })
            .collect(),
        servers: servers
            .into_iter()
            .map(|server| McpServerSummary {
                name: server.name,
                source_kind: server.source_kind,
                source_path: server.source_path,
                transport: server.transport,
                command: server.command,
                url: server.url,
            })
            .collect(),
        warning: None,
    }
}

fn read_host_mcp_text(app: &AppHandle) -> Result<String, String> {
    let path = crate::commands::config::aethon_state_path(app, "config.toml")?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(truncate_utf8(text, MCP_CONFIG_MAX_BYTES)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn parse_host_mcp_policy(input: &str) -> HostMcpPolicy {
    let parsed = match input.parse::<toml::Value>() {
        Ok(parsed) => parsed,
        Err(_) => return HostMcpPolicy::default(),
    };
    let Some(mcp) = parsed.get("mcp").and_then(toml::Value::as_table) else {
        return HostMcpPolicy::default();
    };
    let enabled = mcp
        .get("enabled")
        .and_then(toml::Value::as_bool)
        .unwrap_or(true);
    let project_config_mode = match mcp.get("project_configs").and_then(toml::Value::as_str) {
        Some("auto-load" | "auto_load" | "always") => ProjectConfigMode::AutoLoad,
        Some("never" | "disabled") => ProjectConfigMode::Never,
        _ => ProjectConfigMode::RequireApproval,
    };
    HostMcpPolicy {
        enabled,
        project_config_mode,
    }
}

fn discover_project_sources(root: &Path) -> Vec<ProjectSource> {
    PROJECT_CONFIGS
        .iter()
        .filter_map(|(kind, relative_path)| {
            let path = root.join(relative_path);
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => truncate_utf8(text, MCP_CONFIG_MAX_BYTES),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
                Err(e) => {
                    tracing::warn!(
                        target: "aethon::mcp",
                        "read {} failed: {e}; skipping project MCP config",
                        path.display()
                    );
                    return None;
                }
            };
            Some(ProjectSource {
                kind,
                relative_path,
                path,
                text,
            })
        })
        .collect()
}

fn effective_servers(
    host_policy: &HostMcpPolicy,
    project_approved: bool,
    host_text: &str,
    sources: &[ProjectSource],
) -> Vec<DiscoveredServer> {
    if !host_policy.enabled {
        return Vec::new();
    }
    let mut servers: BTreeMap<String, DiscoveredServer> = BTreeMap::new();
    for server in parse_toml_servers(host_text, "host-toml", "~/.aethon/config.toml") {
        servers.insert(server.name.clone(), server);
    }
    if host_policy.project_config_mode != ProjectConfigMode::Never && project_approved {
        for source in sources {
            let discovered = if source.kind == "aethon-toml" {
                parse_toml_servers(&source.text, source.kind, source.relative_path)
            } else {
                parse_json_servers(&source.text, source.kind, source.relative_path)
            };
            for server in discovered {
                servers.insert(server.name.clone(), server);
            }
        }
    }
    servers.into_values().collect()
}

fn parse_toml_servers(text: &str, source_kind: &str, source_path: &str) -> Vec<DiscoveredServer> {
    let Ok(parsed) = text.parse::<toml::Value>() else {
        return Vec::new();
    };
    let Some(raw_root) = parsed.as_table() else {
        return Vec::new();
    };
    let raw_mcp = parsed
        .get("mcp")
        .and_then(toml::Value::as_table)
        .unwrap_or(raw_root);
    let Some(servers) = raw_mcp.get("servers").and_then(toml::Value::as_table) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, raw)| {
            let table = raw.as_table()?;
            summarize_server(
                name,
                source_kind,
                source_path,
                table.get("command").and_then(toml::Value::as_str),
                table.get("url").and_then(toml::Value::as_str),
            )
        })
        .collect()
}

fn parse_json_servers(text: &str, source_kind: &str, source_path: &str) -> Vec<DiscoveredServer> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(servers) = parsed
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, raw)| {
            let table = raw.as_object()?;
            summarize_server(
                name,
                source_kind,
                source_path,
                table.get("command").and_then(serde_json::Value::as_str),
                table.get("url").and_then(serde_json::Value::as_str),
            )
        })
        .collect()
}

fn summarize_server(
    name: &str,
    source_kind: &str,
    source_path: &str,
    command: Option<&str>,
    url: Option<&str>,
) -> Option<DiscoveredServer> {
    let command = command.filter(|value| !value.trim().is_empty());
    let url = url.filter(|value| !value.trim().is_empty());
    if command.is_none() && url.is_none() {
        return None;
    }
    Some(DiscoveredServer {
        name: name.to_string(),
        source_kind: source_kind.to_string(),
        source_path: source_path.to_string(),
        transport: if url.is_some() { "http" } else { "stdio" }.to_string(),
        command: command.map(ToString::to_string),
        url: url.map(ToString::to_string),
    })
}

fn project_fingerprint(root: &Path, sources: &[ProjectSource]) -> Option<String> {
    if sources.is_empty() {
        return None;
    }
    let mut sha = Sha1::new();
    sha.update(b"aethon-mcp-v1\0");
    sha.update(root.display().to_string().as_bytes());
    sha.update(b"\0");
    for source in sources {
        sha.update(source.relative_path.as_bytes());
        sha.update(b"\0");
        sha.update(source.text.as_bytes());
        sha.update(b"\0");
    }
    Some(format!("{:x}", sha.finalize()))
}

fn read_approval_store(app: &AppHandle) -> Result<ApprovalStore, String> {
    let path = crate::commands::config::aethon_state_path(app, MCP_APPROVALS_FILE)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ApprovalStore::default()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_approval_store(app: &AppHandle, store: &ApprovalStore) -> Result<(), String> {
    let path = crate::commands::config::aethon_state_path(app, MCP_APPROVALS_FILE)?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

fn canonicalize_root(root: &Path) -> PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

fn truncate_utf8(mut input: String, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input;
    }
    let mut idx = max_bytes;
    while !input.is_char_boundary(idx) {
        idx -= 1;
    }
    input.truncate(idx);
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_host_policy_defaults_to_enabled_with_approval_required() {
        let policy = parse_host_mcp_policy("");
        assert!(policy.enabled);
        assert_eq!(
            policy.project_config_mode,
            ProjectConfigMode::RequireApproval
        );
    }

    #[test]
    fn parse_host_policy_normalizes_modes() {
        let policy = parse_host_mcp_policy("[mcp]\nenabled = false\nproject_configs = \"never\"\n");
        assert!(!policy.enabled);
        assert_eq!(policy.project_config_mode, ProjectConfigMode::Never);

        let policy = parse_host_mcp_policy("[mcp]\nproject_configs = \"auto-load\"\n");
        assert_eq!(policy.project_config_mode, ProjectConfigMode::AutoLoad);
    }

    #[test]
    fn project_fingerprint_changes_with_source_contents() {
        let root = Path::new("/tmp/aethon-mcp-project");
        let sources = vec![ProjectSource {
            kind: "claude-json",
            relative_path: ".mcp.json",
            path: root.join(".mcp.json"),
            text: "{\"mcpServers\":{}}".into(),
        }];
        let changed = vec![ProjectSource {
            text: "{\"mcpServers\":{\"x\":{\"command\":\"node\"}}}".into(),
            ..sources[0].clone()
        }];

        assert_ne!(
            project_fingerprint(root, &sources),
            project_fingerprint(root, &changed)
        );
    }

    #[test]
    fn status_requires_approval_for_untrusted_project_files() {
        let root = Path::new("/tmp/aethon-mcp-project");
        let fingerprint = "abc".to_string();
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint.clone());
        let status = status_for_root(root, &HostMcpPolicy::default(), &store, "");

        assert_eq!(status.state, "no_config");
        assert!(!status.required);
        assert!(!status.approved);
    }

    #[test]
    fn status_lists_effective_servers_after_project_approval() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"query":{"command":"nix","args":["run"]}}}"#,
        )
        .expect("write .mcp.json");
        std::fs::create_dir_all(root.join(".aethon")).expect("mkdir .aethon");
        std::fs::write(
            root.join(".aethon/mcp.toml"),
            "[mcp.servers.remote]\nurl = \"https://mcp.example.test\"\n",
        )
        .expect("write mcp.toml");
        let sources = discover_project_sources(root);
        let fingerprint = project_fingerprint(root, &sources).expect("fingerprint");
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint);

        let status = status_for_root(
            root,
            &HostMcpPolicy::default(),
            &store,
            "[mcp.servers.host]\ncommand = \"host-mcp\"\n",
        );

        assert_eq!(status.state, "approved");
        assert_eq!(
            status
                .servers
                .iter()
                .map(|server| (
                    server.name.as_str(),
                    server.transport.as_str(),
                    server.source_path.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("host", "stdio", "~/.aethon/config.toml"),
                ("query", "stdio", ".mcp.json"),
                ("remote", "http", ".aethon/mcp.toml"),
            ]
        );
    }
}
