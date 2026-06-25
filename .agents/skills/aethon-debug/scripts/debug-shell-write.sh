#!/usr/bin/env bash
# Send raw input to a shell tab, bypassing the share-mode gate that
# production `shell_write` enforces. Backed by the `cfg(debug_assertions)`
# `debug_shell_write_raw` Tauri command — only present in dev builds.
#
# Auto-appends a newline if the input doesn't end in one (the common
# case is "run a command", which needs Enter).
#
# Usage:
#   debug-shell-write.sh <tabId> 'echo hello'
#   echo 'cargo --version' | debug-shell-write.sh <tabId>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: debug-shell-write.sh <tabId> [<input>]" >&2
  echo "       echo '<input>' | debug-shell-write.sh <tabId>" >&2
  exit 64
fi

TAB_ID="$1"
shift
if [[ $# -gt 0 ]]; then
  INPUT="$*"
else
  INPUT="$(cat)"
fi
# Normalize: ensure a trailing newline so the shell actually runs the line.
[[ -n "${INPUT}" && "${INPUT: -1}" != $'\n' ]] && INPUT="${INPUT}"$'\n'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use python to safely JSON-encode the input (handles quotes, newlines, etc.)
ARGS_JSON=$(python3 -c "
import json, sys
print(json.dumps({'tabId': sys.argv[1], 'data': sys.argv[2]}))
" "${TAB_ID}" "${INPUT}")

exec "${SCRIPT_DIR}/debug-invoke.sh" debug_shell_write_raw "${ARGS_JSON}"
