//! Project icon discovery — one IPC round-trip that scans a curated set
//! of well-known logo / favicon / app-icon locations inside a project and
//! returns the first match as a `data:` URL ready to drop into an `<img>`.
//!
//! Why Rust instead of the TS scanner: the old approach fired one
//! `fs_list_dir` + one `fs_read_file_base64` per candidate directory over
//! the IPC bridge. Adding more locations multiplied the round-trips. Doing
//! the whole walk in one native call keeps it to a single `invoke`, and
//! the filesystem `stat`s are essentially free compared to the bridge hop.
//!
//! Security: every candidate is a fixed relative path (no caller input
//! beyond `project_path`), joined to the root and run through the same
//! symlink-escape check the rest of `commands::fs` uses, so a symlinked
//! `public/favicon.png -> /etc/shadow` can't leak out.
//!
//! The candidate order is priority order: purpose-built brand logos first,
//! then framework favicons, then app-bundle icons (so a Tauri/Electron
//! repo surfaces its own product icon — e.g. `src-tauri/icons/`).

use super::security::{canonical_root, ensure_symlink_safe};
use std::path::Path;

/// Icons should be small — cap the inlined blob well below the 10 MB file
/// ceiling so a stray large PNG in `assets/` can't bloat the data URL.
const ICON_MAX_BYTES: u64 = 512 * 1024;

/// Relative paths probed in priority order. First readable image wins.
const ICON_CANDIDATES: &[&str] = &[
    // 1) Purpose-built brand logos at the repo root / common doc spots.
    "logo.svg",
    "logo.png",
    "logo.webp",
    "logo.jpg",
    "icon.svg",
    "icon.png",
    ".github/logo.svg",
    ".github/logo.png",
    "assets/logo.svg",
    "assets/logo.png",
    "docs/logo.svg",
    "docs/logo.png",
    "docs/public/logo.svg",
    "docs/public/logo.png",
    // 2) Framework favicons (Vite/CRA/Next/SvelteKit/Hugo/Astro layouts).
    "public/logo.svg",
    "public/logo.png",
    "public/favicon.svg",
    "public/favicon.png",
    "public/favicon.ico",
    "public/apple-touch-icon.png",
    "static/favicon.svg",
    "static/favicon.png",
    "static/favicon.ico",
    "app/icon.svg",
    "app/icon.png",
    "app/favicon.ico",
    "src/favicon.ico",
    "src/assets/logo.svg",
    "src/assets/logo.png",
    "website/public/logo.svg",
    "website/static/img/logo.svg",
    // 3) Desktop-app bundle icons (Tauri / Electron product icons).
    "src-tauri/icons/128x128@2x.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/icon.png",
    "build/icon.png",
    "resources/icon.png",
    "icons/icon.png",
    // 4) Bare-root favicons (last — least likely to be the brand mark).
    "favicon.svg",
    "favicon.png",
    "favicon.ico",
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

/// Scan the project for a sensible icon. Returns a `data:<mime>;base64,…`
/// URL for the first match, or `None` if nothing suitable is found (the
/// caller then falls back to the GitHub avatar / initial-tile). Errors
/// only when the root itself is invalid.
#[tauri::command]
pub fn fs_discover_project_icon(project_path: String) -> Result<Option<String>, String> {
    use base64::Engine as _;
    let root_canon = canonical_root(&project_path)?;
    let root = Path::new(&project_path);

    for rel in ICON_CANDIDATES {
        let target = root.join(rel);
        // Cheap existence gate before the symlink canonicalization.
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
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(Some(format!("data:{};base64,{b64}", mime_for(name))));
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

    #[test]
    fn finds_public_favicon_and_encodes_data_url() {
        let root = tmp_dir("favicon");
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("public/favicon.png"), b"\x89PNG\r\n\x1a\nfake").unwrap();

        let out = fs_discover_project_icon(root.to_string_lossy().into_owned())
            .unwrap()
            .expect("icon found");
        assert!(out.starts_with("data:image/png;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prefers_logo_over_favicon() {
        let root = tmp_dir("priority");
        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("logo.svg"), b"<svg/>").unwrap();
        std::fs::write(root.join("public/favicon.png"), b"png").unwrap();

        let out = fs_discover_project_icon(root.to_string_lossy().into_owned())
            .unwrap()
            .expect("icon found");
        assert!(out.starts_with("data:image/svg+xml;base64,"), "got {out}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn returns_none_when_no_icon() {
        let root = tmp_dir("empty");
        std::fs::write(root.join("README.md"), b"# hi").unwrap();

        let out = fs_discover_project_icon(root.to_string_lossy().into_owned()).unwrap();
        assert!(out.is_none(), "expected None, got {out:?}");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn skips_oversize_icon() {
        let root = tmp_dir("oversize");
        let big = vec![0u8; (ICON_MAX_BYTES + 1) as usize];
        std::fs::write(root.join("logo.png"), &big).unwrap();

        let out = fs_discover_project_icon(root.to_string_lossy().into_owned()).unwrap();
        assert!(out.is_none(), "oversize icon should be skipped");

        std::fs::remove_dir_all(&root).ok();
    }
}
