/**
 * Agent-pushed toasts. Fire-and-forget by default (the frontend stack
 * auto-dismisses after durationMs); pass an explicit id to drive dismiss
 * programmatically. Visible state lives on the frontend; the bridge
 * doesn't track lifecycle so the state file isn't polluted by transient
 * toasts.
 */

import type { AethonAgentState, MutationResult } from "./state";
import { trackMutation } from "./mutation-ack";

export interface NotificationsDeps {
  send: (obj: Record<string, unknown>) => void;
}

interface NotifyInput {
  id?: unknown;
  title?: unknown;
  message?: unknown;
  kind?: unknown;
  durationMs?: unknown;
  actions?: unknown;
}

export function notify(
  state: AethonAgentState,
  deps: NotificationsDeps,
  input: unknown,
): Promise<MutationResult> {
  if (!input || typeof input !== "object") {
    return Promise.resolve({ ok: false, error: "notify requires { title }" });
  }
  const obj = input as NotifyInput;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) {
    return Promise.resolve({
      ok: false,
      error: "notify: title required (non-empty string)",
    });
  }
  const id =
    typeof obj.id === "string" && obj.id ? obj.id : state.nextNotificationId();
  const kind =
    obj.kind === "success" || obj.kind === "warning" || obj.kind === "error"
      ? obj.kind
      : "info";
  const message = typeof obj.message === "string" ? obj.message : undefined;
  const durationMs =
    obj.durationMs === null
      ? null
      : typeof obj.durationMs === "number" && Number.isFinite(obj.durationMs)
        ? obj.durationMs
        : undefined;
  let actions: { label: string; action: string }[] | undefined;
  if (Array.isArray(obj.actions)) {
    actions = obj.actions
      .filter(
        (a): a is { label: string; action: string } =>
          !!a &&
          typeof a === "object" &&
          typeof (a as { label?: unknown }).label === "string" &&
          typeof (a as { action?: unknown }).action === "string",
      )
      .map((a) => ({ label: a.label, action: a.action }));
    if (actions.length === 0) actions = undefined;
  }
  const notification = {
    id,
    title,
    ...(message ? { message } : {}),
    kind,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(actions ? { actions } : {}),
    createdAt: Date.now(),
  };
  const { id: mid, promise } = trackMutation(state);
  deps.send({ type: "notification", mutationId: mid, notification });
  return promise;
}

export function dismissNotification(
  state: AethonAgentState,
  deps: NotificationsDeps,
  id: unknown,
): Promise<MutationResult> {
  if (typeof id !== "string" || !id) {
    return Promise.resolve({ ok: false, error: "id required" });
  }
  const { id: mid, promise } = trackMutation(state);
  deps.send({ type: "notification_dismiss", mutationId: mid, id });
  return promise;
}
