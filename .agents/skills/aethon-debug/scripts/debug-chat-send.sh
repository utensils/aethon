#!/usr/bin/env bash
# Send a chat message to an agent tab the same way pressing Enter in
# the composer would. Returns once the agent has acknowledged receipt
# (NOT once the response finishes — for that, poll `debug-chat-wait`).
#
# Usage:
#   debug-chat-send.sh <tabId> "what is 2 + 2?"
#   echo "long multi-line message" | debug-chat-send.sh <tabId>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: debug-chat-send.sh <tabId> [<message>]" >&2
  exit 64
fi

TAB_ID="$1"
shift
if [[ $# -gt 0 ]]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

PAYLOAD_JSON=$(python3 -c "
import json, sys
print(json.dumps({
  'message': sys.argv[1],
  'tabId': sys.argv[2],
}))
" "${MSG}" "${TAB_ID}")

exec "${SCRIPT_DIR}/debug-eval.sh" "
return await (async () => {
  const payload = ${PAYLOAD_JSON};
  const state = typeof window.__AETHON_STATE__ === 'function'
    ? window.__AETHON_STATE__()
    : {};
  if (payload.tabId && state.activeTabId && payload.tabId !== state.activeTabId) {
    throw new Error(\`debug-chat-send can only use the active composer; active=\${state.activeTabId} requested=\${payload.tabId}\`);
  }
  const field = document.querySelector('textarea.a2ui-chat-input-field');
  const send = [...document.querySelectorAll('button')].find((button) =>
    button.getAttribute('aria-label') === 'Send' ||
    button.classList.contains('a2ui-chat-input-send')
  );
  if (!field || !send) {
    throw new Error('composer not found');
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(field, payload.message);
  field.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: payload.message,
  }));
  send.click();
  return JSON.stringify({ sent: true, activeTabId: state.activeTabId ?? null });
})();
"
