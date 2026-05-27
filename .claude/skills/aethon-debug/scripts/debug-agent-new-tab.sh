#!/usr/bin/env bash
# Create an agent tab pinned to a specific cwd. This mirrors what
# clicking "+ New Tab" in the Aethon header does once the user has
# picked a project, but without needing the React tab-strip UI to be
# in a particular state.
#
# Returns the new tabId on success.
#
# Usage:
#   debug-agent-new-tab.sh                       # cwd = active project or aethon root
#   debug-agent-new-tab.sh /path/to/project      # explicit cwd
#   debug-agent-new-tab.sh /path                 my-tab-id
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CWD="${1:-}"
TAB_ID="${2:-uat-agent-$(date +%s)-$RANDOM}"

EVAL=$(cat <<EOF
const inv = window.__TAURI_INTERNALS__.invoke;
let cwd = ${CWD:+\"${CWD}\"};
if (!cwd) {
  const s = window.__AETHON_STATE__() || {};
  cwd = (s.projects?.projects || [])
    .find(p => p.id === s.activeProjectId)?.path
    || s.projectRoot
    || s.aethonRoot;
}
if (!cwd) return "ERROR: no cwd resolvable";
// Drive both sides:
//   1. Push a tab entry into the central store so the chat surface
//      has something to render against.
//   2. Send a tab_open message to the agent so its pi session spawns
//      with the right cwd (and the customTools-shadowed bash tool
//      gets bound to that cwd, threading the devshell env through
//      pi's BashSpawnHook).
const tab = { id: "${TAB_ID}", kind: "agent", cwd, label: "UAT", messages: [], draft: "", waiting: false, queuedMessages: [], queueCount: 0, canvas: null };
window.__AETHON_SET_STATE__({
  ...window.__AETHON_STATE__(),
  tabs: { ...(window.__AETHON_STATE__().tabs ?? {}), "${TAB_ID}": tab },
  activeTabId: "${TAB_ID}",
  hasTabs: true,
});
await inv("agent_command", { payload: JSON.stringify({ type: "tab_open", tabId: "${TAB_ID}", cwd }) });
return "${TAB_ID}";
EOF
)

exec "${SCRIPT_DIR}/debug-eval.sh" "${EVAL}"
