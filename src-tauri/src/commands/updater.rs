//! Auto-updater IPC: channel-aware `check_for_updates_with_channel` and
//! `install_pending_update`. Wraps `tauri_plugin_updater` so the frontend's
//! manual "Check for Updates" path and the background polling hook flow
//! through the same code path, with boot-probation backups taken just
//! before the install actually downloads.
//!
//! Lifted from Claudette (`src-tauri/src/commands/updater.rs`) with the
//! release URLs, tracing target, and managed-state hand-off rebased on
//! Aethon's conventions.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::boot_probation;
use crate::updater_state::UpdaterState;

const STABLE_URL: &str = "https://github.com/utensils/aethon/releases/latest/download/latest.json";
const NIGHTLY_URL: &str =
    "https://github.com/utensils/aethon/releases/download/nightly/latest.json";

const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/utensils/aethon/releases?per_page=10";
const NIGHTLY_CANDIDATE_LIMIT: usize = 3;
const USER_AGENT: &str = concat!("aethon-updater/", env!("CARGO_PKG_VERSION"));
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);

/// Subset of [`tauri_plugin_updater::Update`] that we expose across the IPC boundary.
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

fn endpoint_for(channel: &str) -> &'static str {
    match channel {
        "stable" => STABLE_URL,
        "nightly" => NIGHTLY_URL,
        other => {
            tracing::warn!(target: "aethon::updater", channel = %other, "unknown channel — falling back to stable");
            STABLE_URL
        }
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Subset of the GitHub Releases API payload we filter on.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
}

/// Parse a GitHub Releases API response and return the top `limit` candidate
/// `latest.json` URLs for the nightly channel, newest first. Pure function so
/// the filtering/sorting logic is unit-testable without HTTP.
fn nightly_candidate_urls_from_json(body: &str, limit: usize) -> Vec<Url> {
    if limit == 0 {
        return Vec::new();
    }
    let releases: Vec<GhRelease> = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut filtered: Vec<GhRelease> = releases
        .into_iter()
        .filter(|r| {
            !r.draft
                && r.prerelease
                && r.tag_name != "nightly-staging"
                && (r.tag_name == "nightly" || r.tag_name.starts_with("nightly-"))
        })
        .collect();

    // Newest first. ISO-8601 Z-suffixed timestamps sort correctly as strings.
    // Releases with no published_at sort last.
    filtered.sort_by(|a, b| b.published_at.cmp(&a.published_at));

    let mut urls: Vec<Url> = Vec::new();
    for r in filtered {
        let raw = format!(
            "https://github.com/utensils/aethon/releases/download/{}/latest.json",
            r.tag_name
        );
        if let Ok(url) = Url::parse(&raw)
            && !urls.contains(&url)
        {
            urls.push(url);
            if urls.len() >= limit {
                break;
            }
        }
    }
    urls
}

/// Discover nightly `latest.json` candidate URLs by querying the GitHub
/// Releases API. Always returns a (possibly empty) vec; transport, HTTP,
/// or parse failures are logged and downgrade to "no candidates," letting
/// the caller fall back to the static [`NIGHTLY_URL`].
async fn discover_nightly_endpoints() -> Vec<Url> {
    let resp = match http_client()
        .get(GITHUB_RELEASES_API)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .timeout(DISCOVERY_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                target: "aethon::updater",
                error = %e,
                "nightly discovery request failed — falling back to static URL"
            );
            return Vec::new();
        }
    };

    let status = resp.status();
    if !status.is_success() {
        tracing::warn!(
            target: "aethon::updater",
            status = %status,
            "nightly discovery returned non-success HTTP status — falling back to static URL"
        );
        return Vec::new();
    }

    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(
                target: "aethon::updater",
                error = %e,
                "nightly discovery body read failed — falling back to static URL"
            );
            return Vec::new();
        }
    };

    nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT)
}

/// Build the ordered endpoint list to feed to the Tauri updater plugin. The
/// plugin tries each in order and stops at the first one that fetches +
/// parses, so a broken `latest.json` on the most recent nightly silently fails
/// over to the previous one.
async fn endpoints_for(channel: &str) -> Result<Vec<Url>, String> {
    if channel == "nightly" {
        let mut endpoints = discover_nightly_endpoints().await;
        let static_fallback: Url = NIGHTLY_URL
            .parse()
            .map_err(|e: url::ParseError| e.to_string())?;
        if !endpoints.contains(&static_fallback) {
            endpoints.push(static_fallback);
        }
        return Ok(endpoints);
    }

    let url: Url = endpoint_for(channel)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    Ok(vec![url])
}

/// Classifies an updater error: `Ok(())` means "downgrade to no update
/// available", `Err(...)` is a real transport/parse failure that should
/// bubble up to the UI.
///
/// `Error::ReleaseNotFound` covers HTTP 404 on `latest.json` (the manifest
/// doesn't exist — e.g. nightly is mid-build and the release is still
/// draft) plus any other non-success HTTP status the upstream plugin maps
/// to the same variant. Both are benign — the user's currently-installed
/// build is still working; surfacing a red error banner is more alarming
/// than the situation warrants.
fn classify_check_error(err: tauri_plugin_updater::Error) -> Result<(), String> {
    match err {
        tauri_plugin_updater::Error::ReleaseNotFound => Ok(()),
        other => Err(other.to_string()),
    }
}

/// Check the configured channel's release feed for an update.
///
/// On success, the resulting [`tauri_plugin_updater::Update`] is stashed in
/// [`UpdaterState::pending_update`] so that [`install_pending_update`] can
/// hand it off to the platform installer. The serializable [`UpdateInfo`]
/// is returned to JS so the UI can render the version banner.
#[tauri::command]
pub async fn check_for_updates_with_channel(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    channel: String,
) -> Result<Option<UpdateInfo>, String> {
    if !crate::commands::window::updater_pubkey_configured() {
        // No pubkey → no signature verification → don't promise updates.
        return Ok(None);
    }
    let endpoints = endpoints_for(&channel).await?;

    let result = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await;

    let update = match result {
        Ok(u) => u,
        Err(e) => match classify_check_error(e) {
            Ok(()) => {
                tracing::info!(
                    target: "aethon::updater",
                    channel = %channel,
                    "release manifest unavailable — treating as no update available"
                );
                None
            }
            Err(msg) => return Err(msg),
        },
    };

    let mut slot = state.pending_update.lock().await;
    match update {
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                body: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            };
            *slot = Some(u);
            Ok(Some(info))
        }
        None => {
            *slot = None;
            Ok(None)
        }
    }
}

/// Download and install the pending update, then restart the app.
///
/// Emits `updater://preparing` ("backup" then "downloading") around the
/// pre-install backup, and `updater://progress` (u32, 0–100) as bytes
/// arrive. Returns an error if no update is pending.
#[tauri::command]
pub async fn install_pending_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    let update = state
        .pending_update
        .lock()
        .await
        .take()
        .ok_or_else(|| "No pending update".to_string())?;

    let app_for_cb = app.clone();
    let mut total: u64 = 0;
    let mut downloaded: u64 = 0;

    let _ = app.emit("updater://preparing", "backup");
    let data_dir = aethon_data_dir(&app)?;
    let current_version = update.current_version.clone();
    let next_version = update.version.clone();
    let download_url = update.download_url.as_str().to_string();
    // The recursive backup copy is synchronous std::fs work and would
    // block this command's tokio worker for the full duration of the
    // .app bundle copy — measurably bad. spawn_blocking offloads it to
    // the dedicated blocking pool so other commands and event listeners
    // stay responsive while the backup is created.
    tokio::task::spawn_blocking(move || {
        boot_probation::prepare_for_update(
            &data_dir,
            &current_version,
            &next_version,
            &download_url,
        )
    })
    .await
    .map_err(|e| format!("boot probation prepare task panicked: {e}"))??;
    let _ = app.emit("updater://preparing", "downloading");

    update
        .download_and_install(
            move |chunk_len, content_len| {
                if let Some(c) = content_len {
                    total = c;
                }
                downloaded += chunk_len as u64;
                // Hold back the emit until we know the payload size.
                // tauri-plugin-updater's callback signature allows
                // `content_len = None` on the first chunk, and a
                // divide-by-zero against `total = 0` would keep
                // emitting `0%` for every subsequent chunk until the
                // size finally arrives. Letting the frontend stay on
                // its prior "Preparing…" state is a better UX than a
                // bar pinned at 0%.
                if total == 0 {
                    return;
                }
                let pct = downloaded
                    .checked_mul(100)
                    .and_then(|v| v.checked_div(total))
                    .unwrap_or(0)
                    .min(100) as u32;
                let _ = app_for_cb.emit("updater://progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // `AppHandle::restart` returns `!`, so it satisfies the `Result<(), String>`
    // signature without an explicit `Ok(())`.
    app.restart();
}

/// Resolve `~/.aethon` for the running user, honouring the `AETHON_USER_DIR`
/// sandbox override that `scripts/dev.sh --new` uses. Returns an error if
/// the home directory itself can't be resolved.
fn aethon_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home_dir: {e}"))?;
    crate::helpers::aethon_dir(Some(home)).ok_or_else(|| "aethon dir unresolved".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_not_found_is_treated_as_no_update() {
        let result = classify_check_error(tauri_plugin_updater::Error::ReleaseNotFound);
        assert!(matches!(result, Ok(())));
    }

    #[test]
    fn other_errors_bubble_up_as_strings() {
        let err = tauri_plugin_updater::Error::EmptyEndpoints;
        let expected = err.to_string();
        match classify_check_error(err) {
            Err(msg) => assert_eq!(msg, expected),
            Ok(_) => panic!("EmptyEndpoints should not be downgraded"),
        }
    }

    #[test]
    fn endpoint_for_known_channels() {
        assert_eq!(endpoint_for("stable"), STABLE_URL);
        assert_eq!(endpoint_for("nightly"), NIGHTLY_URL);
        assert_eq!(endpoint_for("garbage"), STABLE_URL);
    }

    fn release_json(
        tag: &str,
        draft: bool,
        prerelease: bool,
        published_at: Option<&str>,
    ) -> String {
        let pa = match published_at {
            Some(s) => format!("\"{s}\""),
            None => "null".to_string(),
        };
        format!(
            "{{\"tag_name\":\"{tag}\",\"draft\":{draft},\"prerelease\":{prerelease},\"published_at\":{pa}}}"
        )
    }

    fn url(tag: &str) -> Url {
        Url::parse(&format!(
            "https://github.com/utensils/aethon/releases/download/{tag}/latest.json"
        ))
        .unwrap()
    }

    #[test]
    fn parses_and_filters_top_three_nightlies() {
        let body = format!(
            "[{},{},{},{},{}]",
            release_json("v0.4.0", false, false, Some("2026-05-25T00:00:00Z")),
            release_json("nightly-staging", true, true, Some("2026-05-26T18:00:00Z")),
            release_json("nightly", false, true, Some("2026-05-26T15:00:00Z")),
            release_json(
                "nightly-2026-05-25",
                false,
                true,
                Some("2026-05-25T12:00:00Z")
            ),
            release_json(
                "nightly-2026-05-24",
                false,
                true,
                Some("2026-05-24T12:00:00Z")
            ),
        );
        let got = nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT);
        assert_eq!(
            got,
            vec![
                url("nightly"),
                url("nightly-2026-05-25"),
                url("nightly-2026-05-24"),
            ]
        );
    }

    #[test]
    fn excludes_drafts() {
        let body = format!(
            "[{}]",
            release_json("nightly", true, true, Some("2026-05-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn excludes_nightly_staging_even_when_published() {
        let body = format!(
            "[{}]",
            release_json("nightly-staging", false, true, Some("2026-05-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn excludes_non_prerelease() {
        let body = format!(
            "[{}]",
            release_json("nightly", false, false, Some("2026-05-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn malformed_json_returns_empty() {
        assert!(nightly_candidate_urls_from_json("not json", NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn limit_zero_returns_empty() {
        let body = format!(
            "[{}]",
            release_json("nightly", false, true, Some("2026-05-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, 0).is_empty());
    }

    #[test]
    fn missing_published_at_sorts_last() {
        let body = format!(
            "[{},{}]",
            release_json("nightly-undated", false, true, None),
            release_json("nightly", false, true, Some("2026-05-26T15:00:00Z")),
        );
        let got = nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT);
        assert_eq!(got, vec![url("nightly"), url("nightly-undated")]);
    }
}
