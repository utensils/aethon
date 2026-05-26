//! Hand the OS a path: reveal a file inside its parent in the native
//! file manager, open a directory in the file manager, or open a file
//! with the OS default application. The three commands all gate access
//! through the same project-root check used elsewhere; `fs_open_in_file_manager`
//! is the exception — its `path` argument *is* the root (a registered
//! project / worktree), so it applies a tighter shape check instead.

use std::path::PathBuf;

/// Reveal a path in the native file manager (Finder / Explorer / xdg).
/// On macOS uses `open -R` so the target file is preselected inside its
/// parent directory; on Linux falls back to `xdg-open` on the parent.
///
/// `root` is required and `path` must resolve inside it — same gate as
/// `fs_read_file` / `fs_delete` / etc. Without this, a misbehaving
/// extension calling `aethon.invoke("fs_reveal_in_file_manager", { path })`
/// could prompt the OS to reveal arbitrary system files, leaking
/// existence/non-existence info to the user-visible Finder window.
#[tauri::command]
pub fn fs_reveal_in_file_manager(root: String, path: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let req = PathBuf::from(&path);
    let p = crate::helpers::resolve_inside_root(&root_path, &req)
        .ok_or_else(|| format!("path outside root: {path}"))?;
    let canon = p.canonicalize().map_err(|e| format!("canonicalize: {e}"))?;
    let root_canon = root_path
        .canonicalize()
        .map_err(|e| format!("canonicalize root: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err(format!("symlink escape: {path}"));
    }
    if !canon.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let p = canon;
    #[cfg(target_os = "macos")]
    {
        crate::env::command("open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("open -R: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        crate::env::command("explorer.exe")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| format!("explorer.exe: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select-this-file" on Linux; open the parent dir.
        let parent = p.parent().unwrap_or(&p);
        crate::env::command("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
        Ok(())
    }
}

/// Open a directory in the OS file manager. Project- / worktree-level
/// "Open in Finder" flow — sidebar passes a `path` that's a registered
/// project root or worktree path the user has already opted into. There
/// is no `root` to constrain to here (the path *is* the root), so this
/// command applies a tighter shape check instead of `resolve_inside_root`:
///
/// - Path must be absolute (no relative segments that could resolve
///   against the working directory).
/// - Path must canonicalize to a real directory (rejects files, dangling
///   symlinks, NULs, and traversal segments like `..`).
///
/// The command does not return existence info beyond the success / error
/// boundary, so a malicious extension can't use this as a generic
/// "does this directory exist?" oracle — the only side effect is opening
/// Finder/Explorer/xdg-open, which is itself visible to the user.
#[tauri::command]
pub fn fs_open_in_file_manager(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(format!("path must be absolute: {path}"));
    }
    if path.contains('\0') {
        return Err("path contains NUL".to_string());
    }
    let canon = p.canonicalize().map_err(|e| format!("canonicalize: {e}"))?;
    if !canon.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let target = canon;
    #[cfg(target_os = "macos")]
    {
        crate::env::command("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("open: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        crate::env::command("explorer.exe")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("explorer.exe: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::env::command("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
        Ok(())
    }
}

/// Open a file with the OS default application. Same root-gating as
/// `fs_reveal_in_file_manager` — a `root` argument is required and the
/// resolved canonical path must live inside it. Without the gate, a
/// caller could open `/etc/passwd` or similar and trigger external
/// applications on arbitrary files.
#[tauri::command]
pub fn fs_open_in_default_app(root: String, path: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let req = PathBuf::from(&path);
    let p = crate::helpers::resolve_inside_root(&root_path, &req)
        .ok_or_else(|| format!("path outside root: {path}"))?;
    let canon = p.canonicalize().map_err(|e| format!("canonicalize: {e}"))?;
    let root_canon = root_path
        .canonicalize()
        .map_err(|e| format!("canonicalize root: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err(format!("symlink escape: {path}"));
    }
    if !canon.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let p = canon;
    #[cfg(target_os = "macos")]
    {
        crate::env::command("open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("open: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // start "" "<file>" — the empty title argument is required by cmd.
        crate::env::command("cmd")
            .args(["/C", "start", ""])
            .arg(&p)
            .spawn()
            .map_err(|e| format!("start: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::env::command("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
        Ok(())
    }
}
