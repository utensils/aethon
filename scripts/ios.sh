#!/usr/bin/env bash
# iOS companion helper — drives `cargo tauri ios <dev|build>` for the thin
# crate under apps/mobile, plus a `run` mode that installs the built app
# into a simulator. Xcode + CocoaPods live OUTSIDE the Nix devshell
# (Tauri's iOS tooling shells out to xcodebuild); this puts Homebrew on
# PATH so `pod` / `xcodegen` resolve, generates gen/apple on first run,
# then hands off to the Tauri CLI. See docs/mobile.md.
set -uo pipefail

mode="${1:-dev}"
shift || true

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$repo_root/apps/mobile"
bundle_id="com.utensils.aethon.mobile"
sim_app="src-tauri/gen/apple/build/arm64-sim/Aethon.app"

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

# Preferred simulator: AETHON_IOS_DEVICE override, else iPhone 17 Pro,
# else the first available iPhone. Echoes the resolved device name.
pick_device() {
  local want="${AETHON_IOS_DEVICE:-iPhone 17 Pro}"
  local sims
  sims="$(xcrun simctl list devices available)"
  # "$want (" keeps the match exact — "iPhone 17 Pro (" can't hit
  # "iPhone 17 Pro Max (…" because Max breaks the "name (" adjacency.
  if grep -qF "$want (" <<<"$sims"; then
    echo "$want"
    return
  fi
  grep -oE '^ +iPhone [^(]+' <<<"$sims" | head -1 | sed 's/^ *//;s/ *$//'
}

# UDID for a device name. Several runtimes can carry the same name
# (iPhone 17 Pro exists for iOS 26.0…26.5); the Tauri CLI resolves a
# bare name to the FIRST simctl match (runtimes list oldest-first), so
# take head -1 to target the same simulator it will deploy to.
device_udid() {
  xcrun simctl list devices available | grep -F "$1 (" |
    grep -oE '[0-9A-F-]{36}' | head -1
}

cd "$app_dir"

# First-run scaffold: generate the Xcode project if it isn't there yet.
if [ ! -d src-tauri/gen/apple ]; then
  echo "==> gen/apple missing — running 'cargo tauri ios init'"
  cargo tauri ios init --ci
fi

case "$mode" in
  dev)
    # Zero-arg default: pick a simulator by name so the Tauri CLI never
    # prompts (and Xcode never opens). Only one `ios dev` session can
    # run at a time — the xcodebuild script phase dials back into the
    # CLI's options server, so a second session (or a build started
    # from Xcode without the CLI) dies with "Connection refused".
    if [ $# -eq 0 ]; then
      device="$(pick_device)"
      if [ -z "$device" ]; then
        echo "error: no available iPhone simulator (xcrun simctl list devices available)" >&2
        exit 1
      fi
      # The CLI installs without booting — a Shutdown target fails
      # deploy with SimError 405 ("Unable to lookup in current state").
      # Pre-boot the exact UDID it will resolve the name to.
      udid="$(device_udid "$device")"
      if [ -n "$udid" ]; then
        echo "==> booting $device ($udid)"
        xcrun simctl boot "$udid" 2>/dev/null || true # already booted is fine
        open -a Simulator
      fi
      set -- "$device"
    fi
    echo "==> cargo tauri ios dev $*"
    exec cargo tauri ios dev "$@"
    ;;
  build)
    # The Tauri CLI renames the freshly-archived .app inside the
    # xcarchive; a stale archive from a previous run makes that rename
    # fail with ENOTEMPTY (os error 66). gen/apple/build holds final
    # products only — incremental state lives in DerivedData and
    # target/ — so clearing it is cheap and makes rebuilds reliable.
    rm -rf src-tauri/gen/apple/build
    # generate_context! embeds frontendDist (dist-mobile) into the
    # binary at macro-expansion time, but cargo doesn't track the dist
    # as a dependency — without dirtying the crate, a frontend-only
    # change ships the PREVIOUS embed (black screen, stale UI). The
    # beforeBuildCommand rebuilds dist-mobile before cargo runs, so a
    # touch here guarantees the fresh bundle is what gets embedded.
    touch src-tauri/src/lib.rs
    # A bare device build (the Tauri CLI default) needs code signing,
    # and bundle.iOS.developmentTeam is unset — xcodebuild fails with
    # "requires a development team". Default to the unsigned simulator
    # build instead so zero-arg ios-build works out of the box.
    if [ $# -eq 0 ]; then
      echo "==> no args: defaulting to the unsigned simulator build"
      echo "    (device build: ios-build --target aarch64 — needs a development"
      echo "     team in apps/mobile/src-tauri/tauri.conf.json bundle.iOS)"
      set -- --debug --target aarch64-sim
    fi
    echo "==> cargo tauri ios build $*"
    exec cargo tauri ios build "$@"
    ;;
  run)
    # Install + launch the last `ios-build` output in a simulator —
    # static bundle, no dev server, no Xcode. Builds first if missing.
    if [ ! -d "$sim_app" ]; then
      echo "==> no simulator build yet — running ios.sh build"
      bash "$repo_root/scripts/ios.sh" build || exit 1
    fi
    device="$(pick_device)"
    udid="$(device_udid "$device")"
    if [ -z "$udid" ]; then
      echo "error: no available iPhone simulator (xcrun simctl list devices available)" >&2
      exit 1
    fi
    echo "==> booting $device ($udid)"
    xcrun simctl boot "$udid" 2>/dev/null || true # already booted is fine
    open -a Simulator
    echo "==> installing $sim_app"
    xcrun simctl install "$udid" "$sim_app"
    echo "==> launching $bundle_id"
    xcrun simctl launch --terminate-running-process "$udid" "$bundle_id"
    ;;
  *)
    echo "usage: ios.sh <dev|build|run> [tauri-ios-args...]" >&2
    exit 2
    ;;
esac
