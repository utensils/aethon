//! API-key resolution for the cascade conversation providers.
//!
//! Environment variables win over config.toml so a shell-exported key can't
//! be silently shadowed by a stale value saved from Settings. Key VALUES must
//! never be logged or emitted through Tauri events — only presence booleans
//! leave this module's callers.

use crate::helpers::config::VoiceConfig;

pub(crate) const DEEPGRAM_KEY_ENV: &str = "DEEPGRAM_API_KEY";
pub(crate) const CARTESIA_KEY_ENV: &str = "CARTESIA_API_KEY";

pub(crate) struct CascadeKeys {
    pub(crate) deepgram: Option<String>,
    pub(crate) cartesia: Option<String>,
}

pub(crate) fn resolve_cascade_keys(config: &VoiceConfig) -> CascadeKeys {
    CascadeKeys {
        deepgram: resolve_key(DEEPGRAM_KEY_ENV, config.deepgram_api_key.as_deref()),
        cartesia: resolve_key(CARTESIA_KEY_ENV, config.cartesia_api_key.as_deref()),
    }
}

fn resolve_key(env_var: &str, config_value: Option<&str>) -> Option<String> {
    std::env::var(env_var)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            config_value
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}
