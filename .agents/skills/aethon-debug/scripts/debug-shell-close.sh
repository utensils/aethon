#!/usr/bin/env bash
# Close a shell tab (mirrors the user clicking the X on the tab strip).
#
# Usage: debug-shell-close.sh <tabId>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: debug-shell-close.sh <tabId>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARGS_JSON=$(python3 -c "import json,sys; print(json.dumps({'tabId': sys.argv[1]}))" "$1")
exec "${SCRIPT_DIR}/debug-invoke.sh" shell_close "${ARGS_JSON}"
