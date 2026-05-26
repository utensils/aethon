import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { A2UIPayload } from "../../types/a2ui";

export interface AgentReloadDeps {
  bootLayout: A2UIPayload;
  activeResponseIdRef: MutableRefObject<string | null>;
  hangWarnTimersRef: MutableRefObject<
    Map<string, ReturnType<typeof setTimeout>>
  >;
  hangWarnActiveRef: MutableRefObject<Set<string>>;
  hangWarnNotifId: (tabId: string) => string;
  dismissNotification: (id: string) => void;
  setStatusFlags: (
    flags: Partial<{ waiting: boolean; status: string; connection: string }>,
  ) => void;
}

/** `agent-reloaded` fires when the supervisor restarts the bridge in
 *  response to an extension hot-reload (see commands/extensions.rs
 *  run_debounce_worker). Drops in-flight response id + all hang-warn
 *  state, then re-primes the full bridge handshake (start_agent →
 *  boot_layout → report). A bare start_agent re-emits the bridge's
 *  startup ready but does not replay the boot layout or request a
 *  post-layout snapshot — without those, hot-reload restore is
 *  dependent on message timing. */
export function subscribeAgentReload(deps: AgentReloadDeps): () => void {
  const {
    bootLayout,
    activeResponseIdRef,
    hangWarnTimersRef,
    hangWarnActiveRef,
    hangWarnNotifId,
    dismissNotification,
    setStatusFlags,
  } = deps;

  const unlistenReload = listen<string>("agent-reloaded", () => {
    activeResponseIdRef.current = null;
    for (const h of hangWarnTimersRef.current.values()) clearTimeout(h);
    hangWarnTimersRef.current.clear();
    for (const tid of hangWarnActiveRef.current)
      dismissNotification(hangWarnNotifId(tid));
    hangWarnActiveRef.current.clear();
    setStatusFlags({ waiting: false, status: "agent reloaded" });
    (async () => {
      await invoke("start_agent");
      await invoke("agent_command", {
        payload: JSON.stringify({
          type: "boot_layout",
          payload: bootLayout,
        }),
      });
      await invoke("agent_command", {
        payload: JSON.stringify({ type: "report" }),
      });
    })().catch(() => {
      /* surfaced by the next user action */
    });
  });

  return () => {
    unlistenReload.then((fn) => fn());
  };
}
