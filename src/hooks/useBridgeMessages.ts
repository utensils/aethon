import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { A2UIPayload } from "../types/a2ui";
import {
  bridgeMessageHandlers,
  type BridgeMessage,
  type BridgeMessageContext,
} from "./bridgeMessageHandlers";
import { refreshHangWarnForBridgeMessage } from "./bridgeMessageHandlers/hangWarn";

export interface UseBridgeMessagesOptions {
  /** Everything handlers close over. The hook layers `ackMutation`,
   *  `hangWarnNotifId`, `hangWarnMs`, and `bootLayout` on top before
   *  passing to handlers. */
  ctx: Omit<
    BridgeMessageContext,
    "ackMutation" | "hangWarnNotifId" | "hangWarnMs" | "bootLayout"
  >;
  /** Boot layout used by the `ready` handler when the bridge doesn't
   *  report an extension-supplied layout. */
  bootLayout: A2UIPayload;
  /** Hang-warn timeout in ms (production: 30_000). Exposed so tests can
   *  shrink it without faking timers. */
  hangWarnMs?: number;
  /** Boot-time error escape hatch — invoked if the start_agent /
   *  boot_layout / report sequence throws. App.tsx surfaces this as a
   *  chat bubble + status flag. */
  onBootError: (err: unknown) => void;
}

export interface UseBridgeMessagesActions {
  /** Ack a mutation back to the bridge so the awaiting Promise resolves.
   *  Exposed for callers that settle bridge promises outside the
   *  response path. Fire-and-forget — we don't await the ack-send
   *  because the bridge ack channel is independent of any other
   *  outgoing message. */
  ackMutation: (
    mutationId: unknown,
    success: boolean,
    error?: string,
    data?: unknown,
  ) => void;
}

const DEFAULT_HANG_WARN_MS = 30_000;
const hangWarnNotifId = (tabId: string) => `ae-hang-warn:${tabId}`;
const BRIDGE_DRAIN_BUDGET_MS = 8;
const BRIDGE_DRAIN_MAX_MESSAGES = 80;

export type BridgeDispatchDecision =
  | { kind: "handle" }
  | { kind: "ignore" }
  | { kind: "ack-reject"; error: string };

/** Pure dispatch policy for an inbound bridge message.
 *
 *  - `originTabId` (stamped by per-tab workers on registry-replacing
 *    messages — see agent/origin-gate.ts) must belong to a tab in the
 *    active workspace bucket (`/tabs`). Hydrates from background-workspace
 *    workers are rejected so they can't clobber the active workspace's
 *    extension surface; the reject is acked so the worker's awaiting
 *    extension resolves instead of hitting the 5s mutation timeout.
 *  - A mutation-bearing message with no registered handler is acked as
 *    failed instead of silently dropped — a silent drop leaks the
 *    bridge-side pending entry until timeout AND the Rust supervisor's
 *    mutation route forever.
 */
export function bridgeDispatchDecision(
  message: BridgeMessage,
  hasHandler: boolean,
  // Lazy: most inbound traffic (streaming deltas, tool cards) carries no
  // originTabId, so the active-tab Set is only built when gating applies.
  activeTabIds: () => ReadonlySet<string>,
): BridgeDispatchDecision {
  const origin = message.originTabId;
  if (typeof origin === "string" && origin.length > 0) {
    if (!activeTabIds().has(origin)) {
      return {
        kind: "ack-reject",
        error: `origin tab "${origin}" is not in the active workspace`,
      };
    }
  }
  if (!hasHandler) {
    if (typeof message.mutationId === "string" && message.mutationId) {
      return {
        kind: "ack-reject",
        error: `unhandled message type "${String(message.type)}"`,
      };
    }
    return { kind: "ignore" };
  }
  return { kind: "handle" };
}

function activeTabIdsFromState(state: Record<string, unknown>): Set<string> {
  const tabs = state.tabs as { id?: unknown }[] | undefined;
  const ids = new Set<string>();
  for (const tab of tabs ?? []) {
    if (typeof tab?.id === "string") ids.add(tab.id);
  }
  return ids;
}

type InputPendingNavigator = Navigator & {
  scheduling?: {
    isInputPending?: (options?: { includeContinuous?: boolean }) => boolean;
  };
};

function hasPendingInput(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    (navigator as InputPendingNavigator).scheduling?.isInputPending?.({
      includeContinuous: true,
    }) === true
  );
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createBridgePayloadPump(
  processPayload: (payload: string) => void,
) {
  let queue: string[] = [];
  let head = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const compact = () => {
    if (head < 256 || head * 2 < queue.length) return;
    queue = queue.slice(head);
    head = 0;
  };

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(drain, 0);
  };

  const drain = () => {
    timer = null;
    if (disposed) return;

    const started = nowMs();
    let count = 0;
    while (head < queue.length) {
      processPayload(queue[head]);
      head += 1;
      count += 1;

      if (
        count >= BRIDGE_DRAIN_MAX_MESSAGES ||
        nowMs() - started >= BRIDGE_DRAIN_BUDGET_MS ||
        hasPendingInput()
      ) {
        break;
      }
    }

    compact();
    if (head < queue.length) schedule();
  };

  return {
    enqueue(payload: string) {
      if (disposed) return;
      queue.push(payload);
      schedule();
    },
    dispose() {
      disposed = true;
      queue = [];
      head = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function processBridgePayload(
  payload: string,
  options: UseBridgeMessagesOptions,
  ackMutation: UseBridgeMessagesActions["ackMutation"],
): void {
  let data: BridgeMessage;
  try {
    data = JSON.parse(payload) as BridgeMessage;
  } catch {
    // Non-JSON line from the bridge — ignore.
    return;
  }
  const type = data.type;
  if (typeof type !== "string") return;
  const handler = bridgeMessageHandlers[type];
  const decision = bridgeDispatchDecision(data, handler !== undefined, () =>
    activeTabIdsFromState(options.ctx.stateRef.current),
  );
  if (decision.kind === "ack-reject") {
    ackMutation(data.mutationId, false, decision.error);
    return;
  }
  if (decision.kind === "ignore" || !handler) return;
  const fullCtx: BridgeMessageContext = {
    ...options.ctx,
    ackMutation,
    hangWarnNotifId,
    hangWarnMs: options.hangWarnMs ?? DEFAULT_HANG_WARN_MS,
    bootLayout: options.bootLayout,
  };
  try {
    refreshHangWarnForBridgeMessage(data, fullCtx);
    handler(data, fullCtx);
  } catch (err) {
    const message = errorMessage(err);
    if (typeof data.mutationId === "string" && data.mutationId.length > 0) {
      ackMutation(data.mutationId, false, message);
    }
    console.error(`[bridge] handler ${type} failed:`, err);
  }
}

export function useBridgeMessages(
  options: UseBridgeMessagesOptions,
): UseBridgeMessagesActions {
  const { bootLayout } = options;
  const optionsRef = useRef(options);
  // Sync the latest options into the ref AFTER render so the
  // listener (which reads optionsRef.current at event time) always
  // sees the current ctx without us touching the ref during render
  // — react-hooks/refs disallows the latter.
  useEffect(() => {
    optionsRef.current = options;
  });

  const ackMutation = (
    mutationId: unknown,
    success: boolean,
    error?: string,
    data?: unknown,
  ) => {
    if (typeof mutationId !== "string" || mutationId.length === 0) return;
    invoke("agent_command", {
      payload: JSON.stringify({
        type: "mutation_ack",
        mutationId,
        success,
        ...(error ? { error } : {}),
        ...(data !== undefined ? { data } : {}),
      }),
    }).catch(() => {
      /* bridge gone — extension's awaiter will hit the timeout instead */
    });
  };

  useEffect(() => {
    // Boot sequence: spawn the agent, tell the bridge our boot layout
    // (so extensions calling api.getLayout() at register-time see a
    // meaningful tree instead of null), then request a fresh `ready`
    // event in case the agent process was already running before this
    // React tree mounted (after a webview hot-reload). Newly-spawned
    // agents emit ready unconditionally, so the duplicate is harmless.
    (async () => {
      try {
        await invoke("start_agent");
        await invoke("agent_command", {
          payload: JSON.stringify({ type: "boot_layout", payload: bootLayout }),
        });
        await invoke("agent_command", {
          payload: JSON.stringify({ type: "report" }),
        });
      } catch (err) {
        optionsRef.current.onBootError(err);
      }
    })();

    const processPayload = (payload: string) => {
      processBridgePayload(payload, optionsRef.current, ackMutation);
    };

    const pump = createBridgePayloadPump(processPayload);
    const unlistenResponse = listen<string>("agent-response", (event) => {
      pump.enqueue(event.payload);
    });

    return () => {
      pump.dispose();
      unlistenResponse.then((fn) => fn());
    };
    // Boot effect runs once. Subsequent option changes are picked up via
    // optionsRef inside the listener. The eslint disable matches the
    // existing pattern in App.tsx for top-level boot effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ackMutation };
}

export { hangWarnNotifId };
