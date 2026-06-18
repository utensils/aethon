import { invoke } from "@tauri-apps/api/core";

export type ScheduledTaskMode =
  | "loopFixed"
  | "loopSelfPaced"
  | "oneShot"
  | "cron";

export type ScheduledTaskStatus =
  | "scheduled"
  | "running"
  | "paused"
  | "expired"
  | "cancelled"
  | "failed"
  | "completed";

export type ScheduledTaskSchedule =
  | { kind: "interval"; intervalMs: number; label: string }
  | { kind: "selfPaced"; nextRunAt?: number | null; reason?: string | null }
  | { kind: "oneShot"; runAt: number }
  | { kind: "cron"; expression: string };

export interface ScheduledTaskRecord {
  version: number;
  id: string;
  tabId: string;
  cwd: string;
  model?: string | null;
  thinkingLevel?: string | null;
  hardEnforce?: boolean | null;
  authProfileId?: string | null;
  label: string;
  prompt: string;
  visiblePrompt: string;
  promptSource: string;
  mode: ScheduledTaskMode;
  schedule: ScheduledTaskSchedule;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastCompletedAt?: number | null;
  expiresAt: number;
  runCount: number;
  coalescedMisses: number;
  lastError?: string | null;
  status: ScheduledTaskStatus;
  currentRunId?: string | null;
}

export interface ScheduledTaskCreateInput {
  tabId: string;
  cwd: string;
  model?: string | null;
  thinkingLevel?: string | null;
  hardEnforce?: boolean | null;
  authProfileId?: string | null;
  label?: string | null;
  prompt: string;
  visiblePrompt?: string | null;
  promptSource?: string | null;
  mode?: ScheduledTaskMode;
  schedule: ScheduledTaskSchedule;
}

export interface LoopPromptResolution {
  prompt: string;
  source: string;
}

export type ParsedLoopCommand =
  | {
      ok: true;
      mode: "loopFixed";
      schedule: Extract<ScheduledTaskSchedule, { kind: "interval" }>;
      prompt: string;
    }
  | {
      ok: true;
      mode: "loopSelfPaced";
      schedule: Extract<ScheduledTaskSchedule, { kind: "selfPaced" }>;
      prompt: string;
    }
  | { ok: false; error: string };

const INTERVAL_MIN_MS = 60_000;
const INTERVAL_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export async function listScheduledTasks(): Promise<ScheduledTaskRecord[]> {
  return await invoke<ScheduledTaskRecord[]>("scheduled_tasks_list");
}

export async function createScheduledTask(
  input: ScheduledTaskCreateInput,
): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_create", { input });
}

export async function updateScheduledTask(
  id: string,
  patch: Partial<
    Pick<
      ScheduledTaskCreateInput,
      "label" | "prompt" | "visiblePrompt" | "schedule"
    >
  >,
): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_update", {
    id,
    patch,
  });
}

export async function pauseScheduledTask(
  id: string,
): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_pause", { id });
}

export async function resumeScheduledTask(
  id: string,
): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_resume", { id });
}

export async function cancelScheduledTask(
  id: string,
): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_cancel", { id });
}

export async function runScheduledTaskNow(
  id: string,
): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_run_now", { id });
}

export async function completeScheduledTaskRun(input: {
  taskId: string;
  runId: string;
  success: boolean;
  error?: string;
  completeTask?: boolean;
}): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_complete", {
    input,
  });
}

export async function scheduleLoopWakeup(input: {
  taskId: string;
  runId?: string;
  nextRunAt?: number;
  delayMs?: number;
  reason?: string;
}): Promise<ScheduledTaskRecord> {
  return await invoke<ScheduledTaskRecord>("scheduled_task_schedule_wakeup", {
    input,
  });
}

export async function reconcileScheduledTaskTabs(
  liveTabIds: string[],
): Promise<ScheduledTaskRecord[]> {
  return await invoke<ScheduledTaskRecord[]>(
    "scheduled_tasks_reconcile_live_tabs",
    { liveTabIds },
  );
}

export async function failRunningScheduledTasksForTab(input: {
  tabId?: string | null;
  message?: string | null;
}): Promise<ScheduledTaskRecord[]> {
  return await invoke<ScheduledTaskRecord[]>(
    "scheduled_tasks_fail_running_for_tab",
    { input },
  );
}

export async function resolveLoopPrompt(
  cwd?: string | null,
): Promise<LoopPromptResolution> {
  return await invoke<LoopPromptResolution>("scheduled_task_resolve_loop_prompt", {
    cwd: cwd || null,
  });
}

export function parseLoopArgs(args: string): ParsedLoopCommand {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      ok: true,
      mode: "loopSelfPaced",
      schedule: { kind: "selfPaced" },
      prompt: "",
    };
  }

  const everyMatch = trimmed.match(
    /^every\s+(\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))(?:\s+([\s\S]+))?$/i,
  );
  if (everyMatch) {
    const parsed = parseInterval(everyMatch[1]);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      mode: "loopFixed",
      schedule: {
        kind: "interval",
        intervalMs: parsed.ms,
        label: formatIntervalLabel(parsed.ms),
      },
      prompt: (everyMatch[2] ?? "").trim(),
    };
  }

  const [first, ...rest] = trimmed.split(/\s+/);
  const parsed = parseInterval(first);
  if (parsed.ok) {
    return {
      ok: true,
      mode: "loopFixed",
      schedule: {
        kind: "interval",
        intervalMs: parsed.ms,
        label: formatIntervalLabel(parsed.ms),
      },
      prompt: rest.join(" ").trim(),
    };
  }
  if (/^\d+\s*[A-Za-z]+$/.test(first)) {
    return parsed;
  }

  return {
    ok: true,
    mode: "loopSelfPaced",
    schedule: { kind: "selfPaced" },
    prompt: trimmed,
  };
}

function parseInterval(raw: string): { ok: true; ms: number } | { ok: false; error: string } {
  const match = raw
    .trim()
    .match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) return { ok: false, error: `Invalid interval: ${raw}` };
  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit.startsWith("s")
    ? 1000
    : unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 60 * 60_000
        : 24 * 60 * 60_000;
  const ms = count * factor;
  if (!Number.isFinite(ms) || ms < INTERVAL_MIN_MS) {
    return { ok: false, error: "Loop interval must be at least 1 minute." };
  }
  if (ms > INTERVAL_MAX_MS) {
    return { ok: false, error: "Loop interval must be no more than 7 days." };
  }
  return { ok: true, ms };
}

export function formatIntervalLabel(ms: number): string {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ms % day === 0) return `${ms / day}d`;
  if (ms % hour === 0) return `${ms / hour}h`;
  if (ms % minute === 0) return `${ms / minute}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function formatTaskStatus(task: ScheduledTaskRecord): string {
  const next = task.nextRunAt ? ` next ${formatRelativeTime(task.nextRunAt)}` : "";
  const error = task.lastError ? ` - ${task.lastError}` : "";
  return `${task.status}${next}${error}`;
}

export function formatRelativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const unit =
    abs >= 24 * 60 * 60_000
      ? [Math.round(abs / (24 * 60 * 60_000)), "d"]
      : abs >= 60 * 60_000
        ? [Math.round(abs / (60 * 60_000)), "h"]
        : abs >= 60_000
          ? [Math.round(abs / 60_000), "m"]
          : [Math.max(0, Math.round(abs / 1000)), "s"];
  return diff >= 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}
