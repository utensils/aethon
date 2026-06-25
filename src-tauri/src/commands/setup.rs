//! Guided project setup commands.
//!
//! These commands are intentionally narrow: they write only Aethon-owned
//! project files or explicit host policy keys after a frontend setup flow has
//! asked the user. Detection can happen automatically; mutation should not.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFileStatus {
    exists: bool,
    path: String,
    managed_block: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSetupStatus {
    root: String,
    agents: SetupFileStatus,
    startup: SetupFileStatus,
    mcp_toml: SetupFileStatus,
    claude_mcp_json: SetupFileStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteAgentsArgs {
    root: String,
    body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetHostMcpPolicyArgs {
    enabled: bool,
    project_configs: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteStartupCommandArgs {
    root: String,
    id: String,
    label: String,
    command: String,
    required: bool,
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    path: String,
}

const AGENTS_BEGIN: &str = "<!-- AETHON:BEGIN -->";
const AGENTS_END: &str = "<!-- AETHON:END -->";
const DEFAULT_STARTUP_TIMEOUT_SECONDS: u64 = 600;

#[tauri::command]
pub fn aethon_setup_status(root: String) -> Result<ProjectSetupStatus, String> {
    let root = canonicalize_existing_dir(&root)?;
    Ok(ProjectSetupStatus {
        root: root.display().to_string(),
        agents: file_status(&root.join("AGENTS.md"), Some((AGENTS_BEGIN, AGENTS_END))),
        startup: file_status(&root.join(".aethon").join("startup.toml"), None),
        mcp_toml: file_status(&root.join(".aethon").join("mcp.toml"), None),
        claude_mcp_json: file_status(&root.join(".mcp.json"), None),
    })
}

#[tauri::command]
pub fn aethon_setup_write_agents(args: WriteAgentsArgs) -> Result<WriteResult, String> {
    let root = canonicalize_existing_dir(&args.root)?;
    let path = root.join("AGENTS.md");
    let existing = read_optional(&path)?;
    let block = format!(
        "{AGENTS_BEGIN}\n{}\n{AGENTS_END}",
        args.body.trim().trim_matches('\n')
    );
    let next = replace_managed_block(existing.as_deref().unwrap_or(""), &block);
    std::fs::write(&path, next).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(WriteResult {
        path: path.display().to_string(),
    })
}

#[tauri::command]
pub fn aethon_setup_set_host_mcp_policy(
    args: SetHostMcpPolicyArgs,
    app: AppHandle,
) -> Result<WriteResult, String> {
    let path = crate::commands::config::aethon_state_path(&app, "config.toml")?;
    let existing = read_optional(&path)?.unwrap_or_default();
    let mut doc = parse_toml_doc(&existing, &path)?;
    let table = ensure_table(&mut doc, "mcp");
    table.insert("enabled", toml_edit::value(args.enabled));
    table.insert(
        "project_configs",
        toml_edit::value(normalize_project_configs(&args.project_configs)),
    );
    atomic_write(&path, &doc.to_string())?;
    Ok(WriteResult {
        path: path.display().to_string(),
    })
}

#[tauri::command]
pub fn aethon_setup_import_mcp_json(root: String) -> Result<WriteResult, String> {
    let root = canonicalize_existing_dir(&root)?;
    let source = root.join(".mcp.json");
    let text =
        std::fs::read_to_string(&source).map_err(|e| format!("read {}: {e}", source.display()))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", source.display()))?;
    let servers = parsed
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| ".mcp.json does not contain an mcpServers object".to_string())?;
    let target = root.join(".aethon").join("mcp.toml");
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    let existing = read_optional(&target)?.unwrap_or_default();
    let mut doc = parse_toml_doc(&existing, &target)?;
    let mcp = ensure_table(&mut doc, "mcp");
    let servers_table = ensure_nested_table(mcp, "servers");
    for (name, raw) in servers {
        validate_server_name(name)?;
        let Some(raw_server) = raw.as_object() else {
            continue;
        };
        let mut table = toml_edit::Table::new();
        set_json_string(&mut table, "command", raw_server.get("command"));
        set_json_string(&mut table, "url", raw_server.get("url"));
        set_json_string(&mut table, "cwd", raw_server.get("cwd"));
        set_json_string_array(&mut table, "args", raw_server.get("args"));
        set_json_string_map(&mut table, "env", raw_server.get("env"));
        set_json_string_map(&mut table, "headers", raw_server.get("headers"));
        set_json_value(&mut table, "auth", raw_server.get("auth"));
        set_json_value(&mut table, "oauth", raw_server.get("oauth"));
        set_json_string(
            &mut table,
            "bearer_token",
            raw_server
                .get("bearer_token")
                .or_else(|| raw_server.get("bearerToken")),
        );
        set_json_string(
            &mut table,
            "bearer_token_env",
            raw_server
                .get("bearer_token_env")
                .or_else(|| raw_server.get("bearerTokenEnv")),
        );
        set_json_string(&mut table, "lifecycle", raw_server.get("lifecycle"));
        set_json_number(
            &mut table,
            "idle_timeout_minutes",
            raw_server
                .get("idle_timeout_minutes")
                .or_else(|| raw_server.get("idleTimeout")),
        );
        set_json_bool(
            &mut table,
            "expose_resources",
            raw_server
                .get("expose_resources")
                .or_else(|| raw_server.get("exposeResources")),
        );
        set_json_string_array(
            &mut table,
            "exclude_tools",
            raw_server
                .get("exclude_tools")
                .or_else(|| raw_server.get("excludeTools")),
        );
        set_json_bool(&mut table, "debug", raw_server.get("debug"));
        servers_table.insert_formatted(&toml_edit::Key::new(name), toml_edit::Item::Table(table));
    }
    atomic_write(&target, &doc.to_string())?;
    Ok(WriteResult {
        path: target.display().to_string(),
    })
}

#[tauri::command]
pub fn aethon_setup_write_startup_command(
    args: WriteStartupCommandArgs,
) -> Result<WriteResult, String> {
    let root = canonicalize_existing_dir(&args.root)?;
    let target = root.join(".aethon").join("startup.toml");
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    let existing = read_optional(&target)?.unwrap_or_default();
    let mut doc = parse_toml_doc(&existing, &target)?;
    let startup = ensure_table(&mut doc, "startup");
    if !startup.contains_key("timeout_seconds") {
        startup.insert(
            "timeout_seconds",
            toml_edit::value(DEFAULT_STARTUP_TIMEOUT_SECONDS as i64),
        );
    }
    let commands = ensure_array_of_tables(startup, "commands")?;
    let id = sanitize_id(&args.id);
    let mut table = toml_edit::Table::new();
    table.insert("id", toml_edit::value(id.as_str()));
    table.insert("label", toml_edit::value(args.label.trim()));
    table.insert("command", toml_edit::value(args.command.trim()));
    table.insert("required", toml_edit::value(args.required));
    if let Some(timeout) = args.timeout_seconds.filter(|n| *n > 0) {
        table.insert("timeout_seconds", toml_edit::value(timeout as i64));
    }
    if let Some(existing) = commands
        .iter_mut()
        .find(|item| item.get("id").and_then(toml_edit::Item::as_str) == Some(id.as_str()))
    {
        *existing = table;
    } else {
        commands.push(table);
    }
    atomic_write(&target, &doc.to_string())?;
    Ok(WriteResult {
        path: target.display().to_string(),
    })
}

fn file_status(path: &Path, markers: Option<(&str, &str)>) -> SetupFileStatus {
    let text = read_optional(path).ok().flatten();
    let managed_block = markers
        .zip(text.as_deref())
        .is_some_and(|((begin, end), text)| text.contains(begin) && text.contains(end));
    SetupFileStatus {
        exists: text.is_some(),
        path: path.display().to_string(),
        managed_block,
    }
}

fn canonicalize_existing_dir(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("root {root}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn replace_managed_block(existing: &str, block: &str) -> String {
    if let (Some(begin), Some(end)) = (existing.find(AGENTS_BEGIN), existing.find(AGENTS_END)) {
        let end = end + AGENTS_END.len();
        let mut next = String::new();
        next.push_str(existing[..begin].trim_end());
        if !next.is_empty() {
            next.push_str("\n\n");
        }
        next.push_str(block);
        let tail = existing[end..].trim_start();
        if !tail.is_empty() {
            next.push_str("\n\n");
            next.push_str(tail);
        }
        if !next.ends_with('\n') {
            next.push('\n');
        }
        return next;
    }
    let mut next = existing.trim_end().to_string();
    if !next.is_empty() {
        next.push_str("\n\n");
    }
    next.push_str(block);
    next.push('\n');
    next
}

fn parse_toml_doc(text: &str, path: &Path) -> Result<toml_edit::DocumentMut, String> {
    if text.trim().is_empty() {
        Ok(toml_edit::DocumentMut::new())
    } else {
        text.parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("parse {}: {e}", path.display()))
    }
}

fn ensure_table<'a>(doc: &'a mut toml_edit::DocumentMut, name: &str) -> &'a mut toml_edit::Table {
    if !doc.contains_key(name) {
        doc.insert(name, toml_edit::Item::Table(toml_edit::Table::new()));
    }
    doc.get_mut(name)
        .and_then(toml_edit::Item::as_table_mut)
        .expect("section was just inserted")
}

fn ensure_nested_table<'a>(
    parent: &'a mut toml_edit::Table,
    name: &str,
) -> &'a mut toml_edit::Table {
    if !parent.contains_key(name) {
        parent.insert(name, toml_edit::Item::Table(toml_edit::Table::new()));
    }
    parent
        .get_mut(name)
        .and_then(toml_edit::Item::as_table_mut)
        .expect("section was just inserted")
}

fn ensure_array_of_tables<'a>(
    table: &'a mut toml_edit::Table,
    key: &str,
) -> Result<&'a mut toml_edit::ArrayOfTables, String> {
    if !table.contains_key(key) {
        table.insert(
            key,
            toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new()),
        );
    }
    table
        .get_mut(key)
        .and_then(toml_edit::Item::as_array_of_tables_mut)
        .ok_or_else(|| format!("[startup].{key} must be an array of tables"))
}

fn normalize_project_configs(value: &str) -> &'static str {
    match value {
        "auto-load" | "auto_load" | "always" => "auto-load",
        "never" | "disabled" => "never",
        _ => "require-approval",
    }
}

fn validate_server_name(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("MCP server name must not be empty".to_string());
    }
    if value.chars().any(|ch| ch == '\0' || ch.is_control()) {
        return Err(format!(
            "MCP server name `{value}` contains a control character"
        ));
    }
    Ok(())
}

fn sanitize_id(value: &str) -> String {
    let id: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let id = id.trim_matches('-').to_string();
    if id.is_empty() {
        "command-1".to_string()
    } else {
        id
    }
}

fn set_json_string(table: &mut toml_edit::Table, key: &str, value: Option<&serde_json::Value>) {
    if let Some(value) = value.and_then(serde_json::Value::as_str) {
        table.insert(key, toml_edit::value(value));
    }
}

fn set_json_bool(table: &mut toml_edit::Table, key: &str, value: Option<&serde_json::Value>) {
    if let Some(value) = value.and_then(serde_json::Value::as_bool) {
        table.insert(key, toml_edit::value(value));
    }
}

fn set_json_number(table: &mut toml_edit::Table, key: &str, value: Option<&serde_json::Value>) {
    let Some(value) = value else {
        return;
    };
    if let Some(value) = value.as_i64() {
        table.insert(key, toml_edit::value(value));
    } else if let Some(value) = value.as_f64().filter(|n| n.is_finite()) {
        table.insert(key, toml_edit::value(value));
    }
}

fn set_json_string_array(
    table: &mut toml_edit::Table,
    key: &str,
    value: Option<&serde_json::Value>,
) {
    let Some(values) = value.and_then(serde_json::Value::as_array) else {
        return;
    };
    let mut arr = toml_edit::Array::new();
    for value in values.iter().filter_map(serde_json::Value::as_str) {
        arr.push(value);
    }
    if !arr.is_empty() {
        table.insert(key, toml_edit::value(arr));
    }
}

fn set_json_string_map(table: &mut toml_edit::Table, key: &str, value: Option<&serde_json::Value>) {
    let Some(values) = value.and_then(serde_json::Value::as_object) else {
        return;
    };
    let mut out = toml_edit::Table::new();
    for (name, value) in values {
        if let Some(value) = value.as_str() {
            out.insert(name, toml_edit::value(value));
        }
    }
    if !out.is_empty() {
        table.insert(key, toml_edit::Item::Table(out));
    }
}

fn set_json_value(table: &mut toml_edit::Table, key: &str, value: Option<&serde_json::Value>) {
    let Some(item) = value.and_then(json_to_toml_item) else {
        return;
    };
    table.insert(key, item);
}

fn json_to_toml_item(value: &serde_json::Value) -> Option<toml_edit::Item> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(value) => Some(toml_edit::value(*value)),
        serde_json::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Some(toml_edit::value(value))
            } else {
                value
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .map(toml_edit::value)
            }
        }
        serde_json::Value::String(value) => Some(toml_edit::value(value)),
        serde_json::Value::Array(values) => {
            let mut arr = toml_edit::Array::new();
            for value in values {
                match value {
                    serde_json::Value::Bool(value) => {
                        arr.push(*value);
                    }
                    serde_json::Value::Number(value) => {
                        if let Some(value) = value.as_i64() {
                            arr.push(value);
                        } else if let Some(value) = value.as_f64().filter(|n| n.is_finite()) {
                            arr.push(value);
                        }
                    }
                    serde_json::Value::String(value) => {
                        arr.push(value.as_str());
                    }
                    serde_json::Value::Null
                    | serde_json::Value::Array(_)
                    | serde_json::Value::Object(_) => {}
                }
            }
            Some(toml_edit::value(arr))
        }
        serde_json::Value::Object(values) => {
            let mut out = toml_edit::Table::new();
            for (name, value) in values {
                let Some(item) = json_to_toml_item(value) else {
                    continue;
                };
                if validate_server_name(name).is_ok() {
                    out.insert_formatted(&toml_edit::Key::new(name), item);
                }
            }
            Some(toml_edit::Item::Table(out))
        }
    }
}

fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_block_preserves_user_content() {
        let next = replace_managed_block(
            "# Notes\n\nhello\n",
            "<!-- AETHON:BEGIN -->\nmanaged\n<!-- AETHON:END -->",
        );
        assert!(next.contains("# Notes"));
        assert!(next.contains("hello"));
        assert!(next.contains("managed"));
    }

    #[test]
    fn managed_block_replaces_previous_block() {
        let next = replace_managed_block(
            "top\n\n<!-- AETHON:BEGIN -->\nold\n<!-- AETHON:END -->\n\nbottom\n",
            "<!-- AETHON:BEGIN -->\nnew\n<!-- AETHON:END -->",
        );
        assert!(next.contains("top"));
        assert!(next.contains("bottom"));
        assert!(next.contains("new"));
        assert!(!next.contains("old"));
    }

    #[test]
    fn startup_id_is_safe() {
        assert_eq!(sanitize_id("Dev Server!"), "dev-server");
        assert_eq!(sanitize_id(""), "command-1");
    }

    #[test]
    fn import_mcp_json_preserves_supported_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{
              "mcpServers": {
                "remote": {
                  "url": "https://mcp.example.test",
                  "headers": { "X-Team": "core" },
                  "auth": { "type": "oauth", "scopes": ["repo", "read"] },
                  "oauth": { "clientId": "abc" },
                  "bearerTokenEnv": "MCP_TOKEN",
                  "lifecycle": "lazy",
                  "idleTimeout": 12,
                  "exposeResources": true,
                  "excludeTools": ["delete"],
                  "debug": true
                }
              }
            }"#,
        )
        .expect("write .mcp.json");

        let result =
            aethon_setup_import_mcp_json(dir.path().display().to_string()).expect("import");
        let text = std::fs::read_to_string(result.path).expect("read import");

        assert!(text.contains("url = \"https://mcp.example.test\""));
        assert!(text.contains("bearer_token_env = \"MCP_TOKEN\""));
        assert!(text.contains("lifecycle = \"lazy\""));
        assert!(text.contains("idle_timeout_minutes = 12"));
        assert!(text.contains("expose_resources = true"));
        assert!(text.contains("exclude_tools = [\"delete\"]"));
        assert!(text.contains("debug = true"));
        assert!(text.contains("[mcp.servers.remote.auth]"));
        assert!(text.contains("scopes = [\"repo\", \"read\"]"));
        assert!(text.contains("[mcp.servers.remote.oauth]"));
        assert!(text.contains("[mcp.servers.remote.headers]"));
    }

    #[test]
    fn import_mcp_json_quotes_valid_json_server_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{
              "mcpServers": {
                "demo.server/name": {
                  "command": "node",
                  "args": ["server.js"]
                }
              }
            }"#,
        )
        .expect("write .mcp.json");

        let result =
            aethon_setup_import_mcp_json(dir.path().display().to_string()).expect("import");
        let text = std::fs::read_to_string(result.path).expect("read import");
        let parsed = text
            .parse::<toml_edit::DocumentMut>()
            .expect("generated toml parses");

        assert!(text.contains("\"demo.server/name\""));
        assert_eq!(
            parsed["mcp"]["servers"]["demo.server/name"]["command"].as_str(),
            Some("node")
        );
    }
}
