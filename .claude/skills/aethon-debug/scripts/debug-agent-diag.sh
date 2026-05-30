#!/usr/bin/env bash
# Dump the agent-worker diagnostics table (#159): one row per live
# aethon-agent worker — key (__global__ / tab:<id>), tab id, cwd,
# pid, alive, ms since spawn, ms since last activity, prompt-in-flight,
# and a friendly session label. Read-only.
#
# Use it to map a hot PID (from `top` / Activity Monitor) back to a tab
# and see whether it's mid-prompt or idle.
#
# Usage:
#   debug-agent-diag.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/debug-invoke.sh" agent_diagnostics
