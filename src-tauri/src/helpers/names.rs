//! Filename / state-name validators. These guard the leaf path components
//! the rest of the shell composes into `~/.aethon/<name>` paths — every
//! state file write, every paste-image file name, runs through one of
//! these helpers before touching disk.

/// Validates a leaf filename used inside `~/.aethon/`. Rejects anything
/// that could escape the directory — empty, slashes, parent-directory
/// references. Used by `read_state` / `write_state` to keep arbitrary
/// callers from writing outside the user dir.
pub fn validate_state_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("invalid state name: (empty)".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!("invalid state name: {name}"));
    }
    if name == ".." || name == "." {
        return Err(format!("invalid state name: {name}"));
    }
    if name.starts_with('\0') || name.contains('\0') {
        return Err(format!("invalid state name: {name}"));
    }
    Ok(())
}

/// POSIX-friendly filename sanitiser: keeps `[A-Za-z0-9_-]+`, replaces
/// runs of unsafe chars with `_`, trims leading/trailing dots/dashes/
/// underscores, and clamps to 64 chars. Empty input → empty output (the
/// caller substitutes a default stem).
pub fn sanitize_filename_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_was_underscore = false;
    for c in input.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if ok {
            out.push(c);
            last_was_underscore = false;
        } else if !last_was_underscore && !out.is_empty() {
            out.push('_');
            last_was_underscore = true;
        }
    }
    let trimmed = out
        .trim_matches(|c: char| c == '_' || c == '-' || c == '.')
        .to_string();
    if trimmed.len() > 64 {
        trimmed.chars().take(64).collect()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_state_name_accepts_simple_leaves() {
        assert!(validate_state_name("messages.json").is_ok());
        assert!(validate_state_name("theme").is_ok());
        assert!(validate_state_name("config.toml").is_ok());
        assert!(validate_state_name("state.json").is_ok());
    }

    #[test]
    fn validate_state_name_rejects_empty() {
        assert!(validate_state_name("").is_err());
    }

    #[test]
    fn validate_state_name_rejects_path_separators() {
        assert!(validate_state_name("a/b").is_err());
        assert!(validate_state_name("a\\b").is_err());
        assert!(validate_state_name("/absolute").is_err());
    }

    #[test]
    fn validate_state_name_rejects_dot_traversal() {
        assert!(validate_state_name("..").is_err());
        assert!(validate_state_name(".").is_err());
    }

    #[test]
    fn validate_state_name_rejects_null_bytes() {
        assert!(validate_state_name("foo\0bar").is_err());
    }
}
