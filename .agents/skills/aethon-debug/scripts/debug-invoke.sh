#!/usr/bin/env bash
# Generic Tauri-command invoker. Sends:
#   __TAURI_INTERNALS__.invoke(<command>, <args-json>)
# from inside the webview and prints the result (or "ERROR: ..." on
# failure).
#
# Examples:
#   debug-invoke.sh devshell_status '{"args":{"root":"/Users/.../aethon"}}'
#   debug-invoke.sh shell_list_shareable
#   debug-invoke.sh debug_shell_snapshot '{"tabId":"uat-1","tailBytes":4096}'
#
# Useful as the lowest level under the gesture scripts in this dir.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: debug-invoke.sh <command> [<args-json>]" >&2
  exit 64
fi

CMD="$1"
# `${2:-{}}` doesn't work — bash's `}` terminator on parameter
# expansion swallows the inner `}` and the default ends up as `{}}`,
# which then makes the generated JS a SyntaxError. Use a real var.
if [[ $# -ge 2 ]]; then
  ARGS_JSON="$2"
else
  ARGS_JSON='{}'
fi

EVAL=$(cat <<EOF
const inv = window.__TAURI_INTERNALS__.invoke;
const args = ${ARGS_JSON};
return inv("${CMD}", args).then(
  r => (typeof r === "string" ? r : JSON.stringify(r, null, 2)),
  e => "ERROR: " + (e && e.message ? e.message : String(e)),
);
EOF
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/debug-eval.sh" "${EVAL}"
