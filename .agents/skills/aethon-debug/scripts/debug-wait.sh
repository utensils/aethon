#!/usr/bin/env bash
# Block until Aethon's `state.waiting` flips false (agent done responding).
# Returns a JSON snapshot when the wait condition is met.
# Usage: debug-wait.sh [--timeout 300] [--interval 1]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVAL="${SCRIPT_DIR}/debug-eval.sh"

TIMEOUT=300
INTERVAL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: debug-wait.sh [--timeout N] [--interval N]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

start=$(date +%s)
while true; do
  now=$(date +%s)
  elapsed=$(( now - start ))
  if (( elapsed >= TIMEOUT )); then
    echo "{\"timeout\": true, \"elapsed\": ${elapsed}}"
    exit 124
  fi

  result=$("$EVAL" <<'JS' 2>/dev/null || true
const s = window.__AETHON_STATE__();
const messages = s.messages || [];
const last = messages[messages.length - 1];
return {
  waiting: !!s.waiting,
  status: s.status,
  messageCount: messages.length,
  lastRole: last ? last.role : null,
  lastPreview: last ? (last.text || '').slice(0, 200) : null,
};
JS
)

  if [[ -z "$result" ]]; then
    sleep "$INTERVAL"
    continue
  fi

  # If python3 returns the JSON shape, check `waiting` field.
  waiting=$(printf '%s' "$result" | python3 -c "import json,sys
try:
    d=json.loads(sys.stdin.read())
    print(d.get('waiting'))
except Exception:
    print('?')" 2>/dev/null || echo "?")

  if [[ "$waiting" == "False" ]]; then
    echo "$result"
    exit 0
  fi

  sleep "$INTERVAL"
done
