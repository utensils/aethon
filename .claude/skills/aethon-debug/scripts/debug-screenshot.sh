#!/usr/bin/env bash
# Capture a screenshot of the Aethon dev app window.
#
# On macOS this now produces a WINDOW-SCOPED shot: it raises the dev process
# by PID (System Events `unix id`, never by app name — name-based activation
# can match a stale release `.app`, see the never-osascript-activate rule),
# reads the front window's bounds, and region-captures just that window. If
# the window bounds can't be read (e.g. no Accessibility permission), it falls
# back to a full-display capture so you still get something.
#
# Returns the path to the PNG on stdout.
# Default save location: ${TMPDIR:-/tmp}/aethon-debug/aethon-<timestamp>.png
#
# Flags:
#   --output PATH   where to write the PNG
#   --full          force a full-display capture (skip window scoping)
#   --pid N         target a specific dev PID (default: auto-resolve)
#   --width N       downscale the result to N px wide (handy for docs assets)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${TMPDIR:-/tmp}/aethon-debug/aethon-$(date +%Y%m%d-%H%M%S).png"
FOCUS_TIMEOUT=1
FULL=0
PID_OVERRIDE=""
SCALE_WIDTH=""

DEV_INFO_DEFAULT="${HOME}/.aethon/dev-info.json"
SANDBOX_GLOB="${TMPDIR:-/tmp}/aethon-dev/new-*/dev-info.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUT="$2"; shift 2 ;;
    --full) FULL=1; shift ;;
    --pid)
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "ERROR: --pid must be a number" >&2; exit 2; }
      PID_OVERRIDE="$2"; shift 2 ;;
    --width)
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "ERROR: --width must be a number" >&2; exit 2; }
      SCALE_WIDTH="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: debug-screenshot.sh [--output PATH] [--full] [--pid N] [--width N]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$OUT")"

# Resolve dev-info.json (conventional path, else newest `dev --new` sandbox).
resolve_dev_info() {
  if [[ -f "${DEV_INFO_DEFAULT}" ]]; then echo "${DEV_INFO_DEFAULT}"; return; fi
  # shellcheck disable=SC2206
  local matches=( ${SANDBOX_GLOB} )
  [[ "${#matches[@]}" -eq 0 || ! -f "${matches[0]}" ]] && return
  local newest="" newest_mtime=0 m
  for f in "${matches[@]}"; do
    [[ -f "$f" ]] || continue
    m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    (( m > newest_mtime )) && { newest_mtime=$m; newest=$f; }
  done
  echo "${newest}"
}
DEV_INFO="$(resolve_dev_info)"

resolve_port() {
  [[ -n "${AETHON_DEBUG_PORT:-}" ]] && { echo "${AETHON_DEBUG_PORT}"; return; }
  if [[ -n "${DEV_INFO}" && -f "${DEV_INFO}" ]]; then
    python3 -c "import json;print((json.load(open('${DEV_INFO}')).get('debugPort') or 19433))" 2>/dev/null || echo 19433
  else
    echo 19433
  fi
}

# Resolve the dev GUI PID. The debug server runs INSIDE the Tauri GUI
# process, so the PID LISTENing on the debug port is the window we want.
# Prefer that. dev-info.json's `pid` is written by scripts/dev.sh as the
# launcher SHELL pid ($$) on a normal `dev` launch — it has no window, so
# `System Events` can't find it and we'd silently fall back to full-screen.
# Only use dev-info.json's pid as a last resort (e.g. lsof unavailable).
resolve_pid() {
  [[ -n "${PID_OVERRIDE}" ]] && { echo "${PID_OVERRIDE}"; return; }
  local pid=""
  pid=$(lsof -nP -iTCP:"$(resolve_port)" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
  if [[ -n "$pid" ]]; then echo "$pid"; return; fi
  if [[ -n "${DEV_INFO}" && -f "${DEV_INFO}" ]]; then
    pid=$(python3 -c "import json;print(json.load(open('${DEV_INFO}')).get('pid') or '')" 2>/dev/null || true)
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; return; }
  fi
  echo ""
}

# Nudge the webview to foreground its own window (harmless, helps on the
# rare path where Accessibility isn't granted and we full-capture).
"${SCRIPT_DIR}/debug-eval.sh" 'window.focus(); return "focused"' >/dev/null 2>&1 || true

case "$(uname -s)" in
  Darwin)
    REGION=""
    if [[ "${FULL}" -eq 0 ]]; then
      PID="$(resolve_pid)"
      if [[ -n "${PID}" ]]; then
        # Raise by unix id (PID-bound — does NOT resolve by app name) and
        # read the front window's bounds in screen points.
        REGION="$(osascript <<OSA 2>/dev/null || true
tell application "System Events"
  set proc to first process whose unix id is ${PID}
  set frontmost of proc to true
  delay 0.4
  tell proc
    set w to front window
    set {x, y} to position of w
    set {ww, hh} to size of w
  end tell
end tell
return ((x as integer) & "," & (y as integer) & "," & (ww as integer) & "," & (hh as integer)) as text
OSA
)"
      fi
    fi
    sleep "${FOCUS_TIMEOUT}"
    if [[ -n "${REGION}" && "${REGION}" =~ ^-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+$ ]]; then
      screencapture -x -R"${REGION}" "$OUT"
    else
      [[ "${FULL}" -eq 0 ]] && echo "INFO: window bounds unavailable; full-display capture (try --pid, or grant Accessibility)." >&2
      screencapture -x "$OUT"
    fi
    ;;
  Linux)
    if command -v grim >/dev/null 2>&1; then grim "$OUT"
    elif command -v scrot >/dev/null 2>&1; then scrot "$OUT"
    elif command -v import >/dev/null 2>&1; then import -window root "$OUT"
    else echo "ERROR: no screenshot tool found (need grim, scrot, or imagemagick)" >&2; exit 1
    fi
    ;;
  *) echo "ERROR: unsupported platform $(uname -s)" >&2; exit 1 ;;
esac

# Optional downscale (e.g. for embedding in docs).
if [[ -n "${SCALE_WIDTH}" ]] && command -v sips >/dev/null 2>&1; then
  sips --resampleWidth "${SCALE_WIDTH}" "$OUT" >/dev/null 2>&1 || true
fi

echo "$OUT"
