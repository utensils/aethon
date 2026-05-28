//! CI / check-run status for a branch via the `gh` CLI.
//!
//! Sibling to `github.rs::gh_branch_status` (PR state). This command rolls
//! up the GitHub **check-runs** for a branch's head commit into a single
//! conclusion the header chip + source-control panel can render without
//! parsing the full Checks schema.
//!
//! Like every other `gh` call in this crate it degrades silently: missing
//! binary, not authed, non-GitHub remote, network error, or a branch with
//! no CI all collapse to `gh_available`/`conclusion` the UI can gate on.

use std::path::PathBuf;
use std::time::Duration;

use crate::commands::git::github::{url_encode_path_segment, worktree_is_dangling};
use crate::env;

/// One CI check-run, narrowed to what the UI shows.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhCheckRun {
    pub name: String,
    /// `queued` | `in_progress` | `completed`.
    pub status: String,
    /// `success` | `failure` | `neutral` | `cancelled` | `skipped` |
    /// `timed_out` | `action_required` | `stale` | null (still running).
    pub conclusion: Option<String>,
    /// Link to the run on GitHub (`details_url`, falling back to `html_url`).
    pub url: Option<String>,
}

/// Rolled-up CI state for a branch.
///
/// `gh_available = false` collapses every other field. `conclusion` is the
/// single signal the chip reads:
///   - `None`            → not applicable (no gh / no GitHub remote)
///   - `Some("none")`    → repo found, but the head commit has no checks
///   - `Some("pending")` → at least one check still running
///   - `Some("failure")` → at least one check failed
///   - `Some("success")` → all checks passed
///   - `Some("neutral")` → checks exist but all skipped/neutral
#[derive(serde::Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhChecks {
    pub gh_available: bool,
    pub repo: Option<String>,
    pub conclusion: Option<String>,
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub skipped: u32,
    pub checks: Vec<GhCheckRun>,
}

/// Fetch CI check-run status for `branch`. Mirrors `gh_branch_status`'s
/// degrade-silently contract; `ghAvailable` + `conclusion` are the UI's
/// gates.
#[tauri::command]
pub async fn gh_checks(project_path: String, branch: String) -> Result<GhChecks, String> {
    Ok(gh_checks_inner(&project_path, &branch).await)
}

async fn gh_checks_inner(project_path: &str, branch: &str) -> GhChecks {
    let mut checks = GhChecks::default();
    let dir = PathBuf::from(project_path);
    if !dir.is_dir() || branch.is_empty() {
        return checks;
    }
    // A pruned worktree would make every git/gh call fail; short-circuit
    // the same way gh_branch_status does so the UI doesn't mislabel it.
    if worktree_is_dangling(&dir) {
        return checks;
    }

    let auth = env::tokio_command("gh")
        .args(["auth", "status"])
        .output()
        .await;
    let Ok(out) = auth else { return checks };
    if !out.status.success() {
        return checks;
    }
    checks.gh_available = true;

    // Resolve <owner>/<repo>; empty / non-zero means no GitHub remote.
    let repo_out = env::tokio_command("gh")
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
        .await;
    let repo_str = match repo_out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return checks,
    };
    if repo_str.is_empty() {
        return checks;
    }
    checks.repo = Some(repo_str.clone());

    // check-runs for the branch's head commit. `?per_page=100` covers
    // essentially every repo in one page (pagination on a {…} response
    // body doesn't merge cleanly under `gh api --paginate`). Branch names
    // with slashes must be percent-encoded.
    let branch_encoded = url_encode_path_segment(branch);
    let runs_fut = env::tokio_command("gh")
        .args([
            "api",
            "-X",
            "GET",
            &format!("repos/{repo_str}/commits/{branch_encoded}/check-runs?per_page=100"),
        ])
        .current_dir(&dir)
        .output();
    let runs_out = tokio::time::timeout(Duration::from_secs(5), runs_fut).await;

    if let Ok(Ok(o)) = runs_out
        && o.status.success()
        && let Some(parsed) = parse_check_runs_json(&String::from_utf8_lossy(&o.stdout))
    {
        return GhChecks {
            gh_available: true,
            repo: Some(repo_str),
            ..parsed
        };
    }

    // gh available + repo known, but the checks call failed/timed out:
    // treat as "no signal" rather than an error.
    checks.conclusion = Some("none".to_string());
    checks
}

/// Pure parser over the `GET .../check-runs` JSON body. Split out so the
/// rollup logic is exercisable without shelling to gh. Leaves `gh_available`
/// / `repo` for the caller to fill.
pub(crate) fn parse_check_runs_json(s: &str) -> Option<GhChecks> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let runs = v.get("check_runs")?.as_array()?;

    let mut out = GhChecks::default();
    for run in runs {
        let name = run
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let status = run
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let conclusion = run
            .get("conclusion")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let url = run
            .get("details_url")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| run.get("html_url").and_then(|x| x.as_str()))
            .filter(|s| !s.is_empty())
            .map(String::from);

        out.total += 1;
        let completed = status == "completed";
        match conclusion.as_deref() {
            Some("success") => out.passed += 1,
            Some("failure")
            | Some("timed_out")
            | Some("cancelled")
            | Some("action_required")
            | Some("startup_failure")
            | Some("stale") => out.failed += 1,
            Some("skipped") | Some("neutral") => out.skipped += 1,
            // No conclusion yet, or not completed → still pending.
            _ if !completed => out.pending += 1,
            _ => out.skipped += 1,
        }

        out.checks.push(GhCheckRun {
            name,
            status,
            conclusion,
            url,
        });
    }

    out.conclusion = Some(rollup_conclusion(&out).to_string());
    Some(out)
}

/// Collapse the per-run tallies into one signal. Order matters: a failure
/// dominates a pending which dominates a success.
fn rollup_conclusion(c: &GhChecks) -> &'static str {
    if c.total == 0 {
        "none"
    } else if c.failed > 0 {
        "failure"
    } else if c.pending > 0 {
        "pending"
    } else if c.passed > 0 {
        "success"
    } else {
        "neutral"
    }
}
