#!/usr/bin/env bash
set -euo pipefail

# Build a Tauri updater manifest (`latest.json`) from a directory of
# per-platform `.sig` files.
#
# Aethon ships only `darwin-aarch64` right now (Apple Silicon). This
# script is deliberately small: it expects one .sig file matching the
# Tauri-bundler output name and emits the manifest shape the
# `tauri-plugin-updater` client consumes.
#
# Centralizing manifest construction (vs letting tauri-action emit one
# per matrix leg) removes the parallel-upload race that bites multi-arch
# matrices. Aethon is single-leg today, but the structure is the same so
# adding `darwin-x86_64` / `linux-*` later is just another case branch.
#
# Required positional arguments:
#   $1 - directory containing per-platform `*.sig` files
#   $2 - version string (e.g. `0.4.0` or `0.4.0-dev.12.g1a2b3c4`)
#   $3 - asset URL prefix (e.g.
#        `https://github.com/utensils/aethon/releases/download/v0.4.0`)
#
# Recognized .sig filename pattern → manifest key:
#   Aethon_aarch64.app.tar.gz.sig     -> darwin-aarch64
#   Aethon_*_aarch64.app.tar.gz.sig   -> darwin-aarch64 (with embedded version)
#
# The Tauri 2.x updater client looks up `darwin-aarch64`. Both keys
# point at the same signed `.app.tar.gz` so older 1.x clients (which
# look up `darwin-aarch64-app`) still resolve.

usage() {
  echo "usage: $0 <sig-dir> <version> <url-prefix>" >&2
  exit 64
}

[ "$#" -eq 3 ] || usage
SIG_DIR="$1"
VERSION="$2"
URL_PREFIX="$3"

[ -d "$SIG_DIR" ] || {
  echo "::error::$SIG_DIR is not a directory" >&2
  exit 1
}

declare -A PLATFORMS

shopt -s nullglob
for sig in "$SIG_DIR"/*.sig; do
  asset="$(basename "$sig" .sig)"
  case "$asset" in
    Aethon_aarch64.app.tar.gz | Aethon_*_aarch64.app.tar.gz)
      PLATFORMS[darwin-aarch64]="$asset"
      PLATFORMS[darwin-aarch64-app]="$asset"
      ;;
    *)
      echo "warn: unrecognized .sig file: $asset" >&2
      ;;
  esac
done
shopt -u nullglob

declare -a REQUIRED=(
  "darwin-aarch64"
  "darwin-aarch64-app"
)
for key in "${REQUIRED[@]}"; do
  if [ -z "${PLATFORMS[$key]:-}" ]; then
    echo "::error::missing platform entry: $key (no matching .sig file in $SIG_DIR)" >&2
    exit 1
  fi
done

platforms='{}'
for key in "${!PLATFORMS[@]}"; do
  asset="${PLATFORMS[$key]}"
  platforms="$(jq \
    --arg key "$key" \
    --rawfile sig "$SIG_DIR/$asset.sig" \
    --arg url "$URL_PREFIX/$asset" \
    '. + {($key): {signature: $sig, url: $url}}' \
    <<<"$platforms")"
done

PUB_DATE="$(date -u +%FT%T.000Z)"

jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$PUB_DATE" \
  --argjson platforms "$platforms" \
  '{version: $version, notes: "", pub_date: $pub_date, platforms: $platforms}'
