//! Install-target detection: locate the self-contained install (`.app`
//! bundle / AppImage / Windows install dir) we'll back up and restore.

use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

use super::schema::{InstallKind, InstallTarget};

pub(super) fn detect_install_target() -> Result<InstallTarget, String> {
    let executable_path = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    detect_install_target_from_exe(&executable_path)
}

fn detect_install_target_from_exe(executable_path: &Path) -> Result<InstallTarget, String> {
    #[cfg(target_os = "macos")]
    {
        let app = mac_app_root(executable_path)?;
        return Ok(InstallTarget {
            kind: InstallKind::MacApp,
            target_path: app,
            executable_path: executable_path.to_path_buf(),
            is_dir: true,
        });
    }

    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or_else(|| executable_path.to_path_buf());
        return Ok(InstallTarget {
            kind: InstallKind::LinuxAppImage,
            target_path: appimage.clone(),
            executable_path: appimage,
            is_dir: false,
        });
    }

    #[cfg(windows)]
    {
        let dir = executable_path
            .parent()
            .ok_or_else(|| "current executable has no parent directory".to_string())?
            .to_path_buf();
        return Ok(InstallTarget {
            kind: InstallKind::WindowsInstallDir,
            target_path: dir,
            executable_path: executable_path.to_path_buf(),
            is_dir: true,
        });
    }

    #[allow(unreachable_code)]
    Err("unsupported updater target".to_string())
}

#[cfg(target_os = "macos")]
fn mac_app_root(executable_path: &Path) -> Result<std::path::PathBuf, String> {
    let mut cur = executable_path;
    while let Some(parent) = cur.parent() {
        if parent.extension().and_then(|s| s.to_str()) == Some("app") {
            return Ok(parent.to_path_buf());
        }
        cur = parent;
    }
    Err(format!(
        "could not find .app root for {}",
        executable_path.display()
    ))
}
