//! Trash-aware delete. Uses the `trash` crate to move files to the
//! platform trash; falls back to a rename into `~/.Trash` if the OS
//! call fails. We never permanently delete from the file tree — if
//! the user really wants a hard delete they can empty the trash
//! themselves.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::security::{canonical_root, ensure_symlink_safe, validated_target};

/// Move to the OS trash. Recoverable by the user via the platform's
/// trash UI. We never permanently delete from the file tree to avoid
/// data-loss surprises; if a user really wants a hard delete they can
/// empty the trash themselves.
#[tauri::command]
pub fn fs_delete(root: String, path: String) -> Result<(), String> {
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    match trash::delete(&target) {
        Ok(()) => Ok(()),
        Err(trash_err) => move_to_home_trash(&target).map_err(|fallback_err| {
            format!(
                "trash {}: {trash_err}; fallback move to ~/.Trash failed: {fallback_err}",
                target.display()
            )
        }),
    }
}

fn home_dir_from_env() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| "home directory unavailable".to_string())
}

fn unique_trash_target(trash_dir: &Path, source: &Path) -> Result<PathBuf, String> {
    let file_name = source
        .file_name()
        .ok_or_else(|| format!("path has no file name: {}", source.display()))?;
    let first = trash_dir.join(file_name);
    if !first.exists() {
        return Ok(first);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for i in 1..1000 {
        let mut name = file_name.to_os_string();
        name.push(format!(".aethon-trash-{now}-{i}"));
        let candidate = trash_dir.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "could not allocate unique trash path for {}",
        source.display()
    ))
}

fn move_to_home_trash(target: &Path) -> Result<(), String> {
    let home = home_dir_from_env()?;
    let trash_dir = home.join(".Trash");
    std::fs::create_dir_all(&trash_dir)
        .map_err(|e| format!("create {}: {e}", trash_dir.display()))?;
    let dest = unique_trash_target(&trash_dir, target)?;
    std::fs::rename(target, &dest)
        .map_err(|e| format!("move {} -> {}: {e}", target.display(), dest.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_trash_target_avoids_collisions() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-trash-name-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("current-context-panel.ts");
        std::fs::write(&source, "x").unwrap();
        std::fs::write(tmp.join("current-context-panel.ts"), "existing").unwrap();

        let target = unique_trash_target(&tmp, &source).unwrap();
        assert_ne!(target, tmp.join("current-context-panel.ts"));
        assert!(
            target
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("current-context-panel.ts.aethon-trash-")
        );

        std::fs::remove_dir_all(&tmp).ok();
    }
}
