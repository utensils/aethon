use std::path::PathBuf;

use super::common::read_only_tokio_gh_command;

/// Compact view of a single GitHub issue, surfaced on the dashboard.
/// camelCase serde so the TS side reads it as-is.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhIssue {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub labels: Vec<GhIssueLabel>,
    /// ISO 8601 — surface "updated 3d ago" on the card.
    pub updated_at: Option<String>,
    pub author: Option<String>,
    pub comments: i64,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhIssueLabel {
    pub name: String,
    /// Hex color (without `#`) so the frontend can render the chip.
    pub color: Option<String>,
}

/// Detailed fetch for a single issue, used when the user picks "send
/// to agent" — we need the body, not just the headline.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhIssueDetail {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub body: String,
    pub author: Option<String>,
}

pub(crate) fn parse_gh_issue_list(s: &str) -> Vec<GhIssue> {
    let v: serde_json::Value = match serde_json::from_str(s) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|item| {
            let number = item.get("number")?.as_i64()?;
            let title = item.get("title")?.as_str()?.to_string();
            let url = item.get("url")?.as_str()?.to_string();
            let state = item
                .get("state")
                .and_then(|x| x.as_str())
                .unwrap_or("OPEN")
                .to_string();
            let updated_at = item
                .get("updatedAt")
                .and_then(|x| x.as_str())
                .map(String::from);
            let author = item
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|s| s.as_str())
                .map(String::from);
            let comments = item.get("comments").and_then(|x| x.as_i64()).unwrap_or(0);
            let labels = item
                .get("labels")
                .and_then(|x| x.as_array())
                .map(|labels| {
                    labels
                        .iter()
                        .filter_map(|l| {
                            let name = l.get("name")?.as_str()?.to_string();
                            let color = l.get("color").and_then(|c| c.as_str()).map(String::from);
                            Some(GhIssueLabel { name, color })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(GhIssue {
                number,
                title,
                url,
                state,
                labels,
                updated_at,
                author,
                comments,
            })
        })
        .collect()
}

/// List open issues for the gh-resolved repository at `project_path`.
/// Empty Vec when gh isn't installed / not auth'd / repo not on GH —
/// the dashboard renders the empty state in that case rather than an
/// error. `limit` is clamped to [1, 100] to keep one shell-out fast.
#[tauri::command]
pub async fn gh_issue_list(project_path: String, limit: Option<u32>) -> Vec<GhIssue> {
    use std::time::Duration;
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Vec::new();
    }
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let limit_str = limit.to_string();
    tokio::time::timeout(Duration::from_secs(5), async {
        let out = read_only_tokio_gh_command()
            .args([
                "issue",
                "list",
                "--state",
                "open",
                "--limit",
                &limit_str,
                "--json",
                "number,title,url,state,labels,updatedAt,author,comments",
            ])
            .current_dir(&dir)
            .output()
            .await
            .ok()?;
        if !out.status.success() {
            return Some(Vec::new());
        }
        Some(parse_gh_issue_list(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .unwrap_or(Some(Vec::new()))
    .unwrap_or_default()
}

/// Fetch a single issue's body + author. Separate from `gh_issue_list`
/// so the list view stays cheap; this is only called when the user
/// picks "send to agent" so we have the full content to forward.
#[tauri::command]
pub async fn gh_issue_view(project_path: String, number: i64) -> Result<GhIssueDetail, String> {
    use std::time::Duration;
    let dir = PathBuf::from(&project_path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {project_path}"));
    }
    if number <= 0 {
        return Err("issue number must be positive".into());
    }
    let out = tokio::time::timeout(Duration::from_secs(5), async {
        read_only_tokio_gh_command()
            .args([
                "issue",
                "view",
                &number.to_string(),
                "--json",
                "number,title,url,body,author",
            ])
            .current_dir(&dir)
            .output()
            .await
    })
    .await
    .map_err(|_| "gh issue view timed out".to_string())?
    .map_err(|e| format!("gh issue view: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("gh issue view: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("gh issue view: bad json: {e}"))?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let url = v
        .get("url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let body = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let author = v
        .get("author")
        .and_then(|a| a.get("login"))
        .and_then(|s| s.as_str())
        .map(String::from);
    Ok(GhIssueDetail {
        number,
        title,
        url,
        body,
        author,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gh_issue_list_extracts_labels_and_author() {
        let json = r#"
        [
            {
                "number": 1,
                "title": "Crash on launch",
                "url": "https://github.com/o/r/issues/1",
                "state": "OPEN",
                "labels": [
                    {"name": "bug", "color": "ee0701"},
                    {"name": "good first issue"}
                ],
                "updatedAt": "2026-05-22T00:00:00Z",
                "author": {"login": "someone"},
                "comments": 3
            },
            {
                "number": 2,
                "title": "Idea",
                "url": "https://github.com/o/r/issues/2"
            }
        ]
        "#;
        let parsed = parse_gh_issue_list(json);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].number, 1);
        assert_eq!(parsed[0].author.as_deref(), Some("someone"));
        assert_eq!(parsed[0].labels.len(), 2);
        assert_eq!(parsed[0].labels[0].name, "bug");
        assert_eq!(parsed[0].labels[0].color.as_deref(), Some("ee0701"));
        assert_eq!(parsed[0].labels[1].color, None);
        assert_eq!(parsed[0].comments, 3);
        // Second entry: minimal payload (no labels/author/comments)
        // should still produce a row with sensible defaults.
        assert_eq!(parsed[1].number, 2);
        assert!(parsed[1].labels.is_empty());
        assert_eq!(parsed[1].author, None);
        assert_eq!(parsed[1].comments, 0);
    }

    #[test]
    fn parse_gh_issue_list_returns_empty_on_garbage() {
        assert!(parse_gh_issue_list("not json").is_empty());
        assert!(parse_gh_issue_list("{}").is_empty());
        assert!(parse_gh_issue_list("[]").is_empty());
    }
}
