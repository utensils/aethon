#!/usr/bin/env bash
# Fail-loud safety net: scan a built Aethon.app for any /nix/store paths
# in the main binary's Mach-O load commands. The release build inside
# `nix develop` must produce a binary whose dylib references all live
# under /usr/lib, /System/Library, or the bundle itself. A /nix/store
# install_name means the bundle won't dyld-link on any non-builder Mac.
#
# Usage: scripts/verify-bundle.sh [path/to/Aethon.app]
# Default path: src-tauri/target/release/bundle/macos/Aethon.app
#
# Exits 0 if clean, non-zero with a diff-style report otherwise.
set -euo pipefail

bundle="${1:-src-tauri/target/release/bundle/macos/Aethon.app}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "verify-bundle.sh: skipped (not macOS)"
  exit 0
fi

if [[ ! -d "$bundle" ]]; then
  echo "verify-bundle.sh: bundle not found at $bundle" >&2
  exit 1
fi

bin="$bundle/Contents/MacOS/aethon"
if [[ ! -x "$bin" ]]; then
  echo "verify-bundle.sh: binary not found at $bin" >&2
  exit 1
fi

leaks="$(otool -L "$bin" | awk 'NR>1 {print $1}' | grep -E '^/nix/store/' || true)"
if [[ -n "$leaks" ]]; then
  echo "verify-bundle.sh: FAIL — Nix store paths in $bin" >&2
  echo "$leaks" | sed 's/^/  /' >&2
  echo "" >&2
  echo "  These will fail dyld's Team ID check on any Mac that isn't the" >&2
  echo "  builder. Check flake.nix for LIBRARY_PATH / NIX_LDFLAGS / buildInputs" >&2
  echo "  pulling Nix-provided system libs (libiconv, libcxx, etc.)." >&2
  exit 2
fi

echo "verify-bundle.sh: OK — no /nix/store paths in $bin"

# Scan the bundled LFM2-Audio runner (binary + @loader_path dylibs), if staged.
# Bundled via Tauri `resources` → Contents/Resources/lfm2-audio/. The prebuilt
# runner is system-linked, so a /nix/store hit here means a Nix-built binary
# was staged by mistake instead of the upstream release.
runner_dir="$bundle/Contents/Resources/lfm2-audio"
if [[ -d "$runner_dir" ]]; then
  runner_leaks=""
  while IFS= read -r -d '' macho; do
    hits="$(otool -L "$macho" 2>/dev/null | awk 'NR>1 {print $1}' | grep -E '^/nix/store/' || true)"
    if [[ -n "$hits" ]]; then
      runner_leaks+="$macho"$'\n'"$hits"$'\n'
    fi
  done < <(find "$runner_dir" -type f \
    \( -name '*.dylib' -o -name '*.so' -o -name 'llama-lfm2-audio' \) -print0)
  if [[ -n "$runner_leaks" ]]; then
    echo "verify-bundle.sh: FAIL — Nix store paths in the LFM2-Audio runner" >&2
    echo "$runner_leaks" | sed 's/^/  /' >&2
    echo "" >&2
    echo "  Stage the upstream prebuilt runner via scripts/stage-lfm2-runner.sh;" >&2
    echo "  do not bundle a Nix-built llama-lfm2-audio." >&2
    exit 2
  fi
  echo "verify-bundle.sh: OK — no /nix/store paths in the LFM2-Audio runner"
fi
