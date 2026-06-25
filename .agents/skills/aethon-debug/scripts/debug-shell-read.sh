#!/usr/bin/env bash
# Dump a shell tab's recent scrollback regardless of share-mode.
# Backed by `debug_shell_snapshot` (dev-only).
#
# Usage:
#   debug-shell-read.sh <tabId>              # last 4 KiB of output
#   debug-shell-read.sh <tabId> 16384        # last 16 KiB
#   debug-shell-read.sh <tabId> 8192 raw     # just the tail bytes
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: debug-shell-read.sh <tabId> [<tailBytes>] [raw]" >&2
  exit 64
fi

TAB_ID="$1"
TAIL_BYTES="${2:-4096}"
MODE="${3:-json}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS_JSON=$(python3 -c "
import json, sys
print(json.dumps({'tabId': sys.argv[1], 'tailBytes': int(sys.argv[2])}))
" "${TAB_ID}" "${TAIL_BYTES}")

RESULT="$("${SCRIPT_DIR}/debug-invoke.sh" debug_shell_snapshot "${ARGS_JSON}")"

if [[ "${MODE}" == "raw" ]]; then
  python3 -c "
import json, sys
try:
    obj = json.loads(sys.argv[1])
except Exception as e:
    sys.stderr.write(f'ERROR: parsing snapshot: {e}\n')
    sys.exit(1)
sys.stdout.write(obj.get('tail', ''))
" "${RESULT}"
else
  echo "${RESULT}"
fi
