#!/usr/bin/env bash
# Poll a tab until the agent has finished its current response (the
# state's `waiting` flag flips false AND the message count advanced).
# Prints the last assistant message and any tool-call summaries.
#
# Usage: debug-chat-wait.sh <tabId> [<timeout-sec>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAB_ID="${1:-}"
TIMEOUT="${2:-60}"

if [[ -z "${TAB_ID}" ]]; then
  echo "Usage: debug-chat-wait.sh <tabId> [<timeout-sec>]" >&2
  exit 64
fi

# Capture starting message count so we know what counts as "new".
START_COUNT=$("${SCRIPT_DIR}/debug-eval.sh" "
const s = window.__AETHON_STATE__();
const t = s.tabs && s.tabs['${TAB_ID}'];
return String((t && t.messages ? t.messages.length : 0));
" | tr -d '"')

elapsed=0
while (( elapsed < TIMEOUT )); do
  STATUS=$("${SCRIPT_DIR}/debug-eval.sh" "
const s = window.__AETHON_STATE__();
const t = s.tabs && s.tabs['${TAB_ID}'];
if (!t) return JSON.stringify({error: 'no tab'});
return JSON.stringify({waiting: !!t.waiting, msgCount: (t.messages || []).length, last: (t.messages || [])[t.messages.length - 1]});")
  WAITING=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('waiting'))" 2>/dev/null || echo "?")
  COUNT=$(echo "$STATUS"  | python3 -c "import json,sys; print(json.load(sys.stdin).get('msgCount'))" 2>/dev/null || echo "0")
  if [[ "${WAITING}" == "False" ]] && (( COUNT > START_COUNT )); then
    echo "$STATUS"
    exit 0
  fi
  sleep 2
  (( elapsed += 2 ))
done

echo "ERROR: timeout after ${TIMEOUT}s — waiting=${WAITING}, msgCount=${COUNT}, started at ${START_COUNT}" >&2
exit 1
