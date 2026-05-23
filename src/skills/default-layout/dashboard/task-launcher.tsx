/**
 * task-launcher — Codex-style "start a task" composer for the
 * per-project dashboard. Textarea + chip row + submit. Submit fires a
 * `start-task` event with the full options shape; the dashboard route
 * handler calls `ctx.startTaskInProject(...)`, which is also the entry
 * point for the agent-side `startTask` pi tool (UI/pi parity).
 *
 * Chip row:
 *   - project — switcher across projects (selectable when multiple).
 *   - worktree — "current" (cwd), or one of the existing worktrees, or
 *     "+ New worktree" (opens the branch chip).
 *   - branch — only shown for "+ New worktree". Base branch picker
 *     populated lazily from `git_branch_list`.
 *
 * Props read $ref-style from /taskLauncher/* paths so the surface is
 * fully live-mutable. An extension can register a custom task-launcher
 * with `aethon.registerComponent("task-launcher", …)`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import { resolvePointer } from "../../../utils/jsonPointer";

interface ProjectLite {
  id: string;
  label: string;
  path: string;
}

interface WorktreeLite {
  id: string;
  label: string;
  branch?: string;
  path: string;
}

interface LauncherData {
  /** The project this composer targets — usually `/project`. */
  project: ProjectLite | null;
  /** Other selectable projects, used by the project chip's menu. */
  otherProjects: ProjectLite[];
  /** Existing worktrees for the active project. */
  worktrees: WorktreeLite[];
  /** Currently-selected worktree id (or null for "project root"). */
  activeWorktreeId: string | null;
}

function isRef(v: unknown): v is { $ref: string } {
  return typeof v === "object" && v !== null && "$ref" in (v);
}

function resolveOrInline<T>(v: unknown, state: Record<string, unknown>): T | null {
  if (!v) return null;
  if (isRef(v)) {
    const r = resolvePointer(state, v.$ref);
    return (r ?? null) as T | null;
  }
  return v as T;
}

/**
 * Default-branch fallback: empty string means "let the backend pick
 * HEAD." We deliberately do NOT pre-fill 'main' — many repos use
 * master/trunk/dev/misc-wip as their default, and `git worktree add
 * <target> main` fails when no local main exists. Backend's
 * git_worktree_add omits the base argument when this field is empty,
 * which is equivalent to "start from current HEAD".
 */
const DEFAULT_BASE_BRANCH = "";

type WorktreeChoice =
  | { kind: "current" }
  | { kind: "existing"; id: string; path: string; label: string }
  | { kind: "new" };

export function TaskLauncher({
  component,
  state,
  onEvent,
}: BuiltinComponentProps) {
  const props = component.props as
    | {
        project?: unknown;
        otherProjects?: unknown;
        worktrees?: unknown;
        activeWorktreeId?: unknown;
        placeholder?: string;
        prompt?: unknown;
      }
    | undefined;

  const data: LauncherData = useMemo(
    () => ({
      project: resolveOrInline<ProjectLite>(props?.project, state),
      otherProjects:
        resolveOrInline<ProjectLite[]>(props?.otherProjects, state) ?? [],
      worktrees:
        resolveOrInline<WorktreeLite[]>(props?.worktrees, state) ?? [],
      activeWorktreeId:
        resolveOrInline<string>(props?.activeWorktreeId, state) ?? null,
    }),
    [
      props?.project,
      props?.otherProjects,
      props?.worktrees,
      props?.activeWorktreeId,
      state,
    ],
  );

  const initialPrompt = useMemo(
    () => resolveOrInline<string>(props?.prompt, state) ?? "",
    [props?.prompt, state],
  );

  const [promptText, setPromptText] = useState(initialPrompt);
  // Seed worktree selection from the project's currently-active
  // worktree so the chip shows what the user has switched to in the
  // sidebar, not just "project root". Falls back to "current" (project
  // root) when no worktree is active.
  const initialChoice: WorktreeChoice = useMemo(() => {
    if (!data.activeWorktreeId) return { kind: "current" };
    const wt = data.worktrees.find((w) => w.id === data.activeWorktreeId);
    if (!wt) return { kind: "current" };
    return {
      kind: "existing",
      id: wt.id,
      path: wt.path,
      label: wt.label || wt.branch || "worktree",
    };
  }, [data.activeWorktreeId, data.worktrees]);
  const [worktreeChoice, setWorktreeChoice] =
    useState<WorktreeChoice>(initialChoice);
  // Re-sync when the active worktree changes on the project (the user
  // can switch worktrees from the sidebar while the launcher is open).
  // Only resets when the user hasn't started typing — typing a prompt
  // implies intent, so don't yank their selection out from under them.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setWorktreeChoice(initialChoice);
  }, [initialChoice, touched]);
  const [newBranch, setNewBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState(DEFAULT_BASE_BRANCH);
  const [submitting, setSubmitting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Auto-grow textarea up to ~10 lines.
    el.style.height = "auto";
    const max = 220;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
  }, [promptText]);

  const submit = useCallback(() => {
    if (submitting) return;
    const text = promptText.trim();
    if (!text) return;
    if (!data.project) return;
    if (worktreeChoice.kind === "new" && !newBranch.trim()) return;
    setSubmitting(true);
    // baseBranch only sent when the user actually typed something — an
    // empty / whitespace value means "off current HEAD", which is the
    // backend's omit-the-argument path. Otherwise repos without a local
    // 'main' would 404 on `git worktree add -b <new> <target> main`.
    const baseTrimmed = baseBranch.trim();
    onEvent("start-task", {
      projectId: data.project.id,
      prompt: text,
      newWorktree: worktreeChoice.kind === "new",
      branch:
        worktreeChoice.kind === "new" ? newBranch.trim() : undefined,
      baseBranch:
        worktreeChoice.kind === "new" && baseTrimmed.length > 0
          ? baseTrimmed
          : undefined,
      // Existing worktree case: we send the worktreeId so the route
      // handler can activate it before spawning the tab.
      worktreeId:
        worktreeChoice.kind === "existing" ? worktreeChoice.id : undefined,
    });
    // Clear the input optimistically — if the start fails the dashboard
    // will surface the error via the notification stack. Reset `touched`
    // so a fresh dashboard visit re-syncs to the active worktree.
    setPromptText("");
    setTouched(false);
    setSubmitting(false);
  }, [
    submitting,
    promptText,
    data.project,
    worktreeChoice,
    newBranch,
    baseBranch,
    onEvent,
  ]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Plain Enter submits; Shift+Enter adds a newline. Matches the main
    // chat composer. Cmd/Ctrl+Enter also submits for users who hold
    // modifiers out of habit.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (!data.project) return null;

  const worktreeLabel =
    worktreeChoice.kind === "current"
      ? "project root"
      : worktreeChoice.kind === "existing"
      ? worktreeChoice.label
      : "+ New worktree";

  return (
    <div className="a2ui-task-launcher">
      <textarea
        ref={textareaRef}
        className="a2ui-task-launcher-input"
        placeholder={
          props?.placeholder ?? `Start a task in ${data.project.label}…`
        }
        value={promptText}
        rows={3}
        onChange={(e) => {
          setPromptText(e.target.value);
          setTouched(true);
        }}
        onKeyDown={onKey}
        disabled={submitting}
        aria-label="Task prompt"
      />
      <div className="a2ui-task-launcher-row">
        <ChipMenu
          label={data.project.label}
          icon="◰"
          ariaLabel="Project"
          items={[
            { id: data.project.id, label: data.project.label, current: true },
            ...data.otherProjects.map((p) => ({
              id: p.id,
              label: p.label,
              current: false,
            })),
          ]}
          onSelect={(id) => {
            if (id === data.project!.id) return;
            onEvent("select-project-card", { projectId: id });
          }}
        />
        <ChipMenu
          label={worktreeLabel}
          icon="⌥"
          ariaLabel="Worktree"
          items={[
            {
              id: "current",
              label: `project root (${data.project.label})`,
              current: worktreeChoice.kind === "current",
            },
            ...data.worktrees.map((w) => ({
              id: w.id,
              label: w.label || w.branch || "worktree",
              current:
                worktreeChoice.kind === "existing" &&
                worktreeChoice.id === w.id,
            })),
            {
              id: "__new__",
              label: "+ New worktree",
              current: worktreeChoice.kind === "new",
            },
          ]}
          onSelect={(id) => {
            setTouched(true);
            if (id === "current") setWorktreeChoice({ kind: "current" });
            else if (id === "__new__") setWorktreeChoice({ kind: "new" });
            else {
              const found = data.worktrees.find((w) => w.id === id);
              if (found)
                setWorktreeChoice({
                  kind: "existing",
                  id: found.id,
                  path: found.path,
                  label: found.label || found.branch || "worktree",
                });
            }
          }}
        />
        {worktreeChoice.kind === "new" && (
          <>
            <input
              type="text"
              className="a2ui-task-launcher-branch-input"
              placeholder="new branch name"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              aria-label="New branch name"
            />
            <input
              type="text"
              className="a2ui-task-launcher-base-input"
              placeholder="base (current HEAD)"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              aria-label="Base branch (empty = current HEAD)"
              title="Base branch to fork from. Leave empty to use the current HEAD — useful when the repo's default isn't 'main'."
            />
          </>
        )}
        <button
          type="button"
          className="a2ui-task-launcher-submit"
          onClick={submit}
          disabled={
            submitting ||
            !promptText.trim() ||
            (worktreeChoice.kind === "new" && !newBranch.trim())
          }
        >
          {submitting ? "…" : "Start"}
        </button>
      </div>
    </div>
  );
}

interface ChipMenuItem {
  id: string;
  label: string;
  current?: boolean;
}

function ChipMenu({
  label,
  icon,
  ariaLabel,
  items,
  onSelect,
}: {
  label: string;
  icon?: string;
  ariaLabel: string;
  items: ChipMenuItem[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="a2ui-task-launcher-chip-wrap">
      <button
        type="button"
        className="a2ui-task-launcher-chip"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        {icon && (
          <span className="a2ui-task-launcher-chip-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="a2ui-task-launcher-chip-label">{label}</span>
        <span className="a2ui-task-launcher-chip-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="a2ui-task-launcher-chip-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={
                "a2ui-task-launcher-chip-menu-item" +
                (item.current ? " is-current" : "")
              }
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
