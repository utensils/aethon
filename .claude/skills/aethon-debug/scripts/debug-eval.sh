#!/usr/bin/env bash
# Aethon debug eval helper — sends JS to the running Aethon debug server.
# Usage: debug-eval.sh 'return 1 + 1'
#        echo 'return document.title' | debug-eval.sh
#
# Port discovery (in priority order):
#   1. $AETHON_DEBUG_PORT — explicit override
#   2. ~/.aethon/dev-info.json — written by scripts/dev.sh on each launch.
#      Lets the skill find the port even when the wrapper auto-incremented
#      because 19433 was busy. The file is removed when the dev session
#      exits, so a stale file from a crashed run just falls through to
#      the default.
#   3. 19433 — built-in default (matches src-tauri's DEFAULT_DEBUG_PORT)
#
# The dev build must be running (`bun tauri dev` or the devshell `dev` helper).
# Release builds have no debug server (gated by #[cfg(debug_assertions)]).
set -euo pipefail

HOST="127.0.0.1"
DEV_INFO="${HOME}/.aethon/dev-info.json"
TIMEOUT=12

if [[ -n "${AETHON_DEBUG_PORT:-}" ]]; then
  PORT="${AETHON_DEBUG_PORT}"
elif [[ -f "${DEV_INFO}" ]]; then
  # Pull debugPort from dev-info.json. python3 is already a dependency
  # of this script for the TCP I/O below, so reuse it instead of jq.
  PORT="$(python3 -c "
import json, sys
try:
    with open('${DEV_INFO}') as f:
        info = json.load(f)
    p = info.get('debugPort')
    if isinstance(p, int) and p > 0:
        print(p)
        sys.exit(0)
except Exception:
    pass
print(19433)
" 2>/dev/null || echo 19433)"
else
  PORT=19433
fi

if [[ $# -gt 0 ]]; then
  JS="$*"
else
  JS="$(cat)"
fi

if [[ -z "${JS}" ]]; then
  echo "Usage: debug-eval.sh <javascript>" >&2
  echo "       echo 'return ...' | debug-eval.sh" >&2
  exit 1
fi

python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(${TIMEOUT})
try:
    s.connect(('${HOST}', ${PORT}))
except ConnectionRefusedError:
    sys.stderr.write('ERROR: cannot connect to debug server on ${HOST}:${PORT}\n')
    sys.stderr.write('Start the dev build with \`bun tauri dev\` (or the devshell \`dev\` helper).\n')
    sys.stderr.write('Release builds have no debug server.\n')
    sys.exit(1)
s.sendall(sys.stdin.buffer.read())
s.shutdown(socket.SHUT_WR)
data = b''
while True:
    try:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    except socket.timeout:
        break
s.close()
sys.stdout.buffer.write(data)
" <<< "${JS}"
