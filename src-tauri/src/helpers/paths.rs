//! Path-safety helpers shared by the Tauri commands. Every path that
//! crosses the user dir or a project root passes through one of these:
//! `aethon_dir` to resolve `~/.aethon` (honouring the dev-sandbox
//! override) and `resolve_inside_root` to keep file-system commands
//! from escaping the active project.

use std::path::PathBuf;

/// Resolve the Aethon user directory. Honors the `AETHON_USER_DIR`
/// environment variable when set (used by `scripts/dev.sh --new` to
/// route a session into a per-PID tmp sandbox so first-run UX can be
/// exercised without nuking the real user data). Falls back to
/// `<home>/.aethon` otherwise. Caller is responsible for `home_dir`
/// when no override is set — pass `None` to skip the fallback and get
/// a `None` back when neither the env var nor a usable home is set.
pub fn aethon_dir(home: Option<PathBuf>) -> Option<PathBuf> {
    if let Ok(s) = std::env::var("AETHON_USER_DIR")
        && !s.is_empty()
    {
        return Some(PathBuf::from(s));
    }
    home.map(|h| h.join(".aethon"))
}

/// Lexically resolve `..` and `.` segments in `path` and check whether
/// the result is `root` or a descendant. Inputs must be absolute. Returns
/// `Some(resolved)` when the path stays inside `root`, `None` otherwise.
///
/// This is the gatekeeper for the file-system Tauri commands in
/// [`crate::commands::fs`]. Each editor / file-tree operation passes the
/// active project's cwd as `root` and the target path as `path`; the
/// command refuses to touch anything that lexically escapes the root.
///
/// Implementation notes:
///
/// - Pure path arithmetic. We do **not** call `canonicalize` here — for
///   create operations the target path doesn't exist yet, and the helper
///   has to give a stable answer either way. Symlink-aware canonicalization
///   happens once per command, after this check passes, on whichever
///   parent component already exists. That second pass catches symlink
///   escapes that lexical resolution can't see.
/// - Strips `RootDir`/`Prefix` components on Windows so the comparison is
///   structural; the inputs are still required to be absolute.
/// - Both arguments must be normalized to the same prefix style by the
///   caller (the commands convert `tilde` and relative segments before
///   calling).
pub fn resolve_inside_root(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    use std::path::{Component, PathBuf};
    if !root.is_absolute() || !path.is_absolute() {
        return None;
    }
    // Walk `path` lexically; build up the resolved absolute path.
    let mut resolved: Vec<Component<'_>> = Vec::with_capacity(8);
    for component in path.components() {
        match component {
            Component::ParentDir => {
                // Pop the most recent Normal component. If the only thing
                // left is the prefix/root, this attempts to ascend past
                // the filesystem root — refuse.
                if let Some(last) = resolved.last()
                    && matches!(last, Component::Normal(_))
                {
                    resolved.pop();
                    continue;
                }
                return None;
            }
            Component::CurDir => continue,
            other => resolved.push(other),
        }
    }
    let resolved_path: PathBuf = resolved.iter().collect();
    // Same-prefix structural compare. `starts_with` matches Path
    // component-by-component, so `/a/bc` does not start with `/a/b`.
    if resolved_path == root || resolved_path.starts_with(root) {
        Some(resolved_path)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn resolve_inside_root_accepts_direct_descendant() {
        let root = Path::new("/projects/aethon");
        let target = Path::new("/projects/aethon/src/App.tsx");
        let out = resolve_inside_root(root, target).expect("should resolve");
        assert_eq!(out, PathBuf::from("/projects/aethon/src/App.tsx"));
    }

    #[test]
    fn resolve_inside_root_accepts_root_itself() {
        let root = Path::new("/projects/aethon");
        let out = resolve_inside_root(root, root).expect("root is inside root");
        assert_eq!(out, PathBuf::from("/projects/aethon"));
    }

    #[test]
    fn resolve_inside_root_resolves_inner_parent_segments() {
        // /projects/aethon/src/.. → /projects/aethon, still inside.
        let root = Path::new("/projects/aethon");
        let target = Path::new("/projects/aethon/src/..");
        let out = resolve_inside_root(root, target).expect("inner .. stays inside");
        assert_eq!(out, PathBuf::from("/projects/aethon"));
    }

    #[test]
    fn resolve_inside_root_rejects_traversal_escape() {
        let root = Path::new("/projects/aethon");
        // /projects/aethon/../passwd → /projects/passwd, escapes.
        assert!(resolve_inside_root(root, Path::new("/projects/aethon/../passwd")).is_none());
        // /etc/passwd is plain outside.
        assert!(resolve_inside_root(root, Path::new("/etc/passwd")).is_none());
        // Sibling that shares a prefix is NOT a descendant — `/projects/aethon-other`
        // starts with the same string as `/projects/aethon` but is a sibling
        // dir. starts_with compares components, so this is rejected.
        assert!(resolve_inside_root(root, Path::new("/projects/aethon-other/file")).is_none());
    }

    #[test]
    fn resolve_inside_root_rejects_relative_inputs() {
        // Both args must be absolute. A relative root or path is a caller
        // bug — return None so the command surfaces an error.
        assert!(resolve_inside_root(Path::new("projects/aethon"), Path::new("/x")).is_none());
        assert!(resolve_inside_root(Path::new("/x"), Path::new("projects/aethon")).is_none());
    }

    #[test]
    fn resolve_inside_root_rejects_pop_past_root() {
        // /projects/aethon/../.. ascends above /projects — refuse rather
        // than pop off the prefix component.
        let root = Path::new("/projects/aethon");
        assert!(resolve_inside_root(root, Path::new("/projects/aethon/../..")).is_none());
    }

    /// Tests for `aethon_dir`. The function consults `AETHON_USER_DIR`
    /// at call time, so each test must set+unset the var locally to
    /// stay isolated from sibling tests running in the same process.
    /// We use a global mutex (`ENV_LOCK`) so concurrent test threads
    /// can't observe each other's env mutations.
    mod aethon_dir_tests {
        use super::super::aethon_dir;
        use std::path::PathBuf;
        use std::sync::Mutex;

        static ENV_LOCK: Mutex<()> = Mutex::new(());

        #[test]
        fn returns_home_dotaethon_when_no_override() {
            let _g = ENV_LOCK.lock().unwrap();
            // SAFETY: ENV_LOCK serialises env mutations across tests in
            // this module so concurrent test threads cannot observe a
            // half-written global.
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
            let got = aethon_dir(Some(PathBuf::from("/home/test")));
            assert_eq!(got, Some(PathBuf::from("/home/test/.aethon")));
        }

        #[test]
        fn returns_override_when_env_set() {
            let _g = ENV_LOCK.lock().unwrap();
            unsafe { std::env::set_var("AETHON_USER_DIR", "/tmp/sandbox-42") };
            let got = aethon_dir(Some(PathBuf::from("/home/test")));
            assert_eq!(got, Some(PathBuf::from("/tmp/sandbox-42")));
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
        }

        #[test]
        fn returns_none_when_no_home_and_no_env() {
            let _g = ENV_LOCK.lock().unwrap();
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
            assert_eq!(aethon_dir(None), None);
        }

        #[test]
        fn env_override_wins_even_when_no_home() {
            let _g = ENV_LOCK.lock().unwrap();
            unsafe { std::env::set_var("AETHON_USER_DIR", "/tmp/sandbox-99") };
            let got = aethon_dir(None);
            assert_eq!(got, Some(PathBuf::from("/tmp/sandbox-99")));
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
        }

        #[test]
        fn empty_env_var_falls_back_to_home() {
            let _g = ENV_LOCK.lock().unwrap();
            // Some shells export empty string instead of unsetting. We
            // treat that as "no override" so the user isn't trapped in
            // a broken sandbox at "".
            unsafe { std::env::set_var("AETHON_USER_DIR", "") };
            let got = aethon_dir(Some(PathBuf::from("/h")));
            assert_eq!(got, Some(PathBuf::from("/h/.aethon")));
            unsafe { std::env::remove_var("AETHON_USER_DIR") };
        }
    }
}
