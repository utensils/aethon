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
import type { ChatAttachment } from "../../../types/a2ui";
import { resolvePointer } from "../../../utils/jsonPointer";
import { DEFAULT_WORKTREE_BASE_BRANCH } from "../../../projects";
import { saveClipboardImageAttachment } from "../../../utils/imageAttachments";
import { ImageAttachmentImage } from "../image-attachment-image";
import { ImageLightbox } from "../image-lightbox";

interface ProjectLite {
  id: string;
  label: string;
  path: string;
  worktreeBaseBranch?: string;
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

type WorktreeChoice =
  | { kind: "current" }
  | { kind: "existing"; id: string; path: string; label: string }
  | { kind: "new" };

const codeInputProps = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

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
      worktrees: resolveOrInline<WorktreeLite[]>(props?.worktrees, state) ?? [],
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

  // Model list + the resolved default for new sessions. The chip shows
  // (and lets the user override per-launch) which model the task spawns
  // with — `/defaultModel` is the header/Settings pick, `/piDefaultModel`
  // is the pi boot fallback.
  const models = useMemo<{ id: string; label: string }[]>(() => {
    const raw = resolvePointer(state, "/sidebar/models");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (m): m is { id: unknown; label?: unknown } =>
          typeof m === "object" && m !== null,
      )
      .map((m) => ({ id: String(m.id ?? ""), label: String(m.label ?? m.id ?? "") }))
      .filter((m) => m.id.length > 0);
  }, [state]);
  const defaultModelId = useMemo(() => {
    const chosen = resolvePointer(state, "/defaultModel");
    if (typeof chosen === "string" && chosen.length > 0) return chosen;
    const pi = resolvePointer(state, "/piDefaultModel");
    return typeof pi === "string" ? pi : "";
  }, [state]);
  const [modelTouched, setModelTouched] = useState(false);
  const [selectedModel, setSelectedModel] = useState(defaultModelId);
  // Track the live default until the user overrides — so the chip always
  // reflects a header/Settings change made while the launcher is open.
  useEffect(() => {
    if (modelTouched) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived-state resync on external default change
    setSelectedModel(defaultModelId);
  }, [defaultModelId, modelTouched]);

  const [promptText, setPromptText] = useState(initialPrompt);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [openAttachment, setOpenAttachment] = useState<ChatAttachment | null>(
    null,
  );
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
    if (touched) return;
    queueMicrotask(() => setWorktreeChoice(initialChoice));
  }, [initialChoice, touched]);
  const [newBranch, setNewBranch] = useState("");
  const defaultBaseBranch =
    data.project?.worktreeBaseBranch ?? DEFAULT_WORKTREE_BASE_BRANCH;
  const [baseBranch, setBaseBranch] = useState(defaultBaseBranch);
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
    if (!text && attachments.length === 0) return;
    if (!data.project) return;
    setSubmitting(true);
    const baseTrimmed = baseBranch.trim();
    onEvent("start-task", {
      projectId: data.project.id,
      prompt: text,
      attachments,
      newWorktree: worktreeChoice.kind === "new",
      branch: worktreeChoice.kind === "new" ? newBranch.trim() : undefined,
      baseBranch:
        worktreeChoice.kind === "new" && baseTrimmed.length > 0
          ? baseTrimmed
          : undefined,
      // Existing worktree case: we send the worktreeId so the route
      // handler can activate it before spawning the tab.
      worktreeId:
        worktreeChoice.kind === "existing" ? worktreeChoice.id : undefined,
      // Per-launch model. Falls back to the resolved default so the
      // session always boots with a concrete model even before `ready`.
      model: selectedModel || defaultModelId || undefined,
    });
    // Clear the input optimistically — if the start fails the dashboard
    // will surface the error via the notification stack. Reset `touched`
    // so a fresh dashboard visit re-syncs to the active worktree, and
    // `modelTouched` so the chip re-seeds from the live default.
    setPromptText("");
    setAttachments([]);
    setTouched(false);
    setModelTouched(false);
    setSubmitting(false);
  }, [
    submitting,
    promptText,
    attachments,
    data.project,
    worktreeChoice,
    newBranch,
    baseBranch,
    selectedModel,
    defaultModelId,
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

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(files.map((file) => saveClipboardImageAttachment(file)))
      .then((saved) => setAttachments((current) => [...current, ...saved]))
      .catch((err) => {
        console.warn("task-launcher paste image failed:", err);
        onEvent("paste-image-failed", {
          message:
            err instanceof Error ? err.message : "Could not paste image.",
        });
      });
  };

  if (!data.project) return null;

  const worktreeLabel =
    worktreeChoice.kind === "current"
      ? "project root"
      : worktreeChoice.kind === "existing"
        ? worktreeChoice.label
        : "+ New worktree";
  const modelLabel =
    models.find((m) => m.id === selectedModel)?.label ||
    selectedModel ||
    "model";

  return (
    <div className="a2ui-task-launcher">
      <textarea
        ref={textareaRef}
        className="a2ui-task-launcher-input"
        placeholder={
          props?.placeholder ??
          `Start a task in ${data.project.label}… use @path for file context`
        }
        value={promptText}
        rows={3}
        onChange={(e) => {
          setPromptText(e.target.value);
          setTouched(true);
        }}
        onPaste={onPaste}
        onKeyDown={onKey}
        disabled={submitting}
        aria-label="Task prompt"
      />
      {attachments.length > 0 && (
        <div className="a2ui-task-launcher-attachments">
          {attachments.map((attachment) => (
            <figure
              className="a2ui-task-launcher-attachment"
              key={attachment.id}
            >
              <button
                type="button"
                className="a2ui-task-launcher-attachment-thumb"
                aria-label={`Open ${attachment.name}`}
                onClick={() => setOpenAttachment(attachment)}
              >
                <ImageAttachmentImage attachment={attachment} alt="" />
              </button>
              <figcaption title={attachment.name}>{attachment.name}</figcaption>
              <button
                type="button"
                className="a2ui-task-launcher-attachment-remove"
                aria-label={`Remove ${attachment.name}`}
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((item) => item.id !== attachment.id),
                  )
                }
              >
                ×
              </button>
            </figure>
          ))}
        </div>
      )}
      {openAttachment && (
        <ImageLightbox
          attachment={openAttachment}
          onClose={() => setOpenAttachment(null)}
        />
      )}
      <div className="a2ui-task-launcher-row">
        {models.length > 0 && (
          <ChipMenu
            label={modelLabel}
            icon="✦"
            ariaLabel="Model"
            searchable
            searchPlaceholder="filter models — sonnet, gpt, qwen…"
            items={models.map((m) => ({
              id: m.id,
              label: m.label,
              current: m.id === selectedModel,
            }))}
            onSelect={(id) => {
              setModelTouched(true);
              setSelectedModel(id);
            }}
          />
        )}
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
              {...codeInputProps}
            />
            <input
              type="text"
              className="a2ui-task-launcher-base-input"
              placeholder={DEFAULT_WORKTREE_BASE_BRANCH}
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              aria-label="Base branch (empty = project default)"
              title="Base branch to fork from. Leave empty to use the project default."
              {...codeInputProps}
            />
          </>
        )}
        <button
          type="button"
          className="a2ui-task-launcher-submit"
          onClick={submit}
          disabled={
            submitting || (!promptText.trim() && attachments.length === 0)
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
  searchable = false,
  searchPlaceholder,
}: {
  label: string;
  icon?: string;
  ariaLabel: string;
  items: ChipMenuItem[];
  onSelect: (id: string) => void;
  /** Render a filter input atop the menu — for long lists like models. */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q),
    );
  }, [items, query]);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && wrapRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnFocusOut = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (target && wrapRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsidePointer, true);
    document.addEventListener("focusin", closeOnFocusOut, true);
    document.addEventListener("keydown", closeOnEsc);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer, true);
      document.removeEventListener("focusin", closeOnFocusOut, true);
      document.removeEventListener("keydown", closeOnEsc);
    };
  }, [open]);
  return (
    <span className="a2ui-task-launcher-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className="a2ui-task-launcher-chip"
        onClick={() => {
          setQuery("");
          setOpen((v) => !v);
        }}
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
          {searchable && (
            <input
              type="text"
              className="a2ui-task-launcher-chip-search"
              placeholder={searchPlaceholder ?? "filter…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={`Filter ${ariaLabel}`}
              autoFocus
              {...codeInputProps}
            />
          )}
          {filtered.length === 0 ? (
            <div className="a2ui-task-launcher-chip-menu-empty">
              no matches
            </div>
          ) : (
            filtered.map((item) => (
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
            ))
          )}
        </div>
      )}
    </span>
  );
}
