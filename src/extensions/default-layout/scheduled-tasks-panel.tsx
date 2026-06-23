import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { Tab } from "../../types/tab";
import {
  cancelScheduledTask,
  createScheduledTask,
  deleteScheduledTask,
  formatTaskStatus,
  parseLoopArgs,
  pauseScheduledTask,
  resolveLoopPrompt,
  reuseScheduledTask,
  resumeScheduledTask,
  runScheduledTaskNow,
  updateScheduledTask,
  type ScheduledTaskRecord,
  type ScheduledTaskSchedule,
} from "../../scheduledTasks";

type DraftMode = "loopSelfPaced" | "loopFixed" | "oneShot" | "cron";

interface ScheduledTasksState {
  open?: boolean;
  tasks?: ScheduledTaskRecord[];
}

function readScheduledTasksState(
  state: Record<string, unknown>,
): ScheduledTasksState {
  return (state.scheduledTasks as ScheduledTasksState | undefined) ?? {};
}

function activeAgentTab(state: Record<string, unknown>): Tab | null {
  const tabs = (state.tabs as Tab[] | undefined) ?? [];
  const activeId = state.activeTabId as string | undefined;
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.kind === "agent" ? tab : null;
}

function activeProjectPath(state: Record<string, unknown>): string | null {
  const project = state.project as { path?: string } | null | undefined;
  return typeof project?.path === "string" && project.path
    ? project.path
    : null;
}

function datetimeLocalToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isFutureRunAt(ms: number): boolean {
  return ms > Date.now();
}

function defaultRunAtValue(): string {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function msToDatetimeLocal(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatIntervalMs(ms: number): string {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function scheduleDraftValueForMode(
  task: ScheduledTaskRecord,
  mode: DraftMode,
): string {
  const schedule = task.schedule;
  if (mode === "loopFixed" && schedule.kind === "interval") {
    return schedule.label || formatIntervalMs(schedule.intervalMs);
  }
  if (mode === "loopFixed") return "30m";
  if (mode === "cron" && schedule.kind === "cron") return schedule.expression;
  if (mode === "cron") return "*/30 * * * *";
  if (mode === "oneShot" && schedule.kind === "oneShot") {
    return msToDatetimeLocal(schedule.runAt);
  }
  if (mode === "oneShot") return defaultRunAtValue();
  return "";
}

function scheduleFieldLabel(mode: DraftMode): string | null {
  if (mode === "loopFixed") return "Interval";
  if (mode === "cron") return "Cron";
  if (mode === "oneShot") return "Run at";
  return null;
}

function parseTaskSchedule(
  mode: DraftMode,
  value: string,
): ScheduledTaskSchedule {
  if (mode === "loopFixed") {
    const parsed = parseLoopArgs(`${value.trim()} keep`);
    if (!parsed.ok || parsed.mode !== "loopFixed") {
      throw new Error(parsed.ok ? "Interval required." : parsed.error);
    }
    return parsed.schedule;
  }
  if (mode === "cron") {
    const expression = value.trim();
    if (!expression) throw new Error("Cron expression required.");
    return { kind: "cron", expression };
  }
  if (mode === "oneShot") {
    const runAt = datetimeLocalToMs(value);
    if (!runAt || !isFutureRunAt(runAt)) {
      throw new Error("Run time must be in the future.");
    }
    return { kind: "oneShot", runAt };
  }
  return { kind: "selfPaced" };
}

export function ScheduledTasksPanel({ state, onEvent }: BuiltinComponentProps) {
  const scheduled = readScheduledTasksState(state);
  const tasks = useMemo(() => [...(scheduled.tasks ?? [])], [scheduled.tasks]);
  const [mode, setMode] = useState<DraftMode>("loopSelfPaced");
  const [prompt, setPrompt] = useState("");
  const [interval, setIntervalValue] = useState("30m");
  const [cron, setCron] = useState("*/30 * * * *");
  const [runAt, setRunAt] = useState(defaultRunAtValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scheduled.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEvent("close");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [scheduled.open, onEvent]);

  if (!scheduled.open) return null;

  const close = () => onEvent("close");
  const tab = activeAgentTab(state);
  const canCreate = !!tab && !busy;

  async function createTask() {
    if (!tab) {
      setError("Open an agent tab first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const cwd =
        tab.cwd ??
        activeProjectPath(state) ??
        (await invoke<string>("aethon_home_dir").catch(() => ""));
      if (!cwd) throw new Error("Could not resolve a working directory.");
      let schedule: ScheduledTaskSchedule;
      let taskMode: "loopFixed" | "loopSelfPaced" | "oneShot" | "cron";
      if (mode === "loopFixed") {
        const parsed = parseLoopArgs(`${interval} ${prompt}`.trim());
        if (!parsed.ok || parsed.mode !== "loopFixed") {
          throw new Error(parsed.ok ? "Interval required." : parsed.error);
        }
        taskMode = "loopFixed";
        schedule = parsed.schedule;
      } else if (mode === "loopSelfPaced") {
        taskMode = "loopSelfPaced";
        schedule = { kind: "selfPaced" };
      } else if (mode === "oneShot") {
        const ms = datetimeLocalToMs(runAt);
        if (!ms || !isFutureRunAt(ms)) {
          throw new Error("Run time must be in the future.");
        }
        taskMode = "oneShot";
        schedule = { kind: "oneShot", runAt: ms };
      } else {
        taskMode = "cron";
        schedule = { kind: "cron", expression: cron.trim() };
      }
      let body = prompt.trim();
      let promptSource = "inline";
      if (!body && (mode === "loopSelfPaced" || mode === "loopFixed")) {
        const resolved = await resolveLoopPrompt(cwd);
        body = resolved.prompt;
        promptSource = resolved.source;
      }
      if (!body) throw new Error("Prompt required.");
      await createScheduledTask({
        tabId: tab.id,
        cwd,
        model: tab.model || null,
        thinkingLevel: tab.thinkingLevel ?? null,
        hardEnforce: tab.hardEnforceProjectRoot ?? null,
        authProfileId: tab.authProfileId ?? null,
        prompt: body,
        visiblePrompt: body,
        promptSource,
        mode: taskMode,
        schedule,
      });
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(
    fn: (id: string) => Promise<ScheduledTaskRecord>,
    id: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      await fn(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTask(
    task: ScheduledTaskRecord,
    input: { mode: DraftMode; prompt: string; scheduleValue: string },
  ) {
    const body = input.prompt.trim();
    if (!body) {
      setError("Prompt required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const schedule = parseTaskSchedule(input.mode, input.scheduleValue);
      const promptChanged = body !== (task.visiblePrompt || task.prompt);
      const modeChanged = input.mode !== task.mode;
      const scheduleChanged =
        input.scheduleValue !== scheduleDraftValueForMode(task, input.mode);
      await updateScheduledTask(task.id, {
        ...(modeChanged || scheduleChanged
          ? { mode: input.mode, schedule }
          : {}),
        ...(promptChanged ? { prompt: body, visiblePrompt: body } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reuseHere(task: ScheduledTaskRecord) {
    if (!tab) {
      setError("Open an agent tab first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const cwd =
        tab.cwd ??
        activeProjectPath(state) ??
        (await invoke<string>("aethon_home_dir").catch(() => ""));
      if (!cwd) throw new Error("Could not resolve a working directory.");
      await reuseScheduledTask({
        taskId: task.id,
        tabId: tab.id,
        cwd,
        model: tab.model || null,
        thinkingLevel: tab.thinkingLevel ?? null,
        hardEnforce: tab.hardEnforceProjectRoot ?? null,
        authProfileId: tab.authProfileId ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="ae-scheduled-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="ae-scheduled-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Scheduled Tasks"
      >
        <div className="ae-scheduled-header">
          <h2>Scheduled Tasks</h2>
          <button
            type="button"
            className="ae-settings-close"
            onClick={close}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="ae-scheduled-body">
          <section className="ae-scheduled-create">
            <div className="ae-scheduled-grid">
              <label className="ae-scheduled-field">
                <span>Mode</span>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as DraftMode)}
                >
                  <option value="loopSelfPaced">Self-paced loop</option>
                  <option value="loopFixed">Fixed loop</option>
                  <option value="oneShot">One-shot</option>
                  <option value="cron">Cron</option>
                </select>
              </label>
              {mode === "loopFixed" ? (
                <label className="ae-scheduled-field">
                  <span>Interval</span>
                  <input
                    value={interval}
                    onChange={(e) => setIntervalValue(e.target.value)}
                    placeholder="30m"
                  />
                </label>
              ) : null}
              {mode === "oneShot" ? (
                <label className="ae-scheduled-field">
                  <span>Run at</span>
                  <input
                    type="datetime-local"
                    value={runAt}
                    onChange={(e) => setRunAt(e.target.value)}
                  />
                </label>
              ) : null}
              {mode === "cron" ? (
                <label className="ae-scheduled-field">
                  <span>Cron</span>
                  <input
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    placeholder="*/30 * * * *"
                  />
                </label>
              ) : null}
            </div>
            <label className="ae-scheduled-field ae-scheduled-field--wide">
              <span>Prompt</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
              />
            </label>
            {error ? <div className="ae-scheduled-error">{error}</div> : null}
            <div className="ae-scheduled-actions">
              <span className="ae-scheduled-target">
                {tab ? tab.label : "No agent tab"}
              </span>
              <button
                type="button"
                className="ae-settings-primary"
                disabled={!canCreate}
                onClick={() => void createTask()}
              >
                Create
              </button>
            </div>
          </section>
          <section className="ae-scheduled-list">
            {tasks.length === 0 ? (
              <div className="ae-scheduled-empty">No scheduled tasks.</div>
            ) : (
              tasks.map((task) => (
                <ScheduledTaskRow
                  key={`${task.id}:${task.updatedAt}:${task.status}`}
                  task={task}
                  busy={busy}
                  canReuse={isReusableLoopTask(task)}
                  hasActiveAgentTab={!!tab}
                  onRun={() => void act(runScheduledTaskNow, task.id)}
                  onReuse={() => void reuseHere(task)}
                  onResume={() => void act(resumeScheduledTask, task.id)}
                  onPause={() => void act(pauseScheduledTask, task.id)}
                  onCancel={() => void act(cancelScheduledTask, task.id)}
                  onDelete={() => void act(deleteScheduledTask, task.id)}
                  onSave={(input) => void saveTask(task, input)}
                />
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ScheduledTaskRow({
  task,
  busy,
  canReuse,
  hasActiveAgentTab,
  onRun,
  onReuse,
  onResume,
  onPause,
  onCancel,
  onDelete,
  onSave,
}: {
  task: ScheduledTaskRecord;
  busy: boolean;
  canReuse: boolean;
  hasActiveAgentTab: boolean;
  onRun: () => void;
  onReuse: () => void;
  onResume: () => void;
  onPause: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onSave: (input: {
    mode: DraftMode;
    prompt: string;
    scheduleValue: string;
  }) => void;
}) {
  const [modeDraft, setModeDraft] = useState<DraftMode>(task.mode);
  const [promptDraft, setPromptDraft] = useState(
    task.visiblePrompt || task.prompt,
  );
  const [scheduleDraft, setScheduleDraft] = useState(
    scheduleDraftValueForMode(task, task.mode),
  );

  const terminal = isTerminalTask(task);
  const canPause = !terminal && task.status !== "running";
  const canResume =
    !terminal && (task.status === "paused" || task.status === "failed");
  const scheduleLabel = scheduleFieldLabel(modeDraft);
  const canEdit = task.status !== "running";
  const modeChanged = modeDraft !== task.mode;
  const promptChanged = promptDraft !== (task.visiblePrompt || task.prompt);
  const scheduleChanged =
    scheduleDraft !== scheduleDraftValueForMode(task, modeDraft);
  const canSave = canEdit && (modeChanged || promptChanged || scheduleChanged);

  const changeMode = (nextMode: DraftMode) => {
    setModeDraft(nextMode);
    setScheduleDraft(scheduleDraftValueForMode(task, nextMode));
  };

  return (
    <article className="ae-scheduled-row">
      <div className="ae-scheduled-row-head">
        <div className="ae-scheduled-row-main">
          <div className="ae-scheduled-title">
            <strong>{task.label}</strong>
            <code>{task.id.slice(0, 8)}</code>
          </div>
          <div className="ae-scheduled-meta">
            <span>{task.mode}</span>
            <span>{formatTaskStatus(task)}</span>
          </div>
        </div>
        <div className="ae-scheduled-row-actions">
          <button
            type="button"
            title="Save"
            onClick={() =>
              onSave({
                mode: modeDraft,
                prompt: promptDraft,
                scheduleValue: scheduleDraft,
              })
            }
            disabled={busy || !canSave}
          >
            Save
          </button>
          <button
            type="button"
            title="Run now"
            onClick={onRun}
            disabled={busy || task.status === "running"}
          >
            Run
          </button>
          {canReuse ? (
            <button
              type="button"
              title={
                hasActiveAgentTab
                  ? "Reuse this loop on the active session"
                  : "Open an agent tab to reuse this loop"
              }
              onClick={onReuse}
              disabled={busy || !hasActiveAgentTab || task.status === "running"}
            >
              Reuse
            </button>
          ) : null}
          {canResume ? (
            <button
              type="button"
              title="Resume"
              onClick={onResume}
              disabled={busy}
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              title="Pause"
              onClick={onPause}
              disabled={busy || !canPause}
            >
              Pause
            </button>
          )}
          {terminal ? (
            <button
              type="button"
              title="Delete"
              onClick={onDelete}
              disabled={busy}
            >
              Delete
            </button>
          ) : (
            <button
              type="button"
              title="Cancel"
              onClick={onCancel}
              disabled={busy || task.status === "running"}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="ae-scheduled-edit-grid">
        <label className="ae-scheduled-field ae-scheduled-field--mode">
          <span>Mode</span>
          <select
            value={modeDraft}
            onChange={(e) => changeMode(e.target.value as DraftMode)}
            disabled={!canEdit}
          >
            <option value="loopSelfPaced">Self-paced loop</option>
            <option value="loopFixed">Fixed loop</option>
            <option value="oneShot">One-shot</option>
            <option value="cron">Cron</option>
          </select>
        </label>
        {scheduleLabel ? (
          <label className="ae-scheduled-field ae-scheduled-field--schedule">
            <span>{scheduleLabel}</span>
            <input
              type={modeDraft === "oneShot" ? "datetime-local" : "text"}
              value={scheduleDraft}
              onChange={(e) => setScheduleDraft(e.target.value)}
              disabled={!canEdit}
            />
          </label>
        ) : null}
        <label className="ae-scheduled-field ae-scheduled-field--wide">
          <span>Prompt</span>
          <textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            disabled={!canEdit}
            rows={6}
          />
        </label>
      </div>
    </article>
  );
}

function isTerminalTask(task: ScheduledTaskRecord): boolean {
  return (
    task.status === "cancelled" ||
    task.status === "completed" ||
    task.status === "expired"
  );
}

function isReusableLoopTask(task: ScheduledTaskRecord): boolean {
  return (
    task.status !== "running" &&
    (task.mode === "loopFixed" ||
      task.mode === "loopSelfPaced" ||
      task.mode === "cron")
  );
}
