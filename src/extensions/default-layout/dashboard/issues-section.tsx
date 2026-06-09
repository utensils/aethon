/**
 * issues-section — surfaces the active project's open GitHub issues on
 * the per-project dashboard. Two affordances per row, per the user's
 * spec:
 *
 *   - left-click  → open the issue's URL in the OS browser
 *   - right-click → context menu with "Send to agent (new workspace)" and
 *                   "Send to agent (current workspace/branch)" (also
 *                   keyboard-equivalent via the dedicated send button
 *                   on the row hover state).
 *
 * The "send to agent" paths fetch the full issue body and emit
 * `start-task` with a prompt built from the project's optional
 * `.aethon/issues.toml` templates. The built-in markdown prompt remains
 * the fallback. The default row action asks the shared task path to
 * create a fresh workspace so each issue starts isolated.
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
  type CSSProperties,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";
import {
  type GhIssue,
  getIssueDetail,
  refreshIssues,
} from "../../../ghIssuesCache";
import { formatRelativeTime } from "../../../utils/time";
import { buildIssueTask } from "./issue-task";
import {
  loadIssueTemplates,
  matchingIssueTemplates,
  type IssueTemplate,
} from "./issue-templates";

interface ProjectInfo {
  id: string;
  label: string;
  path: string;
}

interface IssueSectionProps {
  project?: unknown;
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

function projectWorkspaceBranches(
  state: Record<string, unknown>,
  projectId: string,
): Set<string> {
  const sidebar =
    (state.sidebar as
      | {
          projects?: {
            id: string;
            workspaces?: { branch?: string | null; label?: string }[];
          }[];
        }
      | undefined) ?? {};
  const project = sidebar.projects?.find((p) => p.id === projectId);
  return new Set(
    (project?.workspaces ?? [])
      .flatMap((w) => [w.branch, w.label])
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  );
}

function currentProjectWorkspaceId(
  state: Record<string, unknown>,
  projectId: string,
): string | undefined {
  const activeWorkspaceId =
    typeof state.activeWorkspaceId === "string" &&
    state.activeWorkspaceId.length > 0
      ? state.activeWorkspaceId
      : undefined;
  const sidebar =
    (state.sidebar as
      | {
          projects?: {
            id: string;
            workspaces?: { id?: string; active?: boolean }[];
          }[];
        }
      | undefined) ?? {};
  const project = sidebar.projects?.find((p) => p.id === projectId);
  const workspace =
    project?.workspaces?.find((w) => w.id && w.id === activeWorkspaceId) ??
    project?.workspaces?.find((w) => w.id && w.active === true);
  return workspace?.id;
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
  const limit = typeof props.limit === "number" ? props.limit : 30;

  const [issues, setIssues] = useState<GhIssue[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [issueTemplates, setIssueTemplates] = useState<IssueTemplate[]>([]);
  const [templateWarning, setTemplateWarning] = useState<string | null>(null);
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
      const [fetched, templateConfig] = await Promise.all([
        refreshIssues(project.path, limit),
        loadIssueTemplates(project.path),
      ]);
      if (cancelled) return;
      setIssues(fetched);
      setIssueTemplates(templateConfig.templates);
      setTemplateWarning(templateConfig.warning);
      if (templateConfig.warning) {
        console.warn("issue template config warning:", templateConfig.warning);
      }
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
    async (
      issue: GhIssue,
      options: {
        forceNewWorkspace?: boolean;
        template?: IssueTemplate | null;
      } = {},
    ) => {
      if (!project) return;
      setSending(issue.number);
      try {
        const detail = await getIssueDetail(project.path, issue.number);
        const matching = matchingIssueTemplates(issueTemplates, issue);
        const selectedTemplate =
          options.template === null
            ? null
            : (options.template ?? matching[0] ?? null);
        const task = buildIssueTask(detail, issue, project, {
          template: selectedTemplate,
          forceNewWorkspace: options.forceNewWorkspace,
          existingBranches: projectWorkspaceBranches(state, project.id),
        });
        const workspaceId = task.newWorkspace
          ? undefined
          : currentProjectWorkspaceId(state, project.id);
        // Route through the dashboard's start-task event so the
        // launcher + start-task path stays the single source of
        // truth (UI / pi tool parity).
        onEvent(
          "start-task",
          {
            projectId: project.id,
            prompt: task.prompt,
            newWorkspace: task.newWorkspace,
            branch: task.branch,
            workspaceId,
            // Tag the payload so tests (and future telemetry) can spot
            // an issue-originated launch. The start-task route handler
            // forwards only its known keys, so these extra fields are
            // observational and intentionally not consumed there yet.
            source: "github-issue",
            issueNumber: issue.number,
            issueUrl: issue.url,
            issueTemplateId: task.templateId,
            issueTemplateLabel: task.templateLabel,
          },
          `issue-${issue.number}`,
        );
      } catch (err) {
        console.warn("send-to-agent failed:", err);
      } finally {
        setSending(null);
      }
    },
    [project, onEvent, state, issueTemplates],
  );

  const sendIssueToNewWorkspace = useCallback(
    async (issue: GhIssue, template?: IssueTemplate | null) => {
      await sendIssueToAgent(issue, { forceNewWorkspace: true, template });
    },
    [sendIssueToAgent],
  );

  const sendIssueToCurrentWorkspace = useCallback(
    async (issue: GhIssue, template?: IssueTemplate | null) => {
      await sendIssueToAgent(issue, { forceNewWorkspace: false, template });
    },
    [sendIssueToAgent],
  );

  const onRowContextMenu = (e: React.MouseEvent, issue: GhIssue) => {
    e.preventDefault();
    setMenu({ issue, x: e.clientX, y: e.clientY });
  };

  if (!project) return null;

  const total = issues?.length ?? 0;
  const menuTemplates = menu
    ? matchingIssueTemplates(issueTemplates, menu.issue)
    : [];
  const showTemplateChoices = menuTemplates.length > 1;
  return (
    <section className="a2ui-dashboard-issues" ref={containerRef}>
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
                const [fresh, templateConfig] = await Promise.all([
                  refreshIssues(project.path, limit),
                  loadIssueTemplates(project.path),
                ]);
                setIssues(fresh);
                setIssueTemplates(templateConfig.templates);
                setTemplateWarning(templateConfig.warning);
                if (templateConfig.warning) {
                  console.warn(
                    "issue template config warning:",
                    templateConfig.warning,
                  );
                }
                setLoadedFor(project.path);
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

      {templateWarning ? (
        <p className="a2ui-dashboard-issues-warning">{templateWarning}</p>
      ) : null}

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
                      updated {formatRelativeTime(Date.parse(issue.updatedAt))}
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
                          ? ({
                              // The chrome rule mixes this with the theme's
                              // --text and --border tokens so the chip stays
                              // readable across all themes. Setting the raw
                              // hex as bg/fg (the old behaviour) collapsed
                              // contrast to ~1.8:1 for pale labels.
                              "--label-color": `#${l.color}`,
                            } as CSSProperties)
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
                  title="Send to agent in new workspace"
                  disabled={isSending}
                  onClick={(e) => {
                    e.stopPropagation();
                    void sendIssueToNewWorkspace(issue);
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
              void sendIssueToNewWorkspace(m.issue);
            }}
          >
            Send to agent (new workspace)
          </button>
          <button
            type="button"
            role="menuitem"
            className="a2ui-dashboard-issue-menu-item"
            onClick={() => {
              const m = menu;
              setMenu(null);
              void sendIssueToCurrentWorkspace(m.issue);
            }}
          >
            Send to agent (current workspace/branch)
          </button>
          {showTemplateChoices
            ? menuTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  role="menuitem"
                  className="a2ui-dashboard-issue-menu-item"
                  onClick={() => {
                    const m = menu;
                    setMenu(null);
                    void sendIssueToAgent(m.issue, { template });
                  }}
                >
                  Use template: {template.label}
                </button>
              ))
            : null}
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
