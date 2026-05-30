use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::helpers;

/// Keep the non-blocking file appender's WorkerGuard alive for the process
/// lifetime. Dropping it flushes pending writes and exits the logging thread.
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

const RETENTION_DAYS: u64 = 7;

/// `~/.aethon/logs/` — same parent as state.json + projects.json so a user
/// troubleshooting an issue finds everything in one place.
fn log_dir() -> Result<Option<PathBuf>, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let Some(dir) = helpers::aethon_dir(home).map(|dir| dir.join("logs")) else {
        return Ok(None);
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(format!("mkdir {}: {e}", dir.display()));
    }
    Ok(Some(dir))
}

/// Prune old `aethon.YYYY-MM-DD` files without touching bridge logs or any
/// other troubleshooting artifacts in the same directory.
fn prune_old_logs(dir: &Path) {
    let cutoff = match std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(
        RETENTION_DAYS * 24 * 60 * 60,
    )) {
        Some(t) => t,
        None => return,
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = match name.to_str() {
            Some(s) => s,
            None => continue,
        };
        if !name_str.starts_with("aethon.") {
            continue;
        }
        let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
        if let Some(t) = modified
            && t < cutoff
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Initialize the `tracing` subscriber. Honors `AETHON_LOG` first, then
/// `RUST_LOG`, and logs to both stderr and a daily rotating file.
pub(crate) fn init_tracing() {
    use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};
    let default_level = if cfg!(debug_assertions) {
        "info"
    } else {
        "warn"
    };
    // Quiet the mdns_sd crate's below-warn chatter (routine multicast send
    // retries on interfaces without a route) in the DEFAULT filter only — an
    // explicit AETHON_LOG / RUST_LOG override wins and can re-enable it. The
    // `[server] enabled = false` gate is the full off-switch.
    let filter = EnvFilter::try_from_env("AETHON_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new(format!("{default_level},mdns_sd=warn")));

    let stderr_layer = fmt::layer().with_target(true).with_writer(std::io::stderr);

    let mut log_dir_error = None;
    let file_layer = match log_dir() {
        Ok(Some(dir)) => {
            prune_old_logs(&dir);
            let file_appender = tracing_appender::rolling::daily(&dir, "aethon");
            let (writer, guard) = tracing_appender::non_blocking(file_appender);
            LOG_GUARD.set(guard).ok().map(|_| {
                fmt::layer()
                    .with_target(true)
                    .with_ansi(false)
                    .with_writer(writer)
            })
        }
        Ok(None) => None,
        Err(err) => {
            log_dir_error = Some(err);
            None
        }
    };

    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer);
    let _ = if let Some(file) = file_layer {
        subscriber.with(file).try_init()
    } else {
        subscriber.try_init()
    };
    if let Some(err) = log_dir_error {
        tracing::warn!(target: "aethon::logging", "log file setup skipped: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::RETENTION_DAYS;

    #[test]
    fn log_retention_stays_one_week() {
        assert_eq!(RETENTION_DAYS, 7);
    }

    #[test]
    fn logging_errors_stay_on_tracing_pipeline() {
        let src = include_str!("logging.rs");

        assert!(!src.contains(concat!("e", "println!")));
        assert!(src.contains("log file setup skipped"));
    }
}
