#!/usr/bin/env bash
# Stage the prebuilt `llama-lfm2-audio` runner (binary + its @loader_path
# dylibs) into src-tauri/binaries/lfm2-audio/ for the LFM2-Audio voice provider.
#
# The runner ships inside Liquid AI's GGUF repo as a per-platform zip, pinned
# here to a known commit + SHA-256 so a release machine can't silently ship a
# different binary. It is treated like the other staged binaries
# (src-tauri/binaries/ is gitignored, fetched at build time, never committed).
# `beforeBuildCommand` stages it; Tauri bundles it via `resources` (so it is
# packaged + signed/notarized); `resolve_lfm2_binary` (src-tauri/src/voice/
# lfm2.rs) finds it at runtime.
#
# Unsupported platforms (e.g. Windows, where there is no prebuilt runner) skip
# gracefully so the build proceeds without the voice provider.
#
# Usage: scripts/stage-lfm2-runner.sh [--force]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$repo_root/src-tauri/binaries/lfm2-audio"
hf_repo="LiquidAI/LFM2-Audio-1.5B-GGUF"
# Pinned revision of the GGUF repo. Bump together with the SHA-256s below.
hf_rev="5a54beabc49a8abcd158a9ea86516fa4ae82dfc9"

os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)
    runner="runners/macos-arm64/lfm2-audio-macos-arm64.zip"
    inner="lfm2-audio-macos-arm64"
    sha256="f225cacaa98c0e2a32cb3bb9ab2d31f5c00868360a8d4ce0a711c822a3c9a744"
    ;;
  Linux/x86_64)
    runner="runners/ubuntu-x64/lfm2-audio-ubuntu-x64.zip"
    inner="lfm2-audio-ubuntu-x64"
    sha256="60172bb90804b76bf249cf0ba71da40b12b5c8dd531f40d37f4f24b49e712ddf"
    ;;
  Linux/aarch64)
    runner="runners/ubuntu-arm64/lfm2-audio-ubuntu-arm64.zip"
    inner="lfm2-audio-ubuntu-arm64"
    sha256="2f2ff9c757dee96a9e191aec10eb5616dd9691d858125f8fb7b43847fab17ac4"
    ;;
  *)
    echo "stage-lfm2-runner: no prebuilt runner for $os/$arch; skipping (voice provider unavailable)"
    exit 0
    ;;
esac

bin="$dest/llama-lfm2-audio"
if [ -x "$bin" ] && [ "${1:-}" != "--force" ]; then
  echo "stage-lfm2-runner: already staged at $dest (use --force to refresh)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://huggingface.co/$hf_repo/resolve/$hf_rev/$runner"
echo "stage-lfm2-runner: downloading $runner @ ${hf_rev:0:12} ..."
curl -fL --retry 3 -o "$tmp/runner.zip" "$url"

# Prefer coreutils sha256sum (ubiquitous on Linux CI); fall back to shasum
# (default on macOS). One of the two is present on every target platform.
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/runner.zip" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/runner.zip" | awk '{print $1}')"
else
  echo "stage-lfm2-runner: neither sha256sum nor shasum found; cannot verify download" >&2
  exit 1
fi
if [ "$actual" != "$sha256" ]; then
  echo "stage-lfm2-runner: checksum mismatch for $runner" >&2
  echo "  expected $sha256" >&2
  echo "  actual   $actual" >&2
  exit 1
fi

unzip -q -o "$tmp/runner.zip" -d "$tmp/unzipped"
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$tmp/unzipped/$inner/." "$dest/"
chmod +x "$bin"
echo "stage-lfm2-runner: staged + verified runner → $dest"

# Code-sign every nested Mach-O (the runner binary + its @loader_path dylibs)
# with the Developer ID + hardened runtime + secure timestamp. Tauri signs the
# app and its externalBin sidecars, but NOT executables dropped into
# `resources`, and Apple notarization rejects any unsigned nested Mach-O (the
# upstream runner ships only ad-hoc-signed).
#
# We must sign here, in beforeBuildCommand: Tauri imports the cert into its own
# temporary keychain only at the later signing phase (and deletes it after), so
# no signing keychain exists yet. The signing env vars ARE available though, so
# we set up our own keychain, import the cert, and sign — mirroring Tauri's own
# keychain dance. The nested signatures are embedded in the files, so they
# survive Tauri copying them into Resources and sealing the outer bundle
# (inside-out order). Local/unsigned builds (no APPLE_CERTIFICATE) skip this.
if [ "$os" = "Darwin" ] && [ -n "${APPLE_CERTIFICATE:-}" ] \
  && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ] && [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "stage-lfm2-runner: code-signing nested runner binaries"
  sign_tmp="$(mktemp -d)"
  keychain="$sign_tmp/lfm2-signing.keychain-db"
  kc_pass="lfm2-$$-stage"
  # Capture the user's keychain search list as an array (each path a separate
  # element, so paths survive verbatim) to restore it afterwards. Matters for
  # local signed build-app runs; CI runners are ephemeral.
  orig_keychains=()
  while IFS= read -r kc_line; do
    kc_clean="$(printf '%s' "$kc_line" | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//')"
    [ -n "$kc_clean" ] && orig_keychains+=("$kc_clean")
  done < <(security list-keychains -d user)
  cleanup_keychain() {
    if [ "${#orig_keychains[@]}" -gt 0 ]; then
      security list-keychains -d user -s "${orig_keychains[@]}" >/dev/null 2>&1 || true
    fi
    security delete-keychain "$keychain" >/dev/null 2>&1 || true
    rm -rf "$sign_tmp" "$tmp"
  }
  # Replaces the earlier download-tmp trap; fold its cleanup in here.
  trap cleanup_keychain EXIT

  echo "$APPLE_CERTIFICATE" | base64 --decode > "$sign_tmp/cert.p12"
  security create-keychain -p "$kc_pass" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$kc_pass" "$keychain"
  security import "$sign_tmp/cert.p12" -P "$APPLE_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign -k "$keychain"
  # Let codesign use the imported key without an interactive prompt.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pass" \
    "$keychain" >/dev/null
  # Prepend our keychain to the search list (mirrors Tauri's own signing dance)
  # so codesign resolves the identity; the system keychain stays in the list for
  # Apple intermediate-cert chain trust.
  security list-keychains -d user -s "$keychain" "${orig_keychains[@]}" >/dev/null

  signed=0
  while IFS= read -r macho; do
    if file -b "$macho" | grep -q "Mach-O"; then
      codesign --force --options runtime --timestamp \
        --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" "$macho"
      signed=$((signed + 1))
    fi
  done < <(find "$dest" -type f)
  echo "stage-lfm2-runner: signed $signed nested Mach-O file(s)"
fi
