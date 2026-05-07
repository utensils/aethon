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
#   AETHON_SKIP_BUN_INSTALL    when set to 1, skip the frontend dependency check
#
# Env vars set for the child:
#   VITE_PORT                  the chosen Vite port (vite.config.ts honors this)
#   AETHON_DEBUG_PORT          the chosen debug port (src-tauri/src/debug.rs honors this)
#   TAURI_CONFIG               JSON patch overriding devUrl so Tauri loads the right port

set -euo pipefail

VITE_BASE="${AETHON_VITE_PORT_BASE:-1420}"
DEBUG_BASE="${AETHON_DEBUG_PORT_BASE:-19433}"
DEV_INFO="${HOME}/.aethon/dev-info.json"

ensure_frontend_deps() {
  if [[ "${AETHON_SKIP_BUN_INSTALL:-0}" == "1" ]]; then
    return
  fi
  if [[ -x "node_modules/.bin/vite" ]]; then
    return
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "[dev] local Vite is missing and bun is not on PATH; run bun install" >&2
    return 1
  fi
  echo "[dev] local Vite is missing; running bun install" >&2
  if [[ -f bun.lock || -f bun.lockb ]]; then
    if ! bun install --frozen-lockfile; then
      echo "[dev] frozen bun install failed; retrying without --frozen-lockfile" >&2
      bun install
    fi
  else
    bun install
  fi
  if [[ ! -x "node_modules/.bin/vite" ]]; then
    echo "[dev] bun install completed but node_modules/.bin/vite is still missing" >&2
    return 1
  fi
}

# Test whether ANY process is listening on TCP $1 on any interface or
# address family. We use lsof here (available on macOS and the Nix
# devshell on Linux) instead of `nc -z 127.0.0.1` because `nc -z` only
# tests IPv4 — when Vite from a stale run is bound on `::1:<port>`
# (modern macOS resolves "localhost" to IPv6 first), the IPv4 probe
# returns "free" and the script handed Vite a port that fails to bind.
#
# `-t` prints just PIDs (so we test by emptiness), `-nP` skips DNS /
# protocol lookups for speed, `-iTCP:$port -sTCP:LISTEN` filters to
# TCP listeners on the given port across all interfaces and families.
is_port_busy() {
  [[ -n "$(lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null)" ]]
}

# Bound search to keep a runaway loop (every port busy somehow) from
# spinning forever — give up after 200 ports above the base. In practice
# the user has at most a handful of stale dev servers; a hard ceiling is
# safer than an infinite loop.
find_free_port() {
  local base="$1"
  local p="$base"
  local stop=$((base + 200))
  while [[ "$p" -lt "$stop" ]] && is_port_busy "$p"; do
    p=$((p + 1))
  done
  if [[ "$p" -ge "$stop" ]]; then
    echo "[dev] could not find a free port near $base (checked through $((stop - 1)))" >&2
    return 1
  fi
  echo "$p"
}

ensure_frontend_deps

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
