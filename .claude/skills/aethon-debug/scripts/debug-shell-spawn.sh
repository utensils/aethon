#!/usr/bin/env bash
# Open a shell tab as if the user clicked "+ new shell". Prints the
# tabId on success. Mirrors `useTabs.newShellTab` — including the
# devshell wrap that fires inside `shell_open` — so this is a
# faithful UAT for the real user gesture, not a Rust-only shortcut.
#
# Usage:
#   debug-shell-spawn.sh                    # cwd = active project
#   debug-shell-spawn.sh /path/to/project   # explicit cwd
#   debug-shell-spawn.sh /path my-tab-id    # explicit tabId
#
# Default share mode is "private" to match the user's first-click
# behaviour. Pair with debug-shell-write / debug-shell-read which
# use the cfg(debug_assertions) bypass commands so UAT does not have
# to force a non-private mode that would skew read/write tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CWD="${1:-}"
TAB_ID="${2:-uat-shell-$(date +%s)-$RANDOM}"

EVAL=$(cat <<EOF
const inv = window.__TAURI_INTERNALS__.invoke;
let cwd = ${CWD:+\"${CWD}\"};
if (!cwd) {
  const state = window.__AETHON_STATE__() || {};
  cwd = (state.projects && state.projects.projects || [])
    .find(p => p.id === state.activeProjectId)?.path
    || state.projectRoot
    || state.aethonRoot;
}
if (!cwd) return "ERROR: no cwd resolvable";
return inv("shell_open", {
  args: {
    tabId: "${TAB_ID}",
    cwd,
    cols: 100,
    rows: 30,
    inheritEnv: true,
  },
}).then(() => "${TAB_ID}", e => "ERROR: " + (e && e.message ? e.message : String(e)));
EOF
)

exec "${SCRIPT_DIR}/debug-eval.sh" "${EVAL}"
