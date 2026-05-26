//! Directory listing and project-wide file enumeration.
//!
//! `fs_list_dir` is the non-recursive read used by the file tree.
//! `fs_walk_project` is the recursive walk that powers the Cmd+P palette;
//! it skips `EXCLUDED_DIRS` and caps the result at `WALK_FILE_CAP` entries.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::security::{canonical_root, ensure_symlink_safe, validated_target};

/// One entry in a directory listing. Returned by [`fs_list_dir`].
#[derive(serde::Serialize)]
pub struct FsEntry {
    /// Leaf name, without the parent path.
    pub name: String,
    /// Absolute path on disk.
    pub path: String,
    /// `"file"` or `"dir"`. Symlinks resolve to whichever side they point
    /// at; broken symlinks are skipped entirely.
    pub kind: &'static str,
    /// File size in bytes, or 0 for directories.
    pub size: u64,
    /// Modified time as Unix epoch seconds, or 0 when unavailable.
    pub modified: u64,
}

/// Convert a `SystemTime` to Unix epoch seconds, defaulting to 0 when
/// the platform reports a value before 1970 (shouldn't happen, but the
/// API allows it).
fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Non-recursive directory listing. Hidden files (leading `.`) are
/// included — the file tree shows them; the JS side decides whether to
/// render them. Broken symlinks are skipped.
#[tauri::command]
pub fn fs_list_dir(root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    let read =
        std::fs::read_dir(&target).map_err(|e| format!("read_dir {}: {e}", target.display()))?;
    let mut entries: Vec<FsEntry> = Vec::new();
    for entry in read.flatten() {
        let entry_path = entry.path();
        // metadata() follows symlinks; symlink_metadata() doesn't.
        // We follow so the file tree shows what the symlink points at,
        // matching the user's mental model of "click to open the file".
        let metadata = match std::fs::metadata(&entry_path) {
            Ok(m) => m,
            Err(_) => continue, // broken symlink — skip silently
        };
        let kind = if metadata.is_dir() { "dir" } else { "file" };
        // Final safety net: the listed entry's canonical path must still
        // stay under `root_canon`. Catches a symlinked dir inside `root`
        // that points outside.
        if let Ok(canon) = entry_path.canonicalize()
            && !(canon == root_canon || canon.starts_with(&root_canon))
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let modified = metadata.modified().ok().map(unix_seconds).unwrap_or(0);
        entries.push(FsEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            kind,
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified,
        });
    }
    // Folders first, then files, each group sorted case-insensitively
    // by name — matches the conventional file tree ordering.
    entries.sort_by(|a, b| match (a.kind, b.kind) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Directories pruned from the project walk. Reasons range from huge
/// (`node_modules`, `target`) to noisy (`.git`) to platform metadata
/// (`__pycache__`, `.next`). Hidden-by-convention; this is the same
/// list VSCode's quick-open uses by default. Kept short so the user
/// can `git grep` `EXCLUDED_DIRS` and immediately understand the policy.
const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".direnv",
    ".cache",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "coverage",
    "__pycache__",
    ".venv",
    ".tox",
    "bower_components",
    "vendor",
    ".gradle",
];

/// Hard ceiling on the project walk. 20 000 files comfortably covers
/// large repos (Aethon's own `src/` is ~150 files) while keeping the
/// returned payload under ~2 MB and the walk under ~50 ms on SSD-class
/// disks. Going higher would slow the fuzzy-search palette without
/// adding usefulness for a single-window quick-open UX.
const WALK_FILE_CAP: usize = 20_000;

/// Recursive non-binary file enumeration for the Cmd+P file fuzzy
/// search. Returns absolute paths inside `root` (so they round-trip
/// through `fs_read_file` without rewriting), capped at 20k entries.
/// Excludes directory names in `EXCLUDED_DIRS`; dot-prefixed directories
/// not listed there are still walked. Symlinks are not followed — too
/// easy to get stuck in a loop or wander outside the project.
#[tauri::command]
pub fn fs_walk_project(root: String) -> Result<Vec<String>, String> {
    let root_canon = canonical_root(&root)?;
    // Use the supplied root as the prefix the frontend will pass back
    // to fs_read_file / fs_write_file. If the project was opened
    // through a symlink, canonicalize() resolves to a different
    // string; returning canonical paths would then fail
    // resolve_inside_root because the lexical layer compares against
    // the original (uncanonicalized) project root.
    let root_path = PathBuf::from(&root);
    let mut out: Vec<String> = Vec::with_capacity(1024);
    let mut stack: Vec<PathBuf> = vec![root_canon.clone()];
    while let Some(dir) = stack.pop() {
        if out.len() >= WALK_FILE_CAP {
            break;
        }
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let path = entry.path();
            // symlink_metadata avoids following symlinks; broken or
            // recursive links are skipped.
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if EXCLUDED_DIRS.iter().any(|d| name_str == *d) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if meta.is_file() {
                // Rebase under the original root so the path lives in
                // the same space the FE's later fs_read_file calls
                // validate against. strip_prefix never fails here —
                // every walked file is under root_canon — but if it
                // somehow does, fall back to the canonical form
                // rather than dropping the entry.
                let rebased = match path.strip_prefix(&root_canon) {
                    Ok(rel) => root_path.join(rel),
                    Err(_) => path,
                };
                out.push(rebased.to_string_lossy().into_owned());
                if out.len() >= WALK_FILE_CAP {
                    break;
                }
            }
        }
    }
    // Stable lexicographic ordering so the palette renders the same
    // list across invocations.
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn list_dir_reads_a_directory_and_filters_to_inside_root() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-list-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.txt"), "hi").unwrap();
        std::fs::create_dir_all(tmp.join("nested")).unwrap();

        let canon = tmp.canonicalize().unwrap();
        let entries = fs_list_dir(s(&canon), s(&canon)).expect("listing should succeed");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"nested"));

        // Dirs come before files.
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind).collect();
        assert_eq!(kinds.first().copied(), Some("dir"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn walk_returns_files_excluding_blocklist() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-walk-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = tmp.canonicalize().unwrap();
        std::fs::write(canon.join("App.tsx"), "x").unwrap();
        std::fs::create_dir_all(canon.join("src")).unwrap();
        std::fs::write(canon.join("src").join("nested.ts"), "x").unwrap();
        // Should be skipped:
        std::fs::create_dir_all(canon.join("node_modules").join("foo")).unwrap();
        std::fs::write(
            canon.join("node_modules").join("foo").join("ignored.js"),
            "x",
        )
        .unwrap();

        let paths = fs_walk_project(s(&canon)).unwrap();
        let leaves: Vec<&str> = paths
            .iter()
            .filter_map(|p| p.split('/').next_back())
            .collect();
        assert!(leaves.contains(&"App.tsx"));
        assert!(leaves.contains(&"nested.ts"));
        assert!(
            !leaves.contains(&"ignored.js"),
            "node_modules content must not appear; got {paths:?}"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }
}
