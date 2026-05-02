// Cross-session search overlay (M6 P6). Cmd+Shift+F opens. Searches
// across every persisted pi session JSONL under
// `~/.aethon/sessions/<tabId>/` via the Tauri `search_sessions`
// command. Click a result → restore that tab.
//
// State contract (`/search` slice):
//   { open: boolean, query: string, results: SearchHit[], busy: boolean }
//
// Results carry just enough to restore a tab — `tabId` is the cue
// for the bridge's SessionManager.continueRecent. The current
// implementation re-runs the search on each query change with a
// short debounce; v1 ships scan-only, no token index.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

interface SearchHit {
  tabId: string;
  role: string;
  snippet: string;
  timestamp?: number;
}

interface SearchState {
  open: boolean;
  query: string;
}

function readSearchState(state: Record<string, unknown>): SearchState {
  const s = (state.search as Partial<SearchState> | undefined) ?? {};
  return {
    open: !!s.open,
    query: typeof s.query === "string" ? s.query : "",
  };
}

const DEBOUNCE_MS = 180;
const RESULT_LIMIT = 200;

export function SearchPanel({ state, onEvent }: BuiltinComponentProps) {
  const search = readSearchState(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  // Auto-focus the input when opened. Same pattern as CommandPalette.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (search.open && !wasOpenRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    wasOpenRef.current = search.open;
  }, [search.open]);

  // Debounced search. Each keystroke schedules a new search; the
  // previous timer is cleared so we only fire after the user pauses.
  // Empty query → empty results (avoid an expensive scan with no hit
  // criterion).
  useEffect(() => {
    if (!search.open) {
      setResults([]);
      return;
    }
    const q = search.query.trim();
    if (q.length === 0) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      setBusy(true);
      try {
        const hits = await invoke<SearchHit[]>("search_sessions", {
          query: q,
          limit: RESULT_LIMIT,
        });
        setResults(Array.isArray(hits) ? hits : []);
      } catch (err) {
        console.warn("search_sessions failed:", err);
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [search.open, search.query]);

  if (!search.open) return null;

  const close = () => onEvent("close");
  const setQuery = (q: string) => onEvent("query", { value: q });
  const select = (hit: SearchHit) => onEvent("select", { hit });

  return (
    <div
      className="ae-search-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="ae-search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search sessions"
      >
        <div className="ae-search-header">
          <span className="ae-search-icon" aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            className="ae-search-input"
            placeholder="Search across sessions…"
            value={search.query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {busy && <span className="ae-search-busy">searching…</span>}
        </div>
        <div className="ae-search-results">
          {search.query.trim().length === 0 ? (
            <div className="ae-search-empty">
              Type to search messages across all your sessions.
            </div>
          ) : results.length === 0 && !busy ? (
            <div className="ae-search-empty">
              No matches for "{search.query.trim()}".
            </div>
          ) : (
            results.map((hit, i) => (
              <button
                key={`${hit.tabId}-${i}`}
                type="button"
                className="ae-search-row"
                onClick={() => select(hit)}
              >
                <div className="ae-search-row-meta">
                  <span className="ae-search-row-role">{hit.role}</span>
                  <span className="ae-search-row-tab">{hit.tabId}</span>
                  {hit.timestamp ? (
                    <span className="ae-search-row-time">
                      {new Date(hit.timestamp).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                <div className="ae-search-row-snippet">{hit.snippet}</div>
              </button>
            ))
          )}
        </div>
        <div className="ae-search-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
