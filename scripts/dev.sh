#!/usr/bin/env bash
# Aethon dev launcher — finds free ports for Vite and the debug TCP server,
# writes them to ~/.aethon/dev-info.json so the aethon-debug skill can
# discover the running instance, then execs `cargo tauri dev`.
#
# Why this exists:
#   - Tauri requires a fixed devUrl (Vite's `strictPort: true`) so a leaked
#     1420 from a prior run kills the next `dev`. Vite-style auto-increment
#     restores the "just works" UX, with both Vite and the bridge debug
#     port shifting in lockstep so multiple dev instances don't collide.
#   - The skill needs to know the actual debug port without the user
#     typing it. dev-info.json gives it a single discovery file.
#
# Env vars consumed:
#   AETHON_VITE_PORT_BASE      starting port for Vite (default 1420)
#   AETHON_DEBUG_PORT_BASE     starting port for the debug server (default 19433)
#
# Env vars set for the child:
#   VITE_PORT                  the chosen Vite port (vite.config.ts honors this)
#   AETHON_DEBUG_PORT          the chosen debug port (src-tauri/src/debug.rs honors this)
#   TAURI_CONFIG               JSON patch overriding devUrl so Tauri loads the right port

set -euo pipefail

VITE_BASE="${AETHON_VITE_PORT_BASE:-1420}"
DEBUG_BASE="${AETHON_DEBUG_PORT_BASE:-19433}"
DEV_INFO="${HOME}/.aethon/dev-info.json"

# Test if a TCP port on 127.0.0.1 is currently bound. nc is in macOS base
# image and the Nix devshell. /dev/tcp would also work but it's bash-only
# and prints noise on connection refused. Returns 0 (success / "port is
# busy") when nc connects.
is_port_busy() {
  nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}

find_free_port() {
  local p="$1"
  while is_port_busy "$p"; do
    p=$((p + 1))
  done
  echo "$p"
}

VITE_PORT="$(find_free_port "$VITE_BASE")"
DEBUG_PORT="$(find_free_port "$DEBUG_BASE")"

mkdir -p "$(dirname "$DEV_INFO")"
# Atomic write — temp file then mv, so the skill never reads a half-written
# JSON. The file lives only as long as this dev session; the EXIT trap
# below removes it so a stale file from a crashed run can't mislead the
# skill on the next launch.
TMP="$(mktemp)"
cat >"$TMP" <<EOF
{
  "vitePort": ${VITE_PORT},
  "debugPort": ${DEBUG_PORT},
  "pid": $$,
  "startedAt": $(date +%s)
}
EOF
mv "$TMP" "$DEV_INFO"
trap 'rm -f "$DEV_INFO"' EXIT INT TERM

export VITE_PORT
export AETHON_DEBUG_PORT="$DEBUG_PORT"
# Tauri reads TAURI_CONFIG as a JSON patch merged over tauri.conf.json,
# so we override devUrl to point at the actually-bound Vite port. Stays
# in sync with --port semantics from older Tauri without the dependency.
export TAURI_CONFIG="{\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\"}}"

if [[ "$VITE_PORT" != "$VITE_BASE" || "$DEBUG_PORT" != "$DEBUG_BASE" ]]; then
  echo "[dev] vite=${VITE_PORT} (was ${VITE_BASE}) debug=${DEBUG_PORT} (was ${DEBUG_BASE})" >&2
fi

exec cargo tauri dev "$@"
