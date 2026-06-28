//! SQLite-backed application state storage.
//!
//! The database is the canonical home for Aethon-managed state. User-authored
//! files such as `config.toml` and system-prompt markdown remain plain files so
//! users can keep editing them directly.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use tauri::{AppHandle, Manager};

use crate::helpers::{sanitize_filename_segment, validate_state_name};

const DB_RELATIVE_DIR: &str = "state";
const DB_FILE: &str = "aethon.sqlite3";
const KV_NAMESPACE_STATE: &str = "state";
const CURRENT_SCHEMA: i64 = 1;

const FILE_BACKED_STATE_NAMES: &[&str] = &[
    "config.toml",
    "system-prompt.md",
    "system-prompt-append.md",
    "ai-tools.md",
];

const LEGACY_STATE_FILES: &[&str] = &[
    "disabled-extensions.json",
    "editor-tabs.json",
    "file-tree-prefs.json",
    "file-tree.json",
    "git-fetch-attempts.json",
    "git-status.json",
    "hosts.json",
    "layout_prefs",
    "mcp-approvals.json",
    "messages.json",
    "native-windows.json",
    "project-icons.json",
    "projects.json",
    "scheduled-tasks.json",
    "session_ui_snapshot",
    "sidebar_width",
    "startup-approvals.json",
    "state.json",
    "terminal_height",
    "theme",
    "ui_state",
    "ui_zoom",
    "vcs-status.json",
    "voice.json",
    "window-state.json",
];

const RESERVED_TOP_LEVEL_DIRS: &[&str] = &[
    "agents",
    "auth",
    "control",
    "devshell-cache",
    "extension-packages",
    "extensions",
    "legacy-json",
    "logs",
    "mcp",
    "memory",
    "models",
    "pastes",
    "projects",
    "sessions",
    "skills",
    "state",
    "themes",
    "updates",
];

pub(crate) fn aethon_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    let dir = crate::helpers::aethon_dir(Some(home))
        .ok_or_else(|| "aethon dir unresolved".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub(crate) fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = aethon_dir(app)?.join(DB_RELATIVE_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join(DB_FILE))
}

pub(crate) fn is_file_backed_state_name(name: &str) -> bool {
    FILE_BACKED_STATE_NAMES.contains(&name)
}

pub(crate) fn legacy_state_file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    validate_state_name(name)?;
    Ok(aethon_dir(app)?.join(name))
}

fn connect_path(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let conn =
        Connection::open(path).map_err(|e| format!("open sqlite {}: {e}", path.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("sqlite journal_mode: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("sqlite foreign_keys: {e}"))?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| format!("sqlite busy_timeout: {e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("sqlite synchronous: {e}"))?;
    migrate_connection(&conn)?;
    Ok(conn)
}

pub(crate) fn connect(app: &AppHandle) -> Result<Connection, String> {
    connect_path(&db_path(app)?)
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let dir = aethon_dir(app)?;
    initialize_dir(&dir)
}

fn initialize_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::create_dir_all(projects_dir_from_aethon_dir(dir)).map_err(|e| {
        format!(
            "create {}: {e}",
            projects_dir_from_aethon_dir(dir).display()
        )
    })?;
    let conn = connect_path(&db_path_from_aethon_dir(dir))?;
    import_legacy_state_files_from_dir(dir, &conn)?;
    migrate_project_data_dirs_from_dir(dir, &conn)?;
    Ok(())
}

fn db_path_from_aethon_dir(dir: &Path) -> PathBuf {
    dir.join(DB_RELATIVE_DIR).join(DB_FILE)
}

fn projects_dir_from_aethon_dir(dir: &Path) -> PathBuf {
    dir.join("projects")
}

fn migrate_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );

        CREATE TABLE IF NOT EXISTS kv_store (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY (namespace, key)
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          path TEXT NOT NULL,
          host_id TEXT,
          data_dir TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          last_used INTEGER,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );

        CREATE TABLE IF NOT EXISTS project_workspaces (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY (project_id, id),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS session_tabs (
          tab_id TEXT PRIMARY KEY,
          cwd TEXT,
          custom_label TEXT,
          label_cwd TEXT,
          first_user_message TEXT,
          last_modified INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          tab_id TEXT NOT NULL,
          cwd TEXT,
          current_leaf_entry_id TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          FOREIGN KEY (tab_id) REFERENCES session_tabs(tab_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS session_entries (
          session_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          parent_entry_id TEXT,
          entry_type TEXT NOT NULL,
          role TEXT,
          text TEXT,
          timestamp INTEGER,
          payload_json TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          PRIMARY KEY (session_id, entry_id),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_session_entries_session_ordinal
          ON session_entries(session_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_session_entries_parent
          ON session_entries(session_id, parent_entry_id);

        CREATE TABLE IF NOT EXISTS session_local_messages (
          tab_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT,
          thinking TEXT,
          created_at INTEGER,
          cwd TEXT,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (tab_id, message_id),
          FOREIGN KEY (tab_id) REFERENCES session_tabs(tab_id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
          tab_id UNINDEXED,
          role UNINDEXED,
          text,
          timestamp UNINDEXED,
          source UNINDEXED
        );
        "#,
    )
    .map_err(|e| format!("sqlite migrate: {e}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?1)",
        params![CURRENT_SCHEMA],
    )
    .map_err(|e| format!("sqlite record migration: {e}"))?;
    Ok(())
}

pub(crate) fn read_kv(
    app: &AppHandle,
    namespace: &str,
    key: &str,
) -> Result<Option<String>, String> {
    let conn = connect(app)?;
    conn.query_row(
        "SELECT value FROM kv_store WHERE namespace = ?1 AND key = ?2",
        params![namespace, key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("sqlite read kv {namespace}/{key}: {e}"))
}

pub(crate) fn write_kv(
    app: &AppHandle,
    namespace: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let conn = connect(app)?;
    write_kv_conn(&conn, namespace, key, value)
}

fn write_kv_conn(conn: &Connection, namespace: &str, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO kv_store(namespace, key, value, updated_at)
        VALUES (?1, ?2, ?3, unixepoch() * 1000)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        "#,
        params![namespace, key, value],
    )
    .map_err(|e| format!("sqlite write kv {namespace}/{key}: {e}"))?;
    Ok(())
}

pub(crate) fn read_state_value(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    validate_state_name(name)?;
    if let Some(value) = read_kv(app, KV_NAMESPACE_STATE, name)? {
        return Ok(Some(value));
    }
    let path = legacy_state_file_path(app, name)?;
    match std::fs::read_to_string(&path) {
        Ok(value) => {
            write_kv(app, KV_NAMESPACE_STATE, name, &value)?;
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

pub(crate) fn write_state_value(app: &AppHandle, name: &str, value: &str) -> Result<(), String> {
    validate_state_name(name)?;
    write_kv(app, KV_NAMESPACE_STATE, name, value)
}

fn import_legacy_state_files_from_dir(dir: &Path, conn: &Connection) -> Result<(), String> {
    for name in LEGACY_STATE_FILES {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM kv_store WHERE namespace = ?1 AND key = ?2",
                params![KV_NAMESPACE_STATE, name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("sqlite check legacy {name}: {e}"))?;
        if exists.is_some() {
            continue;
        }
        let path = dir.join(name);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        write_kv_conn(conn, KV_NAMESPACE_STATE, name, &raw)?;
    }
    import_projects_json_from_dir(dir, conn)?;
    Ok(())
}

fn import_projects_json_from_dir(dir: &Path, conn: &Connection) -> Result<(), String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM kv_store WHERE namespace = ?1 AND key = ?2",
            params![KV_NAMESPACE_STATE, "projects.json"],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("sqlite read project registry: {e}"))?;
    let raw = match raw {
        Some(raw) if !raw.trim().is_empty() => raw,
        _ => return Ok(()),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    let projects = parsed
        .get("projects")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let workspaces = parsed
        .get("workspacesByProject")
        .or_else(|| parsed.get("worktreesByProject"))
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    for project in projects {
        let Some(id) = project.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(path) = project.get("path").and_then(|value| value.as_str()) else {
            continue;
        };
        let label = project
            .get("label")
            .and_then(|value| value.as_str())
            .unwrap_or("project");
        let host_id = project.get("hostId").and_then(|value| value.as_str());
        let last_used = project.get("lastUsed").and_then(|value| value.as_i64());
        let data_dir = projects_dir_from_aethon_dir(dir).join(safe_project_data_dir(id));
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("create {}: {e}", data_dir.display()))?;
        conn.execute(
            r#"
            INSERT INTO projects(id, label, path, host_id, data_dir, payload_json, last_used, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch() * 1000)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              path = excluded.path,
              host_id = excluded.host_id,
              data_dir = excluded.data_dir,
              payload_json = excluded.payload_json,
              last_used = excluded.last_used,
              updated_at = excluded.updated_at
            "#,
            params![
                id,
                label,
                path,
                host_id,
                data_dir.to_string_lossy(),
                project.to_string(),
                last_used
            ],
        )
        .map_err(|e| format!("sqlite import project {id}: {e}"))?;
        if let Some(list) = workspaces.get(id).and_then(|value| value.as_array()) {
            for workspace in list {
                let Some(workspace_id) = workspace.get("id").and_then(|value| value.as_str())
                else {
                    continue;
                };
                let Some(workspace_path) = workspace.get("path").and_then(|value| value.as_str())
                else {
                    continue;
                };
                conn.execute(
                    r#"
                    INSERT INTO project_workspaces(id, project_id, path, payload_json, updated_at)
                    VALUES (?1, ?2, ?3, ?4, unixepoch() * 1000)
                    ON CONFLICT(project_id, id) DO UPDATE SET
                      path = excluded.path,
                      payload_json = excluded.payload_json,
                      updated_at = excluded.updated_at
                    "#,
                    params![workspace_id, id, workspace_path, workspace.to_string()],
                )
                .map_err(|e| format!("sqlite import workspace {workspace_id}: {e}"))?;
            }
        }
    }
    Ok(())
}

fn safe_project_data_dir(project_id: &str) -> String {
    let safe = sanitize_filename_segment(project_id);
    if safe.is_empty() {
        format!("project-{}", uuid::Uuid::new_v4().simple())
    } else {
        safe
    }
}

fn migrate_project_data_dirs_from_dir(dir: &Path, conn: &Connection) -> Result<(), String> {
    let reserved: HashSet<&str> = RESERVED_TOP_LEVEL_DIRS.iter().copied().collect();
    let mut stmt = conn
        .prepare("SELECT id, label, path, data_dir FROM projects")
        .map_err(|e| format!("sqlite prepare project dirs: {e}"))?;
    let projects = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| format!("sqlite query project dirs: {e}"))?;

    for project in projects {
        let (id, label, project_path, data_dir): (String, String, String, String) =
            project.map_err(|e| format!("sqlite read project dir row: {e}"))?;
        let dest = PathBuf::from(data_dir);
        std::fs::create_dir_all(&dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

        let mut candidates = Vec::new();
        candidates.push(sanitize_filename_segment(&label));
        if let Some(base) = Path::new(&project_path)
            .file_name()
            .and_then(|name| name.to_str())
        {
            candidates.push(sanitize_filename_segment(base));
        }
        candidates.push(safe_project_data_dir(&id));
        candidates.sort();
        candidates.dedup();

        for candidate in candidates {
            if candidate.is_empty() || reserved.contains(candidate.as_str()) {
                continue;
            }
            let source = dir.join(&candidate);
            if !source.is_dir() || source == dest {
                continue;
            }
            move_project_dir_contents(&source, &dest)?;
            if std::fs::read_dir(&source)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
            {
                let _ = std::fs::remove_dir(&source);
            }
        }
    }
    Ok(())
}

fn move_project_dir_contents(source: &Path, dest: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(source).map_err(|e| format!("read {}: {e}", source.display()))? {
        let entry = entry.map_err(|e| format!("read {}: {e}", source.display()))?;
        let file_name = entry.file_name();
        let target = dest.join(&file_name);
        if target.exists() {
            tracing::warn!(
                target: "aethon::storage",
                "leaving project data item in place because destination exists: {}",
                target.display()
            );
            continue;
        }
        std::fs::rename(entry.path(), &target).map_err(|e| {
            format!(
                "move {} -> {}: {e}",
                entry.path().display(),
                target.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_backed_state_names_are_explicit() {
        assert!(is_file_backed_state_name("config.toml"));
        assert!(is_file_backed_state_name("system-prompt.md"));
        assert!(!is_file_backed_state_name("projects.json"));
    }

    #[test]
    fn safe_project_data_dir_sanitizes_ids() {
        assert_eq!(safe_project_data_dir("project:one"), "project_one");
        assert_eq!(safe_project_data_dir("aethon"), "aethon");
    }

    #[test]
    fn sqlite_kv_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state").join("aethon.sqlite3");
        let conn = connect_path(&path).unwrap();
        write_kv_conn(&conn, "state", "theme", "dark").unwrap();
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM kv_store WHERE namespace='state' AND key='theme'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(value.as_deref(), Some("dark"));
    }

    #[test]
    fn initialize_imports_legacy_projects_and_moves_project_data_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let aethon_dir = temp.path().join(".aethon");
        std::fs::create_dir_all(&aethon_dir).unwrap();
        std::fs::write(
            aethon_dir.join("projects.json"),
            r#"{
              "schemaVersion": 5,
              "projects": [
                {
                  "id": "project-one",
                  "label": "Example Project",
                  "path": "/Users/example/Projects/example-project",
                  "lastUsed": 123
                }
              ],
              "workspacesByProject": {
                "project-one": [
                  {
                    "id": "main",
                    "path": "/Users/example/Projects/example-project",
                    "isMain": true
                  }
                ]
              }
            }"#,
        )
        .unwrap();
        let legacy_project_dir = aethon_dir.join("Example_Project");
        std::fs::create_dir_all(&legacy_project_dir).unwrap();
        std::fs::write(legacy_project_dir.join("state.json"), "{}").unwrap();

        initialize_dir(&aethon_dir).unwrap();

        let db = connect_path(&db_path_from_aethon_dir(&aethon_dir)).unwrap();
        let project_count: i64 = db
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        let workspace_count: i64 = db
            .query_row("SELECT COUNT(*) FROM project_workspaces", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(project_count, 1);
        assert_eq!(workspace_count, 1);
        assert!(
            aethon_dir
                .join("projects")
                .join("project-one")
                .join("state.json")
                .is_file()
        );
        assert!(!legacy_project_dir.exists());
    }

    #[test]
    fn project_data_dir_migration_keeps_conflicting_files_in_legacy_dir() {
        let temp = tempfile::tempdir().unwrap();
        let aethon_dir = temp.path().join(".aethon");
        std::fs::create_dir_all(aethon_dir.join("conflict-project")).unwrap();
        std::fs::write(aethon_dir.join("conflict-project").join("keep.json"), "old").unwrap();
        std::fs::create_dir_all(aethon_dir.join("projects").join("conflict-project")).unwrap();
        std::fs::write(
            aethon_dir
                .join("projects")
                .join("conflict-project")
                .join("keep.json"),
            "new",
        )
        .unwrap();
        std::fs::write(
            aethon_dir.join("projects.json"),
            r#"{
              "schemaVersion": 5,
              "projects": [
                {
                  "id": "conflict-project",
                  "label": "conflict-project",
                  "path": "/Users/example/Projects/conflict-project"
                }
              ]
            }"#,
        )
        .unwrap();

        initialize_dir(&aethon_dir).unwrap();

        assert_eq!(
            std::fs::read_to_string(
                aethon_dir
                    .join("projects")
                    .join("conflict-project")
                    .join("keep.json")
            )
            .unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(aethon_dir.join("conflict-project").join("keep.json")).unwrap(),
            "old"
        );
    }
}
