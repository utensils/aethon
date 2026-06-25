use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

pub(super) const STARTUP_CONFIG_MAX_BYTES: usize = 64 * 1024;
const STARTUP_DEFAULT_TIMEOUT_SECONDS: u64 = 600;
const STARTUP_MAX_TIMEOUT_SECONDS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupConfig {
    pub timeout_seconds: u64,
    pub auto_approve: bool,
    pub commands: Vec<StartupCommandConfig>,
    pub warning: Option<String>,
    #[serde(skip_serializing)]
    pub parse_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupCommandConfig {
    pub id: String,
    pub label: String,
    pub command: String,
    pub required: bool,
    pub timeout_seconds: u64,
}

#[derive(Default, Deserialize)]
struct RawStartupToml {
    #[serde(default)]
    startup: RawStartupSection,
}

#[derive(Default, Deserialize)]
struct RawStartupSection {
    timeout_seconds: Option<u64>,
    // Deprecated and intentionally ignored for approval decisions: project
    // config is repo-controlled, while startup command trust must be user-owned.
    auto_approve: Option<bool>,
    commands: Option<Vec<RawStartupCommand>>,
}

#[derive(Default, Deserialize)]
struct RawStartupCommand {
    id: Option<String>,
    label: Option<String>,
    command: Option<String>,
    required: Option<bool>,
    timeout_seconds: Option<u64>,
}

pub(crate) fn parse_startup_config(input: &str) -> StartupConfig {
    let (parsed, parse_error) = if input.trim().is_empty() {
        (RawStartupToml::default(), None)
    } else {
        match toml::from_str::<RawStartupToml>(input) {
            Ok(parsed) => (parsed, None),
            Err(err) => (
                RawStartupToml::default(),
                Some(format!(
                    "Could not parse .aethon/startup.toml; startup commands were not run: {err}"
                )),
            ),
        }
    };
    let timeout_seconds = normalize_timeout(parsed.startup.timeout_seconds);
    let mut warnings = Vec::new();
    if let Some(error) = &parse_error {
        warnings.push(error.clone());
    }
    if parsed.startup.auto_approve == Some(true) {
        warnings.push(
            "Ignored [startup].auto_approve from project config; configure startup trust in Aethon"
                .to_string(),
        );
    }
    let commands = parsed
        .startup
        .commands
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(idx, raw)| {
            let command = raw.command.unwrap_or_default().trim().to_string();
            if command.is_empty() {
                warnings.push(format!(
                    "Skipped startup command {} because command is missing",
                    idx + 1
                ));
                return None;
            }
            let id = raw
                .id
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("command-{}", idx + 1));
            let label = raw
                .label
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| id.clone());
            Some(StartupCommandConfig {
                id,
                label,
                command,
                required: raw.required.unwrap_or(true),
                timeout_seconds: normalize_timeout(raw.timeout_seconds.or(Some(timeout_seconds))),
            })
        })
        .collect();
    StartupConfig {
        timeout_seconds,
        auto_approve: false,
        commands,
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
        parse_error,
    }
}

fn normalize_timeout(value: Option<u64>) -> u64 {
    value
        .filter(|n| *n > 0)
        .unwrap_or(STARTUP_DEFAULT_TIMEOUT_SECONDS)
        .min(STARTUP_MAX_TIMEOUT_SECONDS)
}

pub(crate) fn startup_fingerprint(config: &StartupConfig) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"aethon-startup:v1");
    hasher.update(config.timeout_seconds.to_le_bytes());
    if let Some(parse_error) = &config.parse_error {
        hasher.update(b"parse_error\0");
        hasher.update(parse_error.as_bytes());
        hasher.update(b"\0");
    }
    for command in &config.commands {
        hasher.update(command.id.as_bytes());
        hasher.update(b"\0");
        hasher.update(command.label.as_bytes());
        hasher.update(b"\0");
        hasher.update(command.command.as_bytes());
        hasher.update(b"\0");
        hasher.update([u8::from(command.required)]);
        hasher.update(command.timeout_seconds.to_le_bytes());
    }
    hex_sha1(hasher.finalize().as_slice())
}

fn hex_sha1(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub(super) fn truncate_utf8(mut text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}
