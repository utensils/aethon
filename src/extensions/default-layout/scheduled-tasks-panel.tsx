import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinComponentProps } from "../../components/A2UIRenderer";
import type { Tab } from "../../types/tab";
import {
  cancelScheduledTask,
  createScheduledTask,
  formatRelativeTime,
  formatTaskStatus,
  parseLoopArgs,
  pauseScheduledTask,
  resolveLoopPrompt,
  resumeScheduledTask,
  runScheduledTaskNow,
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

function defaultRunAtValue(): string {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function ScheduledTasksPanel({ state, onEvent }: BuiltinComponentProps) {
  const scheduled = readScheduledTasksState(state);
  const tasks = useMemo(
    () => [...(scheduled.tasks ?? [])],
    [scheduled.tasks],
  );
  const [mode, setMode] = useState<DraftMode>("loopSelfPaced");
  const [prompt, setPrompt] = useState("");
  const [interval, setIntervalValue] = useState("30m");
  const [cron, setCron] = useState("*/30 * * * *");
  const [runAt, setRunAt] = useState(defaultRunAtValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (!ms || ms <= Date.now()) throw new Error("Run time must be future.");
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
          <button className="ae-settings-close" onClick={close} aria-label="Close">
            x
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
                <article key={task.id} className="ae-scheduled-row">
                  <div className="ae-scheduled-row-main">
                    <div className="ae-scheduled-title">
                      <strong>{task.label}</strong>
                      <code>{task.id.slice(0, 8)}</code>
                    </div>
                    <div className="ae-scheduled-meta">
                      <span>{task.mode}</span>
                      <span>{formatTaskStatus(task)}</span>
                      {task.nextRunAt ? (
                        <span>{formatRelativeTime(task.nextRunAt)}</span>
                      ) : null}
                    </div>
                    <div className="ae-scheduled-prompt">
                      {task.visiblePrompt}
                    </div>
                  </div>
                  <div className="ae-scheduled-row-actions">
                    <button
                      title="Run now"
                      onClick={() => void act(runScheduledTaskNow, task.id)}
                      disabled={busy || task.status === "running"}
                    >
                      Run
                    </button>
                    {task.status === "paused" || task.status === "failed" ? (
                      <button
                        title="Resume"
                        onClick={() => void act(resumeScheduledTask, task.id)}
                        disabled={busy}
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        title="Pause"
                        onClick={() => void act(pauseScheduledTask, task.id)}
                        disabled={busy || task.status === "running"}
                      >
                        Pause
                      </button>
                    )}
                    <button
                      title="Cancel"
                      onClick={() => void act(cancelScheduledTask, task.id)}
                      disabled={busy || task.status === "running"}
                    >
                      Cancel
                    </button>
                  </div>
                </article>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
