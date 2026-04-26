#!/usr/bin/env bash
# Aethon debug eval helper — sends JS to the running Aethon debug server.
# Usage: debug-eval.sh 'return 1 + 1'
#        echo 'return document.title' | debug-eval.sh
#
# Port:
#   - $AETHON_DEBUG_PORT overrides
#   - Default: 19433
#
# The dev build must be running (`bun tauri dev` or the devshell `dev` helper).
# Release builds have no debug server (gated by #[cfg(debug_assertions)]).
set -euo pipefail

HOST="127.0.0.1"
PORT="${AETHON_DEBUG_PORT:-19433}"
TIMEOUT=12

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
