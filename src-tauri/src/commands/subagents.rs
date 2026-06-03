//! Subagent definition CRUD for the overview UI.
//!
//! Subagents live as one markdown-with-frontmatter file per definition:
//!
//!   ~/.aethon/agents/<name>.md            (user scope, global)
//!   <project>/.aethon/agents/<name>.md    (project scope, overrides user)
//!
//! Rust owns only the **file IO** (list / write / delete) with the usual
//! path-safety guards; *parsing* the frontmatter is the agent bridge's and the
//! frontend's job (a single TS parser, mirrored), so the markdown contract
//! never diverges across two languages. After a mutation we nudge the running
//! bridge(s) with a `subagents_changed` line so the registry re-merges and the
//! system prompt re-advertises without a restart.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::agent_process::AgentProcesses;
use crate::helpers::{self, resolve_inside_root};

/// Hard cap on a single definition file, matching the config.toml convention.
const MAX_SUBAGENT_BYTES: u64 = 64 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFile {
    pub scope: String,
    pub name: String,
    pub file_path: String,
    pub content: String,
}

/// Canonical name shape, mirroring the TS `isSafeSubagentName`:
/// lower-case, `[a-z0-9_-]`, starting alphanumeric, ≤64 chars.
fn is_safe_subagent_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().expect("non-empty checked above");
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn read_capped(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut buf = String::new();
    file.take(MAX_SUBAGENT_BYTES)
        .read_to_string(&mut buf)
        .ok()?;
    Some(buf)
}

/// List every `<safe-name>.md` definition in `dir`, sorted by name. Missing or
/// unreadable directory → empty (no subagents at this scope). Unsafe filenames
/// and oversized files are skipped silently — the bridge surfaces load issues.
fn list_in_dir(dir: &Path, scope: &str) -> Vec<SubagentFile> {
    let mut names: Vec<(String, PathBuf)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if file_name.starts_with('.') || !file_name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let stem = &file_name[..file_name.len() - 3];
        let name = stem.to_ascii_lowercase();
        if !is_safe_subagent_name(&name) {
            continue;
        }
        names.push((name, path));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    names
        .into_iter()
        .filter_map(|(name, path)| {
            read_capped(&path).map(|content| SubagentFile {
                scope: scope.to_string(),
                name,
                file_path: path.to_string_lossy().into_owned(),
                content,
            })
        })
        .collect()
}

/// Atomically write `<name>.md` into `dir` (tmp + rename). Validates the name
/// and size; creates the directory on demand. Returns the written path.
fn write_in_dir(dir: &Path, name: &str, content: &str) -> Result<PathBuf, String> {
    if !is_safe_subagent_name(name) {
        return Err(format!("invalid subagent name: {name}"));
    }
    if content.len() as u64 > MAX_SUBAGENT_BYTES {
        return Err(format!(
            "subagent definition too large ({} bytes; max {MAX_SUBAGENT_BYTES})",
            content.len()
        ));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all {}: {e}", dir.display()))?;
    let target = dir.join(format!("{name}.md"));
    let tmp = dir.join(format!("{name}.md.tmp"));
    std::fs::write(&tmp, content).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        // Best-effort cleanup so a failed rename doesn't strand a .tmp file.
        let _ = std::fs::remove_file(&tmp);
        format!("rename {}: {e}", target.display())
    })?;
    Ok(target)
}

/// Delete `<name>.md` from `dir`. Idempotent — a missing file is success.
fn delete_in_dir(dir: &Path, name: &str) -> Result<(), String> {
    if !is_safe_subagent_name(name) {
        return Err(format!("invalid subagent name: {name}"));
    }
    let target = dir.join(format!("{name}.md"));
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", target.display())),
    }
}

/// Resolve the agents directory for a scope. `user` → `~/.aethon/agents`;
/// `project` → `<project_root>/.aethon/agents` (root must be absolute).
fn scope_agents_dir(
    scope: &str,
    project_root: Option<&str>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    match scope {
        "user" => {
            let home = app
                .path()
                .home_dir()
                .map_err(|e| format!("home_dir: {e}"))?;
            let dir = helpers::aethon_dir(Some(home))
                .ok_or_else(|| "aethon dir unresolved".to_string())?;
            Ok(dir.join("agents"))
        }
        "project" => {
            let root =
                project_root.ok_or_else(|| "project scope requires project_root".to_string())?;
            let root_path = PathBuf::from(root);
            if !root_path.is_absolute() {
                return Err("project_root must be absolute".to_string());
            }
            Ok(root_path.join(".aethon").join("agents"))
        }
        other => Err(format!("invalid scope: {other}")),
    }
}

/// For project scope, refuse a target that escapes the project root — both
/// lexically (the safe-name check already blocks separators) AND via symlinks:
/// if `.aethon` / `.aethon/agents` is a symlink to a directory outside the
/// project, the lexical check passes but the file op would follow it. So we
/// also canonicalize the deepest existing ancestor and verify it still lives
/// under the canonical project root (same defence as the fs commands).
fn assert_inside_project(
    scope: &str,
    project_root: Option<&str>,
    target: &Path,
) -> Result<(), String> {
    if scope != "project" {
        return Ok(());
    }
    let root = PathBuf::from(project_root.ok_or_else(|| "project_root required".to_string())?);
    if resolve_inside_root(&root, target).is_none() {
        return Err("refusing to touch a path outside the project root".to_string());
    }
    let canonical_root =
        std::fs::canonicalize(&root).map_err(|e| format!("canonicalize project root: {e}"))?;
    // Walk up to the deepest component that already exists on disk (the target
    // file usually doesn't yet), then canonicalize it to resolve any symlinks.
    let mut probe: &Path = target;
    let existing = loop {
        if probe.exists() {
            break Some(probe);
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break None,
        }
    };
    if let Some(existing) = existing {
        let canonical = std::fs::canonicalize(existing)
            .map_err(|e| format!("canonicalize {}: {e}", existing.display()))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(
                "refusing to touch a path that escapes the project root via a symlink".to_string(),
            );
        }
    }
    Ok(())
}

/// Nudge every running bridge to re-merge its subagent registry. Best-effort —
/// a wedged child is simply skipped (the next project change / boot re-reads).
fn notify_bridge_subagents_changed(app: &AppHandle) {
    let state: State<'_, AgentProcesses> = app.state();
    let children: Vec<Arc<_>> = match state.children.lock() {
        Ok(guard) => guard.values().map(Arc::clone).collect(),
        Err(_) => return,
    };
    for child in children {
        if let Ok(mut child) = child.lock()
            && let Some(stdin) = child.stdin.as_mut()
        {
            use std::io::Write;
            let _ =
                writeln!(stdin, "{{\"type\":\"subagents_changed\"}}").and_then(|_| stdin.flush());
        }
    }
}

/// List the merged-by-the-caller subagent files across user scope and (when a
/// project is active) project scope. Returns raw content per file; the frontend
/// parses + merges (project wins by name).
#[tauri::command]
pub fn subagents_list(
    project_root: Option<String>,
    app: AppHandle,
) -> Result<Vec<SubagentFile>, String> {
    let mut out = Vec::new();
    let user_dir = scope_agents_dir("user", None, &app)?;
    out.extend(list_in_dir(&user_dir, "user"));
    if let Some(root) = project_root.as_deref() {
        let project_dir = scope_agents_dir("project", Some(root), &app)?;
        out.extend(list_in_dir(&project_dir, "project"));
    }
    Ok(out)
}

/// Create or replace a subagent definition at the given scope.
#[tauri::command]
pub fn subagents_write(
    scope: String,
    name: String,
    content: String,
    project_root: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let name = name.trim().to_ascii_lowercase();
    let dir = scope_agents_dir(&scope, project_root.as_deref(), &app)?;
    let target = dir.join(format!("{name}.md"));
    assert_inside_project(&scope, project_root.as_deref(), &target)?;
    write_in_dir(&dir, &name, &content)?;
    notify_bridge_subagents_changed(&app);
    Ok(())
}

/// Delete a subagent definition at the given scope.
#[tauri::command]
pub fn subagents_delete(
    scope: String,
    name: String,
    project_root: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let name = name.trim().to_ascii_lowercase();
    let dir = scope_agents_dir(&scope, project_root.as_deref(), &app)?;
    let target = dir.join(format!("{name}.md"));
    assert_inside_project(&scope, project_root.as_deref(), &target)?;
    delete_in_dir(&dir, &name)?;
    notify_bridge_subagents_changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "aethon-subagents-test-{}-{}",
            std::process::id(),
            // A monotonic-ish suffix without Date::now (unavailable here):
            // use a static atomic counter.
            next_id(),
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn next_id() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }

    #[test]
    fn safe_name_accepts_and_rejects() {
        assert!(is_safe_subagent_name("reviewer"));
        assert!(is_safe_subagent_name("code-reviewer_2"));
        assert!(is_safe_subagent_name("a"));
        assert!(!is_safe_subagent_name(""));
        assert!(!is_safe_subagent_name("-lead"));
        assert!(!is_safe_subagent_name("UPPER"));
        assert!(!is_safe_subagent_name("has space"));
        assert!(!is_safe_subagent_name("../escape"));
        assert!(!is_safe_subagent_name(&"x".repeat(65)));
    }

    #[test]
    fn write_list_delete_round_trip() {
        let dir = tmpdir();
        let body = "---\ndescription: Reviews\nmodel: ollama/llama3.3\n---\nYou review.";
        let written = write_in_dir(&dir, "reviewer", body).expect("write");
        assert!(written.ends_with("reviewer.md"));

        let listed = list_in_dir(&dir, "user");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "reviewer");
        assert_eq!(listed[0].scope, "user");
        assert_eq!(listed[0].content, body);

        delete_in_dir(&dir, "reviewer").expect("delete");
        assert!(list_in_dir(&dir, "user").is_empty());
        // Delete is idempotent.
        delete_in_dir(&dir, "reviewer").expect("idempotent delete");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_rejects_unsafe_name_and_oversize() {
        let dir = tmpdir();
        assert!(write_in_dir(&dir, "Bad Name", "x").is_err());
        let big = "x".repeat((MAX_SUBAGENT_BYTES + 1) as usize);
        assert!(write_in_dir(&dir, "ok", &big).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_skips_unsafe_and_non_markdown() {
        let dir = tmpdir();
        fs::write(dir.join("good.md"), "---\ndescription: d\n---\nbody").unwrap();
        fs::write(dir.join("Bad Name.md"), "x").unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();
        fs::write(dir.join(".hidden.md"), "x").unwrap();
        let listed = list_in_dir(&dir, "user");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "good");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_missing_dir_is_empty() {
        let dir = std::env::temp_dir().join("aethon-subagents-does-not-exist-xyz");
        assert!(list_in_dir(&dir, "user").is_empty());
    }

    #[test]
    fn assert_inside_project_accepts_inside_and_rejects_lexical_escape() {
        let base = tmpdir();
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap();

        let inside = root.join(".aethon").join("agents").join("reviewer.md");
        assert!(assert_inside_project("project", Some(root_str), &inside).is_ok());

        let outside = base.join("other").join("x.md");
        assert!(assert_inside_project("project", Some(root_str), &outside).is_err());

        // User scope is never project-guarded.
        assert!(assert_inside_project("user", None, &outside).is_ok());
        fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn assert_inside_project_rejects_symlinked_aethon_dir() {
        use std::os::unix::fs::symlink;
        let base = tmpdir();
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        // An attacker-controlled `.aethon` symlink pointing outside the project.
        let evil = base.join("evil");
        fs::create_dir_all(&evil).unwrap();
        symlink(&evil, root.join(".aethon")).unwrap();

        // The lexical check passes, but canonicalizing the existing `.aethon`
        // symlink resolves outside the root, so the guard must reject it.
        let target = root.join(".aethon").join("agents").join("x.md");
        assert!(assert_inside_project("project", Some(root.to_str().unwrap()), &target).is_err());
        fs::remove_dir_all(&base).ok();
    }
}
