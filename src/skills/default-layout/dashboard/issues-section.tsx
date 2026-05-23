/**
 * issues-section — surfaces the active project's open GitHub issues on
 * the per-project dashboard. Two affordances per row, per the user's
 * spec:
 *
 *   - left-click  → open the issue's URL in the OS browser
 *   - right-click → context menu with "Send to agent" (also
 *                   keyboard-equivalent via the dedicated send button
 *                   on the row hover state).
 *
 * The "send to agent" path fetches the full issue body and emits
 * `start-task` with a markdown-formatted prompt that includes title,
 * url, author, and body. The same chip selection (project / worktree /
 * branch) from the launcher applies — `worktreeId` is sourced from
 * `/activeWorktreeId` so the agent lands in whichever worktree the
 * user has activated.
 *
 * Registered as the dashboard component type `issues-section` so
 * extensions can swap it with `aethon.registerComponent`. All data
 * comes from refs / cache reads — the layout passes only the project
 * info; nothing in this component is hardcoded to the default project.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import {
  type GhIssue,
  getIssueDetail,
  getIssues,
  refreshIssues,
} from "../../../ghIssuesCache";
import { formatRelativeTime } from "../../../utils/time";

interface ProjectInfo {
  id: string;
  label: string;
  path: string;
}

interface IssueSectionProps {
  project?: unknown;
  /** Optional ref into state for the active worktree id, so "send to
   *  agent" honors the current worktree selection. Default
   *  `/activeWorktreeId`. */
  activeWorktreeIdRef?: unknown;
  /** Issue list cap. Bumped from default for users with sprawling
   *  backlogs; clamped server-side anyway. */
  limit?: number;
}

function isRef(v: unknown): v is { $ref: string } {
  return typeof v === "object" && v !== null && "$ref" in v;
}

function resolveOrInline<T>(
  v: unknown,
  state: Record<string, unknown>,
): T | null {
  if (!v) return null;
  if (isRef(v)) {
    const r = resolvePointer(state, v.$ref);
    return (r ?? null) as T | null;
  }
  return v as T;
}

interface ContextMenuState {
  issue: GhIssue;
  x: number;
  y: number;
}

/** Build the prompt body sent to the agent when the user picks "Send
 *  to agent" — keeps GH formatting so the model can reason about
 *  checklists, links, mentions. */
function buildIssuePrompt(detail: {
  number: number;
  title: string;
  url: string;
  body: string;
  author: string | null;
}): string {
  const author = detail.author ? `@${detail.author}` : "the reporter";
  const trimmedBody = detail.body.trim();
  const bodyBlock =
    trimmedBody.length === 0
      ? "_(no body provided)_"
      : trimmedBody;
  return [
    `Please work on GitHub issue #${detail.number}: **${detail.title}**.`,
    "",
    `Source: ${detail.url}`,
    `Reported by ${author}.`,
    "",
    "---",
    "",
    bodyBlock,
  ].join("\n");
}

export function IssuesSection({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = (component.props ?? {}) as IssueSectionProps;
  const project = useMemo(
    () => resolveOrInline<ProjectInfo>(props.project, state),
    [props.project, state],
  );
  const activeWorktreeId = useMemo(() => {
    const refSpec = props.activeWorktreeIdRef ?? { $ref: "/activeWorktreeId" };
    return resolveOrInline<string>(refSpec, state);
  }, [props.activeWorktreeIdRef, state]);
  const limit = typeof props.limit === "number" ? props.limit : 30;

  const [issues, setIssues] = useState<GhIssue[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  // Lazy fetch: defer until the section scrolls into view. Avoids
  // burning a gh call on every dashboard activation if the user
  // never looks at issues.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // Test environment / older browser — fall through to eager load.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot fallback when IntersectionObserver isn't available
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    if (!project) return;
    if (loadedFor === project.path) return;
    let cancelled = false;
    void (async () => {
      const fetched = await getIssues(project.path, limit);
      if (cancelled) return;
      setIssues(fetched);
      setLoadedFor(project.path);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, project, limit, loadedFor]);

  // Close the menu on outside-click / Esc / scroll. Capture phase so a
  // click on a sibling card row doesn't leak into the row's click
  // handler before the menu closes.
  useEffect(() => {
    if (!menu) return;
    const closeOnEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
      }
    };
    const closeOnAnyClick = () => setMenu(null);
    document.addEventListener("keydown", closeOnEsc);
    document.addEventListener("mousedown", closeOnAnyClick, true);
    document.addEventListener("scroll", closeOnAnyClick, true);
    return () => {
      document.removeEventListener("keydown", closeOnEsc);
      document.removeEventListener("mousedown", closeOnAnyClick, true);
      document.removeEventListener("scroll", closeOnAnyClick, true);
    };
  }, [menu]);

  const openIssueInBrowser = useCallback((url: string) => {
    void openUrl(url).catch((err) =>
      console.warn("open-issue-url failed:", err),
    );
  }, []);

  const sendIssueToAgent = useCallback(
    async (issue: GhIssue) => {
      if (!project) return;
      setSending(issue.number);
      try {
        const detail = await getIssueDetail(project.path, issue.number);
        const prompt = buildIssuePrompt(detail);
        // Route through the dashboard's start-task event so the
        // launcher + start-task path stays the single source of
        // truth (UI / pi tool parity).
        onEvent(
          "start-task",
          {
            projectId: project.id,
            prompt,
            // newWorktree / branch left undefined — we use the current
            // worktree selection so the user can stack multiple issues
            // into the same worktree before opening fresh ones.
            worktreeId: activeWorktreeId ?? undefined,
            // Tag the payload so the route handler / tests can spot
            // an issue-originated launch.
            source: "github-issue",
            issueNumber: issue.number,
            issueUrl: issue.url,
          },
          `issue-${issue.number}`,
        );
      } catch (err) {
        console.warn("send-to-agent failed:", err);
      } finally {
        setSending(null);
      }
    },
    [project, onEvent, activeWorktreeId],
  );

  const onRowContextMenu = (e: React.MouseEvent, issue: GhIssue) => {
    e.preventDefault();
    setMenu({ issue, x: e.clientX, y: e.clientY });
  };

  if (!project) return null;

  const total = issues?.length ?? 0;
  return (
    <section
      className="a2ui-dashboard-issues"
      ref={containerRef}
    >
      <header className="a2ui-dashboard-issues-head">
        <h2>
          Open issues
          {issues && total > 0 ? (
            <span className="a2ui-dashboard-issues-count" aria-hidden="true">
              {total}
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          className="a2ui-dashboard-issues-refresh"
          disabled={refreshing || !visible}
          aria-label="Refresh issues"
          onClick={() => {
            if (!project) return;
            setRefreshing(true);
            void (async () => {
              try {
                const fresh = await refreshIssues(project.path, limit);
                setIssues(fresh);
              } finally {
                setRefreshing(false);
              }
            })();
          }}
          title="Refresh from gh"
        >
          {refreshing ? "Refreshing…" : "↻"}
        </button>
      </header>

      {!visible ? (
        <p className="a2ui-dashboard-issues-empty">Scroll to load…</p>
      ) : issues === null ? (
        <p className="a2ui-dashboard-issues-empty">Loading issues…</p>
      ) : issues.length === 0 ? (
        <p className="a2ui-dashboard-issues-empty">
          No open issues — or this project isn't connected to a GitHub
          repository.
        </p>
      ) : (
        <ul className="a2ui-dashboard-issues-list">
          {issues.map((issue) => {
            const isSending = sending === issue.number;
            return (
              <li
                key={issue.number}
                className="a2ui-dashboard-issue-row"
                title="Left-click: open on GitHub · Right-click: more actions"
                onClick={() => openIssueInBrowser(issue.url)}
                onContextMenu={(e) => onRowContextMenu(e, issue)}
                data-issue-number={issue.number}
              >
                <div className="a2ui-dashboard-issue-line">
                  <span className="a2ui-dashboard-issue-num">
                    #{issue.number}
                  </span>
                  <span className="a2ui-dashboard-issue-title">
                    {issue.title}
                  </span>
                </div>
                <div className="a2ui-dashboard-issue-meta">
                  {issue.author && (
                    <span className="a2ui-dashboard-issue-author">
                      @{issue.author}
                    </span>
                  )}
                  {issue.updatedAt && (
                    <span className="a2ui-dashboard-issue-updated">
                      updated{" "}
                      {formatRelativeTime(Date.parse(issue.updatedAt))}
                    </span>
                  )}
                  {issue.comments > 0 && (
                    <span className="a2ui-dashboard-issue-comments">
                      💬 {issue.comments}
                    </span>
                  )}
                  {issue.labels.slice(0, 4).map((l) => (
                    <span
                      key={l.name}
                      className="a2ui-dashboard-issue-label"
                      style={
                        l.color
                          ? {
                              background: `#${l.color}33`,
                              borderColor: `#${l.color}`,
                              color: `#${l.color}`,
                            }
                          : undefined
                      }
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="a2ui-dashboard-issue-send"
                  aria-label={`Send issue #${issue.number} to agent`}
                  title="Send to agent"
                  disabled={isSending}
                  onClick={(e) => {
                    e.stopPropagation();
                    void sendIssueToAgent(issue);
                  }}
                >
                  {isSending ? "…" : "→ Agent"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {menu && (
        <div
          className="a2ui-dashboard-issue-menu"
          style={{ position: "fixed", top: menu.y, left: menu.x }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="a2ui-dashboard-issue-menu-item"
            onClick={() => {
              openIssueInBrowser(menu.issue.url);
              setMenu(null);
            }}
          >
            Open on GitHub
          </button>
          <button
            type="button"
            role="menuitem"
            className="a2ui-dashboard-issue-menu-item"
            onClick={() => {
              const m = menu;
              setMenu(null);
              void sendIssueToAgent(m.issue);
            }}
          >
            Send to agent (current worktree)
          </button>
          <button
            type="button"
            role="menuitem"
            className="a2ui-dashboard-issue-menu-item"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(menu.issue.url)
                .catch(() => {});
              setMenu(null);
            }}
          >
            Copy issue URL
          </button>
        </div>
      )}
    </section>
  );
}
