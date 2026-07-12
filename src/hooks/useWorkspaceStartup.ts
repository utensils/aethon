import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { safeUnlisten } from "../utils/safeUnlisten";
import { TERMINAL_REPLAY_MAX } from "./tabOps/constants";

export interface WorkspaceStartupTask {
  id: string;
  label: string;
  required: boolean;
  state: string;
}

export interface WorkspaceStartupEntry {
  root: string;
  fingerprint: string;
  state: string;
  approved: boolean;
  autoApprove?: boolean;
  hostAutoApprove?: boolean;
  projectAutoApprove?: boolean;
  commands: WorkspaceStartupTask[];
  warning?: string | null;
  reason?: string | null;
  activeTaskId?: string | null;
}

export interface WorkspaceStartupSlice {
  activeRoot?: string | null;
  entries?: Record<string, WorkspaceStartupEntry>;
  outputByRoot?: Record<string, string>;
}

export interface WorkspaceStartupView {
  entry: WorkspaceStartupEntry | null;
  output: string;
}

interface WorkspaceStartupStatus {
  root: string;
  fingerprint: string;
  state: string;
  approved: boolean;
  autoApprove?: boolean;
  hostAutoApprove?: boolean;
  projectAutoApprove?: boolean;
  commands: WorkspaceStartupTask[];
  warning?: string | null;
  reason?: string | null;
}

interface WorkspaceStartupEvent {
  root?: string;
  fingerprint?: string;
  state?: string;
  taskId?: string | null;
  taskLabel?: string | null;
  required?: boolean | null;
  message?: string | null;
  reason?: string | null;
}

interface WorkspaceStartupOutputEvent {
  root?: string;
  fingerprint?: string;
  taskId?: string;
  taskLabel?: string;
  stream?: string;
  content?: string;
}

interface PendingPrepare {
  cwd: string;
  resolve: (ready: boolean) => void;
  reject: (err: unknown) => void;
}

export interface UseWorkspaceStartupOptions {
  state: Record<string, unknown>;
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  stateRef: MutableRefObject<Record<string, unknown>>;
}

export interface UseWorkspaceStartupActions {
  view: WorkspaceStartupView;
  prepareWorkspaceStartup: (cwd: string) => Promise<boolean>;
  approveStartup: () => Promise<void>;
  retryStartup: () => Promise<void>;
  continueStartup: () => Promise<void>;
}

const READY_STATES = new Set(["ready", "continued", "disabled"]);
const BLOCKING_STATES = new Set(["approval_required", "failed"]);

export function useWorkspaceStartup({
  state,
  setState,
  stateRef,
}: UseWorkspaceStartupOptions): UseWorkspaceStartupActions {
  const pendingRef = useRef<Map<string, PendingPrepare[]>>(new Map());

  const applyStatus = useCallback(
    (status: WorkspaceStartupStatus): WorkspaceStartupStatus => {
      setState((prev) => {
        const slice = workspaceStartupSlice(prev);
        const entries = { ...(slice.entries ?? {}) };
        entries[status.root] = {
          root: status.root,
          fingerprint: status.fingerprint,
          state: status.state,
          approved: status.approved,
          commands: status.commands,
          warning: status.warning ?? null,
          reason: status.reason ?? null,
          activeTaskId: entries[status.root]?.activeTaskId ?? null,
        };
        return {
          ...prev,
          workspaceStartup: {
            ...slice,
            activeRoot:
              isVisibleStartupState(status.state)
                ? status.root
                : slice.activeRoot === status.root
                  ? null
                : slice.activeRoot,
            entries,
          },
        };
      });
      settlePendingIfReady(status.root, status, pendingRef.current);
      return status;
    },
    [setState],
  );

  const prepareOnce = useCallback(
    async (cwd: string): Promise<WorkspaceStartupStatus> => {
      const status = await invoke<WorkspaceStartupStatus | null>(
        "workspace_startup_prepare_for_path",
        { args: { cwd } },
      );
      if (!status) {
        // A surface without startup approval (the companion stubs the
        // family — the desktop owns execution-boundary approvals)
        // answers null; treat it as nothing-to-approve.
        return {
          root: cwd,
          fingerprint: "",
          state: "disabled",
          approved: true,
          commands: [],
        };
      }
      return applyStatus(status);
    },
    [applyStatus],
  );

  const prepareWorkspaceStartup = useCallback(
    async (cwd: string): Promise<boolean> => {
      const status = await prepareOnce(cwd);
      if (READY_STATES.has(status.state)) return true;
      if (!BLOCKING_STATES.has(status.state)) return false;
      return new Promise<boolean>((resolve, reject) => {
        const list = pendingRef.current.get(status.root) ?? [];
        list.push({ cwd, resolve, reject });
        pendingRef.current.set(status.root, list);
      });
    },
    [prepareOnce],
  );

  const rerunPendingForRoot = useCallback(
    async (root: string) => {
      const pending = pendingRef.current.get(root);
      const cwd = pending?.[0]?.cwd ?? root;
      try {
        const status = await prepareOnce(cwd);
        if (BLOCKING_STATES.has(status.state)) return;
        settlePendingIfReady(root, status, pendingRef.current);
      } catch (err) {
        rejectPending(root, err, pendingRef.current);
      }
    },
    [prepareOnce],
  );

  const approveStartup = useCallback(async () => {
    const entry = activeEntry(stateRef.current);
    if (!entry) return;
    const status = await invoke<WorkspaceStartupStatus>(
      "workspace_startup_approve",
      { args: { root: entry.root, fingerprint: entry.fingerprint } },
    );
    applyStatus(status);
    await rerunPendingForRoot(entry.root);
  }, [applyStatus, rerunPendingForRoot, stateRef]);

  const retryStartup = useCallback(async () => {
    const entry = activeEntry(stateRef.current);
    if (!entry) return;
    const status = await invoke<WorkspaceStartupStatus>(
      "workspace_startup_retry",
      { args: { root: entry.root } },
    );
    applyStatus(status);
    if (READY_STATES.has(status.state)) {
      settlePendingIfReady(entry.root, status, pendingRef.current);
    }
  }, [applyStatus, stateRef]);

  const continueStartup = useCallback(async () => {
    const entry = activeEntry(stateRef.current);
    if (!entry) return;
    const status = await invoke<WorkspaceStartupStatus>(
      "workspace_startup_continue",
      { args: { root: entry.root, fingerprint: entry.fingerprint } },
    );
    applyStatus(status);
    settlePendingIfReady(entry.root, status, pendingRef.current);
  }, [applyStatus, stateRef]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    void (async () => {
      try {
        const offStatus = await listen<WorkspaceStartupEvent>(
          "workspace-startup-status",
          (event) => applyStartupEvent(event.payload, setState),
        );
        const offOutput = await listen<WorkspaceStartupOutputEvent>(
          "workspace-startup-output",
          (event) => applyStartupOutput(event.payload, setState),
        );
        if (cancelled) {
          safeUnlisten(offStatus);
          safeUnlisten(offOutput);
          return;
        }
        unlisteners.push(offStatus, offOutput);
      } catch {
        // Outside Tauri.
      }
    })();
    return () => {
      cancelled = true;
      for (const fn of unlisteners) safeUnlisten(fn);
    };
  }, [setState]);

  const slice = workspaceStartupSlice(state);
  const entry = activeEntry(state);
  const output =
    entry && slice.outputByRoot ? (slice.outputByRoot[entry.root] ?? "") : "";

  return useMemo(
    () => ({
      view: { entry, output },
      prepareWorkspaceStartup,
      approveStartup,
      retryStartup,
      continueStartup,
    }),
    [
      approveStartup,
      continueStartup,
      entry,
      output,
      prepareWorkspaceStartup,
      retryStartup,
    ],
  );
}

function applyStartupEvent(
  event: WorkspaceStartupEvent,
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
): void {
  const root = event.root;
  const state = event.state;
  if (!root || !state) return;
  setState((prev) => {
    const slice = workspaceStartupSlice(prev);
    const entries = { ...(slice.entries ?? {}) };
    const existing = entries[root] ?? {
      root,
      fingerprint: event.fingerprint ?? "",
      state,
      approved: false,
      commands: [],
      reason: null,
      warning: null,
      activeTaskId: null,
    };
    const commands = mergeTaskEvent(existing.commands, event);
    entries[root] = {
      ...existing,
      fingerprint: event.fingerprint ?? existing.fingerprint,
      state,
      commands,
      reason: event.reason ?? existing.reason ?? null,
      activeTaskId: event.taskId ?? existing.activeTaskId ?? null,
    };
    return {
      ...prev,
      workspaceStartup: {
        ...slice,
        activeRoot: isVisibleStartupState(state)
          ? root
          : slice.activeRoot === root
            ? null
            : slice.activeRoot,
        entries,
      },
    };
  });
}

function applyStartupOutput(
  event: WorkspaceStartupOutputEvent,
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
): void {
  if (
    !event.root ||
    typeof event.content !== "string" ||
    event.content.length === 0
  ) {
    return;
  }
  const prefix =
    event.taskLabel && event.stream
      ? `[startup:${event.taskLabel}:${event.stream}] `
      : "[startup] ";
  const content = `${prefix}${event.content}`.replace(/\r?\n/g, "\r\n");
  setState((prev) => {
    const slice = workspaceStartupSlice(prev);
    const outputByRoot = { ...(slice.outputByRoot ?? {}) };
    outputByRoot[event.root!] = trimOutput(
      (outputByRoot[event.root!] ?? "") + content,
    );
    const tabs = Array.isArray(prev.tabs)
      ? (prev.tabs as Array<Record<string, unknown>>)
      : [];
    const term = (prev.terminal as Record<string, unknown> | undefined) ?? {};
    const buffers = (term.buffer as Record<string, string> | undefined) ?? {};
    const nextBuffers = { ...buffers };
    const nextTabs = tabs.map((tab) => {
      const cwd = cwdForTab(tab);
      if (!cwd || !isUnderRoot(cwd, event.root!)) return tab;
      const terminalBuffer = trimOutput(
        `${typeof tab.terminalBuffer === "string" ? tab.terminalBuffer : ""}${content}`,
      );
      nextBuffers[String(tab.id)] = terminalBuffer;
      return { ...tab, terminalBuffer };
    });
    return {
      ...prev,
      tabs: nextTabs,
      workspaceStartup: {
        ...slice,
        activeRoot: slice.activeRoot ?? event.root,
        outputByRoot,
      },
      terminal: {
        ...term,
        buffer: nextBuffers,
      },
    };
  });
}

function mergeTaskEvent(
  commands: WorkspaceStartupTask[],
  event: WorkspaceStartupEvent,
): WorkspaceStartupTask[] {
  if (!event.taskId) return commands;
  const next = commands.slice();
  const idx = next.findIndex((task) => task.id === event.taskId);
  const task: WorkspaceStartupTask = {
    id: event.taskId,
    label: event.taskLabel ?? event.taskId,
    required: event.required ?? true,
    state: event.state ?? "idle",
  };
  if (idx >= 0) {
    next[idx] = { ...next[idx], ...task };
  } else {
    next.push(task);
  }
  return next;
}

function workspaceStartupSlice(
  state: Record<string, unknown>,
): WorkspaceStartupSlice {
  return (state.workspaceStartup as WorkspaceStartupSlice | undefined) ?? {};
}

function activeEntry(
  state: Record<string, unknown>,
): WorkspaceStartupEntry | null {
  const slice = workspaceStartupSlice(state);
  const root = slice.activeRoot;
  if (!root || !slice.entries) return null;
  return slice.entries[root] ?? null;
}

function isVisibleStartupState(state: string): boolean {
  return (
    state === "running" || state === "approval_required" || state === "failed"
  );
}

function settlePendingIfReady(
  root: string,
  status: WorkspaceStartupStatus,
  pending: Map<string, PendingPrepare[]>,
): void {
  if (!READY_STATES.has(status.state)) return;
  const list = pending.get(root);
  if (!list) return;
  pending.delete(root);
  for (const item of list) item.resolve(true);
}

function rejectPending(
  root: string,
  err: unknown,
  pending: Map<string, PendingPrepare[]>,
): void {
  const list = pending.get(root);
  if (!list) return;
  pending.delete(root);
  for (const item of list) item.reject(err);
}

function trimOutput(value: string): string {
  return value.length > TERMINAL_REPLAY_MAX
    ? value.slice(value.length - TERMINAL_REPLAY_MAX)
    : value;
}

function cwdForTab(tab: Record<string, unknown>): string | null {
  if (tab.kind === "shell") {
    const shell = tab.shell as { cwd?: unknown } | undefined;
    return typeof shell?.cwd === "string" ? shell.cwd : null;
  }
  return typeof tab.cwd === "string" ? tab.cwd : null;
}

function isUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return cwd.startsWith(prefix);
}
