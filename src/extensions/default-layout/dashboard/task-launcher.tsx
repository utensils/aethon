/**
 * task-launcher — Codex-style "start a task" composer for the
 * per-project dashboard. Textarea + chip row + submit. Submit fires a
 * `start-task` event with the full options shape; the dashboard route
 * handler calls `ctx.startTaskInProject(...)`, which is also the entry
 * point for the agent-side `startTask` pi tool (UI/pi parity).
 *
 * Chip row:
 *   - project — optional host-level switcher across projects.
 *   - workspace — "current" (cwd), or one of the existing workspaces, or
 *     "+ New workspace" (opens the branch chip).
 *   - branch — only shown for "+ New workspace". Base branch picker
 *     populated lazily from `git_branch_list`.
 *
 * Props read $ref-style from /taskLauncher/* paths so the surface is
 * fully live-mutable. An extension can register a custom task-launcher
 * with `aethon.registerComponent("task-launcher", …)`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BuiltinComponentProps } from "../../../components/A2UIRenderer";
import type { ChatAttachment } from "../../../types/a2ui";
import { resolvePointer } from "../../../utils/jsonPointer";
import { DEFAULT_WORKSPACE_BASE_BRANCH } from "../../../projects";
import { saveClipboardImageAttachment } from "../../../utils/imageAttachments";
import { ImageAttachmentImage } from "../image-attachment-image";
import { ImageLightbox } from "../image-lightbox";
import { AtPicker } from "../at-picker";
import { SlashPicker } from "../slash-picker";
import { useAtMentionTextarea } from "../use-at-mention-textarea";
import { useTextareaVoiceInput } from "../use-textarea-voice-input";
import { VoiceInputButton, VoiceStatus } from "../voice-controls";
import {
  type ArgMatch,
  type CommandMatch,
  type PickerMatch,
  type SlashCommandSource,
  useSlashMatching,
} from "../use-slash-matching";

interface ProjectLite {
  id: string;
  label: string;
  path: string;
  workspaceBaseBranch?: string;
}

interface WorkspaceLite {
  id: string;
  label: string;
  branch?: string;
  path: string;
}

interface LauncherData {
  /** The project this composer targets — usually `/project`. */
  project: ProjectLite | null;
  /** Selectable projects for host-level launchers. */
  projects: ProjectLite[];
  /** Other selectable projects, used by the project chip's menu. */
  otherProjects: ProjectLite[];
  /** Existing workspaces keyed by project id for host-level launchers. */
  workspacesByProject: Record<string, WorkspaceLite[]>;
  /** Existing workspaces for the active project. */
  workspaces: WorkspaceLite[];
  /** Currently-selected workspace id (or null for "project root"). */
  activeWorkspaceId: string | null;
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

type WorkspaceChoice =
  | { kind: "current" }
  | { kind: "existing"; id: string; path: string; label: string }
  | { kind: "new" };

const HOST_PROJECT_ID = "__aethon_host__";

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
        projects?: unknown;
        otherProjects?: unknown;
        workspacesByProject?: unknown;
        workspaces?: unknown;
        activeWorkspaceId?: unknown;
        placeholder?: string;
        prompt?: unknown;
        showProjectSelector?: boolean;
        defaultTarget?: "host" | "project";
        commands?: SlashCommandSource;
      }
    | undefined;
  const showProjectSelector = props?.showProjectSelector === true;
  const defaultToHost =
    showProjectSelector && props?.defaultTarget === "host";

  const data: LauncherData = useMemo(
    () => ({
      project: resolveOrInline<ProjectLite>(props?.project, state),
      projects: resolveOrInline<ProjectLite[]>(props?.projects, state) ?? [],
      otherProjects:
        resolveOrInline<ProjectLite[]>(props?.otherProjects, state) ?? [],
      workspacesByProject:
        resolveOrInline<Record<string, WorkspaceLite[]>>(
          props?.workspacesByProject,
          state,
        ) ?? {},
      workspaces:
        resolveOrInline<WorkspaceLite[]>(props?.workspaces, state) ?? [],
      activeWorkspaceId:
        resolveOrInline<string>(props?.activeWorkspaceId, state) ?? null,
    }),
    [
      props?.project,
      props?.projects,
      props?.otherProjects,
      props?.workspacesByProject,
      props?.workspaces,
      props?.activeWorkspaceId,
      state,
    ],
  );

  const selectableProjects = useMemo(() => {
    const seen = new Set<string>();
    const list: ProjectLite[] = [];
    for (const p of [data.project, ...data.projects, ...data.otherProjects]) {
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      list.push(p);
    }
    return list;
  }, [data.project, data.projects, data.otherProjects]);
  const [selectedProjectId, setSelectedProjectId] = useState(
    defaultToHost
      ? HOST_PROJECT_ID
      : (data.project?.id ?? selectableProjects[0]?.id ?? ""),
  );
  const hostSelected =
    showProjectSelector && selectedProjectId === HOST_PROJECT_ID;
  const selectedProject =
    showProjectSelector && !hostSelected
      ? (selectableProjects.find((p) => p.id === selectedProjectId) ??
        data.project ??
        selectableProjects[0] ??
        null)
      : showProjectSelector
        ? null
        : data.project;
  const selectedWorkspaces = useMemo(
    () =>
      showProjectSelector
        ? selectedProject
          ? (data.workspacesByProject[selectedProject.id] ?? [])
          : []
        : data.workspaces,
    [
      data.workspaces,
      data.workspacesByProject,
      selectedProject,
      showProjectSelector,
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
      .map((m) => ({
        id: String(m.id ?? ""),
        label: String(m.label ?? m.id ?? ""),
      }))
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
  // Seed workspace selection from the project's currently-active
  // workspace so the chip shows what the user has switched to in the
  // sidebar, not just "project root". Falls back to "current" (project
  // root) when no workspace is active.
  const initialChoice: WorkspaceChoice = useMemo(() => {
    if (!data.activeWorkspaceId || showProjectSelector) {
      return { kind: "current" };
    }
    const wt = selectedWorkspaces.find((w) => w.id === data.activeWorkspaceId);
    if (!wt) return { kind: "current" };
    return {
      kind: "existing",
      id: wt.id,
      path: wt.path,
      label: wt.label || wt.branch || "workspace",
    };
  }, [data.activeWorkspaceId, selectedWorkspaces, showProjectSelector]);
  const [workspaceChoice, setWorkspaceChoice] =
    useState<WorkspaceChoice>(initialChoice);
  // Re-sync when the active workspace changes on the project (the user
  // can switch workspaces from the sidebar while the launcher is open).
  // Only resets when the user hasn't started typing — typing a prompt
  // implies intent, so don't yank their selection out from under them.
  const [touched, setTouched] = useState(false);
  const hostOverviewVisible = defaultToHost && state.emptyAndNoProject === true;
  const wasHostOverviewVisibleRef = useRef(hostOverviewVisible);
  useEffect(() => {
    if (touched) return;
    queueMicrotask(() => setWorkspaceChoice(initialChoice));
  }, [initialChoice, touched]);
  const [newBranch, setNewBranch] = useState("");
  const defaultBaseBranch =
    selectedProject?.workspaceBaseBranch ?? DEFAULT_WORKSPACE_BASE_BRANCH;
  const [baseBranch, setBaseBranch] = useState(defaultBaseBranch);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!defaultToHost) return;
    const wasVisible = wasHostOverviewVisibleRef.current;
    wasHostOverviewVisibleRef.current = hostOverviewVisible;
    if (!hostOverviewVisible || wasVisible) return;
    setSelectedProjectId(HOST_PROJECT_ID);
    setWorkspaceChoice({ kind: "current" });
    setBaseBranch(DEFAULT_WORKSPACE_BASE_BRANCH);
    setTouched(false);
  }, [defaultToHost, hostOverviewVisible]);

  useEffect(() => {
    if (defaultToHost) {
      if (selectedProjectId === HOST_PROJECT_ID) return;
      if (selectableProjects.some((p) => p.id === selectedProjectId)) return;
      queueMicrotask(() => {
        setSelectedProjectId(HOST_PROJECT_ID);
        setWorkspaceChoice({ kind: "current" });
        setBaseBranch(DEFAULT_WORKSPACE_BASE_BRANCH);
      });
      return;
    }
    const fallbackProject = data.project ?? selectableProjects[0] ?? null;
    if (!fallbackProject) return;
    if (selectableProjects.some((p) => p.id === selectedProjectId)) return;
    queueMicrotask(() => {
      setSelectedProjectId(fallbackProject.id);
      setWorkspaceChoice({ kind: "current" });
      setBaseBranch(
        fallbackProject.workspaceBaseBranch ?? DEFAULT_WORKSPACE_BASE_BRANCH,
      );
    });
  }, [data.project, defaultToHost, selectableProjects, selectedProjectId]);

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

  // `@` completion — same picker as the chat composer, rooted at
  // whatever the task will actually run against: the selected existing
  // workspace, else the project root (a "+ New workspace" forks from the
  // project, so its files are the right suggestions too).
  const launcherRef = useRef<HTMLDivElement | null>(null);
  const { slashMatch, highlightIdx, setHighlightIdx, dismissPicker } =
    useSlashMatching({
      value: promptText,
      commandsRaw: props?.commands ?? { $ref: "/slashCommands" },
      state,
    });
  const atRoot =
    !hostSelected && workspaceChoice.kind === "existing"
      ? workspaceChoice.path
      : (selectedProject?.path ?? null);
  const {
    atMatch,
    atHighlightIdx,
    setAtHighlightIdx,
    setCursor,
    insertAtMention,
    handleAtMentionKeyDown,
  } = useAtMentionTextarea({
    value: promptText,
    setValue: setPromptText,
    onValueCommit: () => setTouched(true),
    textareaRef,
    root: atRoot,
    enabled: !submitting && !slashMatch,
  });

  const submitPrompt = useCallback((rawPrompt: string) => {
    if (submitting) return;
    const text = rawPrompt.trim();
    if (!text && attachments.length === 0) return;
    if (!selectedProject && !hostSelected) return;
    setSubmitting(true);
    const baseTrimmed = baseBranch.trim();
    onEvent("start-task", {
      ...(hostSelected
        ? { target: "host" }
        : { projectId: selectedProject?.id }),
      prompt: text,
      attachments,
      newWorkspace: !hostSelected && workspaceChoice.kind === "new",
      branch:
        !hostSelected && workspaceChoice.kind === "new"
          ? newBranch.trim()
          : undefined,
      baseBranch:
        !hostSelected &&
        workspaceChoice.kind === "new" &&
        baseTrimmed.length > 0
          ? baseTrimmed
          : undefined,
      // Existing workspace case: we send the workspaceId so the route
      // handler can activate it before spawning the tab.
      workspaceId:
        !hostSelected && workspaceChoice.kind === "existing"
          ? workspaceChoice.id
          : undefined,
      // Per-launch model. Falls back to the resolved default so the
      // session always boots with a concrete model even before `ready`.
      model: selectedModel || defaultModelId || undefined,
    });
    // Clear the input optimistically — if the start fails the dashboard
    // will surface the error via the notification stack. Reset `touched`
    // so a fresh dashboard visit re-syncs to the active workspace, and
    // `modelTouched` so the chip re-seeds from the live default.
    setPromptText("");
    setAttachments([]);
    setTouched(false);
    setModelTouched(false);
    setSubmitting(false);
  }, [
    submitting,
    attachments,
    selectedProject,
    hostSelected,
    workspaceChoice,
    newBranch,
    baseBranch,
    selectedModel,
    defaultModelId,
    onEvent,
  ]);

  const submit = useCallback(() => {
    submitPrompt(promptText);
  }, [promptText, submitPrompt]);

  const insertSlashMatch = (match: PickerMatch) => {
    const text =
      match.kind === "command"
        ? `/${match.cmd.name} `
        : `/${match.cmd.name} ${match.choice.value}`;
    setPromptText(text);
    setTouched(true);
  };

  const submitSlashArgMatch = (match: ArgMatch) => {
    const text = `/${match.cmd.name} ${match.choice.value}`;
    setPromptText(text);
    setTouched(true);
    submitPrompt(text);
  };

  // The dashboard task-launcher and the composer both mount at once — the
  // layout grid hides cells with display:none rather than unmounting — so each
  // registers the same global voice hotkey against one shared mic. Track
  // whether this dashboard actually owns the canvas (mirrors the
  // project-dashboard's `visible: /emptyAndProject` binding) so it neither
  // starts while hidden nor keeps holding the slot after being hidden.
  const voiceSurfaceVisible = defaultToHost
    ? state.emptyAndNoProject === true
    : state.emptyAndProject === true;
  const voiceConfig = (state.voice as
    | {
        toggleHotkey?: string | null;
        holdHotkey?: string | null;
      }
    | undefined) ?? { toggleHotkey: "mod+shift+m", holdHotkey: null };
  const settings = state.settings as { open?: boolean } | undefined;
  const palette = state.commandPalette as { open?: boolean } | undefined;
  const search = state.search as { open?: boolean } | undefined;
  const { voice, useDynamicMeter, voiceErrorOpensSettings } =
    useTextareaVoiceInput({
      value: promptText,
      setValue: setPromptText,
      onValueCommit: () => setTouched(true),
      setCursor,
      textareaRef,
      surfaceActive: voiceSurfaceVisible,
      disabled: submitting,
      overlays: {
        settingsOpen: settings?.open,
        paletteOpen: palette?.open,
        searchOpen: search?.open,
      },
      voiceConfig,
      onNeedsSetup: (providerId) => onEvent("voice:setup", { providerId }),
      onAutoSend: submitPrompt,
    });

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMatch) {
      const list = slashMatch.matches;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % list.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + list.length) % list.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const match = list[highlightIdx] ?? list[0];
        if (match) insertSlashMatch(match);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissPicker();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const value = (e.target as HTMLTextAreaElement).value;
        if (slashMatch.mode === "arg") {
          const match = list[highlightIdx] ?? list[0];
          if (match) submitSlashArgMatch(match as ArgMatch);
          return;
        }
        const exact = (list as CommandMatch[]).find(
          (candidate) =>
            value === `/${candidate.cmd.name}` ||
            value.startsWith(`/${candidate.cmd.name} `),
        );
        if (exact && value.trim().length > 0) {
          submitPrompt(value);
          return;
        }
        const match = list[highlightIdx] ?? list[0];
        if (match) insertSlashMatch(match);
        return;
      }
    }
    if (!slashMatch && handleAtMentionKeyDown(e)) return;
    // Plain Enter submits; Shift+Enter adds a newline. Matches the main
    // chat composer. Cmd/Ctrl+Enter also submits for users who hold
    // modifiers out of habit.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (voice.state === "recording" || voice.state === "starting") {
        voice.cancel();
      }
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

  if (!selectedProject && !hostSelected) return null;

  const workspaceLabel =
    workspaceChoice.kind === "current"
      ? "project root"
      : workspaceChoice.kind === "existing"
        ? workspaceChoice.label
        : "+ New workspace";
  const modelLabel =
    models.find((m) => m.id === selectedModel)?.label ||
    selectedModel ||
    "model";

  return (
    <div className="a2ui-task-launcher" ref={launcherRef}>
      <textarea
        ref={textareaRef}
        className="a2ui-task-launcher-input"
        placeholder={
          props?.placeholder ??
          (hostSelected
            ? "Start a task on this host… use @<subagent> or @path"
            : `Start a task in ${selectedProject!.label}… use @<subagent> or @path`)
        }
        value={promptText}
        rows={3}
        onChange={(e) => {
          setPromptText(e.target.value);
          setCursor(e.target.selectionStart ?? e.target.value.length);
          setTouched(true);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
        onPaste={onPaste}
        onKeyDown={onKey}
        disabled={submitting}
        aria-label="Task prompt"
      />
      <SlashPicker
        anchorRef={launcherRef}
        slashMatch={slashMatch}
        highlightIdx={highlightIdx}
        setHighlightIdx={setHighlightIdx}
        onInsert={insertSlashMatch}
        onSubmitArg={submitSlashArgMatch}
      />
      <AtPicker
        anchorRef={launcherRef}
        atMatch={atMatch}
        highlightIdx={atHighlightIdx}
        setHighlightIdx={setAtHighlightIdx}
        onInsert={insertAtMention}
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
        {showProjectSelector && selectableProjects.length > 0 && (
          <ChipMenu
            label={hostSelected ? "host" : (selectedProject?.label ?? "project")}
            icon="◰"
            ariaLabel="Project"
            items={[
              ...(defaultToHost
                ? [
                    {
                      id: HOST_PROJECT_ID,
                      label: "host",
                      current: hostSelected,
                    },
                  ]
                : []),
              ...selectableProjects.map((p) => ({
                id: p.id,
                label: p.label,
                current: !hostSelected && p.id === selectedProject?.id,
              })),
            ]}
            onSelect={(id) => {
              const project = selectableProjects.find((p) => p.id === id);
              setSelectedProjectId(id);
              setWorkspaceChoice({ kind: "current" });
              setBaseBranch(
                project?.workspaceBaseBranch ?? DEFAULT_WORKSPACE_BASE_BRANCH,
              );
              setTouched(true);
            }}
          />
        )}
        {!hostSelected && selectedProject && (
          <ChipMenu
            label={workspaceLabel}
            icon="⌥"
            ariaLabel="Workspace"
            items={[
              {
                id: "current",
                label: `project root (${selectedProject.label})`,
                current: workspaceChoice.kind === "current",
              },
              ...selectedWorkspaces.map((w) => ({
                id: w.id,
                label: w.label || w.branch || "workspace",
                current:
                  workspaceChoice.kind === "existing" &&
                  workspaceChoice.id === w.id,
              })),
              {
                id: "__new__",
                label: "+ New workspace",
                current: workspaceChoice.kind === "new",
              },
            ]}
            onSelect={(id) => {
              setTouched(true);
              if (id === "current") setWorkspaceChoice({ kind: "current" });
              else if (id === "__new__") setWorkspaceChoice({ kind: "new" });
              else {
                const found = selectedWorkspaces.find((w) => w.id === id);
                if (found)
                  setWorkspaceChoice({
                    kind: "existing",
                    id: found.id,
                    path: found.path,
                    label: found.label || found.branch || "workspace",
                  });
              }
            }}
          />
        )}
        {workspaceChoice.kind === "new" && (
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
              placeholder={DEFAULT_WORKSPACE_BASE_BRANCH}
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              aria-label="Base branch (empty = project default)"
              title="Base branch to fork from. Leave empty to use the project default."
              {...codeInputProps}
            />
          </>
        )}
        <div className="a2ui-task-launcher-voice-controls">
          <VoiceStatus
            voice={voice}
            useDynamicMeter={useDynamicMeter}
            errorOpensSettings={voiceErrorOpensSettings}
            onOpenSettings={() =>
              onEvent("voice:setup", { providerId: voice.activeProvider?.id })
            }
          />
          <VoiceInputButton voice={voice} disabled={submitting} />
        </div>
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
            <div className="a2ui-task-launcher-chip-menu-empty">no matches</div>
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
