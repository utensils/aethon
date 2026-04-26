#!/usr/bin/env bash
# Capture a screenshot of the desktop. Returns the path on stdout.
# Default save location: ${TMPDIR:-/tmp}/aethon-debug/aethon-<timestamp>.png
# Override with --output PATH.
set -euo pipefail

OUT="${TMPDIR:-/tmp}/aethon-debug/aethon-$(date +%Y%m%d-%H%M%S).png"

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

case "$(uname -s)" in
  Darwin)
    # -x silences the shutter sound, default capture is the full main display.
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
