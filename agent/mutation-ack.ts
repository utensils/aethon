/**
 * Mutation feedback channel — every mutating bridge → frontend message
 * carries a `mutationId`. The frontend acks via
 * `mutation_ack { mutationId, success, error? }` after applying. Bridge
 * resolves a Promise so the API can return `Promise<MutationResult>` and
 * the agent can `await` for confirmation.
 *
 * Mutations made before the frontend reports `ready` resolve immediately
 * with {ok:true} on the assumption that retained-state replay will deliver
 * them — otherwise an extension that awaits at register-time would block
 * until the webview connects.
 */

import type { AethonAgentState, MutationResult } from "./state";

export const MUTATION_ACK_TIMEOUT_MS = 5_000;

export interface MutationAckDeps {
  state: AethonAgentState;
}

/** Flip the frontend-ready gate and unblock any awaiters of
 *  {@link awaitFrontendReady}. Idempotent. */
export function markFrontendReady(state: AethonAgentState): void {
  if (state.frontendReady) return;
  state.frontendReady = true;
  for (const r of state.frontendReadyResolvers.splice(0)) r();
}

/** Allocate a mutationId and a Promise that resolves when the frontend
 *  acks. Pre-handshake mutations resolve immediately with {ok:true}. */
export function trackMutation(
  state: AethonAgentState,
  timeoutMs: number = MUTATION_ACK_TIMEOUT_MS,
): { id: string; promise: Promise<MutationResult> } {
  const id = state.nextMutationId();
  if (!state.frontendReady) {
    return { id, promise: Promise.resolve({ ok: true }) };
  }
  const promise = new Promise<MutationResult>((resolve) => {
    const timer = setTimeout(() => {
      if (!state.pendingMutations.has(id)) return;
      state.pendingMutations.delete(id);
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    state.pendingMutations.set(id, { resolve, timer });
  });
  return { id, promise };
}

/** Wait until the frontend handshake completes, bounded by `timeoutMs`
 *  so we never deadlock during extension registration. Extensions that
 *  call `aethon.shells.list()` from inside their async `register()`
 *  would otherwise hang forever: the stdin loop (which receives the
 *  eventual `report`) doesn't start until registration completes, and
 *  registration is blocked on this very await.
 *
 *  Returns `true` when ready, `false` on timeout. Callers that pass no
 *  timeout block until ready (legitimate from post-startup code like
 *  event handlers and tool calls). */
export async function awaitFrontendReady(
  state: AethonAgentState,
  timeoutMs?: number,
): Promise<boolean> {
  if (state.frontendReady) return true;
  if (typeof timeoutMs !== "number") {
    await state.frontendReadyPromise;
    return true;
  }
  return await Promise.race<boolean>([
    state.frontendReadyPromise.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

/** Resolve the awaiter for a previously-allocated mutationId. */
export function ackMutation(
  state: AethonAgentState,
  id: string,
  success: boolean,
  error?: string,
  data?: unknown,
): void {
  const entry = state.pendingMutations.get(id);
  if (!entry) return;
  state.pendingMutations.delete(id);
  clearTimeout(entry.timer);
  entry.resolve({
    ok: !!success,
    ...(error ? { error } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}
