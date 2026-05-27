#!/usr/bin/env bash
# Aethon dev launcher — finds free ports for Vite and the debug TCP server,
# writes them to ~/.aethon/dev-info.json so the aethon-debug skill can
# discover the running instance, then supervises `cargo tauri dev`.
#
# Why this exists:
#   - Tauri requires a fixed devUrl (Vite's `strictPort: true`) so a leaked
#     1420 from a prior run kills the next `dev`. Vite-style auto-increment
#     restores the "just works" UX, with both Vite and the bridge debug
#     port shifting in lockstep so multiple dev instances don't collide.
#   - The skill needs to know the actual debug port without the user
#     typing it. dev-info.json gives it a single discovery file.
#   - On macOS, Apple Speech and microphone permissions require a real
#     responsible .app process. This script passes a custom Tauri runner
#     that wraps the debug binary in a signed "Aethon Dev.app" and launches
#     it through Launch Services, matching Claudette's TCC-safe dev path.
#
# Flags:
#   --new       Spin up a fresh user — points AETHON_USER_DIR at a
#               per-PID tmp tree so the launch sees no existing state
#               and nothing it writes leaks back to the real user.
#               Removed on exit. Useful for first-run UX checks
#               (welcome card, onboarding, missing config), plugin /
#               theme loaders against an empty install, and any flow
#               that should exercise "what does a brand-new user see?"
#               Modeled on claudette/scripts/dev.sh --new.
#
#   --clean     Standalone NUKE action — wipes ${TMPDIR:-/tmp}/aethon-dev/
#               (the directory --new sandboxes live under) and exits
#               without launching. No PID checks — running --new
#               sandboxes get swept too. Use after a SIGKILL leaves a
#               stale sandbox behind.
#
# Env vars consumed:
#   AETHON_VITE_PORT_BASE      starting port for Vite (default 1420)
#   AETHON_DEBUG_PORT_BASE     starting port for the debug server (default 19433)
#   AETHON_SKIP_BUN_INSTALL    when set to 1, skip the frontend dependency check
#
# Env vars set for the child:
#   VITE_PORT                  the chosen Vite port (vite.config.ts honors this)
#   AETHON_DEBUG_PORT          the chosen debug port (src-tauri/src/debug.rs honors this)
#   AETHON_USER_DIR            (--new only) per-PID tmp ~/.aethon override
#   AETHON_PROJECT_ROOT        repo root forwarded through the macOS .app runner
#   TAURI_CONFIG               JSON patch overriding devUrl so Tauri loads the right port

set -euo pipefail

VITE_BASE="${AETHON_VITE_PORT_BASE:-1420}"
DEBUG_BASE="${AETHON_DEBUG_PORT_BASE:-19433}"
SANDBOX_ROOT_DIR="${TMPDIR:-/tmp}/aethon-dev"

# Parse our own flags before forwarding the rest to `cargo tauri dev`.
# Stashed in arrays so we keep ordering for the eventual launch.
new_session=0
clean_action=0
passthrough_args=()
while (( $# )); do
  case "$1" in
    --new)
      new_session=1
      ;;
    --clean)
      clean_action=1
      ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    --)
      shift
      passthrough_args+=("$@")
      break
      ;;
    *)
      passthrough_args+=("$1")
      ;;
  esac
  shift
done
set -- "${passthrough_args[@]+"${passthrough_args[@]}"}"

# --clean: top-level nuke. Mirrors claudette's behavior — no PID checks,
# so any --new run still in flight loses its sandbox. The user asked
# for nuke; that's nuke. Runs before cwd is settled so `dev --clean`
# works from anywhere.
if (( clean_action )); then
  if [[ ! -d "$SANDBOX_ROOT_DIR" ]]; then
    echo "[dev.sh] no aethon-dev state at $SANDBOX_ROOT_DIR — nothing to clean"
    exit 0
  fi
  echo "▸ Nuking $SANDBOX_ROOT_DIR"
  removed=0
  for entry in "$SANDBOX_ROOT_DIR"/* "$SANDBOX_ROOT_DIR"/.[!.]* "$SANDBOX_ROOT_DIR"/..?*; do
    [[ -e "$entry" ]] || continue
    echo "  removed: $(basename "$entry")"
    rm -rf "$entry"
    removed=$((removed + 1))
  done
  rmdir "$SANDBOX_ROOT_DIR" 2>/dev/null || true
  echo "[dev.sh] nuked $removed entries under $SANDBOX_ROOT_DIR"
  exit 0
fi

# Per-PID sandbox + the discovery file inside it. When --new is off
# we stay on the real ~/.aethon and write the discovery file there.
sandbox_dir=""
if (( new_session )); then
  mkdir -p "$SANDBOX_ROOT_DIR"
  sandbox_dir="$SANDBOX_ROOT_DIR/new-$$"
  mkdir -p "$sandbox_dir"
  export AETHON_USER_DIR="$sandbox_dir"
  DEV_INFO="$sandbox_dir/dev-info.json"
  echo "▸ Fresh-user session: $sandbox_dir"
  echo "▸ AETHON_USER_DIR=$AETHON_USER_DIR"
else
  DEV_INFO="${HOME}/.aethon/dev-info.json"
fi

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

# Pre-exec cleanup: only triggers if we exit before exec'ing cargo (e.g.
# port allocation fails, --help, etc.). The post-exec cleanup path is
# the watchdog below.
cleanup() {
  rm -f "$DEV_INFO"
  if [[ -n "$sandbox_dir" && -d "$sandbox_dir" ]]; then
    rm -rf "$sandbox_dir"
  fi
}
trap cleanup EXIT

export VITE_PORT
export AETHON_DEBUG_PORT="$DEBUG_PORT"
export AETHON_PROJECT_ROOT="$(pwd)"
# Tauri reads TAURI_CONFIG as a JSON patch merged over tauri.conf.json,
# so we override devUrl to point at the actually-bound Vite port. Stays
# in sync with --port semantics from older Tauri without the dependency.
export TAURI_CONFIG="{\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\"}}"

if [[ "$VITE_PORT" != "$VITE_BASE" || "$DEBUG_PORT" != "$DEBUG_BASE" ]]; then
  echo "[dev] vite=${VITE_PORT} (was ${VITE_BASE}) debug=${DEBUG_PORT} (was ${DEBUG_BASE})" >&2
fi

# Watchdog: a tiny background process that outlives our `exec` and
# performs the full session cleanup once cargo has exited.
#
# Why a watchdog instead of bash signal traps:
#   `cargo tauri dev` (via the cargo it spawns, or Vite, or the aethon
#   binary's pty handling) takes over the terminal's foreground process
#   group via tcsetpgrp(). After that, Ctrl+C delivers SIGINT to *cargo's*
#   PG, not to this script's PG, so any `trap INT` we install here is
#   never invoked. The previous PG-and-pattern teardown was correct in
#   spirit but the handler that called it was never reached.
#
# How this watchdog finds survivors:
#   AETHON_DEBUG_PORT is exported below and is unique to this dev
#   session (find_free_port auto-increments per concurrent run). Every
#   process in the session inherits it in its environment, so a single
#   `ps -axwwE | grep AETHON_DEBUG_PORT=<port>` sweep catches cargo's
#   child cargo, the aethon binary, vite, the bun agent, and anything
#   else they spawned — even orphans whose PPID is now launchd.
parent_pid=$$
debug_port="$DEBUG_PORT"
dev_info_path="$DEV_INFO"
sandbox_dir_path="$sandbox_dir"

(
  # Detach the watchdog from stdio + the terminal: it must survive even
  # after the user's shell prompt returns, and we don't want it to take
  # SIGINT itself.
  exec </dev/null >/dev/null 2>&1
  trap '' INT TERM HUP

  while kill -0 "$parent_pid" 2>/dev/null; do
    sleep 0.2
  done

  # Survivor sweep, scoped to processes with our exact debug-port env var
  # so a second concurrent `dev` instance (on a different port) is
  # untouched. Excludes our own watchdog PID for paranoia.
  watchdog_pid=$$
  sweep_pids() {
    ps -axwwE 2>/dev/null \
      | awk -v needle="AETHON_DEBUG_PORT=$debug_port" -v me="$watchdog_pid" \
          'index($0, needle) && $1 != me { print $1 }'
  }
  sweep_round() {
    local sig="$1" pid
    while read -r pid; do
      [[ -n "$pid" ]] || continue
      kill "-$sig" "$pid" 2>/dev/null || true
    done < <(sweep_pids)
  }

  sweep_round INT
  sleep 0.2
  sweep_round TERM
  sleep 0.2
  sweep_round KILL

  rm -f "$dev_info_path"
  if [[ -n "$sandbox_dir_path" && -d "$sandbox_dir_path" ]]; then
    rm -rf "$sandbox_dir_path"
  fi
) &
disown

runner_args=()
if [[ "$(uname -s)" == "Darwin" ]]; then
  runner_args=(--runner "$(pwd)/scripts/macos-dev-app-runner.sh")
fi

# Hand the terminal to cargo. After exec, this script's PID *is* cargo —
# the watchdog watches that PID, and Ctrl+C goes straight to cargo with
# zero bash signal-routing in the middle.
exec cargo tauri dev "${runner_args[@]}" "$@"
