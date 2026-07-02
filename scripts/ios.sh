#!/usr/bin/env bash
# iOS companion helper — drives `cargo tauri ios <dev|build>` for the thin
# crate under apps/mobile. Xcode + CocoaPods live OUTSIDE the Nix devshell
# (Tauri's iOS tooling shells out to xcodebuild); this puts Homebrew on
# PATH so `pod` / `xcodegen` resolve, generates gen/apple on first run,
# then hands off to the Tauri CLI. See docs/mobile.md.
set -uo pipefail

mode="${1:-dev}"
shift || true

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$repo_root/apps/mobile"

# Homebrew ships pod/xcodegen/idevice* the Tauri iOS CLI needs; the Nix
# devshell deliberately doesn't carry them.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Cross-compiling C deps (ring's curve25519.c, etc.) for the iOS targets
# must use Apple's unwrapped clang. The Nix cc-wrapper injects
# `-mmacos-version-min=…`, which clang rejects alongside
# `-mios-simulator-version-min=…` ("not allowed with"). Point cc-rs +
# rustc's link step at /usr/bin/clang for the iOS triples only — the
# desktop build's /usr/bin/cc pin (flake.nix) is untouched.
apple_clang="/usr/bin/clang"
for triple in aarch64_apple_ios aarch64_apple_ios_sim x86_64_apple_ios; do
  export "CC_${triple}=${apple_clang}"
  export "CXX_${triple}=${apple_clang}++"
done
export CARGO_TARGET_AARCH64_APPLE_IOS_LINKER="$apple_clang"
export CARGO_TARGET_AARCH64_APPLE_IOS_SIM_LINKER="$apple_clang"
export CARGO_TARGET_X86_64_APPLE_IOS_LINKER="$apple_clang"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "error: xcodebuild not found — install Xcode (xcode-select --install or the App Store)." >&2
  exit 1
fi
if ! command -v pod >/dev/null 2>&1; then
  echo "error: CocoaPods not found — install it with: brew install cocoapods" >&2
  exit 1
fi

cd "$app_dir"

# First-run scaffold: generate the Xcode project if it isn't there yet.
if [ ! -d src-tauri/gen/apple ]; then
  echo "==> gen/apple missing — running 'cargo tauri ios init'"
  cargo tauri ios init --ci
fi

case "$mode" in
  dev)
    echo "==> cargo tauri ios dev ${*:-(default simulator)}"
    exec cargo tauri ios dev "$@"
    ;;
  build)
    echo "==> cargo tauri ios build $*"
    exec cargo tauri ios build "$@"
    ;;
  *)
    echo "usage: ios.sh <dev|build> [tauri-ios-args...]" >&2
    exit 2
    ;;
esac
