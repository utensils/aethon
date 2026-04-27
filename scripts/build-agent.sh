#!/usr/bin/env bash
# Compile agent/main.ts into a self-contained executable for the host
# platform. Output lands in src-tauri/binaries/aethon-agent-<rust-triple>
# so Tauri's externalBin lookup picks it up at bundle time.
#
# Tauri's sidecar mechanism appends the host's Rust target triple to the
# externalBin entry name (e.g. `binaries/aethon-agent` becomes
# `binaries/aethon-agent-aarch64-apple-darwin` on Apple Silicon). The
# bundled app spawns the matching binary by relative path, so the
# triple has to match what `rustc -vV` reports for the build host.

set -euo pipefail

cd "$(dirname "$0")/.."

# Resolve the Rust triple — match what Tauri's bundler uses. Priority:
#   1. --target argument passed in (e.g. `build-agent.sh --target=...`)
#   2. CARGO_BUILD_TARGET / TAURI_ENV_TARGET_TRIPLE env vars (set by
#      `cargo tauri build --target <X>` and during cross-compile CI)
#   3. `rustc -vV` host triple (default for native builds)
#   4. uname-derived guess (CI without a Rust install)
TRIPLE=""
for arg in "$@"; do
  case "$arg" in
    --target=*) TRIPLE="${arg#--target=}" ;;
  esac
done
if [ -z "$TRIPLE" ] && [ -n "${CARGO_BUILD_TARGET:-}" ]; then
  TRIPLE="$CARGO_BUILD_TARGET"
fi
if [ -z "$TRIPLE" ] && [ -n "${TAURI_ENV_TARGET_TRIPLE:-}" ]; then
  TRIPLE="$TAURI_ENV_TARGET_TRIPLE"
fi
if [ -z "$TRIPLE" ] && command -v rustc >/dev/null 2>&1; then
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
fi
if [ -z "$TRIPLE" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)   TRIPLE="aarch64-apple-darwin" ;;
    Darwin-x86_64)  TRIPLE="x86_64-apple-darwin" ;;
    Linux-x86_64)   TRIPLE="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64)  TRIPLE="aarch64-unknown-linux-gnu" ;;
    *) echo "ERROR: cannot guess Rust triple for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
fi

# Map Rust triple → bun --target value. Bun targets are `bun-<os>-<arch>`
# (e.g. `bun-darwin-arm64`); a wrong target produces a binary that won't
# run on the host.
case "$TRIPLE" in
  aarch64-apple-darwin)        BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-apple-darwin)         BUN_TARGET="bun-darwin-x64" ;;
  x86_64-unknown-linux-gnu)    BUN_TARGET="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu)   BUN_TARGET="bun-linux-arm64" ;;
  x86_64-pc-windows-msvc)      BUN_TARGET="bun-windows-x64" ;;
  *) echo "ERROR: no bun target mapping for $TRIPLE" >&2; exit 1 ;;
esac

OUT_DIR="src-tauri/binaries"
# Tauri's externalBin on Windows looks for `aethon-agent-<triple>.exe`;
# on every other target it's the bare name. Match that convention so
# the bundler picks the file up automatically.
case "$TRIPLE" in
  *-windows-*) OUT_NAME="aethon-agent-$TRIPLE.exe" ;;
  *)           OUT_NAME="aethon-agent-$TRIPLE" ;;
esac
mkdir -p "$OUT_DIR"

echo "Compiling agent/main.ts → $OUT_DIR/$OUT_NAME (target=$BUN_TARGET)"
bun build agent/main.ts \
  --compile \
  --target="$BUN_TARGET" \
  --outfile="$OUT_DIR/$OUT_NAME"

# pi-coding-agent reads its own package.json at module load to discover
# version + config dir name. The compiled binary loses access to the
# original node_modules path, so we ship pi's package.json next to the
# binary in a dedicated `pi/` subdir; the Rust shell sets
# PI_PACKAGE_DIR=<binaries-dir>/pi at spawn time and pi's
# config.getPackageDir() honors that override.
PI_PKG_DIR="node_modules/@mariozechner/pi-coding-agent"
PI_OUT_DIR="$OUT_DIR/pi"
mkdir -p "$PI_OUT_DIR"
if [ -f "$PI_PKG_DIR/package.json" ]; then
  cp "$PI_PKG_DIR/package.json" "$PI_OUT_DIR/package.json"
  echo "Copied $PI_PKG_DIR/package.json → $PI_OUT_DIR/package.json"
else
  echo "WARNING: $PI_PKG_DIR/package.json not found — agent will fail at startup" >&2
fi

echo "Done."
ls -lh "$OUT_DIR/$OUT_NAME"
