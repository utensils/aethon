//! Per-file Git diff commands backing the editor's gutter dirty-diff
//! indicators and the side-by-side diff view.
//!
//! Two commands:
//!   - `git_file_diff_hunks` — working-tree-vs-HEAD hunks for one file,
//!     parsed from `git diff -U0` headers into line ranges the frontend
//!     paints in Monaco's gutter (VS Code-style added/modified/deleted
//!     bars).
//!   - `git_show_head` — the file's content at HEAD, the "original" side
//!     of the diff editor. `None` for untracked / never-committed files.
//!
//! Both shell out to `git` via `env::command` (PATH-resolved) and reuse
//! `resolve_repo_and_active_root` so a subdirectory-opened repo resolves
//! the same way the status/ignored commands do.

use std::path::{Path, PathBuf};

use crate::env;

use super::status::resolve_repo_and_active_root;

/// One contiguous change in a file relative to HEAD, in **new-file** line
/// coordinates (1-based). `kind` is one of `added` / `modified` /
/// `deleted`. For deletions `count` is 1 and `start` marks the line the
/// removed text sat after (so the gutter can draw a caret there).
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub kind: &'static str,
    pub start: u32,
    pub count: u32,
}

/// Resolve the path the frontend passed (absolute editor path, or a path
/// already relative to the active root) to a string relative to
/// `active_root`, using forward slashes for git pathspecs.
fn rel_to_active(active_root: &Path, raw: &str) -> Option<String> {
    let raw_path = Path::new(raw);
    let abs = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        active_root.join(raw_path)
    };
    // canonicalize when the file exists so symlinked roots line up; fall
    // back to the lexical join for deleted files (no longer on disk).
    let abs = abs.canonicalize().unwrap_or(abs);
    let rel = abs.strip_prefix(active_root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() { None } else { Some(s) }
}

/// Return working-tree-vs-HEAD hunks for a single file. `None` when the
/// directory isn't a git worktree; `Some(empty)` when the file is clean,
/// untracked (no HEAD baseline), or the path can't be resolved.
#[tauri::command]
pub async fn git_file_diff_hunks(
    root: String,
    path: String,
) -> Result<Option<Vec<DiffHunk>>, String> {
    let dir = PathBuf::from(&root);
    if !dir.is_dir() {
        return Ok(None);
    }
    let Some((_repo_root, active_root)) = resolve_repo_and_active_root(&dir)? else {
        return Ok(None);
    };
    let Some(rel) = rel_to_active(&active_root, &path) else {
        return Ok(Some(Vec::new()));
    };

    // `-U0` collapses each change to its own hunk with zero context, so a
    // header alone tells us the kind + line range. `HEAD` compares the
    // working tree (staged + unstaged) against the last commit, matching
    // VS Code's default dirty-diff baseline.
    let output = env::command("git")
        .arg("-C")
        .arg(&active_root)
        .args(["diff", "--no-color", "-U0", "HEAD", "--", &rel])
        .output()
        .map_err(|e| format!("git diff: {e}"))?;
    if !output.status.success() {
        // Non-zero is the normal "no HEAD entry for this path" case
        // (untracked / new file) — degrade to no gutter rather than error.
        return Ok(Some(Vec::new()));
    }
    Ok(Some(parse_diff_hunks(&output.stdout)))
}

/// Return the file's content at HEAD — the original side of the diff
/// editor. `None` when not in a worktree, the path can't be resolved, or
/// the file doesn't exist at HEAD (untracked / newly added).
#[tauri::command]
pub async fn git_show_head(root: String, path: String) -> Result<Option<String>, String> {
    let dir = PathBuf::from(&root);
    if !dir.is_dir() {
        return Ok(None);
    }
    let Some((_repo_root, active_root)) = resolve_repo_and_active_root(&dir)? else {
        return Ok(None);
    };
    let Some(rel) = rel_to_active(&active_root, &path) else {
        return Ok(None);
    };

    // `HEAD:./<rel>` resolves the blob relative to the cwd (`-C` target),
    // so we don't have to translate into repo-root coordinates.
    let spec = format!("HEAD:./{rel}");
    let output = env::command("git")
        .arg("-C")
        .arg(&active_root)
        .args(["show", &spec])
        .output()
        .map_err(|e| format!("git show: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()))
}

/// Parse `git diff -U0` output into hunks. Only the `@@ -a,b +c,d @@`
/// headers matter at zero context; body lines are ignored. Coordinates
/// are the **new-file** side (`+c,d`).
pub(crate) fn parse_diff_hunks(bytes: &[u8]) -> Vec<DiffHunk> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    for line in text.lines() {
        if !line.starts_with("@@") {
            continue;
        }
        // `@@ -a,b +c,d @@ optional section heading`
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        let Some(end) = rest.find(" @@") else {
            continue;
        };
        let spec = &rest[..end];
        let mut parts = spec.split(' ');
        let Some(old) = parts.next() else { continue };
        let Some(new) = parts.next() else { continue };
        let Some((_old_start, old_count)) = parse_range(old, '-') else {
            continue;
        };
        let Some((new_start, new_count)) = parse_range(new, '+') else {
            continue;
        };

        if old_count == 0 {
            // Pure insertion: `+c,d` are the new lines.
            out.push(DiffHunk {
                kind: "added",
                start: new_start.max(1),
                count: new_count.max(1),
            });
        } else if new_count == 0 {
            // Pure deletion: lines removed after new-file line `c`. Mark a
            // single caret at that line (clamped to 1 for top-of-file).
            out.push(DiffHunk {
                kind: "deleted",
                start: new_start.max(1),
                count: 1,
            });
        } else {
            out.push(DiffHunk {
                kind: "modified",
                start: new_start.max(1),
                count: new_count,
            });
        }
    }
    out
}

/// Parse one side of a hunk range, e.g. `-12,3` or `+45` (count defaults
/// to 1 when omitted). Returns `(start, count)`.
fn parse_range(token: &str, sign: char) -> Option<(u32, u32)> {
    let body = token.strip_prefix(sign)?;
    let mut it = body.split(',');
    let start: u32 = it.next()?.parse().ok()?;
    let count: u32 = match it.next() {
        Some(c) => c.parse().ok()?,
        None => 1,
    };
    Some((start, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_added_modified_and_deleted_hunks() {
        // Insertion of 2 lines at new line 5; modification of 1 line at 10;
        // deletion after new line 20.
        let diff = b"diff --git a/f b/f\n\
index 000..111 100644\n\
--- a/f\n\
+++ b/f\n\
@@ -4,0 +5,2 @@ fn ctx\n\
+added one\n\
+added two\n\
@@ -10,1 +10,1 @@\n\
-old ten\n\
+new ten\n\
@@ -20,2 +20,0 @@\n\
-gone one\n\
-gone two\n";
        let hunks = parse_diff_hunks(diff);
        assert_eq!(
            hunks,
            vec![
                DiffHunk { kind: "added", start: 5, count: 2 },
                DiffHunk { kind: "modified", start: 10, count: 1 },
                DiffHunk { kind: "deleted", start: 20, count: 1 },
            ]
        );
    }

    #[test]
    fn defaults_count_to_one_when_omitted() {
        let diff = b"@@ -3 +3 @@\n-x\n+y\n";
        let hunks = parse_diff_hunks(diff);
        assert_eq!(hunks, vec![DiffHunk { kind: "modified", start: 3, count: 1 }]);
    }

    #[test]
    fn clamps_top_of_file_insertion_to_line_one() {
        let diff = b"@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
        let hunks = parse_diff_hunks(diff);
        assert_eq!(hunks, vec![DiffHunk { kind: "added", start: 1, count: 3 }]);
    }

    #[test]
    fn ignores_non_hunk_lines() {
        assert!(parse_diff_hunks(b"diff --git a/f b/f\njust text\n").is_empty());
        assert!(parse_diff_hunks(b"").is_empty());
    }
}
