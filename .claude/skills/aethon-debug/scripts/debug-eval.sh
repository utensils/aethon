#!/usr/bin/env bash
# Aethon debug eval helper — sends JS to the running Aethon debug server.
# Auto-starts the dev build if it is not running.
#
# Usage: debug-eval.sh 'return 1 + 1'
#        debug-eval.sh --file snippet.js      # multi-line JS from a file
#        echo 'return document.title' | debug-eval.sh
#
# NOTE: inline JS is read from the args verbatim. If you have a multi-line
# snippet, pass it with --file (or pipe it on stdin) — do NOT pass a bare
# file path as the JS, it would be eval'd as a string. As a safety net, a
# single arg that is an existing file is auto-read (with a stderr note).
#
# Port discovery (in priority order):
#   1. $AETHON_DEBUG_PORT — explicit override
#   2. ~/.aethon/dev-info.json — normal `dev` launch.
#   3. $TMPDIR/aethon-dev/new-*/dev-info.json — `dev --new` sandbox
#      launches. We pick the most-recently-modified one when multiple
#      sandboxes exist.
#   4. 19433 — built-in default (matches src-tauri's DEFAULT_DEBUG_PORT)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${SKILL_DIR}/../.." && pwd)"
HOST="127.0.0.1"
DEV_INFO_DEFAULT="${HOME}/.aethon/dev-info.json"
SANDBOX_GLOB="${TMPDIR:-/tmp}/aethon-dev/new-*/dev-info.json"
EVAL_TIMEOUT=12
START_TIMEOUT=240   # seconds to wait for app to start / compile
DEV_LOG="${TMPDIR:-/tmp}/aethon-dev.log"

# Resolve dev-info.json. Prefer the conventional location; fall back
# to the most recent sandbox if the user is running `dev --new`. Keeps
# the skill working across both modes without forcing every UAT call
# to set $AETHON_DEBUG_PORT manually.
resolve_dev_info() {
  if [[ -f "${DEV_INFO_DEFAULT}" ]]; then
    echo "${DEV_INFO_DEFAULT}"
    return
  fi
  # shellcheck disable=SC2206
  local matches=( ${SANDBOX_GLOB} )
  if [[ "${#matches[@]}" -eq 0 || ! -f "${matches[0]}" ]]; then
    return
  fi
  # Pick newest by mtime — important when multiple sandboxes were
  # spawned over the course of a single session.
  local newest=""
  local newest_mtime=0
  for f in "${matches[@]}"; do
    [[ -f "$f" ]] || continue
    local m
    m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
    if (( m > newest_mtime )); then
      newest_mtime=$m
      newest=$f
    fi
  done
  echo "${newest}"
}
DEV_INFO="$(resolve_dev_info)"

# ---------------------------------------------------------------------------
# Port resolution
# ---------------------------------------------------------------------------
resolve_port() {
  if [[ -n "${AETHON_DEBUG_PORT:-}" ]]; then
    echo "${AETHON_DEBUG_PORT}"
    return
  fi
  # Re-resolve in case the sandbox was spawned after the shell
  # was constructed (or the user `rm`d the global dev-info.json
  # mid-session).
  DEV_INFO="$(resolve_dev_info)"
  if [[ -n "${DEV_INFO}" && -f "${DEV_INFO}" ]]; then
    python3 -c "
import json, sys
try:
    with open('${DEV_INFO}') as f:
        info = json.load(f)
    p = info.get('debugPort')
    if isinstance(p, int) and p > 0:
        print(p); sys.exit(0)
except Exception:
    pass
print(19433)
" 2>/dev/null || echo 19433
  else
    echo 19433
  fi
}

# ---------------------------------------------------------------------------
# Check if the debug server is reachable on a given port
# ---------------------------------------------------------------------------
server_up() {
  local port="$1"
  python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(1)
try:
    s.connect(('${HOST}', ${port}))
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Start dev build in the background if not already running
# ---------------------------------------------------------------------------
ensure_app_running() {
  local port
  port="$(resolve_port)"

  if server_up "${port}"; then
    echo "${port}"
    return
  fi

  # Check if existing dev-info.json points to a live PID
  if [[ -f "${DEV_INFO}" ]]; then
    local pid
    pid="$(python3 -c "
import json, sys
try:
    with open('${DEV_INFO}') as f:
        info = json.load(f)
    p = info.get('pid')
    if isinstance(p, int) and p > 0:
        print(p); sys.exit(0)
except Exception:
    pass
sys.exit(1)
" 2>/dev/null)" && kill -0 "${pid}" 2>/dev/null && {
      # PID is alive but server not yet ready — it might still be compiling
      echo "INFO: Dev process (PID ${pid}) is alive but debug server not up yet — waiting..." >&2
    } || true
  fi

  if ! server_up "${port}"; then
    echo "INFO: Aethon dev build not running — starting it (output: ${DEV_LOG})" >&2
    echo "INFO: This may take up to a few minutes on first compile." >&2

    # Prefer the devshell entry point; fall back to bun directly
    if command -v dev &>/dev/null; then
      nohup bash -c "cd '${REPO_DIR}' && dev" >"${DEV_LOG}" 2>&1 &
    else
      nohup bash -c "cd '${REPO_DIR}' && bun tauri dev" >"${DEV_LOG}" 2>&1 &
    fi
  fi

  # Wait for the server to come up
  local elapsed=0
  local dot_interval=10
  local last_dot=0
  while ! server_up "$(resolve_port)"; do
    if (( elapsed >= START_TIMEOUT )); then
      echo "" >&2
      echo "ERROR: Timed out after ${START_TIMEOUT}s waiting for debug server." >&2
      echo "       Check dev build output: tail ${DEV_LOG}" >&2
      exit 1
    fi
    if (( elapsed - last_dot >= dot_interval )); then
      printf "  waiting (%ds)...\n" "${elapsed}" >&2
      last_dot=${elapsed}
    fi
    sleep 2
    (( elapsed += 2 ))
  done
  echo "INFO: Debug server ready." >&2

  resolve_port
}

# ---------------------------------------------------------------------------
# Read JS from --file, args, or stdin
# ---------------------------------------------------------------------------
JS_FILE=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--file)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --file requires a path argument" >&2
        exit 1
      fi
      JS_FILE="$2"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -n "${JS_FILE}" ]]; then
  if [[ ! -f "${JS_FILE}" ]]; then
    echo "ERROR: --file path not found: ${JS_FILE}" >&2
    exit 1
  fi
  JS="$(cat "${JS_FILE}")"
elif [[ "${#ARGS[@]}" -gt 0 ]]; then
  # Safety net: a lone arg that is an existing file is almost certainly a
  # path the caller meant to read, not literal JS. Read it (with a note)
  # instead of eval'ing the path string — which just hangs until timeout.
  if [[ "${#ARGS[@]}" -eq 1 && -f "${ARGS[0]}" ]]; then
    echo "INFO: '${ARGS[0]}' is a file — reading JS from it (use --file to silence)." >&2
    JS="$(cat "${ARGS[0]}")"
  else
    JS="${ARGS[*]}"
  fi
else
  JS="$(cat)"
fi

if [[ -z "${JS}" ]]; then
  echo "Usage: debug-eval.sh <javascript>" >&2
  echo "       debug-eval.sh --file snippet.js" >&2
  echo "       echo 'return ...' | debug-eval.sh" >&2
  exit 1
fi

PORT="$(ensure_app_running)"

python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(${EVAL_TIMEOUT})
try:
    s.connect(('${HOST}', ${PORT}))
except ConnectionRefusedError:
    sys.stderr.write('ERROR: cannot connect to debug server on ${HOST}:${PORT}\n')
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
