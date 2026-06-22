#!/usr/bin/env bash
#
# understand-dashboard.sh — launch the understand-anything knowledge-graph
# dashboard against this repo's .understand-anything/knowledge-graph.json.
#
# The graph is produced by the `/understand` skill (see .understand-anything/).
# This wrapper finds the installed understand-anything plugin, makes sure its
# dashboard package is built, and starts the Vite dev server with GRAPH_DIR
# pointed at the repo root. It runs in the FOREGROUND (like `dev` / `docs`);
# Ctrl+C to stop. Vite prints a tokenized URL — open the one with `?token=`.
#
# Plugin location is resolved in this order (first hit wins):
#   1. $UNDERSTAND_PLUGIN_ROOT            (explicit override)
#   2. $CLAUDE_PLUGIN_ROOT                (Claude Code runtime root)
#   3. ~/.understand-anything-plugin      (universal symlink)
#   4. newest ~/.claude/plugins/cache/understand-anything/understand-anything/*
#   5. self-relative via ~/.agents/skills/understand-dashboard
#   6. common clone install roots (.codex/.opencode/.pi/~)
#
# Usage: understand-dashboard [extra vite args...]
#        understand-dashboard --host 0.0.0.0      # reachable on the LAN
set -euo pipefail

# --- repo root (this script lives in <root>/scripts/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GRAPH="$PROJECT_ROOT/.understand-anything/knowledge-graph.json"
if [ ! -f "$GRAPH" ]; then
  echo "error: no knowledge graph at $GRAPH" >&2
  echo "       run the /understand skill first to analyze this project." >&2
  exit 1
fi

# --- locate the understand-anything plugin root (has packages/dashboard) ---
has_dashboard() { [ -n "${1:-}" ] && [ -d "$1/packages/dashboard" ]; }

newest_cache_root() {
  local base="$HOME/.claude/plugins/cache/understand-anything/understand-anything"
  [ -d "$base" ] || return 0
  # highest version dir (sort -V) that actually carries the dashboard
  local d
  while IFS= read -r d; do
    has_dashboard "$d" && { printf '%s\n' "$d"; return 0; }
  done < <(find "$base" -maxdepth 1 -mindepth 1 -type d | sort -Vr)
}

self_relative() {
  local real
  real="$(realpath ~/.agents/skills/understand-dashboard 2>/dev/null \
        || readlink -f ~/.agents/skills/understand-dashboard 2>/dev/null || true)"
  [ -n "$real" ] && (cd "$real/../.." 2>/dev/null && pwd) || true
}

PLUGIN_ROOT=""
for candidate in \
  "${UNDERSTAND_PLUGIN_ROOT:-}" \
  "${CLAUDE_PLUGIN_ROOT:-}" \
  "$HOME/.understand-anything-plugin" \
  "$(newest_cache_root)" \
  "$(self_relative)" \
  "$HOME/.codex/understand-anything/understand-anything-plugin" \
  "$HOME/.opencode/understand-anything/understand-anything-plugin" \
  "$HOME/.pi/understand-anything/understand-anything-plugin" \
  "$HOME/understand-anything/understand-anything-plugin"; do
  if has_dashboard "$candidate"; then PLUGIN_ROOT="$candidate"; break; fi
done

if [ -z "$PLUGIN_ROOT" ]; then
  echo "error: could not find the understand-anything plugin (packages/dashboard)." >&2
  echo "       set UNDERSTAND_PLUGIN_ROOT=/path/to/understand-anything-plugin and retry." >&2
  exit 1
fi

DASH="$PLUGIN_ROOT/packages/dashboard"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found on PATH (needed to run the dashboard)." >&2
  exit 1
fi

# --- ensure deps installed + core built (the dashboard imports @understand-anything/core) ---
if [ ! -d "$DASH/node_modules" ]; then
  echo "==> installing dashboard deps (pnpm install)"
  ( cd "$PLUGIN_ROOT" && { pnpm install --frozen-lockfile 2>/dev/null || pnpm install; } )
fi
if [ ! -f "$PLUGIN_ROOT/packages/core/dist/index.js" ]; then
  echo "==> building @understand-anything/core"
  ( cd "$PLUGIN_ROOT" && pnpm --filter @understand-anything/core build )
fi

echo "==> dashboard: $DASH"
echo "==> graph:     $GRAPH"
echo "==> launching Vite (look for the http://127.0.0.1:<port>?token=<token> line; Ctrl+C to stop)"

cd "$DASH"
# Run the dashboard's own vite binary directly. `pnpm exec`/`pnpm run` would
# first run an implicit deps-status check that calls `pnpm install`, which
# fails against the read-only plugin cache even though node_modules is present.
VITE_BIN="$DASH/node_modules/.bin/vite"
if [ -x "$VITE_BIN" ]; then
  exec env GRAPH_DIR="$PROJECT_ROOT" "$VITE_BIN" --host 127.0.0.1 "$@"
fi
exec env GRAPH_DIR="$PROJECT_ROOT" npx --no-install vite --host 127.0.0.1 "$@"
