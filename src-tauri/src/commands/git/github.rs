use std::path::{Component, Path, PathBuf};

use super::common::{read_only_gh_command, read_only_tokio_gh_command};

/// GitHub branch status as understood by `gh` CLI. Returned shape is
/// intentionally narrow so the worktree-landing UI can render without
/// dragging the full Octocrab schema.
///
/// All fields are best-effort. `gh_available = false` means we couldn't
/// find / auth `gh`; the UI degrades gracefully (renders "Connect
/// GitHub" instead of an error). `pushed` is true when the branch
/// exists on the remote (we look it up via `gh api`). `prs` lists open
/// + recently-closed PRs whose head matches the branch.
#[derive(serde::Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhBranchStatus {
    /// True when the `gh` CLI binary was reachable AND authenticated.
    /// When false, every other field is empty/None.
    pub gh_available: bool,
    /// `<owner>/<repo>` if the repo has a recognised GitHub remote.
    pub repo: Option<String>,
    /// True when `gh api repos/<repo>/branches/<branch>` returned 200.
    /// Implies the branch is pushed.
    pub pushed: bool,
    /// PRs whose head is the requested branch. Includes open + recently
    /// closed PRs so users see merge state when the branch is gone.
    pub prs: Vec<GhPr>,
    /// True when the worktree directory still exists on disk but its
    /// `.git` file points to a `.git/worktrees/<name>/` entry that's
    /// been pruned externally. Distinct from `gh_available=false`
    /// (gh missing) and `repo=None` (no GitHub remote) — those are
    /// healthy states, this one means the user should clean up the
    /// stale entry.
    pub worktree_broken: bool,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhPr {
    pub number: u64,
    pub state: String,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub merged: bool,
    pub base_ref_name: String,
}

/// Fetch GitHub branch status via `gh` CLI. Silently degrades on every
/// failure mode — missing binary, not authed, non-GitHub remote, network
/// error — so the worktree landing always renders. The frontend reads
/// `ghAvailable` first; on false everything else is ignored.
#[tauri::command]
pub async fn gh_branch_status(
    project_path: String,
    branch: String,
) -> Result<GhBranchStatus, String> {
    Ok(gh_branch_status_inner(&project_path, &branch))
}

/// Detect a worktree whose on-disk `.git` file points to a pruned
/// `.git/worktrees/<name>/` entry. Hermetic — no git process spawn,
/// no network. Returns false for a plain (non-worktree) directory or
/// a healthy repo.
pub(crate) fn worktree_is_dangling(dir: &std::path::Path) -> bool {
    let marker = dir.join(".git");
    if !marker.is_file() {
        return false;
    }
    let Ok(contents) = std::fs::read_to_string(&marker) else {
        return false;
    };
    let Some(target) = contents
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("gitdir:").map(str::trim))
    else {
        return false;
    };
    let Some(target_path) = resolve_gitdir_marker_target(&marker, target) else {
        return false;
    };
    !target_path.exists()
}

fn resolve_gitdir_marker_target(marker: &Path, gitdir: &str) -> Option<PathBuf> {
    let raw = Path::new(gitdir);
    let path = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        marker.parent()?.join(raw)
    };
    normalize_path(&path)
}

fn normalize_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
        }
    }
    Some(normalized)
}

pub(crate) fn gh_branch_status_inner(project_path: &str, branch: &str) -> GhBranchStatus {
    let mut status = GhBranchStatus::default();
    let dir = PathBuf::from(project_path);
    if !dir.is_dir() || branch.is_empty() {
        return status;
    }
    // 0. Short-circuit on a dangling worktree (registry pruned, dir
    //    still on disk). Every git invocation below would fail; we'd
    //    end up with `gh_available=true, repo=None` and the landing
    //    would mislabel it as "no GitHub remote".
    if worktree_is_dangling(&dir) {
        status.worktree_broken = true;
        return status;
    }
    // 1. gh available + authed?
    let auth = read_only_gh_command().args(["auth", "status"]).output();
    let Ok(out) = auth else { return status };
    if !out.status.success() {
        return status;
    }
    status.gh_available = true;

    // 2. Identify the GitHub <owner>/<repo>. `gh repo view` takes a
    //    positional `[<repository>]` arg (not a `-R` flag — `repo view`
    //    is the one subcommand that doesn't share the `--repo` family
    //    convention), so we rely on `current_dir(&dir)` and a bare
    //    invocation. Output empty / non-zero on non-GitHub remotes,
    //    which doubles as our "is this on GitHub?" check.
    let repo_out = read_only_gh_command()
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ])
        .current_dir(&dir)
        .output();
    let repo_str = match repo_out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return status,
    };
    if repo_str.is_empty() {
        return status;
    }
    status.repo = Some(repo_str.clone());

    // 3. Branch exists on remote? `gh api` returns 200 with the branch
    //    metadata when present; non-200 means not pushed. Branch names
    //    containing slashes (`feat/foo`, `release/1.2.3`) must be
    //    percent-encoded — otherwise GitHub treats the trailing segment
    //    as a separate path element and returns 404 even when the
    //    branch exists.
    let branch_encoded = url_encode_path_segment(branch);
    let pushed_out = read_only_gh_command()
        .args([
            "api",
            "-X",
            "GET",
            &format!("repos/{repo_str}/branches/{branch_encoded}"),
            "--silent",
        ])
        .current_dir(&dir)
        .output();
    if let Ok(o) = pushed_out {
        status.pushed = o.status.success();
    }

    // 4. PRs whose head is this branch. `gh pr list --state all` covers
    //    open + closed (incl. merged). Limit 5 keeps the call cheap and
    //    the UI tidy. `--json` makes parsing robust against future CLI
    //    output tweaks.
    let pr_out = read_only_gh_command()
        .args([
            "pr",
            "list",
            "--repo",
            &repo_str,
            "--state",
            "all",
            "--head",
            branch,
            "--limit",
            "5",
            "--json",
            "number,state,title,url,isDraft,baseRefName,mergedAt",
        ])
        .current_dir(&dir)
        .output();
    if let Ok(o) = pr_out
        && o.status.success()
        && let Ok(parsed) = serde_json::from_slice::<Vec<serde_json::Value>>(&o.stdout)
    {
        for entry in parsed {
            let number = entry.get("number").and_then(|v| v.as_u64());
            let state = entry
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = entry
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let url = entry
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_draft = entry
                .get("isDraft")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let base_ref_name = entry
                .get("baseRefName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let merged = entry.get("mergedAt").map(|v| !v.is_null()).unwrap_or(false);
            if let Some(n) = number {
                status.prs.push(GhPr {
                    number: n,
                    state,
                    title,
                    url,
                    is_draft,
                    merged,
                    base_ref_name,
                });
            }
        }
    }
    status
}

/// Repo-level GitHub data for the per-project dashboard.
///
/// `gh_available = false` collapses every other field. Counts default to
/// 0 on parse failure rather than panicking — the dashboard renders a
/// dash for unknown values, never an error.
#[derive(serde::Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhRepoOverview {
    pub gh_available: bool,
    pub repo: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub default_branch: Option<String>,
    pub stargazer_count: i64,
    pub fork_count: i64,
    pub open_issues_count: i64,
    pub open_prs_count: i64,
    /// ISO 8601 string of the last push to any branch.
    pub pushed_at: Option<String>,
}

/// Parsed subset of `gh repo view --json …` output. Split into its own
/// struct so a sync unit test can exercise the parser without shelling
/// out to gh.
#[derive(Debug, PartialEq)]
pub(crate) struct RepoViewParts {
    pub repo: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub default_branch: Option<String>,
    pub stargazer_count: i64,
    pub fork_count: i64,
    pub pushed_at: Option<String>,
}

/// Percent-encode a single URL path segment. We avoid pulling
/// `url`/`percent-encoding` for this one-call site; the rules are
/// "encode everything outside the RFC 3986 unreserved set". Suitable
/// for branch names being placed into `repos/{owner}/{repo}/branches/{x}`.
pub(crate) fn url_encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let unreserved =
            b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~';
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn parse_repo_view_json(s: &str) -> Option<RepoViewParts> {
    fn strip_empty(x: &serde_json::Value) -> Option<String> {
        x.as_str().filter(|s| !s.is_empty()).map(String::from)
    }
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    Some(RepoViewParts {
        repo: v.get("nameWithOwner").and_then(strip_empty),
        description: v.get("description").and_then(strip_empty),
        url: v.get("url").and_then(strip_empty),
        default_branch: v
            .get("defaultBranchRef")
            .and_then(|x| x.get("name"))
            .and_then(strip_empty),
        stargazer_count: v
            .get("stargazerCount")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
        fork_count: v.get("forkCount").and_then(|x| x.as_i64()).unwrap_or(0),
        pushed_at: v.get("pushedAt").and_then(strip_empty),
    })
}

/// Fetch repo-level GitHub data for the per-project dashboard. Three
/// parallel `gh` calls inside `tokio::join!` so the total latency is
/// max-of-three, not sum. Each is wrapped in a 4s timeout — partial
/// data is fine, the UI shows dashes for fields that didn't come back.
///
/// Degrades silently on missing/un-authed gh, non-GitHub remotes, and
/// timeouts. The `ghAvailable` flag is the UI's gate.
#[tauri::command]
pub async fn gh_repo_overview(project_path: String) -> Result<GhRepoOverview, String> {
    Ok(gh_repo_overview_inner(&project_path).await)
}

async fn gh_repo_overview_inner(project_path: &str) -> GhRepoOverview {
    use std::time::Duration;
    let mut overview = GhRepoOverview::default();
    let dir = PathBuf::from(project_path);
    if !dir.is_dir() {
        return overview;
    }

    // gh available + authed?
    let auth = read_only_tokio_gh_command()
        .args(["auth", "status"])
        .output()
        .await;
    let Ok(out) = auth else { return overview };
    if !out.status.success() {
        return overview;
    }
    overview.gh_available = true;

    let dir_a = dir.clone();
    let repo_view_fut = async move {
        read_only_tokio_gh_command()
            .args([
                "repo",
                "view",
                "--json",
                "nameWithOwner,description,url,defaultBranchRef,stargazerCount,forkCount,pushedAt",
            ])
            .current_dir(&dir_a)
            .output()
            .await
    };

    let dir_b = dir.clone();
    let pr_count_fut = async move {
        read_only_tokio_gh_command()
            .args([
                "pr", "list", "--state", "open", "--json", "number", "-q", "length",
            ])
            .current_dir(&dir_b)
            .output()
            .await
    };

    // Issue count needs the <owner>/<repo>. Re-resolve inside this future
    // so the three top-level calls still run in parallel — the sequential
    // sub-pair here is still bounded by the same 4s timeout.
    let dir_c = dir.clone();
    // `gh issue list -q length` returns ONLY issues (gh filters out PRs
    // on its side), unlike `repos/<owner>/<repo>.open_issues_count`
    // which counts issues + PRs together and inflates the dashboard
    // figure when the repo has open PRs.
    let issue_count_fut = async move {
        let count_out = read_only_tokio_gh_command()
            .args([
                "issue", "list", "--state", "open", "--limit", "1000", "--json", "number", "-q",
                "length",
            ])
            .current_dir(&dir_c)
            .output()
            .await
            .ok()?;
        if !count_out.status.success() {
            return None::<i64>;
        }
        String::from_utf8_lossy(&count_out.stdout)
            .trim()
            .parse::<i64>()
            .ok()
    };

    let (repo_view, pr_count, issue_count) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(4), repo_view_fut),
        tokio::time::timeout(Duration::from_secs(4), pr_count_fut),
        tokio::time::timeout(Duration::from_secs(4), issue_count_fut),
    );

    if let Ok(Ok(o)) = repo_view
        && o.status.success()
        && let Some(parts) = parse_repo_view_json(&String::from_utf8_lossy(&o.stdout))
    {
        overview.repo = parts.repo;
        overview.description = parts.description;
        overview.url = parts.url;
        overview.default_branch = parts.default_branch;
        overview.stargazer_count = parts.stargazer_count;
        overview.fork_count = parts.fork_count;
        overview.pushed_at = parts.pushed_at;
    }
    if let Ok(Ok(o)) = pr_count
        && o.status.success()
    {
        overview.open_prs_count = String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<i64>()
            .unwrap_or(0);
    }
    if let Ok(Some(n)) = issue_count {
        overview.open_issues_count = n;
    }

    overview
}

/// Resolve a GitHub avatar URL for the repo at `project_path`. Returns
/// `https://github.com/{owner}.png?size=200` when the repo is on GitHub
/// (avatar URL is stable + cacheable + no API token required), else
/// `None`. Used by `src/projectIcons.ts` as the network fallback after
/// a local logo scan misses.
#[tauri::command]
pub async fn gh_repo_avatar_url(project_path: String) -> Option<String> {
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return None;
    }
    let out = read_only_tokio_gh_command()
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ])
        .current_dir(&dir)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name_with_owner = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (owner, _) = name_with_owner.split_once('/')?;
    if owner.is_empty() {
        return None;
    }
    Some(format!("https://github.com/{owner}.png?size=200"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::git::test_support::init_repo;

    #[test]
    fn parses_gh_repo_view_full_fixture() {
        // Trimmed real `gh repo view --json …` output. Confirms field
        // extraction lines up with the camelCase contract the TS side
        // expects.
        let fixture = r#"{
            "nameWithOwner": "anthropics/claude-code",
            "description": "Claude Code is the official CLI for Claude.",
            "url": "https://github.com/anthropics/claude-code",
            "defaultBranchRef": { "name": "main" },
            "stargazerCount": 4321,
            "forkCount": 87,
            "pushedAt": "2026-05-21T19:04:11Z"
        }"#;
        let parts = parse_repo_view_json(fixture).expect("parse");
        assert_eq!(parts.repo.as_deref(), Some("anthropics/claude-code"));
        assert_eq!(
            parts.description.as_deref(),
            Some("Claude Code is the official CLI for Claude.")
        );
        assert_eq!(parts.default_branch.as_deref(), Some("main"));
        assert_eq!(parts.stargazer_count, 4321);
        assert_eq!(parts.fork_count, 87);
        assert_eq!(parts.pushed_at.as_deref(), Some("2026-05-21T19:04:11Z"));
    }

    #[test]
    fn parses_gh_repo_view_with_missing_optionals() {
        // A brand-new repo: no description, never pushed beyond init,
        // zero stars/forks. None of these should crash the parser; the
        // dashboard shows dashes for missing values.
        let fixture = r#"{
            "nameWithOwner": "user/empty",
            "description": null,
            "url": "https://github.com/user/empty",
            "defaultBranchRef": { "name": "main" },
            "stargazerCount": 0,
            "forkCount": 0,
            "pushedAt": null
        }"#;
        let parts = parse_repo_view_json(fixture).expect("parse");
        assert_eq!(parts.repo.as_deref(), Some("user/empty"));
        assert_eq!(parts.description, None);
        assert_eq!(parts.pushed_at, None);
        assert_eq!(parts.stargazer_count, 0);
    }

    #[test]
    fn parses_gh_repo_view_rejects_malformed_json() {
        assert!(parse_repo_view_json("{ broken").is_none());
        assert!(parse_repo_view_json("").is_none());
    }

    #[test]
    fn gh_repo_overview_camel_case_wire_format() {
        // The TS GhRepoOverview interface keys the cache + UI on
        // camelCase; without rename_all the serializer would emit
        // open_prs_count and the frontend would silently read undefined.
        let o = GhRepoOverview {
            gh_available: true,
            repo: Some("a/b".into()),
            description: None,
            url: None,
            default_branch: Some("main".into()),
            stargazer_count: 10,
            fork_count: 2,
            open_issues_count: 5,
            open_prs_count: 1,
            pushed_at: None,
        };
        let json = serde_json::to_value(&o).unwrap();
        assert!(json.get("ghAvailable").is_some());
        assert!(json.get("openIssuesCount").is_some());
        assert!(json.get("openPrsCount").is_some());
        assert!(json.get("stargazerCount").is_some());
        assert!(json.get("forkCount").is_some());
        assert!(json.get("defaultBranch").is_some());
        assert!(json.get("pushedAt").is_some());
        assert!(json.get("open_issues_count").is_none());
    }

    #[test]
    fn worktree_is_dangling_detects_missing_gitdir_target() {
        // A worktree dir whose `.git` file points to a `.git/worktrees/<name>/`
        // entry that was pruned externally — the exact shape this fix
        // exists to recover from. The check must be hermetic (no git
        // invocation) so it runs before `gh auth status` in the status
        // probe.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".git"),
            "gitdir: /var/empty/aethon-test-no-such-worktree-dir\n",
        )
        .expect("write .git");
        assert!(worktree_is_dangling(dir.path()));
    }

    #[test]
    fn worktree_is_dangling_returns_false_for_normal_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        assert!(!worktree_is_dangling(dir.path()));
    }

    #[test]
    fn worktree_is_dangling_returns_false_for_plain_directory() {
        // No `.git` at all — caller is asking about a plain folder, not
        // a worktree. We don't want to mis-label it as "broken".
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!worktree_is_dangling(dir.path()));
    }

    #[test]
    fn worktree_is_dangling_returns_false_when_gitdir_target_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".git"),
            format!("gitdir: {}\n", target.path().display()),
        )
        .expect("write .git");
        assert!(!worktree_is_dangling(dir.path()));
    }

    #[test]
    fn worktree_is_dangling_resolves_relative_gitdir_from_marker_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("relative-gitdir");
        std::fs::create_dir(&target).expect("create target");
        std::fs::write(dir.path().join(".git"), "gitdir: relative-gitdir\n").expect("write .git");
        assert!(!worktree_is_dangling(dir.path()));
    }

    #[test]
    fn gh_branch_status_marks_dangling_worktree() {
        // End-to-end on the inner helper. No `gh` invocation, no
        // network — the dangling check must short-circuit before
        // `gh auth status`.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".git"),
            "gitdir: /var/empty/aethon-test-no-such-worktree-dir\n",
        )
        .expect("write .git");
        let s = gh_branch_status_inner(&dir.path().to_string_lossy(), "main");
        assert!(s.worktree_broken, "expected worktree_broken=true");
        assert!(!s.gh_available);
        assert!(s.repo.is_none());
    }

    #[test]
    fn gh_branch_status_does_not_mark_healthy_repo_broken() {
        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path());
        let s = gh_branch_status_inner(&dir.path().to_string_lossy(), "main");
        assert!(!s.worktree_broken);
    }

    #[test]
    fn url_encode_path_segment_preserves_unreserved() {
        assert_eq!(
            url_encode_path_segment("simple-branch_1.0"),
            "simple-branch_1.0"
        );
    }

    #[test]
    fn url_encode_path_segment_escapes_slashes_and_spaces() {
        assert_eq!(url_encode_path_segment("feat/foo"), "feat%2Ffoo");
        assert_eq!(
            url_encode_path_segment("release/1.2 final"),
            "release%2F1.2%20final"
        );
        assert_eq!(url_encode_path_segment("#hash"), "%23hash");
    }
}
