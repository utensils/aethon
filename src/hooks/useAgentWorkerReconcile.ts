import { invoke } from "@tauri-apps/api/core";
import { useEffect, type MutableRefObject } from "react";
import type { Tab } from "../types/tab";

// Low cadence — this is orphan cleanup, not a latency-sensitive path. The idle
// sweep (Rust) already retires inactive workers; this just retires faster when
// a tab is gone. The startup delay lets session/tab restore settle so we don't
// reconcile against a not-yet-populated tab set.
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_START_DELAY_MS = 8_000;

/** Agent-tab ids the frontend currently considers live. The Rust
 *  `reconcile_agent_workers` command retires any per-tab worker NOT in this set
 *  — a safety net for a dropped `tab_close` or a worker left over from a crash.
 *  Shell/editor tabs never have agent workers, so they're excluded. */
export function liveAgentTabIds(tabs: Tab[]): string[] {
  return tabs.filter((tab) => tab.kind === "agent").map((tab) => tab.id);
}

/** Periodically reconcile the Rust agent-worker set against the live agent
 *  tabs. Best-effort: IPC errors (e.g. an older shell without the command) are
 *  swallowed. The Rust side age-guards just-spawned workers, so a momentarily
 *  empty set can't kill a freshly-opened tab's worker. */
export function useAgentWorkerReconcile(
  stateRef: MutableRefObject<Record<string, unknown>>,
): void {
  useEffect(() => {
    const reconcile = () => {
      const tabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      invoke("reconcile_agent_workers", {
        liveTabIds: liveAgentTabIds(tabs),
      }).catch(() => {
        /* best-effort cleanup; ignore IPC errors */
      });
    };
    const startId = window.setTimeout(reconcile, RECONCILE_START_DELAY_MS);
    const intervalId = window.setInterval(reconcile, RECONCILE_INTERVAL_MS);
    return () => {
      window.clearTimeout(startId);
      window.clearInterval(intervalId);
    };
  }, [stateRef]);
}
