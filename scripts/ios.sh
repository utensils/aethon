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

# Host-side Rust build scripts still compile for macOS while the app
# itself cross-compiles for iOS. On nix-darwin, plain `cc` can resolve to
# the Nix GCC wrapper, which cannot see Xcode's SDK libiconv.tbd. Pin the
# host tools to Apple's clang so build scripts link against the active SDK.
apple_cc="/usr/bin/cc"
apple_cxx="/usr/bin/c++"
export CC="${CC:-$apple_cc}"
export CXX="${CXX:-$apple_cxx}"
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="${CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER:-$apple_cc}"
export RUSTC_LINKER="${RUSTC_LINKER:-$apple_cc}"
if [ -z "${SDKROOT:-}" ]; then
  export SDKROOT="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
fi

# Cross-compiling C deps (ring's curve25519.c, etc.) for the iOS targets
# must use Apple's unwrapped clang. The Nix cc-wrapper injects
# `-mmacos-version-min=…`, which clang rejects alongside
# `-mios-simulator-version-min=…` ("not allowed with"). Point cc-rs +
# rustc's link step at /usr/bin/clang for the iOS triples only — the
# desktop build's /usr/bin/cc pin (flake.nix) is untouched.
for triple in aarch64_apple_ios aarch64_apple_ios_sim x86_64_apple_ios; do
  export "CC_${triple}=/usr/bin/clang"
  export "CXX_${triple}=/usr/bin/clang++"
done
export CARGO_TARGET_AARCH64_APPLE_IOS_LINKER="/usr/bin/clang"
export CARGO_TARGET_AARCH64_APPLE_IOS_SIM_LINKER="/usr/bin/clang"
export CARGO_TARGET_X86_64_APPLE_IOS_LINKER="/usr/bin/clang"

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

# CoreDevice identifiers are not the same shape as simulator UDIDs, and
# `devicectl list devices` output changes just enough between Xcode releases
# that grepping the pretty table is brittle. Parse the JSON and prefer a
# connected, paired, physical iPhone. Echoes tab-separated:
#   identifier  display-name  marketing-name  transport
pick_physical_ios_device() {
  if [ -n "${AETHON_IOS_UDID:-}" ]; then
    printf '%s\t%s\t%s\t%s\n' "$AETHON_IOS_UDID" "override" "AETHON_IOS_UDID" "manual"
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 not found — needed to parse devicectl JSON." >&2
    echo "       Install the Xcode Command Line Tools (xcode-select --install)," >&2
    echo "       or set AETHON_IOS_UDID to skip device discovery." >&2
    return 1
  fi

  local json_file
  json_file="$(mktemp -t aethon-devicectl-devices.XXXXXX.json)"
  if ! xcrun devicectl list devices --json-output "$json_file" >/dev/null; then
    rm -f "$json_file"
    return 1
  fi

  python3 - "$json_file" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

devices = data.get("result", {}).get("devices", [])

def is_connected_iphone(device):
    hardware = device.get("hardwareProperties") or {}
    connection = device.get("connectionProperties") or {}
    product = str(hardware.get("productType") or "")
    return (
        bool(device.get("identifier"))
        and hardware.get("reality") == "physical"
        and hardware.get("platform") == "iOS"
        and (hardware.get("deviceType") == "iPhone" or product.startswith("iPhone"))
        and connection.get("pairingState") == "paired"
        and connection.get("tunnelState") == "connected"
    )

matches = [device for device in devices if is_connected_iphone(device)]
if not matches:
    sys.exit(1)

matches.sort(
    key=lambda device: (
        (device.get("connectionProperties") or {}).get("lastConnectionDate") or ""
    ),
    reverse=True,
)
device = matches[0]
hardware = device.get("hardwareProperties") or {}
connection = device.get("connectionProperties") or {}
name = (device.get("deviceProperties") or {}).get("name") or "iPhone"
model = hardware.get("marketingName") or hardware.get("productType") or "iPhone"
transport = connection.get("transportType") or "connected"
print(f"{device['identifier']}\t{name}\t{model}\t{transport}")
PY
  local status=$?
  rm -f "$json_file"
  return "$status"
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
    # A bare device build (the Tauri CLI default) needs code signing —
    # that's what `ios-device` does. Zero-arg ios-build stays the
    # unsigned simulator build so it works with no signing setup.
    if [ $# -eq 0 ]; then
      echo "==> no args: defaulting to the unsigned simulator build"
      echo "    (signed device build + install: ios-device)"
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
  device)
    # Signed device build + install onto a USB/network-connected iPhone
    # via devicectl — no Xcode UI. Signing comes from DEVELOPMENT_TEAM +
    # CODE_SIGN_STYLE Automatic in gen/apple/project.yml against the
    # team's local cert + wildcard provisioning profile. (Do NOT try to
    # pass -allowProvisioningUpdates via `--`: tauri forwards trailing
    # args to cargo, not xcodebuild.)
    rm -rf src-tauri/gen/apple/build
    touch src-tauri/src/lib.rs # re-embed dist-mobile (see build mode)
    echo "==> cargo tauri ios build --debug --target aarch64 (signed device build)"
    if ! cargo tauri ios build --debug --target aarch64 --export-method debugging; then
      echo "error: device build failed." >&2
      echo "If it mentions provisioning/profiles: run 'ios-dev --open' once and press Run in" >&2
      echo "Xcode to mint the profile (keep the CLI running — a bare xcodebuild dies at the" >&2
      echo "Build Rust Code phase with 'Connection refused'). Then retry ios-device." >&2
      exit 1
    fi
    device_info="$(pick_physical_ios_device || true)"
    IFS=$'\t' read -r udid device_name device_model device_transport <<<"$device_info"
    if [ -z "$udid" ]; then
      echo "error: no connected physical iPhone found." >&2
      echo "       xcrun devicectl list devices should show State=connected; AETHON_IOS_UDID overrides." >&2
      xcrun devicectl list devices >&2 || true
      exit 1
    fi
    echo "==> selected physical device: $device_name ($device_model, $device_transport) $udid"
    app_path=""
    for candidate in \
      src-tauri/gen/apple/build/arm64/Aethon.ipa \
      src-tauri/gen/apple/build/arm64/Aethon.app \
      src-tauri/gen/apple/build/aethon-mobile_iOS.xcarchive/Products/Applications/Aethon.app; do
      if [ -e "$candidate" ]; then
        app_path="$candidate"
        break
      fi
    done
    if [ -z "$app_path" ]; then
      echo "error: built app not found under src-tauri/gen/apple/build/" >&2
      exit 1
    fi
    echo "==> installing $app_path on device $udid"
    xcrun devicectl device install app --device "$udid" "$app_path"
    echo "==> launching $bundle_id"
    if ! xcrun devicectl device process launch --terminate-existing --device "$udid" "$bundle_id"; then
      # Install already succeeded — a locked phone just can't auto-launch.
      echo "==> installed, but launch failed (phone locked?) — unlock the iPhone and open Aethon."
    fi
    ;;
  *)
    echo "usage: ios.sh <dev|build|run|device> [tauri-ios-args...]" >&2
    exit 2
    ;;
esac
