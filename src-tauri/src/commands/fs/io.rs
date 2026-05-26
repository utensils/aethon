//! Read / write / create / rename for files and directories. Reads cap
//! at [`MAX_FILE_BYTES`]; `fs_write_file` is atomic via a tempfile +
//! rename so a crash mid-write can't leave a half-written file.

use super::security::{MAX_FILE_BYTES, canonical_root, ensure_symlink_safe, validated_target};

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
    let metadata =
        std::fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
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
    let metadata =
        std::fs::metadata(&target).map_err(|e| format!("stat {}: {e}", target.display()))?;
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
    let parent = target
        .parent()
        .ok_or_else(|| format!("target has no parent dir: {}", target.display()))?;
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
        return Err(format!(
            "destination already exists: {}",
            to_target.display()
        ));
    }
    std::fs::rename(&from_target, &to_target).map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            from_target.display(),
            to_target.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
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
