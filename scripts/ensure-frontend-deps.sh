#!/usr/bin/env bash
# Sync the JS dependency tree (node_modules) with bun.lock.
#
# Why this exists:
#   node_modules drifts out of sync whenever bun.lock moves — e.g. a
#   `git pull` lands a commit that adds a dependency. The old check ("is
#   node_modules/.bin/vite present?") couldn't see that: vite was already
#   installed, so it returned early and the new packages (smol-toml,
#   pi-mcp-adapter, ...) were never installed. The first thing to notice
#   was the build.rs sidecar `bun build` failing with "Could not resolve".
#
#   The correct staleness signal is the lockfile itself. We stamp a hash of
#   bun.lock into node_modules after a successful install and re-run only
#   when that hash changes. In steady state this is a sub-millisecond no-op,
#   which matters because it runs on every devshell entry (see below).
#
# Used by:
#   - the Nix devshell startup hook (flake.nix) — so entering / reloading the
#     devshell auto-heals deps. `.envrc` does `watch_file bun.lock`, which
#     makes nix-direnv reload the shell (and re-fire this hook) the moment a
#     pull changes the lockfile.
#   - scripts/dev.sh — belt-and-braces for non-direnv launches (CI,
#     `nix develop -c dev`, direnv disabled).
#
# Skip entirely with AETHON_SKIP_BUN_INSTALL=1.
#
# Exit status:
#   0  tree is in sync (no-op) or was successfully installed
#   1  out of sync and could not be fixed (bun missing, install failed)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

[[ "${AETHON_SKIP_BUN_INSTALL:-0}" == "1" ]] && exit 0

# Pick the lockfile bun actually uses; nothing to sync against without one.
lock_file=""
for candidate in bun.lock bun.lockb; do
  if [[ -f "$candidate" ]]; then
    lock_file="$candidate"
    break
  fi
done
[[ -n "$lock_file" ]] || exit 0

# Portable content hash: GNU coreutils (Linux) -> sha256sum, macOS -> shasum.
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo "[deps] neither sha256sum nor shasum is on PATH; cannot hash $1" >&2
    return 1
  fi
}

stamp="node_modules/.aethon-deps-lock-hash"
want="$(hash_file "$lock_file")"

# Read the stamp into a variable with an explicit `|| true` so a missing
# stamp (first run) never trips errexit via the command substitution.
current="$(cat "$stamp" 2>/dev/null || true)"

# In sync iff node_modules is populated AND its stamp matches the lockfile.
# The stamp lives inside node_modules, so wiping the tree also clears the
# stamp and forces a reinstall.
if [[ -x node_modules/.bin/vite && "$current" == "$want" ]]; then
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[deps] node_modules is out of sync with $lock_file but bun is not on PATH; run 'bun install'" >&2
  exit 1
fi

echo "[deps] $lock_file changed (or node_modules incomplete); running bun install" >&2
# Prefer a frozen install so a stale lockfile is surfaced rather than
# silently rewritten; fall back to a normal install if the lockfile and
# package.json genuinely disagree.
if ! bun install --frozen-lockfile; then
  echo "[deps] frozen install failed; retrying without --frozen-lockfile" >&2
  bun install
fi

if [[ ! -x node_modules/.bin/vite ]]; then
  echo "[deps] bun install completed but node_modules/.bin/vite is still missing" >&2
  exit 1
fi

printf '%s\n' "$want" >"$stamp"
