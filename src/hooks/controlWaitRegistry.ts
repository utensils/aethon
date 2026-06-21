// Deterministic completion for release-control `chat.send --wait`.
//
// The bridge echoes the opaque `controlRequestId` supplied by a control client
// on the turn's terminal events (`response_end` / `error`). Instead of polling
// the optimistic `waiting` flag — which can miss a fast turn and imposes an
// artificial timeout ceiling — a waiter registers its id here BEFORE the chat
// is dispatched, and the bridge-message handlers resolve it the moment the
// matching terminal event lands. That makes the wait exact and unbounded by
// anything but the caller-supplied timeout, so multi-minute agent turns no
// longer report a false timeout.

export interface ControlWaitResult {
  waiting: boolean;
  tabId: string;
  outcome: "completed" | "error" | "timeout";
  elapsedMs: number;
  error?: string;
}

interface PendingControlWait {
  tabId: string;
  startedAt: number;
  resolve: (result: ControlWaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingControlWait>();

/**
 * Register interest in a control turn's completion. Must be called before the
 * chat is dispatched so the terminal event can't race ahead of registration.
 * Resolves when {@link resolveControlWait} fires for `requestId`, or after
 * `timeoutMs` with `{ waiting: true, outcome: "timeout" }`.
 */
export function registerControlWait(
  requestId: string,
  tabId: string,
  timeoutMs: number,
  now: number = Date.now(),
): Promise<ControlWaitResult> {
  // A duplicate id (shouldn't happen — ids are unique per request) resolves the
  // older waiter as a timeout so it can't leak.
  pending.get(requestId)?.resolve({
    waiting: true,
    tabId,
    outcome: "timeout",
    elapsedMs: 0,
  });
  return new Promise<ControlWaitResult>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(requestId);
      pending.delete(requestId);
      resolve({
        waiting: true,
        tabId,
        outcome: "timeout",
        elapsedMs: Date.now() - (entry?.startedAt ?? now),
      });
    }, timeoutMs);
    // Don't keep the process alive on this timer (no-op in the browser, guards
    // any node-based test runner).
    (timer as { unref?: () => void }).unref?.();
    pending.set(requestId, { tabId, startedAt: now, resolve, timer });
  });
}

/**
 * Resolve a registered control wait. Called by the `response_end` / `error`
 * bridge-message handlers when the turn they carry was started by a control
 * client (non-empty `controlRequestId`). A no-op for unknown ids — most turns
 * are UI-driven and carry no id.
 */
export function resolveControlWait(
  requestId: string,
  outcome: "completed" | "error",
  tabId: string,
  error?: string,
  now: number = Date.now(),
): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve({
    waiting: false,
    tabId: tabId || entry.tabId,
    outcome,
    elapsedMs: now - entry.startedAt,
    ...(error ? { error } : {}),
  });
  return true;
}

/** Cancel a wait without resolving its promise's consumer path — used when the
 *  dispatch that the wait was registered for fails before the turn starts. */
export function cancelControlWait(requestId: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve({
    waiting: true,
    tabId: entry.tabId,
    outcome: "timeout",
    elapsedMs: 0,
  });
}
