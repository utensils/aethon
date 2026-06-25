#!/usr/bin/env bash
# Tail / grep the on-disk logs Aethon writes to ~/.aethon/logs/.
#
# Two file series live in that dir:
#   aethon.YYYY-MM-DD       — Rust shell (tracing crate)
#   bridge.YYYY-MM-DD.log   — bun bridge (agent/logger.ts)
#
# By default this prints the most recent ~50 lines from today's files
# (both Rust and bridge). Pass `--follow` for `tail -F`-style live
# streaming, `--grep <pattern>` to filter, or `--source rust|bridge`
# to pick one series. Pass nothing to take the default snapshot.
#
# Usage:
#   debug-logs.sh                          # tail last 50 lines, today
#   debug-logs.sh --follow                 # follow (Ctrl+C to stop)
#   debug-logs.sh --grep ext-loader        # only ext-loader scope
#   debug-logs.sh --source bridge --grep loaded
#   debug-logs.sh --lines 200              # last 200 lines
#   debug-logs.sh --since 2026-05-02       # everything from a given day
#
# Files older than 7 days are pruned at app startup; this script does
# not modify the log directory.

set -euo pipefail

LOG_DIR="${AETHON_LOG_DIR:-${HOME}/.aethon/logs}"
LINES=50
FOLLOW=0
GREP=""
SOURCE="all"   # all | rust | bridge
SINCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --follow|-f)   FOLLOW=1; shift ;;
    --lines|-n)    LINES="$2"; shift 2 ;;
    --grep|-g)     GREP="$2"; shift 2 ;;
    --source|-s)   SOURCE="$2"; shift 2 ;;
    --since)       SINCE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,21p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *) echo "[debug-logs] unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$LOG_DIR" ]]; then
  echo "[debug-logs] no log dir at $LOG_DIR (yet?). The dev app creates it on first run." >&2
  exit 1
fi

today="$(date +%Y-%m-%d)"
target_day="${SINCE:-$today}"

# Build the file glob. tracing-appender omits a trailing .log; the
# bridge uses .log — handle both.
files=()
if [[ "$SOURCE" == "all" || "$SOURCE" == "rust" ]]; then
  for f in "$LOG_DIR/aethon.$target_day"*; do
    [[ -f "$f" ]] && files+=("$f")
  done
fi
if [[ "$SOURCE" == "all" || "$SOURCE" == "bridge" ]]; then
  for f in "$LOG_DIR/bridge.$target_day"*.log; do
    [[ -f "$f" ]] && files+=("$f")
  done
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "[debug-logs] no logs matching source='$SOURCE' day='$target_day' in $LOG_DIR" >&2
  exit 0
fi

if [[ $FOLLOW -eq 1 ]]; then
  if [[ -n "$GREP" ]]; then
    tail -F "${files[@]}" 2>/dev/null | grep --line-buffered -E "$GREP"
  else
    tail -F "${files[@]}" 2>/dev/null
  fi
else
  # Snapshot mode: print the last N lines from each file, optionally filtered.
  if [[ -n "$GREP" ]]; then
    tail -n "$LINES" "${files[@]}" 2>/dev/null | grep -E "$GREP"
  else
    tail -n "$LINES" "${files[@]}" 2>/dev/null
  fi
fi
