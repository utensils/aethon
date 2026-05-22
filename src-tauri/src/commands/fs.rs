//! Project-scoped file-system commands for the Monaco editor + file tree.
//!
//! Each command takes an absolute `root` (the active project's cwd) plus
//! an absolute target `path`. We refuse to touch anything that lexically
//! escapes `root`, then canonicalize the existing portion of the path
//! and refuse again if a symlink redirects out. Two layers because:
//!
//! - The lexical check ([`helpers::resolve_inside_root`]) catches `..`
//!   traversal without hitting the filesystem — works for create-new
//!   paths whose target doesn't exist yet.
//! - The symlink check catches the case where a path inside `root`
//!   resolves through a symlink to somewhere outside (e.g. a malicious
//!   `node_modules/foo/bar` -> `/etc/passwd`).
//!
//! All read/write goes through `std::fs`; no `tauri-plugin-fs`. That
//! plugin's allow-list lives in a capability JSON file at build time —
//! awkward for a per-project root the user picks at runtime. Hand-rolling
//! is simpler and keeps the trust boundary in one place.
//!
//! Deletes go to the OS trash via the `trash` crate. The user can always
//! recover, which matches Aethon's general "don't lose user work" stance.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::helpers::resolve_inside_root;

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

/// Hard ceiling on file reads/writes. Monaco renders multi-MB files but
/// shipping a 50 MB blob over the Tauri IPC bridge will stall the webview;
/// 10 MB is comfortable for source code and stops the user from
/// accidentally opening a release tarball.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Lexically-and-symlink validate that `path` lives inside `root` and
/// return its canonical resolved form (lexically only — see callers for
/// the second symlink-aware pass on the parent).
///
/// The two arguments are passed in as `String` because Tauri's `invoke`
/// serializes paths as JSON strings; the conversion happens here so the
/// commands themselves stay focused on the operation.
fn validated_target(root: &str, path: &str) -> Result<PathBuf, String> {
    let root_path = Path::new(root);
    let target = Path::new(path);
    resolve_inside_root(root_path, target).ok_or_else(|| format!("path outside root: {path}"))
}

/// Walk up `path` until we find a component that exists on disk, then
/// canonicalize that prefix. Used to detect symlink escapes for create
/// operations where the target itself doesn't exist yet.
fn canonicalize_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    let mut probe = path.to_path_buf();
    loop {
        if probe.exists() {
            return probe
                .canonicalize()
                .map_err(|e| format!("canonicalize {}: {e}", probe.display()));
        }
        match probe.parent() {
            Some(p) if p != probe => probe = p.to_path_buf(),
            _ => {
                return Err(format!(
                    "no existing prefix for {} (root must exist)",
                    path.display()
                ));
            }
        }
    }
}

/// Verify the canonicalised existing prefix of `path` stays under
/// `root_canon`. Catches the symlink-escape case where a path inside
/// `root` resolves to a target outside of it.
fn ensure_symlink_safe(path: &Path, root_canon: &Path) -> Result<(), String> {
    let prefix = canonicalize_existing_prefix(path)?;
    if prefix == root_canon || prefix.starts_with(root_canon) {
        Ok(())
    } else {
        Err(format!(
            "symlink escapes root: {} -> {}",
            path.display(),
            prefix.display()
        ))
    }
}

/// Canonicalise the root once per call. Root must exist and be a
/// directory; if it doesn't, every operation under it would fail
/// downstream — better to surface the error here.
fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let root_path = Path::new(root);
    if !root_path.is_absolute() {
        return Err(format!("root must be absolute: {root}"));
    }
    let canon = root_path
        .canonicalize()
        .map_err(|e| format!("root canonicalize {}: {e}", root_path.display()))?;
    if !canon.is_dir() {
        return Err(format!("root is not a directory: {}", canon.display()));
    }
    Ok(canon)
}

/// Convert a `SystemTime` to Unix epoch seconds, defaulting to 0 when
/// the platform reports a value before 1970 (shouldn't happen, but the
/// API allows it).
fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Non-recursive directory listing. Hidden files (leading `.`) are
/// included — the file tree shows them; the JS side decides whether to
/// render them. Broken symlinks are skipped.
#[tauri::command]
pub fn fs_list_dir(root: String, path: String) -> Result<Vec<FsEntry>, String> {
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    let read = std::fs::read_dir(&target).map_err(|e| format!("read_dir {}: {e}", target.display()))?;
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
        let modified = metadata
            .modified()
            .ok()
            .map(unix_seconds)
            .unwrap_or(0);
        entries.push(FsEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            kind,
            size: if metadata.is_file() { metadata.len() } else { 0 },
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

/// Read an arbitrary file from disk and return its bytes base64-encoded.
/// Used by the image viewer — `fs_read_file` rejects non-UTF-8 input by
/// design (Monaco needs faithful round-trip), so the binary path is a
/// separate command. Path validation mirrors `fs_read_file`'s; the
/// same 10 MB ceiling applies so a runaway PNG can't OOM the webview.
#[tauri::command]
pub fn fs_read_file_base64(root: String, path: String) -> Result<String, String> {
    use base64::Engine as _;
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    let metadata = std::fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if metadata.is_dir() {
        return Err(format!("not a file: {}", target.display()));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "file too large: {} bytes (cap {MAX_FILE_BYTES})",
            metadata.len()
        ));
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Read a UTF-8 text file. Non-UTF-8 bytes return an error rather than
/// lossy-replace — Monaco needs faithful round-trip. The 10 MB cap stops
/// a tarball from accidentally tanking the webview.
#[tauri::command]
pub fn fs_read_file(root: String, path: String) -> Result<String, String> {
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    let metadata = std::fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
    if metadata.is_dir() {
        return Err(format!("not a file: {}", target.display()));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "file too large: {} bytes (cap {MAX_FILE_BYTES})",
            metadata.len()
        ));
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("read {}: {e}", target.display()))?;
    String::from_utf8(bytes).map_err(|_| format!("file is not valid UTF-8: {}", target.display()))
}

/// Overwrite an existing file. Atomic via tempfile + rename so a crash
/// mid-write can't leave a half-written file. Refuses to write outside
/// the root or above the size cap.
#[tauri::command]
pub fn fs_write_file(root: String, path: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "content too large: {} bytes (cap {MAX_FILE_BYTES})",
            content.len()
        ));
    }
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    // If the target is a symlink inside the project, write through to
    // its resolved target instead of replacing the link itself. The
    // atomic rename below would silently swap the symlink for a
    // regular file, breaking the original target and surprising any
    // tooling that relied on the link. We still funnel the resolved
    // path through `validated_target` so the boundary check stays
    // intact — the symlink can only redirect inside the project root.
    let target = match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let resolved = target
                .canonicalize()
                .map_err(|e| format!("resolve symlink {}: {e}", target.display()))?;
            let resolved_str = resolved.to_string_lossy().into_owned();
            validated_target(&root, &resolved_str)?
        }
        _ => target,
    };
    ensure_symlink_safe(&target, &root_canon)?;
    // Atomic write: write to a per-call unique temp path in the same
    // directory, then rename. fs::rename is atomic within the same
    // filesystem on Unix and Windows, so a crash mid-write either
    // leaves the old file untouched or the fully-written new one —
    // never a half-state.
    //
    // We open the temp with `create_new(true)` so the syscall fails
    // when the path already exists. That blocks a crafted workspace
    // from pre-planting a symlink named `foo.aethon-save.<uuid>.tmp`
    // pointing outside the project root: `create_new` refuses to
    // follow existing symlinks (it's `O_EXCL` under the hood). The
    // path itself also rides through `validated_target` /
    // `ensure_symlink_safe` so even the lexical layer would catch a
    // traversal in the leaf name; the create-new flag closes the
    // TOCTOU window between validation and write.
    let parent = target.parent().ok_or_else(|| {
        format!("target has no parent dir: {}", target.display())
    })?;
    let target_name = target
        .file_name()
        .ok_or_else(|| format!("target has no leaf name: {}", target.display()))?
        .to_string_lossy()
        .into_owned();
    let tmp_name = format!(
        ".{target_name}.aethon-save.{}.tmp",
        uuid::Uuid::new_v4().simple()
    );
    let tmp = parent.join(&tmp_name);
    // Belt-and-suspenders: the temp path must also live inside the
    // root. Same helpers as the user-facing target.
    let tmp_str = tmp.to_string_lossy().into_owned();
    validated_target(&root, &tmp_str)?;
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("create {}: {e}", tmp.display()))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all().ok();
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        // Best-effort cleanup so a failed rename doesn't leave the
        // hidden temp on disk.
        let _ = std::fs::remove_file(&tmp);
        format!("rename {}: {e}", target.display())
    })?;
    Ok(())
}

/// Create a new file. Errors if it already exists so the caller can
/// surface a "name already taken" prompt rather than silently
/// overwrite.
#[tauri::command]
pub fn fs_create_file(root: String, path: String) -> Result<(), String> {
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    if target.exists() {
        return Err(format!("already exists: {}", target.display()));
    }
    // create_new = true → fail-on-exists at the syscall level; belt-and-
    // suspenders with the explicit check above (which has a TOCTOU
    // window but gives a friendlier error).
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("create {}: {e}", target.display()))?;
    Ok(())
}

/// Create a directory, parents on demand. Errors only if a non-dir
/// file already occupies that path.
#[tauri::command]
pub fn fs_create_dir(root: String, path: String) -> Result<(), String> {
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    if target.exists() && !target.is_dir() {
        return Err(format!(
            "path exists and is not a directory: {}",
            target.display()
        ));
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("mkdir {}: {e}", target.display()))
}

/// Rename or move. Both `from` and `to` must be inside `root`. Used
/// for the file-tree rename action; a future copy/move-between-folders
/// flow can reuse this command verbatim.
#[tauri::command]
pub fn fs_rename(root: String, from: String, to: String) -> Result<(), String> {
    let from_target = validated_target(&root, &from)?;
    let to_target = validated_target(&root, &to)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&from_target, &root_canon)?;
    ensure_symlink_safe(&to_target, &root_canon)?;
    if to_target.exists() {
        return Err(format!("destination already exists: {}", to_target.display()));
    }
    std::fs::rename(&from_target, &to_target).map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            from_target.display(),
            to_target.display()
        )
    })
}

/// Move to the OS trash. Recoverable by the user via the platform's
/// trash UI. We never permanently delete from the file tree to avoid
/// data-loss surprises; if a user really wants a hard delete they can
/// empty the trash themselves.
#[tauri::command]
pub fn fs_delete(root: String, path: String) -> Result<(), String> {
    let target = validated_target(&root, &path)?;
    let root_canon = canonical_root(&root)?;
    ensure_symlink_safe(&target, &root_canon)?;
    trash::delete(&target).map_err(|e| format!("trash {}: {e}", target.display()))
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

    /// Helper: turn a non-existing path into a String the same way the
    /// commands receive it from JS.
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
    fn write_then_read_round_trips_utf8() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-rw-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = tmp.canonicalize().unwrap();
        let file = canon.join("hello.ts");

        fs_write_file(s(&canon), s(&file), "export const x = 1;\n".to_string()).unwrap();
        let read_back = fs_read_file(s(&canon), s(&file)).unwrap();
        assert_eq!(read_back, "export const x = 1;\n");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn write_rejects_path_outside_root() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-escape-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = tmp.canonicalize().unwrap();
        // Lexical escape: /tmp/aethon-fs-escape-.../../etc/passwd
        let escape = canon.parent().unwrap().join("etc-passwd-via-traversal");
        let err = fs_write_file(s(&canon), s(&escape), "evil".to_string());
        assert!(err.is_err(), "expected refusal; got {err:?}");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn create_file_rejects_overwrite() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-create-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = tmp.canonicalize().unwrap();
        let file = canon.join("new.txt");
        std::fs::write(&file, "existing").unwrap();
        let err = fs_create_file(s(&canon), s(&file));
        assert!(err.is_err(), "expected refusal; got {err:?}");
        // Original content untouched.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "existing");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rename_moves_inside_root() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-rename-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = tmp.canonicalize().unwrap();
        let from = canon.join("a.txt");
        let to = canon.join("b.txt");
        std::fs::write(&from, "x").unwrap();
        fs_rename(s(&canon), s(&from), s(&to)).unwrap();
        assert!(!from.exists());
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "x");

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
        std::fs::write(canon.join("node_modules").join("foo").join("ignored.js"), "x").unwrap();

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

    #[test]
    fn rename_rejects_destination_outside_root() {
        let tmp = std::env::temp_dir().join(format!("aethon-fs-rename-esc-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let canon = tmp.canonicalize().unwrap();
        let from = canon.join("a.txt");
        std::fs::write(&from, "x").unwrap();
        let escape = canon.parent().unwrap().join("escape.txt");
        let err = fs_rename(s(&canon), s(&from), s(&escape));
        assert!(err.is_err(), "expected refusal; got {err:?}");
        assert!(from.exists()); // didn't move

        std::fs::remove_dir_all(&tmp).ok();
    }
}
