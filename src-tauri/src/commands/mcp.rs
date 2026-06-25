//! MCP configuration approval commands.
//!
//! The agent side resolves host/project MCP config and writes a generated
//! pi-mcp-adapter config. These commands expose the same project trust
//! decision to the frontend without letting repo-controlled files approve
//! themselves.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager};

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
    let home_dir = app.path().home_dir().ok();
    Ok(status_for_root(
        &root,
        &host_policy,
        &store,
        &host_text,
        home_dir.as_deref(),
    ))
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
    let home_dir = app.path().home_dir().ok();
    let host_project_imports =
        host_project_import_fingerprint_entries(&root, &host_text, home_dir.as_deref());
    let current = project_fingerprint(&root, &sources, &host_project_imports, home_dir.as_deref());
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
    Ok(status_for_root(
        &root,
        &host_policy,
        &store,
        &host_text,
        home_dir.as_deref(),
    ))
}

fn status_for_root(
    root: &Path,
    host_policy: &HostMcpPolicy,
    store: &ApprovalStore,
    host_text: &str,
    home_dir: Option<&Path>,
) -> McpConfigStatus {
    let sources = discover_project_sources(root);
    let host_project_imports = host_project_import_fingerprint_entries(root, host_text, home_dir);
    let fingerprint = project_fingerprint(root, &sources, &host_project_imports, home_dir);
    let key = root.display().to_string();
    let stored = store.approvals.get(&key);
    let approved = host_policy.project_config_mode == ProjectConfigMode::AutoLoad
        || fingerprint
            .as_ref()
            .zip(stored)
            .is_some_and(|(current, stored)| current == stored);
    let required = host_policy.enabled
        && host_policy.project_config_mode != ProjectConfigMode::Never
        && (!sources.is_empty() || !host_project_imports.is_empty());
    let has_project_sources = !sources.is_empty() || !host_project_imports.is_empty();
    let state = if !host_policy.enabled {
        "disabled"
    } else if !has_project_sources {
        "no_config"
    } else if host_policy.project_config_mode == ProjectConfigMode::Never {
        "ignored"
    } else if approved {
        "approved"
    } else {
        "approval_required"
    };
    let servers = effective_servers(host_policy, approved, host_text, &sources, root, home_dir);

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
            .chain(
                host_project_imports
                    .iter()
                    .map(|(relative_path, _text)| McpProjectSource {
                        kind: "host-import".to_string(),
                        relative_path: relative_path.clone(),
                        path: root.join(relative_path).display().to_string(),
                    }),
            )
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
    match read_limited_text(&path) {
        Ok(Some(text)) => Ok(text),
        Ok(None) => Ok(String::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn read_limited_text(path: &Path) -> std::io::Result<Option<String>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::with_capacity(MCP_CONFIG_MAX_BYTES);
    file.take(MCP_CONFIG_MAX_BYTES as u64)
        .read_to_end(&mut bytes)?;
    while std::str::from_utf8(&bytes).is_err() {
        bytes.pop();
    }
    Ok(Some(String::from_utf8(bytes).unwrap_or_default()))
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
            let safe_path = match safe_project_file_path(root, &path) {
                Some(path) => path,
                None => return None,
            };
            let text = match read_limited_text(&safe_path) {
                Ok(Some(text)) => text,
                Ok(None) => return None,
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

fn project_import_fingerprint_entries(
    root: &Path,
    sources: &[ProjectSource],
    home_dir: Option<&Path>,
) -> Vec<(String, String)> {
    let imports = sources
        .iter()
        .flat_map(|source| {
            if source.kind == "aethon-toml" {
                parse_toml_imports(&source.text)
            } else {
                parse_json_imports(&source.text)
            }
        })
        .collect::<Vec<_>>();
    project_import_entries_for_imports(root, imports, home_dir)
}

fn host_project_import_fingerprint_entries(
    root: &Path,
    host_text: &str,
    home_dir: Option<&Path>,
) -> Vec<(String, String)> {
    project_import_entries_for_imports(root, parse_toml_imports(host_text), home_dir)
}

fn project_import_entries_for_imports(
    root: &Path,
    imports: Vec<String>,
    home_dir: Option<&Path>,
) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    for import_name in imports {
        let Some(path) = import_paths(&import_name, root, home_dir)
            .into_iter()
            .find_map(|path| safe_project_file_path(root, &path))
        else {
            continue;
        };
        let canonical = path;
        if !canonical.starts_with(&canonical_root) || !seen.insert(canonical.clone()) {
            continue;
        }
        let text = match read_limited_text(&canonical) {
            Ok(Some(text)) => text,
            Ok(None) => continue,
            Err(e) => {
                tracing::warn!(
                    target: "aethon::mcp",
                    "read {} failed: {e}; skipping imported MCP fingerprint source",
                    canonical.display()
                );
                continue;
            }
        };
        let relative = canonical
            .strip_prefix(&canonical_root)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| canonical.display().to_string());
        entries.push((relative, text));
    }
    entries
}

fn effective_servers(
    host_policy: &HostMcpPolicy,
    project_approved: bool,
    host_text: &str,
    sources: &[ProjectSource],
    root: &Path,
    home_dir: Option<&Path>,
) -> Vec<DiscoveredServer> {
    if !host_policy.enabled {
        return Vec::new();
    }
    let mut servers: BTreeMap<String, DiscoveredServer> = BTreeMap::new();
    let host_imports = parse_toml_imports(host_text);
    let mut project_direct_servers = Vec::new();
    let mut project_imports = Vec::new();

    for import_name in &host_imports {
        if is_project_import(import_name, root, home_dir) {
            continue;
        }
        for server in read_import_servers(import_name, root, home_dir) {
            servers.entry(server.name.clone()).or_insert(server);
        }
    }
    if host_policy.project_config_mode != ProjectConfigMode::Never && project_approved {
        for import_name in host_imports
            .iter()
            .filter(|name| is_project_import(name, root, home_dir))
        {
            for server in read_import_servers(import_name, root, home_dir) {
                servers.entry(server.name.clone()).or_insert(server);
            }
        }
        for source in sources {
            let imports = if source.kind == "aethon-toml" {
                parse_toml_imports(&source.text)
            } else {
                parse_json_imports(&source.text)
            };
            project_imports.extend(imports);
            let discovered = if source.kind == "aethon-toml" {
                parse_toml_servers(&source.text, source.kind, source.relative_path)
            } else {
                parse_json_servers(&source.text, source.kind, source.relative_path)
            };
            project_direct_servers.extend(discovered);
        }
        for server in project_imports
            .into_iter()
            .flat_map(|name| read_project_import_servers(&name, root, home_dir))
        {
            servers.entry(server.name.clone()).or_insert(server);
        }
    }
    for server in parse_toml_servers(host_text, "host-toml", "~/.aethon/config.toml") {
        servers.insert(server.name.clone(), server);
    }
    for server in project_direct_servers {
        servers.insert(server.name.clone(), server);
    }
    servers.into_values().collect()
}

fn is_project_import(import_name: &str, root: &Path, home_dir: Option<&Path>) -> bool {
    if import_name == "vscode" || import_name.starts_with("./") || import_name.starts_with("../") {
        return true;
    }
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    import_paths(import_name, root, home_dir)
        .into_iter()
        .filter(|path| path.exists())
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .any(|path| path.starts_with(&canonical_root))
}

fn parse_toml_imports(text: &str) -> Vec<String> {
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
    raw_mcp
        .get("imports")
        .and_then(toml::Value::as_array)
        .map(|imports| {
            imports
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_json_imports(text: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    parsed
        .get("imports")
        .and_then(serde_json::Value::as_array)
        .map(|imports| {
            imports
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn read_import_servers(
    import_name: &str,
    root: &Path,
    home_dir: Option<&Path>,
) -> Vec<DiscoveredServer> {
    import_paths(import_name, root, home_dir)
        .into_iter()
        .find_map(|path| {
            let project_import = is_project_import(import_name, root, home_dir);
            let read_path = if project_import {
                safe_project_file_path(root, &path)?
            } else {
                path.clone()
            };
            let text = match read_limited_text(&read_path) {
                Ok(Some(text)) => text,
                Ok(None) => return None,
                Err(e) => {
                    tracing::warn!(
                        target: "aethon::mcp",
                        "read {} failed: {e}; skipping imported MCP config",
                        path.display()
                    );
                    return None;
                }
            };
            let source_kind = format!("import:{import_name}");
            let source_path = display_source_path(&read_path, root);
            let servers = if read_path.extension().is_some_and(|ext| ext == "toml") {
                parse_toml_servers(&text, &source_kind, &source_path)
            } else {
                parse_json_servers(&text, &source_kind, &source_path)
            };
            Some(servers)
        })
        .unwrap_or_default()
}

fn read_project_import_servers(
    import_name: &str,
    root: &Path,
    home_dir: Option<&Path>,
) -> Vec<DiscoveredServer> {
    import_paths(import_name, root, home_dir)
        .into_iter()
        .filter_map(|path| safe_project_file_path(root, &path))
        .find_map(|path| {
            let text = match read_limited_text(&path) {
                Ok(Some(text)) => text,
                Ok(None) => return None,
                Err(e) => {
                    tracing::warn!(
                        target: "aethon::mcp",
                        "read {} failed: {e}; skipping project MCP import",
                        path.display()
                    );
                    return None;
                }
            };
            let source_kind = format!("import:{import_name}");
            let source_path = display_source_path(&path, root);
            let servers = if path.extension().is_some_and(|ext| ext == "toml") {
                parse_toml_servers(&text, &source_kind, &source_path)
            } else {
                parse_json_servers(&text, &source_kind, &source_path)
            };
            Some(servers)
        })
        .unwrap_or_default()
}

fn display_source_path(path: &Path, root: &Path) -> String {
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical_path
        .strip_prefix(canonical_root)
        .map(|relative| relative.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

fn import_paths(import_name: &str, root: &Path, home_dir: Option<&Path>) -> Vec<PathBuf> {
    match import_name {
        "claude-code" => home_dir
            .map(|home| {
                vec![
                    home.join(".claude").join("mcp.json"),
                    home.join(".claude.json"),
                    home.join(".claude").join("claude_desktop_config.json"),
                ]
            })
            .unwrap_or_default(),
        "claude-desktop" => home_dir
            .map(|home| {
                vec![
                    home.join("Library")
                        .join("Application Support")
                        .join("Claude")
                        .join("claude_desktop_config.json"),
                ]
            })
            .unwrap_or_default(),
        "codex" => home_dir
            .map(|home| vec![home.join(".codex").join("config.json")])
            .unwrap_or_default(),
        "cursor" => home_dir
            .map(|home| vec![home.join(".cursor").join("mcp.json")])
            .unwrap_or_default(),
        "vscode" => vec![root.join(".vscode").join("mcp.json")],
        "windsurf" => home_dir
            .map(|home| vec![home.join(".windsurf").join("mcp.json")])
            .unwrap_or_default(),
        other if other.starts_with("./") || other.starts_with("../") => vec![root.join(other)],
        other if Path::new(other).is_absolute() => vec![PathBuf::from(other)],
        _ => Vec::new(),
    }
}

fn safe_project_file_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let canonical_root = std::fs::canonicalize(root).ok()?;
    let canonical_path = std::fs::canonicalize(path).ok()?;
    if canonical_path.starts_with(canonical_root) && canonical_path.is_file() {
        Some(canonical_path)
    } else {
        None
    }
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
        .or_else(|| parsed.get("mcp-servers"))
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

fn project_fingerprint(
    root: &Path,
    sources: &[ProjectSource],
    host_project_imports: &[(String, String)],
    home_dir: Option<&Path>,
) -> Option<String> {
    if sources.is_empty() && host_project_imports.is_empty() {
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
    for (relative_path, text) in project_import_fingerprint_entries(root, sources, home_dir) {
        sha.update(relative_path.as_bytes());
        sha.update(b"\0");
        sha.update(text.as_bytes());
        sha.update(b"\0");
    }
    for (relative_path, text) in host_project_imports {
        sha.update(relative_path.as_bytes());
        sha.update(b"\0");
        sha.update(text.as_bytes());
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
    fn read_limited_text_reads_only_capped_valid_utf8_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(".mcp.json");
        let mut bytes = vec![b'a'; MCP_CONFIG_MAX_BYTES - 1];
        bytes.extend_from_slice("étail".as_bytes());
        std::fs::write(&path, bytes).expect("write oversized config");

        let text = read_limited_text(&path)
            .expect("read")
            .expect("config exists");

        assert_eq!(text.len(), MCP_CONFIG_MAX_BYTES - 1);
        assert!(text.chars().all(|ch| ch == 'a'));
        assert!(!text.contains("tail"));
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
            project_fingerprint(root, &sources, &[], None),
            project_fingerprint(root, &changed, &[], None)
        );
    }

    #[test]
    fn project_fingerprint_changes_with_imported_project_file_contents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join(".aethon")).expect("mkdir .aethon");
        std::fs::create_dir_all(root.join(".vscode")).expect("mkdir .vscode");
        std::fs::write(
            root.join(".aethon/mcp.toml"),
            "[mcp]\nimports = [\"vscode\"]\n",
        )
        .expect("write mcp.toml");
        std::fs::write(
            root.join(".vscode/mcp.json"),
            r#"{"mcpServers":{"alpha":{"command":"node"}}}"#,
        )
        .expect("write vscode mcp");
        let sources = discover_project_sources(root);
        let before = project_fingerprint(root, &sources, &[], None);

        std::fs::write(
            root.join(".vscode/mcp.json"),
            r#"{"mcpServers":{"beta":{"command":"node"}}}"#,
        )
        .expect("rewrite vscode mcp");

        assert_ne!(before, project_fingerprint(root, &sources, &[], None));
    }

    #[test]
    fn status_requires_approval_for_untrusted_project_files() {
        let root = Path::new("/tmp/aethon-mcp-project");
        let fingerprint = "abc".to_string();
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint.clone());
        let status = status_for_root(root, &HostMcpPolicy::default(), &store, "", None);

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
        let fingerprint = project_fingerprint(root, &sources, &[], None).expect("fingerprint");
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint);

        let status = status_for_root(
            root,
            &HostMcpPolicy::default(),
            &store,
            "[mcp.servers.host]\ncommand = \"host-mcp\"\n",
            None,
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

    #[test]
    fn status_lists_imported_servers_from_host_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&root).expect("mkdir project");
        std::fs::create_dir_all(home.join(".claude")).expect("mkdir claude");
        std::fs::write(
            home.join(".claude/mcp.json"),
            r#"{"mcpServers":{"query":{"command":"nix","args":["run"]}}}"#,
        )
        .expect("write imported mcp");

        let status = status_for_root(
            &root,
            &HostMcpPolicy::default(),
            &ApprovalStore::default(),
            "[mcp]\nimports = [\"claude-code\"]\n",
            Some(&home),
        );

        assert_eq!(
            status
                .servers
                .iter()
                .map(|server| (
                    server.name.as_str(),
                    server.source_kind.as_str(),
                    server.transport.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![("query", "import:claude-code", "stdio")]
        );
    }

    #[test]
    fn status_requires_approval_for_host_project_imports() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        std::fs::create_dir_all(root.join(".vscode")).expect("mkdir vscode");
        std::fs::write(
            root.join(".vscode/mcp.json"),
            r#"{"mcpServers":{"workspace":{"command":"node"}}}"#,
        )
        .expect("write vscode mcp");

        let status = status_for_root(
            &root,
            &HostMcpPolicy::default(),
            &ApprovalStore::default(),
            "[mcp]\nimports = [\"vscode\"]\n",
            None,
        );

        assert_eq!(status.state, "approval_required");
        assert!(status.required);
        assert!(!status.approved);
        assert_eq!(
            status
                .sources
                .iter()
                .map(|source| source.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![".vscode/mcp.json"]
        );
        assert!(status.servers.is_empty());
    }

    #[test]
    fn status_loads_host_project_imports_after_approval() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        std::fs::create_dir_all(root.join(".vscode")).expect("mkdir vscode");
        std::fs::write(
            root.join(".vscode/mcp.json"),
            r#"{"mcpServers":{"workspace":{"command":"node"}}}"#,
        )
        .expect("write vscode mcp");
        let host = "[mcp]\nimports = [\"vscode\"]\n";
        let fingerprint = project_fingerprint(
            &root,
            &[],
            &host_project_import_fingerprint_entries(&root, host, None),
            None,
        )
        .expect("fingerprint");
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint);

        let status = status_for_root(&root, &HostMcpPolicy::default(), &store, host, None);

        assert_eq!(status.state, "approved");
        assert_eq!(
            status
                .servers
                .iter()
                .map(|server| (server.name.as_str(), server.source_path.as_str()))
                .collect::<Vec<_>>(),
            vec![("workspace", ".vscode/mcp.json")]
        );
    }

    #[test]
    fn status_loads_relative_project_imports_after_approval() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        std::fs::create_dir_all(root.join("tools")).expect("mkdir tools");
        std::fs::write(
            root.join(".mcp.json"),
            r#"{"imports":["./tools/mcp.toml"]}"#,
        )
        .expect("write .mcp.json");
        std::fs::write(
            root.join("tools/mcp.toml"),
            "[mcp.servers.local]\ncommand = \"node\"\n",
        )
        .expect("write relative import");
        let sources = discover_project_sources(&root);
        let fingerprint = project_fingerprint(&root, &sources, &[], None).expect("fingerprint");
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint);

        let status = status_for_root(&root, &HostMcpPolicy::default(), &store, "", None);

        assert_eq!(status.state, "approved");
        assert_eq!(
            status
                .servers
                .iter()
                .map(|server| (server.name.as_str(), server.source_path.as_str()))
                .collect::<Vec<_>>(),
            vec![("local", "tools/mcp.toml")]
        );
    }

    #[test]
    fn status_rejects_relative_project_imports_that_escape_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).expect("mkdir project");
        std::fs::write(root.join(".mcp.json"), r#"{"imports":["../outside.json"]}"#)
            .expect("write .mcp.json");
        std::fs::write(
            dir.path().join("outside.json"),
            r#"{"mcpServers":{"escaped":{"command":"node"}}}"#,
        )
        .expect("write outside import");
        let sources = discover_project_sources(&root);
        let fingerprint = project_fingerprint(&root, &sources, &[], None).expect("fingerprint");
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint);

        let status = status_for_root(&root, &HostMcpPolicy::default(), &store, "", None);

        assert_eq!(status.state, "approved");
        assert!(status.servers.is_empty());
    }

    #[test]
    fn status_direct_servers_override_imported_servers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        std::fs::create_dir_all(root.join("tools")).expect("mkdir tools");
        std::fs::write(
            root.join(".mcp.json"),
            r#"{"imports":["./tools/mcp.json"]}"#,
        )
        .expect("write .mcp.json");
        std::fs::write(
            root.join("tools/mcp.json"),
            r#"{"mcpServers":{"duplicate":{"command":"imported"}}}"#,
        )
        .expect("write imported config");
        let sources = discover_project_sources(&root);
        let fingerprint = project_fingerprint(&root, &sources, &[], None).expect("fingerprint");
        let mut store = ApprovalStore::default();
        store
            .approvals
            .insert(root.display().to_string(), fingerprint);

        let status = status_for_root(
            &root,
            &HostMcpPolicy::default(),
            &store,
            "[mcp.servers.duplicate]\ncommand = \"host\"\n",
            None,
        );

        assert_eq!(
            status
                .servers
                .iter()
                .map(|server| (server.name.as_str(), server.command.as_deref()))
                .collect::<Vec<_>>(),
            vec![("duplicate", Some("host"))]
        );
    }

    #[cfg(unix)]
    #[test]
    fn status_skips_symlinked_project_sources_that_escape_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).expect("mkdir project");
        std::fs::write(
            dir.path().join("outside.json"),
            r#"{"mcpServers":{"escaped":{"command":"node"}}}"#,
        )
        .expect("write outside config");
        std::os::unix::fs::symlink(dir.path().join("outside.json"), root.join(".mcp.json"))
            .expect("symlink outside config");

        let status = status_for_root(
            &root,
            &HostMcpPolicy {
                enabled: true,
                project_config_mode: ProjectConfigMode::AutoLoad,
            },
            &ApprovalStore::default(),
            "",
            None,
        );

        assert_eq!(status.state, "no_config");
        assert!(status.sources.is_empty());
        assert!(status.servers.is_empty());
    }

    #[test]
    fn status_ignores_host_project_imports_when_project_configs_disabled() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        std::fs::create_dir_all(root.join(".vscode")).expect("mkdir vscode");
        std::fs::write(
            root.join(".vscode/mcp.json"),
            r#"{"mcpServers":{"workspace":{"command":"node"}}}"#,
        )
        .expect("write vscode mcp");

        let status = status_for_root(
            &root,
            &HostMcpPolicy {
                enabled: true,
                project_config_mode: ProjectConfigMode::Never,
            },
            &ApprovalStore::default(),
            "[mcp]\nproject_configs = \"never\"\nimports = [\"vscode\"]\n",
            None,
        );

        assert_eq!(status.state, "ignored");
        assert!(!status.required);
        assert!(status.servers.is_empty());
    }

    #[test]
    fn status_lists_claude_code_servers_from_legacy_home_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("project");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&root).expect("mkdir project");
        std::fs::create_dir_all(&home).expect("mkdir home");
        std::fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"legacy":{"url":"http://localhost:3001/mcp"}}}"#,
        )
        .expect("write imported mcp");

        let status = status_for_root(
            &root,
            &HostMcpPolicy::default(),
            &ApprovalStore::default(),
            "[mcp]\nimports = [\"claude-code\"]\n",
            Some(&home),
        );

        assert_eq!(
            status
                .servers
                .iter()
                .map(|server| (
                    server.name.as_str(),
                    server.source_kind.as_str(),
                    server.transport.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![("legacy", "import:claude-code", "http")]
        );
    }
}
