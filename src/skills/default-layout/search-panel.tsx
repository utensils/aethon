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

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";

interface SearchHit {
  tabId: string;
  role: string;
  /** Three-way snippet split — `<before><match><after>`. Rust-side
   *  build_snippet_parts produces these so the frontend can wrap the
   *  middle in `<mark>` without hand-rolling JS index gymnastics. */
  snippetBefore: string;
  snippetMatch: string;
  snippetAfter: string;
  timestamp?: number;
}

type ProjectScope = "current" | "all";

interface SearchState {
  open: boolean;
  query: string;
  /** Which project bucket to filter results to. Defaults to "all" so a
   *  cold-start search isn't surprisingly empty for users who don't yet
   *  have an active project. The toggle persists for the session. */
  scope: ProjectScope;
}

function readSearchState(state: Record<string, unknown>): SearchState {
  const s = (state.search as Partial<SearchState> | undefined) ?? {};
  return {
    open: !!s.open,
    query: typeof s.query === "string" ? s.query : "",
    scope: s.scope === "current" ? "current" : "all",
  };
}

interface TabRecord {
  id: string;
  label?: string;
  projectId?: string | null;
  kind?: string;
}

interface ProjectRecord {
  id: string;
  label: string;
  path?: string;
}

interface DiscoveredRecord {
  tabId: string;
  cwd?: string;
}

/** Look up a (projectLabel, projectId) for a result hit by:
 *  1. Checking the live `/tabs` list (preferred — active tab knows its project)
 *  2. Falling back to discovered-session cwd → matching project path
 *  3. Returning `null` for closed-tab results we can't attribute */
function resolveHitProject(
  hit: SearchHit,
  tabs: TabRecord[],
  discovered: DiscoveredRecord[],
  projects: ProjectRecord[],
): ProjectRecord | null {
  const tab = tabs.find((t) => t.id === hit.tabId);
  if (tab?.projectId) {
    const p = projects.find((q) => q.id === tab.projectId);
    if (p) return p;
  }
  const disc = discovered.find((d) => d.tabId === hit.tabId);
  if (disc?.cwd) {
    const p = projects.find((q) => q.path === disc.cwd);
    if (p) return p;
  }
  return null;
}

const DEBOUNCE_MS = 180;
const RESULT_LIMIT = 200;

export function SearchPanel({ state, onEvent }: BuiltinComponentProps) {
  const search = readSearchState(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  // Cross-reference the live state for project attribution + scope
  // filtering. All read-only — we never write back here. Wrap each
  // pull in its own useMemo so the result identity is stable across
  // renders (otherwise the `?? []` fallback creates a fresh array
  // every render and the `annotated` memo never hits its cache).
  const tabs = useMemo<TabRecord[]>(
    () => (state.tabs as TabRecord[] | undefined) ?? [],
    [state.tabs],
  );
  const discovered = useMemo<DiscoveredRecord[]>(
    () =>
      (state.discoveredSessions as DiscoveredRecord[] | undefined) ?? [],
    [state.discoveredSessions],
  );
  const projects = useMemo<ProjectRecord[]>(
    () =>
      (state.projects as { projects?: ProjectRecord[] } | undefined)
        ?.projects ?? [],
    [state.projects],
  );
  const activeProjectId =
    (state.projects as { activeId?: string | null } | undefined)?.activeId ??
    null;

  // Annotated results = each hit + resolved project. Filtering happens
  // here so the rendered list re-runs when the user flips scope without
  // re-firing the (potentially expensive) session scan.
  const annotated = useMemo(() => {
    return results.map((hit) => ({
      hit,
      project: resolveHitProject(hit, tabs, discovered, projects),
    }));
  }, [results, tabs, discovered, projects]);

  const filtered = useMemo(() => {
    if (search.scope === "all") return annotated;
    if (!activeProjectId) return annotated;
    return annotated.filter((row) => row.project?.id === activeProjectId);
  }, [annotated, search.scope, activeProjectId]);

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
  // setState is always wrapped in a timeout (zero or debounced) so the
  // react-hooks/set-state-in-effect rule stays satisfied.
  //
  // Race guard: a slow scan from query "fo" could resolve *after* the
  // user typed "foo" and the next scan finished — overwriting the
  // newer results with stale ones. Use a monotonic request id (held in
  // a ref) so the resolved Promise can self-discard if it isn't the
  // latest in flight.
  const searchReqIdRef = useRef(0);
  useEffect(() => {
    const q = search.open ? search.query.trim() : "";
    if (q.length === 0) {
      // Bumping the request id invalidates any in-flight scan so its
      // late resolution can't repopulate `results` after the user
      // cleared the query.
      searchReqIdRef.current += 1;
      const handle = window.setTimeout(() => {
        setResults([]);
        setBusy(false);
      }, 0);
      return () => window.clearTimeout(handle);
    }
    const handle = window.setTimeout(async () => {
      const reqId = ++searchReqIdRef.current;
      setBusy(true);
      try {
        const hits = await invoke<SearchHit[]>("search_sessions", {
          query: q,
          limit: RESULT_LIMIT,
        });
        // Stale guard — a newer query has already started; drop these.
        if (reqId !== searchReqIdRef.current) return;
        setResults(Array.isArray(hits) ? hits : []);
      } catch (err) {
        if (reqId !== searchReqIdRef.current) return;
        console.warn("search_sessions failed:", err);
        setResults([]);
      } finally {
        if (reqId === searchReqIdRef.current) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [search.open, search.query]);

  if (!search.open) return null;

  const close = () => onEvent("close");
  const setQuery = (q: string) => onEvent("query", { value: q });
  const setScope = (scope: ProjectScope) => onEvent("scope", { scope });
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
        <div className="ae-search-scope" role="tablist" aria-label="Result scope">
          <button
            type="button"
            role="tab"
            aria-selected={search.scope === "all"}
            className={`ae-search-scope-tab${
              search.scope === "all" ? " ae-search-scope-active" : ""
            }`}
            onClick={() => setScope("all")}
          >
            All projects
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={search.scope === "current"}
            disabled={!activeProjectId}
            title={
              activeProjectId
                ? "Limit results to the active project"
                : "Open a project to scope search to it"
            }
            className={`ae-search-scope-tab${
              search.scope === "current" ? " ae-search-scope-active" : ""
            }`}
            onClick={() => setScope("current")}
          >
            Current project
          </button>
        </div>
        <div className="ae-search-results">
          {search.query.trim().length === 0 ? (
            <div className="ae-search-empty">
              Type to search messages across all your sessions.
            </div>
          ) : filtered.length === 0 && !busy ? (
            <div className="ae-search-empty">
              {results.length > 0 && search.scope === "current"
                ? `No matches in this project for "${search.query.trim()}".`
                : `No matches for "${search.query.trim()}".`}
            </div>
          ) : (
            filtered.map(({ hit, project }, i) => (
              <button
                key={`${hit.tabId}-${i}`}
                type="button"
                className="ae-search-row"
                onClick={() => select(hit)}
              >
                <div className="ae-search-row-meta">
                  <span className="ae-search-row-role">{hit.role}</span>
                  <span
                    className="ae-search-row-tab"
                    title={hit.tabId}
                  >
                    {project?.label ?? hit.tabId}
                  </span>
                  {hit.timestamp ? (
                    <span className="ae-search-row-time">
                      {new Date(hit.timestamp).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                <div className="ae-search-row-snippet">
                  {hit.snippetBefore}
                  <mark className="ae-search-row-mark">{hit.snippetMatch}</mark>
                  {hit.snippetAfter}
                </div>
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
