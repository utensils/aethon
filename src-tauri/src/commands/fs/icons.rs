//! Project icon discovery — one IPC round-trip that scans a curated set
//! of well-known logo / favicon / app-icon locations inside a project and
//! returns the first match as a `data:` URL ready to drop into an `<img>`.
//!
//! Why Rust instead of the TS scanner: the old approach fired one
//! `fs_list_dir` + one `fs_read_file_base64` per candidate directory over
//! the IPC bridge. Adding more locations multiplied the round-trips. Doing
//! the whole walk in one native call keeps it to a single `invoke`, and
//! the filesystem reads are essentially free compared to the bridge hop.
//!
//! Strategy: probe a priority-ordered list of candidate DIRECTORIES, and
//! within each one look for a priority-ordered list of canonical icon
//! BASENAMES (case-insensitive). Matching on exact canonical names —
//! `logo.png`, `favicon.svg`, `icon-512.png`, `128x128.png`, … — keeps
//! coverage broad across frameworks (Vite/Next/SvelteKit/Hugo/Astro/Rails)
//! and app bundlers (Tauri/Electron/PWA) without grabbing arbitrary
//! `*logo*`-named marketing screenshots. The first canonical icon in the
//! highest-priority directory wins.
//!
//! Security: directory + name come from fixed allow-lists (no caller input
//! beyond `project_path`); each match is joined to the root and run
//! through the same symlink-escape check the rest of `commands::fs` uses,
//! so a symlinked `public/favicon.png -> /etc/shadow` can't leak out.

use super::security::{canonical_root, ensure_symlink_safe};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

/// Icons should be small — cap the inlined blob well below the 10 MB file
/// ceiling so a stray large hero image named `logo.png` can't bloat the
/// data URL (it falls through to the next candidate instead).
const ICON_MAX_BYTES: u64 = 1024 * 1024;

/// Candidate directories, highest priority first. Covers repo-root, doc
/// sites, the common web framework static roots (public/static/app),
/// monorepo web subdirs (web/, frontend/, client/, website/), and
/// desktop-app bundle icon dirs (Tauri/Electron).
const ICON_DIRS: &[&str] = &[
    "",
    ".github",
    "public",
    "public/images",
    "public/img",
    "public/assets",
    "static",
    "static/img",
    "static/images",
    "app",
    "app/assets/images",
    "assets",
    "assets/images",
    "src/assets",
    "src/assets/images",
    "frontend/public",
    "frontend/src/assets",
    "client/public",
    "web/public",
    "web/dist",
    "website/public",
    "website/static",
    "website/static/img",
    "docs/public",
    "docs/assets",
    "docs",
    "media",
    "branding",
    "design",
    "src-tauri/icons",
    "build",
    "resources",
    "icons",
    "img",
    "images",
];

/// Canonical icon basenames, highest priority first (compared
/// case-insensitively). Brand logos beat generic favicons; raster app
/// icons (PWA / Tauri / Electron) come last as a recognizable fallback.
const ICON_NAMES: &[&str] = &[
    "logo.svg",
    "logo.png",
    "logo.webp",
    "logo.jpg",
    "logo.jpeg",
    "logomark.svg",
    "logomark.png",
    "icon.svg",
    "icon.png",
    "icon.webp",
    "app-icon.png",
    "appicon.png",
    "mark.svg",
    "mark.png",
    "brand.svg",
    "brand.png",
    "favicon.svg",
    "favicon.png",
    "favicon.ico",
    "favicon-32x32.png",
    "favicon-96x96.png",
    "apple-touch-icon.png",
    "apple-touch-icon-precomposed.png",
    "android-chrome-512x512.png",
    "android-chrome-192x192.png",
    "icon-512x512.png",
    "icon-512.png",
    "icon-256.png",
    "icon-192.png",
    "maskable-icon.png",
    "maskable_icon.png",
    "pwa-512x512.png",
    "pwa-192x192.png",
    "512x512.png",
    "256x256.png",
    "128x128@2x.png",
    "128x128.png",
];

fn mime_for(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else {
        "image/png"
    }
}

/// Lowercased filename -> on-disk filename for the regular files directly
/// inside `dir`. Empty (and silently skipped) when the dir is missing.
fn file_index(dir: &Path) -> HashMap<String, OsString> {
    let mut map = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return map;
    };
    for entry in entries.flatten() {
        // Keep symlinks (they're re-validated below); skip subdirectories.
        let is_file = entry
            .file_type()
            .map(|t| t.is_file() || t.is_symlink())
            .unwrap_or(false);
        if !is_file {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            map.entry(name.to_ascii_lowercase())
                .or_insert_with(|| entry.file_name());
        }
    }
    map
}

/// Scan the project for a sensible icon. Returns a `data:<mime>;base64,…`
/// URL for the first match, or `None` if nothing suitable is found (the
/// caller then falls back to the GitHub avatar / initial-tile). Errors
/// only when the root itself is invalid.
///
/// Async + `spawn_blocking`: the directory walk + file read are synchronous
/// filesystem I/O, so they run on Tauri's blocking pool and never stall the
/// UI thread, even when many projects resolve at once on a cold start.
#[tauri::command]
pub async fn fs_discover_project_icon(project_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || discover_project_icon(&project_path))
        .await
        .map_err(|e| format!("icon scan task failed: {e}"))?
}

/// Synchronous worker behind [`fs_discover_project_icon`]. Kept separate so
/// it runs on the blocking pool (and so unit tests can call it directly).
fn discover_project_icon(project_path: &str) -> Result<Option<String>, String> {
    use base64::Engine as _;
    let root_canon = canonical_root(project_path)?;
    let root = Path::new(project_path);

    for dir in ICON_DIRS {
        let dir_path = if dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(dir)
        };
        // Reject a candidate dir that symlinks outside the project BEFORE
        // reading it, so a hostile `public -> /` symlink can't make us walk
        // a huge or out-of-root tree (the per-file check below would catch
        // the leak, but only after the expensive scan).
        if ensure_symlink_safe(&dir_path, &root_canon).is_err() {
            continue;
        }
        let present = file_index(&dir_path);
        if present.is_empty() {
            continue;
        }
        for name in ICON_NAMES {
            let Some(real) = present.get(*name) else {
                continue;
            };
            let target = dir_path.join(real);
            let Ok(meta) = std::fs::metadata(&target) else {
                continue;
            };
            if !meta.is_file() || meta.len() == 0 || meta.len() > ICON_MAX_BYTES {
                continue;
            }
            // Refuse a symlink that resolves outside the project root.
            if ensure_symlink_safe(&target, &root_canon).is_err() {
                continue;
            }
            let Ok(bytes) = std::fs::read(&target) else {
                continue;
            };
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return Ok(Some(format!("data:{};base64,{b64}", mime_for(name))));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aethon-icon-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn discover(root: &std::path::Path) -> Option<String> {
        // Exercise the synchronous worker directly — the public command is
        // an async spawn_blocking wrapper around it.
        discover_project_icon(&root.to_string_lossy()).unwrap()
    }

    #[test]
    fn finds_public_favicon_and_encodes_data_url() {
        let root = tmp_dir("favicon");
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("public/favicon.png"), b"\x89PNG\r\n\x1a\nfake").unwrap();

        let out = discover(&root).expect("icon found");
        assert!(out.starts_with("data:image/png;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prefers_logo_over_favicon() {
        let root = tmp_dir("priority");
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("logo.svg"), b"<svg/>").unwrap();
        std::fs::write(root.join("public/favicon.png"), b"png").unwrap();

        let out = discover(&root).expect("icon found");
        assert!(out.starts_with("data:image/svg+xml;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn finds_icon_in_nested_framework_dirs() {
        // nxv-style: favicon lives under frontend/, not public/.
        let root = tmp_dir("frontend");
        std::fs::create_dir_all(root.join("frontend/public")).unwrap();
        std::fs::write(root.join("frontend/public/favicon.svg"), b"<svg/>").unwrap();

        let out = discover(&root).expect("icon found");
        assert!(out.starts_with("data:image/svg+xml;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn finds_logo_in_web_public() {
        // mold-style: logo.png under web/public.
        let root = tmp_dir("webpublic");
        std::fs::create_dir_all(root.join("web/public")).unwrap();
        std::fs::write(root.join("web/public/logo.png"), b"png").unwrap();

        let out = discover(&root).expect("icon found");
        assert!(out.starts_with("data:image/png;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn finds_tauri_bundle_icon() {
        let root = tmp_dir("tauri");
        std::fs::create_dir_all(root.join("src-tauri/icons")).unwrap();
        std::fs::write(root.join("src-tauri/icons/128x128.png"), b"png").unwrap();

        let out = discover(&root).expect("icon found");
        assert!(out.starts_with("data:image/png;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn matches_canonical_names_case_insensitively() {
        let root = tmp_dir("case");
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("public/Favicon.PNG"), b"png").unwrap();

        let out = discover(&root).expect("icon found");
        assert!(out.starts_with("data:image/png;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ignores_non_canonical_logo_names() {
        // A marketing screenshot named *logo* must NOT be picked.
        let root = tmp_dir("screenshot");
        std::fs::write(root.join("logo-v2-viewport.png"), b"png").unwrap();

        assert!(
            discover(&root).is_none(),
            "non-canonical name should be ignored"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn skips_candidate_dir_that_symlinks_outside_root() {
        use std::os::unix::fs::symlink;
        let root = tmp_dir("escape-root");
        let outside = tmp_dir("escape-outside");
        std::fs::write(outside.join("favicon.png"), b"png").unwrap();
        // root/public -> outside : an escaping symlink must not be scanned.
        symlink(&outside, root.join("public")).unwrap();

        assert!(
            discover(&root).is_none(),
            "escaped symlink dir must be skipped"
        );

        std::fs::remove_file(root.join("public")).ok();
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn returns_none_when_no_icon() {
        let root = tmp_dir("empty");
        std::fs::write(root.join("README.md"), b"# hi").unwrap();

        assert!(discover(&root).is_none(), "expected None");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn skips_oversize_icon() {
        let root = tmp_dir("oversize");
        let big = vec![0u8; (ICON_MAX_BYTES + 1) as usize];
        std::fs::write(root.join("logo.png"), &big).unwrap();

        assert!(discover(&root).is_none(), "oversize icon should be skipped");

        std::fs::remove_dir_all(&root).ok();
    }
}
