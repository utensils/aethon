// POSIX-style single-quote shell quoting for the file-drop path.
//
// When a user drops a file onto a shell sub-tab, we paste the absolute
// path as text into the PTY. Spaces, single quotes, dollar signs,
// backticks, semicolons and so on must be neutralised — pasting a raw
// `cd /My Films/oh "wow"` would split into multiple tokens and / or
// fire shell expansion.
//
// The classic POSIX trick is to single-quote the whole string and
// replace any embedded `'` with `'\''` (close-quote, escaped-quote,
// re-open-quote). Inside single quotes every other byte is literal
// — no `$`, no `` ` ``, no backslash escape — so this works in
// bash/zsh/fish on every Unix shell we care about.
//
// On Windows PowerShell + cmd.exe quoting is wildly different, but
// shell tabs on Windows still spawn `pwsh`/`cmd` rather than a POSIX
// shell, so this helper isn't appropriate there. The caller should
// fall back to plain paste-as-text on `navigator.platform`-detected
// Windows; we keep this helper Unix-only and pure for testability.

/** Wrap a single path or argument in POSIX single-quote escaping. */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  // Already-safe ASCII shortcut: alnum + a small set of characters
  // that never need quoting in any POSIX shell. Skipping the wrap
  // makes the pasted command read more naturally for the common case.
  if (/^[A-Za-z0-9_\-./:@%+=]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote a list of paths joined by single spaces. Each path is
 *  individually quoted so their concatenation parses as N argv
 *  tokens regardless of contents. */
export function shellQuoteAll(values: readonly string[]): string {
  return values.map(shellQuote).join(" ");
}
