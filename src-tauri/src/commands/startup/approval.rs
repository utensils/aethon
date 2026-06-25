use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::canonicalize_root;
use super::config::{STARTUP_CONFIG_MAX_BYTES, StartupConfig, truncate_utf8};
use super::status::StartupApprovalPolicy;

const STARTUP_APPROVALS_FILE: &str = "startup-approvals.json";

#[derive(Default, Serialize, Deserialize)]
pub(super) struct ApprovalStore {
    #[serde(default)]
    pub(super) approvals: BTreeMap<String, String>,
    #[serde(default)]
    pub(super) auto_approve_roots: BTreeMap<String, bool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectRegistry {
    #[serde(default)]
    pub(super) projects: Vec<ProjectRegistryProject>,
    #[serde(default)]
    pub(super) workspaces_by_project: BTreeMap<String, Vec<ProjectRegistryWorkspace>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectRegistryProject {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) path: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectRegistryWorkspace {
    pub(super) path: String,
}

pub(super) fn startup_approval_policy(
    app: &AppHandle,
    root: &Path,
    config: &StartupConfig,
    fingerprint: &str,
) -> Result<StartupApprovalPolicy, String> {
    let host_auto_approve = host_startup_auto_approve(app)?;
    let store = read_approval_store(app)?;
    let project_auto_approve = project_startup_auto_approve(app, root, &store);
    let auto_approve = host_auto_approve || project_auto_approve;
    let approved = config.commands.is_empty()
        || auto_approve
        || store
            .approvals
            .get(&root.display().to_string())
            .is_some_and(|stored| stored == fingerprint);
    Ok(StartupApprovalPolicy {
        approved,
        auto_approve,
        host_auto_approve,
        project_auto_approve,
    })
}

pub(super) fn project_startup_auto_approve(
    app: &AppHandle,
    root: &Path,
    store: &ApprovalStore,
) -> bool {
    if store_auto_approves_path(store, root) {
        return true;
    }
    let registry = read_project_registry(app);
    let aethon_dir = app
        .path()
        .home_dir()
        .ok()
        .and_then(|home| crate::helpers::aethon_dir(Some(home)));
    project_auto_approve_for_root(root, store, registry.as_ref(), aethon_dir.as_deref())
}

pub(super) fn project_auto_approve_for_root(
    root: &Path,
    store: &ApprovalStore,
    registry: Option<&ProjectRegistry>,
    aethon_dir: Option<&Path>,
) -> bool {
    if store_auto_approves_path(store, root) {
        return true;
    }
    let Some(registry) = registry else {
        return false;
    };
    for project in &registry.projects {
        let project_path = canonicalize_root(Path::new(&project.path));
        if !store_auto_approves_path(store, &project_path) {
            continue;
        }
        if path_contains(&project_path, root) {
            return true;
        }
        if registry
            .workspaces_by_project
            .get(&project.id)
            .into_iter()
            .flatten()
            .any(|workspace| path_contains(&canonicalize_root(Path::new(&workspace.path)), root))
        {
            return true;
        }
        if let Some(aethon_dir) = aethon_dir {
            let label = project.label.trim();
            if !label.is_empty() && path_contains(&aethon_dir.join(label), root) {
                return true;
            }
        }
    }
    false
}

fn store_auto_approves_path(store: &ApprovalStore, path: &Path) -> bool {
    let path_key = path.display().to_string();
    store
        .auto_approve_roots
        .get(&path_key)
        .copied()
        .unwrap_or(false)
        || store
            .auto_approve_roots
            .iter()
            .any(|(key, enabled)| *enabled && canonicalize_root(Path::new(key)) == path)
}

fn path_contains(parent: &Path, child: &Path) -> bool {
    child == parent || child.starts_with(parent)
}

fn read_project_registry(app: &AppHandle) -> Option<ProjectRegistry> {
    let path = match crate::commands::config::aethon_state_path(app, "projects.json") {
        Ok(path) => path,
        Err(err) => {
            tracing::warn!(
                target: "aethon::startup",
                "resolve projects.json failed: {err}; project startup auto-approve disabled"
            );
            return None;
        }
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(
                target: "aethon::startup",
                "read {} failed: {e}; project startup auto-approve disabled",
                path.display()
            );
            return None;
        }
    };
    match serde_json::from_str(&text) {
        Ok(registry) => Some(registry),
        Err(err) => {
            tracing::warn!(
                target: "aethon::startup",
                "parse {} failed: {err}; project startup auto-approve disabled",
                path.display()
            );
            None
        }
    }
}

fn host_startup_auto_approve(app: &AppHandle) -> Result<bool, String> {
    let path = crate::commands::config::aethon_state_path(app, "config.toml")?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => truncate_utf8(text, STARTUP_CONFIG_MAX_BYTES),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            tracing::warn!(
                target: "aethon::startup",
                "read {} failed: {e}; host startup auto-approve disabled",
                path.display()
            );
            String::new()
        }
    };
    Ok(crate::helpers::parse_host_startup_auto_approve(&text))
}

pub(super) fn write_root_auto_approve(
    app: &AppHandle,
    root: &Path,
    enabled: bool,
) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let mut store = read_approval_store(app)?;
    let key = root.display().to_string();
    if enabled {
        store.auto_approve_roots.insert(key, true);
    } else {
        store.auto_approve_roots.remove(&key);
    }
    write_approval_store(app, &store)
}

pub(super) fn write_approval(
    app: &AppHandle,
    root: &Path,
    fingerprint: &str,
) -> Result<(), String> {
    let mut store = read_approval_store(app)?;
    store
        .approvals
        .insert(root.display().to_string(), fingerprint.to_string());
    write_approval_store(app, &store)
}

pub(super) fn write_approval_store(app: &AppHandle, store: &ApprovalStore) -> Result<(), String> {
    let path = approvals_path(app)?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

fn read_approval_store(app: &AppHandle) -> Result<ApprovalStore, String> {
    let path = approvals_path(app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ApprovalStore::default()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn approvals_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(STARTUP_APPROVALS_FILE))
}
