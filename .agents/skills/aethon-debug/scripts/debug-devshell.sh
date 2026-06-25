#!/usr/bin/env bash
# Inspect / manipulate the Nix devshell cache from the skill.
#
# Usage:
#   debug-devshell.sh status [<root>]      # query cache state
#   debug-devshell.sh env [<root>]         # full env map + kind
#   debug-devshell.sh refresh [<root>]     # invalidate + re-resolve
#
# Without <root> we use the active project's cwd (state.projects).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUB="${1:-status}"
shift || true
ROOT="${1:-}"

resolve_root() {
  if [[ -n "${ROOT}" ]]; then
    echo "${ROOT}"
    return
  fi
  "${SCRIPT_DIR}/debug-eval.sh" '
    const s = window.__AETHON_STATE__() || {};
    const proj = (s.projects && s.projects.projects || [])
      .find(p => p.id === s.activeProjectId);
    return proj?.path || s.projectRoot || s.aethonRoot || "";
  '
}

case "${SUB}" in
  status)
    R="$(resolve_root)"
    [[ -z "${R}" ]] && { echo "ERROR: no project root resolvable" >&2; exit 1; }
    ARGS=$(python3 -c "import json,sys; print(json.dumps({'args':{'root': sys.argv[1]}}))" "${R}")
    exec "${SCRIPT_DIR}/debug-invoke.sh" devshell_status "${ARGS}"
    ;;
  env)
    R="$(resolve_root)"
    [[ -z "${R}" ]] && { echo "ERROR: no project root resolvable" >&2; exit 1; }
    ARGS=$(python3 -c "import json,sys; print(json.dumps({'args':{'cwd': sys.argv[1]}}))" "${R}")
    exec "${SCRIPT_DIR}/debug-invoke.sh" devshell_env_for_path "${ARGS}"
    ;;
  refresh)
    R="$(resolve_root)"
    [[ -z "${R}" ]] && { echo "ERROR: no project root resolvable" >&2; exit 1; }
    ARGS=$(python3 -c "import json,sys; print(json.dumps({'args':{'root': sys.argv[1]}}))" "${R}")
    exec "${SCRIPT_DIR}/debug-invoke.sh" devshell_refresh "${ARGS}"
    ;;
  *)
    echo "Unknown subcommand: ${SUB}" >&2
    echo "Usage: debug-devshell.sh {status|env|refresh} [<root>]" >&2
    exit 64
    ;;
esac
