//! Run the kind-specific resolver command and parse its env output.
//!
//! Three resolvers, all reduce to a `BTreeMap<String, String>`:
//!
//! - `Direnv` → `direnv exec <root> env -0`
//! - `Flake`  → `nix develop --command env -0` from the root
//! - `Shell`  → `nix-shell --run 'env -0'` from the root
//!
//! Every spawn captures stdout+stderr and uses a wall-clock timeout so
//! a stuck `nix` evaluation can't wedge the resolver task. The parse
//! step also runs a small filter that drops env vars the resolver
//! subshell pollutes (`PWD`, `OLDPWD`, `SHLVL`, `_`, `BASH_FUNC_*`,
//! `TMPDIR`) so the eventual `CommandBuilder::env` calls don't bake
//! resolver-time junk into the user's shell.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::env;

use super::detect::DevshellKind;

/// Per-resolver wall-clock timeout. A cold `nix develop --command env`
/// on a complex flake can easily take 30-60 s; we cap at 120 s so a
/// genuinely wedged Nix evaluation can't keep the resolver task alive
/// forever. The state machine surfaces the timeout as a `Failed`.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(120);

/// Maximum bytes we'll read from a resolver's stdout. A normal flake
/// `nix develop --command env -0` output is a few hundred KB; the cap keeps a runaway
/// shell from OOM'ing us. 32 MiB is well above the worst realistic
/// shell env.
const STDOUT_MAX_BYTES: usize = 32 * 1024 * 1024;
const STDERR_MAX_BYTES: usize = 256 * 1024;
const NIX_DEVELOP_ENV_SENTINEL: &[u8] = b"__AETHON_ENV_START__\0";

#[derive(Debug, Clone)]
pub struct ResolveProgress {
    pub stream: &'static str,
    pub content: String,
}

pub type ResolveProgressSender = Arc<dyn Fn(ResolveProgress) + Send + Sync>;

#[derive(Clone, Copy)]
enum StdoutProgressMode {
    None,
    UntilSentinel(&'static [u8]),
}

/// The resolved devshell environment in a stable serializable form.
/// Returning a `BTreeMap` (not `HashMap`) makes snapshot-style tests
/// trivial and gives the cache writer a deterministic ordering.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedEnv {
    pub env: BTreeMap<String, String>,
    /// Milliseconds the resolver took. Useful for the badge tooltip
    /// and for keeping an eye on flake eval regressions.
    pub duration_ms: u64,
}

/// Resolve the devshell env for `root` given the chosen kind. Returns
/// an error string suitable for surfacing in the status badge — never
/// panics on bad resolver output (always falls through to a `Failed`).
pub async fn resolve(
    root: &Path,
    kind: DevshellKind,
    progress: Option<ResolveProgressSender>,
) -> Result<ResolvedEnv, String> {
    let started = Instant::now();
    let raw_env = match kind {
        DevshellKind::Direnv => resolve_direnv(root, progress.as_ref()).await?,
        DevshellKind::Flake => resolve_flake(root, progress.as_ref()).await?,
        DevshellKind::Shell => resolve_shell_nix(root, progress.as_ref()).await?,
    };
    let filtered = filter_resolver_junk(raw_env);
    Ok(ResolvedEnv {
        env: filtered,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

async fn resolve_direnv(
    root: &Path,
    progress: Option<&ResolveProgressSender>,
) -> Result<BTreeMap<String, String>, String> {
    let mut cmd = env::tokio_command("direnv");
    cmd.arg("exec")
        .arg(root)
        .arg("env")
        .arg("-0")
        .current_dir(root)
        // Inherit the host env so direnv can find its own state dir,
        // while env::tokio_command supplies Aethon's launch-safe PATH
        // for locating direnv and any tools it shells out to.
        .env("DIRENV_LOG_FORMAT", "")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let raw = run_with_timeout(
        "direnv exec",
        cmd,
        RESOLVE_TIMEOUT,
        progress,
        StdoutProgressMode::None,
    )
    .await?;
    parse_null_separated_env(&raw)
}

async fn resolve_flake(
    root: &Path,
    progress: Option<&ResolveProgressSender>,
) -> Result<BTreeMap<String, String>, String> {
    let mut cmd = env::tokio_command("nix");
    cmd.arg("develop")
        // The `--accept-flake-config` flag matches what users routinely
        // pass at the CLI to avoid the interactive "trust this flake?"
        // prompt that would otherwise wedge the resolver on first use.
        .arg("--accept-flake-config")
        .arg("--command")
        .arg("sh")
        .arg("-lc")
        .arg("printf '%s\\0' __AETHON_ENV_START__; env -0")
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let raw = run_with_timeout(
        "nix develop",
        cmd,
        RESOLVE_TIMEOUT,
        progress,
        StdoutProgressMode::UntilSentinel(NIX_DEVELOP_ENV_SENTINEL),
    )
    .await?;
    parse_nix_develop_env(&raw)
}

async fn resolve_shell_nix(
    root: &Path,
    progress: Option<&ResolveProgressSender>,
) -> Result<BTreeMap<String, String>, String> {
    let mut cmd = env::tokio_command("nix-shell");
    cmd.arg("--run")
        .arg("env -0")
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let raw = run_with_timeout(
        "nix-shell",
        cmd,
        RESOLVE_TIMEOUT,
        progress,
        StdoutProgressMode::None,
    )
    .await?;
    parse_null_separated_env(&raw)
}

async fn run_with_timeout(
    label: &'static str,
    mut cmd: Command,
    t: Duration,
    progress: Option<&ResolveProgressSender>,
    stdout_progress: StdoutProgressMode,
) -> Result<Vec<u8>, String> {
    emit_progress(
        progress,
        "status",
        format!("\r\n[devshell] resolving with {label}\r\n"),
    );
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{label}: failed to spawn — {e} (is the binary on PATH?)"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{label}: stdout pipe missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{label}: stderr pipe missing"))?;

    let progress_for_stdout = progress.cloned();
    let collect = async move {
        let mut stdout = stdout;
        let mut buf = Vec::with_capacity(64 * 1024);
        let mut emitted_prelude = 0usize;
        let mut prelude_done = false;
        loop {
            let mut chunk = [0u8; 16 * 1024];
            let n = stdout
                .read(&mut chunk)
                .await
                .map_err(|e| format!("{label}: read stdout — {e}"))?;
            if n == 0 {
                break;
            }
            if buf.len() + n > STDOUT_MAX_BYTES {
                return Err(format!("{label}: stdout exceeded {STDOUT_MAX_BYTES} bytes"));
            }
            buf.extend_from_slice(&chunk[..n]);
            if let (Some(progress), StdoutProgressMode::UntilSentinel(sentinel)) =
                (progress_for_stdout.as_ref(), stdout_progress)
            {
                emit_stdout_prelude(
                    Some(progress),
                    &buf,
                    &mut emitted_prelude,
                    &mut prelude_done,
                    sentinel,
                );
            }
        }
        if let (Some(progress), StdoutProgressMode::UntilSentinel(sentinel)) =
            (progress_for_stdout.as_ref(), stdout_progress)
        {
            finish_stdout_prelude(
                Some(progress),
                &buf,
                &mut emitted_prelude,
                prelude_done,
                sentinel,
            );
        }
        Ok::<Vec<u8>, String>(buf)
    };

    let progress_for_stderr = progress.cloned();
    let stderr_drain = async move {
        let mut stderr = stderr;
        let mut buf = Vec::with_capacity(4 * 1024);
        loop {
            let mut chunk = [0u8; 8 * 1024];
            let n = match stderr.read(&mut chunk).await {
                Ok(n) => n,
                Err(_) => break,
            };
            if n == 0 {
                break;
            }
            let bytes = &chunk[..n];
            if let Some(progress) = progress_for_stderr.as_ref() {
                emit_progress(
                    Some(progress),
                    "stderr",
                    String::from_utf8_lossy(bytes).into_owned(),
                );
            }
            if buf.len() < STDERR_MAX_BYTES {
                let available = STDERR_MAX_BYTES - buf.len();
                buf.extend_from_slice(&bytes[..bytes.len().min(available)]);
            }
        }
        buf
    };

    let result = timeout(t, async {
        let (out, err, status) = tokio::join!(collect, stderr_drain, child.wait());
        let status = status.map_err(|e| format!("{label}: wait — {e}"))?;
        let out = out?;
        if !status.success() {
            let err_str = String::from_utf8_lossy(&err);
            let head: String = err_str.lines().take(8).collect::<Vec<_>>().join("\n");
            return Err(format!(
                "{label}: exited with {code} — {head}",
                code = status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".to_string())
            ));
        }
        emit_progress(
            progress,
            "status",
            format!("[devshell] {label} completed\r\n"),
        );
        Ok::<Vec<u8>, String>(out)
    })
    .await;
    match result {
        Ok(inner) => inner,
        Err(_elapsed) => Err(format!("{label}: timed out after {}s", t.as_secs())),
    }
}

fn emit_progress(progress: Option<&ResolveProgressSender>, stream: &'static str, content: String) {
    if content.is_empty() {
        return;
    }
    if let Some(progress) = progress {
        progress(ResolveProgress { stream, content });
    }
}

fn emit_stdout_prelude(
    progress: Option<&ResolveProgressSender>,
    buf: &[u8],
    emitted: &mut usize,
    done: &mut bool,
    sentinel: &[u8],
) {
    if *done || sentinel.is_empty() {
        return;
    }
    let end = if let Some(idx) = find_bytes(buf, sentinel) {
        *done = true;
        idx
    } else {
        buf.len()
            .saturating_sub(sentinel_prefix_suffix_len(buf, sentinel))
    };
    emit_stdout_range(progress, buf, emitted, end);
}

fn finish_stdout_prelude(
    progress: Option<&ResolveProgressSender>,
    buf: &[u8],
    emitted: &mut usize,
    done: bool,
    sentinel: &[u8],
) {
    if done {
        return;
    }
    let end = find_bytes(buf, sentinel).unwrap_or(buf.len());
    emit_stdout_range(progress, buf, emitted, end);
}

fn emit_stdout_range(
    progress: Option<&ResolveProgressSender>,
    buf: &[u8],
    emitted: &mut usize,
    end: usize,
) {
    if end <= *emitted {
        return;
    }
    emit_progress(
        progress,
        "stdout",
        String::from_utf8_lossy(&buf[*emitted..end]).into_owned(),
    );
    *emitted = end;
}

fn sentinel_prefix_suffix_len(buf: &[u8], sentinel: &[u8]) -> usize {
    let max = buf.len().min(sentinel.len().saturating_sub(1));
    for len in (1..=max).rev() {
        if buf[buf.len() - len..] == sentinel[..len] {
            return len;
        }
    }
    0
}

/// Parse `env -0` output: each var is `KEY=VAL\0`. We tolerate a
/// trailing NUL.
pub fn parse_null_separated_env(buf: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for chunk in buf.split(|b| *b == 0u8) {
        if chunk.is_empty() {
            continue;
        }
        let s = std::str::from_utf8(chunk)
            .map_err(|e| format!("env -0 output: invalid utf-8 — {e}"))?;
        if let Some(idx) = s.find('=') {
            let (k, v) = s.split_at(idx);
            if is_valid_env_key(k) {
                out.insert(k.to_string(), v[1..].to_string());
            }
        }
    }
    Ok(out)
}

fn parse_nix_develop_env(buf: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let Some(idx) = find_bytes(buf, NIX_DEVELOP_ENV_SENTINEL) else {
        return Err("nix develop: env sentinel missing from resolver output".to_string());
    };
    parse_null_separated_env(&buf[idx + NIX_DEVELOP_ENV_SENTINEL.len()..])
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Strip env vars the resolver subshell pollutes. Without this filter
/// we'd bake the resolver's `PWD`/`OLDPWD`/`TMPDIR` into the user's
/// shell and trash their multi-byte `BASH_FUNC_*` exports — none of
/// which are meaningful in the launched shell.
pub fn filter_resolver_junk(input: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (k, v) in input {
        if matches!(
            k.as_str(),
            "PWD"
                | "OLDPWD"
                | "SHLVL"
                | "_"
                | "TMPDIR"
                | "TMP"
                | "TEMP"
                | "TEMPDIR"
                | "DIRENV_DIR"
                | "DIRENV_FILE"
                | "DIRENV_WATCHES"
                | "DIRENV_DIFF"
        ) {
            continue;
        }
        if k.starts_with("BASH_FUNC_") {
            continue;
        }
        // Empty-named vars don't survive a CommandBuilder::env call
        // and would smuggle the `=` separator into the key.
        if k.is_empty() {
            continue;
        }
        out.insert(k, v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_null_separated_handles_empty_input() {
        let m = parse_null_separated_env(b"").unwrap();
        assert!(m.is_empty());
    }

    #[test]
    fn parse_null_separated_extracts_pairs() {
        let buf: &[u8] = b"PATH=/usr/bin\0FOO=bar\0EMPTY=\0";
        let m = parse_null_separated_env(buf).unwrap();
        assert_eq!(m.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(m.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(m.get("EMPTY").map(String::as_str), Some(""));
    }

    #[test]
    fn parse_null_separated_drops_no_equals_entries() {
        // Entries without `=` (e.g. a stray NUL) are silently dropped
        // instead of crashing the resolver.
        let buf: &[u8] = b"STRAY\0OK=1\0";
        let m = parse_null_separated_env(buf).unwrap();
        assert!(!m.contains_key("STRAY"));
        assert_eq!(m.get("OK").map(String::as_str), Some("1"));
    }

    #[test]
    fn parse_null_separated_drops_invalid_env_keys() {
        let buf: &[u8] = b"[devshell] FORCE=true\0OK=1\0";
        let m = parse_null_separated_env(buf).unwrap();
        assert!(!m.contains_key("[devshell] FORCE"));
        assert_eq!(m.get("OK").map(String::as_str), Some("1"));
    }

    #[test]
    fn parse_null_separated_rejects_invalid_utf8() {
        let buf: &[u8] = b"\xff\xfe=oops\0";
        assert!(parse_null_separated_env(buf).is_err());
    }

    #[test]
    fn parse_nix_develop_env_skips_shell_hook_prelude() {
        let mut raw = b"\x1b[33m[devshell]\x1b[0m menu output\n".to_vec();
        raw.extend_from_slice(NIX_DEVELOP_ENV_SENTINEL);
        raw.extend_from_slice(b"PATH=/nix/store/bin\0IN_NIX_SHELL=impure\0");
        let m = parse_nix_develop_env(&raw).unwrap();
        assert_eq!(m.get("PATH").map(String::as_str), Some("/nix/store/bin"));
        assert_eq!(m.get("IN_NIX_SHELL").map(String::as_str), Some("impure"));
    }

    #[test]
    fn parse_nix_develop_env_requires_sentinel() {
        assert!(parse_nix_develop_env(b"PATH=/x\0").is_err());
    }

    #[test]
    fn stdout_prelude_streaming_waits_for_possible_split_sentinel() {
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = {
            let captured = Arc::clone(&captured);
            Arc::new(move |progress: ResolveProgress| {
                captured.lock().unwrap().push(progress.content);
            }) as ResolveProgressSender
        };
        let mut emitted = 0usize;
        let mut done = false;
        let sentinel = b"__SENTINEL__";
        let mut buf = b"hello __SENT".to_vec();

        emit_stdout_prelude(Some(&sink), &buf, &mut emitted, &mut done, sentinel);
        assert_eq!(captured.lock().unwrap().join(""), "hello ");

        buf.extend_from_slice(b"INEL__PATH=/nix\0");
        emit_stdout_prelude(Some(&sink), &buf, &mut emitted, &mut done, sentinel);
        assert_eq!(captured.lock().unwrap().join(""), "hello ");
        assert!(done);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn run_with_timeout_streams_nix_prelude_before_process_exit() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let sink = Arc::new(move |progress: ResolveProgress| {
            if progress.stream == "stdout" {
                let _ = tx.send(progress.content);
            }
        }) as ResolveProgressSender;
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("printf 'building drv\\n'; sleep 1; printf '__AETHON_ENV_START__\\0PATH=/nix/bin\\0'")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let run = tokio::spawn(async move {
            run_with_timeout(
                "nix develop",
                cmd,
                Duration::from_secs(5),
                Some(&sink),
                StdoutProgressMode::UntilSentinel(NIX_DEVELOP_ENV_SENTINEL),
            )
            .await
        });

        let streamed = timeout(Duration::from_millis(500), rx.recv())
            .await
            .expect("stdout prelude should arrive before the process exits")
            .expect("progress channel should stay open");
        assert_eq!(streamed, "building drv\n");
        let raw = run.await.unwrap().unwrap();
        assert_eq!(
            parse_nix_develop_env(&raw)
                .unwrap()
                .get("PATH")
                .map(String::as_str),
            Some("/nix/bin")
        );
    }

    #[test]
    fn filter_drops_resolver_junk() {
        let mut m = BTreeMap::new();
        m.insert("PWD".into(), "/x".into());
        m.insert("OLDPWD".into(), "/y".into());
        m.insert("SHLVL".into(), "3".into());
        m.insert("_".into(), "/bin/sh".into());
        m.insert("TMPDIR".into(), "/tmp".into());
        m.insert("BASH_FUNC_foo%%".into(), "() { :; }".into());
        m.insert("DIRENV_DIFF".into(), "abc".into());
        m.insert("PATH".into(), "/nix/store/abc/bin".into());
        m.insert("".into(), "weird".into());
        let f = filter_resolver_junk(m);
        assert_eq!(f.len(), 1);
        assert_eq!(
            f.get("PATH").map(String::as_str),
            Some("/nix/store/abc/bin")
        );
    }
}
