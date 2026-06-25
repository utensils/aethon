#!/usr/bin/env bash
# Capture a screenshot of the full display (the Aethon dev app window is
# focused first, not cropped to). Auto-starts the dev build if it is not
# running, then focuses the window via the debug server before capturing.
#
# Returns the path to the PNG on stdout.
# Default save location: ${TMPDIR:-/tmp}/aethon-debug/aethon-<timestamp>.png
# Override with --output PATH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${TMPDIR:-/tmp}/aethon-debug/aethon-$(date +%Y%m%d-%H%M%S).png"
FOCUS_TIMEOUT=3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: debug-screenshot.sh [--output PATH]"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$(dirname "$OUT")"

# Ensure the app is running (auto-starts if needed) and focus the window
# so the screenshot captures the actual Aethon UI, not whatever is on top.
"${SCRIPT_DIR}/debug-eval.sh" 'window.focus(); return "focused"' >/dev/null 2>&1 || true

# Give the window manager a moment to bring the window forward.
sleep "${FOCUS_TIMEOUT}"

case "$(uname -s)" in
  Darwin)
    # -x silences the shutter sound; captures the full main display.
    screencapture -x "$OUT"
    ;;
  Linux)
    if command -v grim >/dev/null 2>&1; then
      grim "$OUT"
    elif command -v scrot >/dev/null 2>&1; then
      scrot "$OUT"
    elif command -v import >/dev/null 2>&1; then
      import -window root "$OUT"
    else
      echo "ERROR: no screenshot tool found (need grim, scrot, or imagemagick)" >&2
      exit 1
    fi
    ;;
  *)
    echo "ERROR: unsupported platform $(uname -s)" >&2
    exit 1
    ;;
esac

echo "$OUT"
