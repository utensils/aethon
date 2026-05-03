import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { A2UIPayload } from "../types/a2ui";
import {
  bridgeMessageHandlers,
  type BridgeMessage,
  type BridgeMessageContext,
} from "./bridgeMessageHandlers";

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

    const unlistenResponse = listen<string>("agent-response", (event) => {
      try {
        const data = JSON.parse(event.payload) as BridgeMessage;
        const type = data.type;
        if (typeof type !== "string") return;
        const handler = bridgeMessageHandlers[type];
        if (!handler) return;
        const opts = optionsRef.current;
        const fullCtx: BridgeMessageContext = {
          ...opts.ctx,
          ackMutation,
          hangWarnNotifId,
          hangWarnMs: opts.hangWarnMs ?? DEFAULT_HANG_WARN_MS,
          bootLayout: opts.bootLayout,
        };
        handler(data, fullCtx);
      } catch {
        // Non-JSON line from the bridge — ignore.
      }
    });

    return () => {
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
