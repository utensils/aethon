/**
 * Extension-driven a2ui event routing.
 *
 * Two halves:
 *   1. **onEvent handlers** — extensions register handlers that match by
 *      `templateRootType` / `componentType` / `descendantId` / `eventType`.
 *      The dispatcher fires every matching handler when the frontend
 *      forwards an `a2ui_event`.
 *   2. **route table** — extensions can install routes that tell the
 *      frontend "these events should bypass the built-in dispatcher and
 *      come back to me as `a2ui_event` instead". Built-in: only events
 *      with a matching route bounce. Extension mode: every event bounces
 *      so the extension can replace the built-in dispatcher wholesale.
 */

import type {
  A2UIEventHandler,
  A2UIEventMatch,
  AethonAgentState,
  MutationResult,
} from "./state";
import { trackMutation } from "./mutation-ack";

export interface EventRoutesDeps {
  send: (obj: Record<string, unknown>) => void;
  scheduleStateFileWrite: () => void;
}

/** Register an a2ui_event handler. Idempotent — a logically identical
 *  re-registration (same match shape + same fn body) is a no-op so a
 *  per-tab session re-running an extension's `register()` doesn't
 *  multiply handler side effects. */
export function onEvent(
  state: AethonAgentState,
  deps: EventRoutesDeps,
  match: A2UIEventMatch,
  handler: A2UIEventHandler,
): void {
  if (typeof handler !== "function") return;
  const key = JSON.stringify(match) + "::" + handler.toString();
  if (state.registeredHandlerKeys.has(key)) return;
  state.registeredHandlerKeys.add(key);
  state.a2uiEventHandlers.push({ match, handler });
  deps.scheduleStateFileWrite();
}

export function registerEventRoute(
  state: AethonAgentState,
  deps: EventRoutesDeps,
  route: unknown,
): Promise<MutationResult> {
  if (!route || typeof route !== "object") {
    return Promise.resolve({ ok: false, error: "route required" });
  }
  const obj = route as { componentId?: unknown; eventType?: unknown };
  const componentId =
    typeof obj.componentId === "string" && obj.componentId.trim()
      ? obj.componentId.trim()
      : undefined;
  const eventType =
    typeof obj.eventType === "string" && obj.eventType.trim()
      ? obj.eventType.trim()
      : undefined;
  if (!componentId && !eventType) {
    const errorMsg =
      "registerEventRoute: at least one of componentId / eventType required";
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  const key = `${componentId ?? "*"}:${eventType ?? "*"}`;
  state.extensionEventRoutes.set(key, {
    ...(componentId ? { componentId } : {}),
    ...(eventType ? { eventType } : {}),
  });
  const list = [...state.extensionEventRoutes.values()];
  const { id, promise } = trackMutation(state);
  deps.send({
    type: "extension_event_routes",
    mutationId: id,
    routes: list,
    mode: state.eventRoutingMode,
  });
  deps.scheduleStateFileWrite();
  return promise;
}

export function unregisterEventRoute(
  state: AethonAgentState,
  deps: EventRoutesDeps,
  route: unknown,
): Promise<MutationResult> {
  if (!route || typeof route !== "object") {
    return Promise.resolve({ ok: false, error: "route required" });
  }
  const obj = route as { componentId?: unknown; eventType?: unknown };
  const componentId =
    typeof obj.componentId === "string" ? obj.componentId : undefined;
  const eventType =
    typeof obj.eventType === "string" ? obj.eventType : undefined;
  const key = `${componentId ?? "*"}:${eventType ?? "*"}`;
  const had = state.extensionEventRoutes.delete(key);
  if (!had) return Promise.resolve({ ok: false, error: "no such route" });
  const list = [...state.extensionEventRoutes.values()];
  const { id, promise } = trackMutation(state);
  deps.send({
    type: "extension_event_routes",
    mutationId: id,
    routes: list,
    mode: state.eventRoutingMode,
  });
  deps.scheduleStateFileWrite();
  return promise;
}

export function setEventRoutingMode(
  state: AethonAgentState,
  deps: EventRoutesDeps,
  mode: unknown,
): Promise<MutationResult> {
  if (mode !== "builtin" && mode !== "extension") {
    const errorMsg =
      "setEventRoutingMode: mode must be 'builtin' or 'extension'";
    deps.send({ type: "notice", message: errorMsg });
    return Promise.resolve({ ok: false, error: errorMsg });
  }
  state.eventRoutingMode = mode;
  const { id, promise } = trackMutation(state);
  deps.send({
    type: "extension_event_routes",
    mutationId: id,
    routes: [...state.extensionEventRoutes.values()],
    mode: state.eventRoutingMode,
  });
  deps.scheduleStateFileWrite();
  return promise;
}

export function listEventRoutes(
  state: AethonAgentState,
): { componentId?: string; eventType?: string }[] {
  return [...state.extensionEventRoutes.values()];
}
