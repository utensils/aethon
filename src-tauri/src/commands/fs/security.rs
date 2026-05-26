//! Path-validation primitives shared by every command in `commands::fs`.
//!
//! Two layers protect the project-root boundary:
//!
//! - The lexical check ([`resolve_inside_root`]) catches `..`
//!   traversal without hitting the filesystem — works for create-new
//!   paths whose target doesn't exist yet.
//! - The symlink check ([`ensure_symlink_safe`]) catches the case where a
//!   path inside `root` resolves through a symlink to somewhere outside
//!   (e.g. a malicious `node_modules/foo/bar` -> `/etc/passwd`).
//!
//! Helpers stay `pub(super)` so sibling submodules can use them; nothing
//! here is part of the crate-wide API.

use std::path::{Path, PathBuf};

use crate::helpers::resolve_inside_root;

/// Hard ceiling on file reads/writes. Monaco renders multi-MB files but
/// shipping a 50 MB blob over the Tauri IPC bridge will stall the webview;
/// 10 MB is comfortable for source code and stops the user from
/// accidentally opening a release tarball.
pub(super) const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Lexically validate that `path` lives inside `root` and return its
/// resolved form. The two arguments are passed in as `String` because
/// Tauri's `invoke` serializes paths as JSON strings; the conversion
/// happens here so the commands themselves stay focused on the operation.
pub(super) fn validated_target(root: &str, path: &str) -> Result<PathBuf, String> {
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
pub(super) fn ensure_symlink_safe(path: &Path, root_canon: &Path) -> Result<(), String> {
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
pub(super) fn canonical_root(root: &str) -> Result<PathBuf, String> {
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
