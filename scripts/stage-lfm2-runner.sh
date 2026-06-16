#!/usr/bin/env bash
# Stage the prebuilt `llama-lfm2-audio` runner (binary + its @loader_path
# dylibs) into src-tauri/binaries/lfm2-audio/ for the LFM2-Audio voice provider.
#
# The runner ships inside Liquid AI's GGUF repo as a per-platform zip. We treat
# it like the other staged binaries (src-tauri/binaries/ is gitignored, fetched
# at build time, never committed). The release bundle and the dev-app mirror
# copy this directory next to the executable, where `resolve_lfm2_binary`
# (src-tauri/src/voice/lfm2.rs) finds it.
#
# Usage: scripts/stage-lfm2-runner.sh [--force]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$repo_root/src-tauri/binaries/lfm2-audio"
hf_repo="LiquidAI/LFM2-Audio-1.5B-GGUF"

os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)
    runner="runners/macos-arm64/lfm2-audio-macos-arm64.zip"
    inner="lfm2-audio-macos-arm64"
    ;;
  Linux/x86_64)
    runner="runners/ubuntu-x64/lfm2-audio-ubuntu-x64.zip"
    inner="lfm2-audio-ubuntu-x64"
    ;;
  Linux/aarch64)
    runner="runners/ubuntu-arm64/lfm2-audio-ubuntu-arm64.zip"
    inner="lfm2-audio-ubuntu-arm64"
    ;;
  *)
    echo "stage-lfm2-runner: unsupported platform $os/$arch" >&2
    exit 1
    ;;
esac

bin="$dest/llama-lfm2-audio"
if [ -x "$bin" ] && [ "${1:-}" != "--force" ]; then
  echo "stage-lfm2-runner: already staged at $dest (use --force to refresh)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://huggingface.co/$hf_repo/resolve/main/$runner"
echo "stage-lfm2-runner: downloading $runner ..."
curl -fL --retry 3 -o "$tmp/runner.zip" "$url"
unzip -q -o "$tmp/runner.zip" -d "$tmp/unzipped"

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$tmp/unzipped/$inner/." "$dest/"
chmod +x "$bin"
echo "stage-lfm2-runner: staged runner → $dest"
