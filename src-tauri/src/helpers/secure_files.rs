//! Owner-only filesystem primitives shared by the credential stores
//! (control socket dir, remote-gateway TLS identity + device tokens).
//!
//! `write_owner_only` applies the 0o600 mode at `open` time so the file
//! never exists with broader permissions (no chmod-after-write TOCTOU
//! window); `0o600 & ~umask` can only be more restrictive, never looser.
//! `set_dir_owner_only` locks the containing directory to 0o700 so other
//! local users can't even reach the entries regardless of file modes.
//! Both are no-ops beyond the plain write on non-unix targets, where the
//! per-user profile directory is the isolation boundary.

use std::io::Write;
use std::path::Path;

#[cfg(unix)]
pub fn write_owner_only(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(contents)
        .map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(not(unix))]
pub fn write_owner_only(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(contents)
        .map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn set_dir_owner_only(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod {}: {e}", dir.display()))?;
    }
    let _ = dir;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn write_owner_only_grants_no_group_or_other_access() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        write_owner_only(&path, b"secret-token").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "mode {mode:o} leaks beyond the owner");
        assert_eq!(std::fs::read(&path).unwrap(), b"secret-token");
    }

    #[test]
    fn write_owner_only_truncates_previous_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        write_owner_only(&path, b"a-long-first-value").unwrap();
        write_owner_only(&path, b"short").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"short");
    }

    #[test]
    fn set_dir_owner_only_locks_directory() {
        let dir = tempfile::tempdir().unwrap();
        set_dir_owner_only(dir.path()).unwrap();
        let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
