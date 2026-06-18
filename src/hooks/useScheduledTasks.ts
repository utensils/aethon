import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ChatMessage } from "../types/a2ui";
import type { Tab } from "../types/tab";
import {
  listScheduledTasks,
  reconcileScheduledTaskTabs,
  type ScheduledTaskRecord,
} from "../scheduledTasks";

interface ScheduledTaskFiredEvent {
  task: ScheduledTaskRecord;
  runId: string;
  visiblePrompt: string;
}

export interface UseScheduledTasksOptions {
  state: Record<string, unknown>;
  setState: (
    update:
      | Record<string, unknown>
      | ((prev: Record<string, unknown>) => Record<string, unknown>),
  ) => void;
  appendMessage: (msg: ChatMessage, tabId?: string) => void;
  persistLocalChatMessage: (msg: ChatMessage, tabId: string) => void;
  pushNotification: (input: {
    title: string;
    message?: string;
    kind?: "info" | "success" | "warning" | "error";
    durationMs?: number | null;
  }) => void;
}

export function useScheduledTasks({
  state,
  setState,
  appendMessage,
  persistLocalChatMessage,
  pushNotification,
}: UseScheduledTasksOptions): void {
  const appendMessageRef = useRef(appendMessage);
  const persistLocalChatMessageRef = useRef(persistLocalChatMessage);
  const pushNotificationRef = useRef(pushNotification);

  useEffect(() => {
    appendMessageRef.current = appendMessage;
    persistLocalChatMessageRef.current = persistLocalChatMessage;
    pushNotificationRef.current = pushNotification;
  }, [appendMessage, persistLocalChatMessage, pushNotification]);

  useEffect(() => {
    let cancelled = false;
    listScheduledTasks()
      .then((tasks) => {
        if (!cancelled) mergeTasks(setState, tasks);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        pushNotificationRef.current({
          title: "Scheduled tasks unavailable",
          message: err instanceof Error ? err.message : String(err),
          kind: "warning",
        });
      });

    const offChanged = listen<ScheduledTaskRecord[]>(
      "scheduled-tasks-changed",
      (event) => mergeTasks(setState, event.payload),
    );
    const offFired = listen<ScheduledTaskFiredEvent>(
      "scheduled-task-fired",
      (event) => {
        const { task, runId, visiblePrompt } = event.payload;
        const msg: ChatMessage = {
          id: `scheduled-${task.id}-${runId}`,
          role: "user",
          text: visiblePrompt,
          createdAt: Date.now(),
          delivery: "sent",
        };
        appendMessageRef.current(msg, task.tabId);
        persistLocalChatMessageRef.current(msg, task.tabId);
        mergeTasks(setState, [task]);
      },
    );
    const offError = listen<{ taskId: string; message: string }>(
      "scheduled-task-error",
      (event) => {
        pushNotificationRef.current({
          title: "Scheduled task failed",
          message: event.payload.message,
          kind: "error",
        });
      },
    );

    return () => {
      cancelled = true;
      offChanged.then((fn) => fn());
      offFired.then((fn) => fn());
      offError.then((fn) => fn());
    };
  }, [setState]);

  useEffect(() => {
    if (state.sessionUiRestored !== true) return;
    const liveTabIds = collectLiveAgentTabIds(
      state.tabs,
      state.persistedTabBuckets,
    );
    void reconcileScheduledTaskTabs(liveTabIds)
      .then((tasks) => mergeTasks(setState, tasks))
      .catch(() => {
        /* best-effort; the next list/event refresh will retry */
      });
  }, [
    setState,
    state.sessionUiRestored,
    state.tabs,
    state.persistedTabBuckets,
  ]);
}

function collectLiveAgentTabIds(
  tabsValue: unknown,
  persistedTabBucketsValue: unknown,
): string[] {
  const ids = new Set<string>();
  const collect = (tabs: Tab[] | undefined) => {
    for (const tab of tabs ?? []) {
      if (tab.kind === "agent") ids.add(tab.id);
    }
  };
  collect(tabsValue as Tab[] | undefined);
  const buckets = persistedTabBucketsValue as
    | Record<string, { tabs?: Tab[] }>
    | undefined;
  for (const bucket of Object.values(buckets ?? {})) {
    collect(bucket.tabs);
  }
  return [...ids];
}

function mergeTasks(
  setState: UseScheduledTasksOptions["setState"],
  incoming: ScheduledTaskRecord[],
): void {
  setState((prev) => {
    const cur =
      (prev.scheduledTasks as { tasks?: ScheduledTaskRecord[] } | undefined) ??
      {};
    const byId = new Map((cur.tasks ?? []).map((task) => [task.id, task]));
    for (const task of incoming) byId.set(task.id, task);
    const tasks = [...byId.values()].sort((a, b) => {
      const nextA = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      const nextB = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      return nextA - nextB || b.createdAt - a.createdAt;
    });
    if (sameScheduledTaskList(cur.tasks ?? [], tasks)) {
      return prev;
    }
    return {
      ...prev,
      scheduledTasks: {
        ...cur,
        tasks,
      },
    };
  });
}

function sameScheduledTaskList(
  left: ScheduledTaskRecord[],
  right: ScheduledTaskRecord[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((task, index) => sameScheduledTask(task, right[index]));
}

function sameScheduledTask(
  left: ScheduledTaskRecord,
  right: ScheduledTaskRecord,
): boolean {
  return (
    left.version === right.version &&
    left.id === right.id &&
    left.tabId === right.tabId &&
    left.cwd === right.cwd &&
    left.model === right.model &&
    left.thinkingLevel === right.thinkingLevel &&
    left.hardEnforce === right.hardEnforce &&
    left.authProfileId === right.authProfileId &&
    left.label === right.label &&
    left.prompt === right.prompt &&
    left.visiblePrompt === right.visiblePrompt &&
    left.promptSource === right.promptSource &&
    left.mode === right.mode &&
    JSON.stringify(left.schedule) === JSON.stringify(right.schedule) &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.nextRunAt === right.nextRunAt &&
    left.lastRunAt === right.lastRunAt &&
    left.lastCompletedAt === right.lastCompletedAt &&
    left.expiresAt === right.expiresAt &&
    left.runCount === right.runCount &&
    left.coalescedMisses === right.coalescedMisses &&
    left.lastError === right.lastError &&
    left.status === right.status &&
    left.currentRunId === right.currentRunId
  );
}
