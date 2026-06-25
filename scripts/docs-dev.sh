#!/usr/bin/env bash
#
# Start the VitePress docs site on a predictable LAN-reachable address.
#
# VitePress binds 0.0.0.0 so the docs are reachable from other devices, but a
# stale loopback-only service on 127.0.0.1:<port> wins localhost routing on
# macOS/Linux. That can make http://localhost:5173/aethon/ show a different app
# even while VitePress is also listening on *:5173.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCS_PORT="${AETHON_DOCS_PORT:-5173}"
ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      if [ "$#" -lt 2 ]; then
        echo "error: --port requires a value" >&2
        exit 2
      fi
      # Capture as DOCS_PORT only; the exec line always appends
      # `--port "$DOCS_PORT"`, so forwarding it here would duplicate the flag.
      DOCS_PORT="$2"
      shift 2
      ;;
    --port=*)
      DOCS_PORT="${1#--port=}"
      shift
      ;;
    -p)
      if [ "$#" -lt 2 ]; then
        echo "error: -p requires a value" >&2
        exit 2
      fi
      DOCS_PORT="$2"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

has_loopback_listener() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fn 2>/dev/null \
      | grep -Eq "^n(127[.]0[.]0[.]1|localhost|\\[::1\\]):$port$"
    return $?
  fi

  return 1
}

if has_loopback_listener "$DOCS_PORT"; then
  cat >&2 <<EOF
error: localhost:$DOCS_PORT is shadowed by a loopback-only listener.

The docs server binds 0.0.0.0:$DOCS_PORT, but a service bound specifically to
127.0.0.1:$DOCS_PORT or [::1]:$DOCS_PORT wins requests to localhost. This can make
http://localhost:$DOCS_PORT/aethon/ show the token-gated Understand Anything dev
dashboard instead of the Aethon docs.

Stop the stale process or choose another docs port:
  lsof -nP -iTCP:$DOCS_PORT -sTCP:LISTEN
  AETHON_DOCS_PORT=5174 docs

The Aethon understand-dashboard helper defaults to 5273 to avoid this collision.
EOF
  exit 1
fi

if [ "${AETHON_DOCS_PRECHECK_ONLY:-0}" = "1" ]; then
  exit 0
fi

cd "$PROJECT_ROOT/website"
[ -d node_modules ] || bun install --frozen-lockfile
exec bun run dev --host 0.0.0.0 --port "$DOCS_PORT" --strictPort "${ARGS[@]}"
