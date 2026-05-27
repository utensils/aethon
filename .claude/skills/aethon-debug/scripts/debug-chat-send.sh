#!/usr/bin/env bash
# Send a chat message to an agent tab the same way pressing Enter in
# the composer would. Returns once the agent has acknowledged receipt
# (NOT once the response finishes — for that, poll `debug-chat-wait`).
#
# Usage:
#   debug-chat-send.sh <tabId> "what is 2 + 2?"
#   echo "long multi-line message" | debug-chat-send.sh <tabId>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: debug-chat-send.sh <tabId> [<message>]" >&2
  exit 64
fi

TAB_ID="$1"
shift
if [[ $# -gt 0 ]]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

ARGS_JSON=$(python3 -c "
import json, sys
print(json.dumps({
  'message': sys.argv[1],
  'mode': 'normal',
  'tabId': sys.argv[2],
}))
" "${MSG}" "${TAB_ID}")

exec "${SCRIPT_DIR}/debug-invoke.sh" send_message "${ARGS_JSON}"
