//! Path resolution for the agent runtime.
//!
//! Two flavours: in dev we run `bun run agent/main.ts` from the project
//! root (the directory holding `agent/main.ts`); in release we exec the
//! bundled `aethon-agent` sidecar Tauri places next to the main binary.

use std::path::{Path, PathBuf};

/// Find the project root (the directory containing `agent/main.ts`). Tauri
/// launches the dev binary with cwd set to `src-tauri/`, but our agent script
/// lives one level up, so a naive relative path resolves to the wrong place.
/// Walk up from cwd until we find the marker; fall back to cwd if nothing
/// matches.
pub(crate) fn project_root() -> PathBuf {
    if let Some(path) = std::env::var_os("AETHON_PROJECT_ROOT") {
        let path = PathBuf::from(path);
        if path.join("agent").join("main.ts").exists() {
            return path;
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir: &Path = &cwd;
    for _ in 0..6 {
        if dir.join("agent").join("main.ts").exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => break,
        }
    }
    cwd
}

/// Locate the bundled `aethon-agent` sidecar binary. Tauri's externalBin
/// mechanism places sidecars next to the main executable on each platform
/// (e.g. `Aethon.app/Contents/MacOS/aethon-agent-aarch64-apple-darwin`).
/// Returns Err with a descriptive message when none of the candidate paths
/// exist; the caller falls back to `bun run` in dev or surfaces the error
/// in release.
pub(super) fn find_sidecar_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or("current_exe has no parent dir")?
        .to_path_buf();
    let triple = env!("AETHON_TARGET_TRIPLE");
    // Tauri's externalBin strips the triple suffix before placing the file
    // alongside the main exe. Check the stripped variant first, then the raw
    // triple form for direct target/release runs.
    let ext = std::env::consts::EXE_SUFFIX;
    let candidates = [
        exe_dir.join(format!("aethon-agent{ext}")),
        exe_dir.join(format!("aethon-agent-{triple}{ext}")),
    ];
    for path in &candidates {
        if path.exists() {
            return Ok(path.clone());
        }
    }
    Err(format!(
        "aethon-agent sidecar not found next to {} (looked for: {})",
        exe.display(),
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn project_root_honors_valid_env_override() {
        let dir = tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        std::fs::write(agent_dir.join("main.ts"), "").expect("main marker");

        unsafe { std::env::set_var("AETHON_PROJECT_ROOT", dir.path()) };
        let got = project_root();
        unsafe { std::env::remove_var("AETHON_PROJECT_ROOT") };

        assert_eq!(got, dir.path());
    }

    #[test]
    fn project_root_ignores_invalid_env_override() {
        let dir = tempdir().expect("tempdir");
        unsafe { std::env::set_var("AETHON_PROJECT_ROOT", dir.path()) };
        let got = project_root();
        unsafe { std::env::remove_var("AETHON_PROJECT_ROOT") };

        assert_ne!(got, dir.path());
    }
}
