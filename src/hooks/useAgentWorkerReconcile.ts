import { invoke } from "@tauri-apps/api/core";
import { useEffect, type MutableRefObject } from "react";
import type { Tab } from "../types/tab";
import type { TabBucket } from "./projectOps/types";

// Low cadence — this is orphan cleanup, not a latency-sensitive path. The idle
// sweep (Rust) already retires inactive workers; this just retires faster when
// a tab is truly gone. The startup delay lets session/tab restore settle so we
// don't reconcile against a not-yet-populated tab set.
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_START_DELAY_MS = 8_000;

/** Agent-tab ids the frontend considers live, ACROSS ALL PROJECT BUCKETS.
 *  Tabs are project-scoped: only the active project's tabs live in
 *  `state.tabs`; the other buckets are stashed in `tabBucketsRef`. The
 *  reconcile set MUST union both — otherwise switching projects would make the
 *  Rust side treat a hidden bucket's tabs as orphaned and retire their
 *  (possibly mid-prompt) workers. Shell/editor tabs never have agent workers,
 *  so they're excluded. Deduped because the active bucket can also linger as a
 *  stale entry in the map. */
export function liveAgentTabIds(
  activeTabs: Tab[],
  buckets: Iterable<TabBucket>,
): string[] {
  const ids = new Set<string>();
  const addAgentTabs = (tabs: Tab[]) => {
    for (const tab of tabs) if (tab.kind === "agent") ids.add(tab.id);
  };
  addAgentTabs(activeTabs);
  for (const bucket of buckets) addAgentTabs(bucket.tabs);
  return [...ids];
}

/** Periodically reconcile the Rust agent-worker set against the live agent
 *  tabs across every project bucket. Best-effort: IPC errors (e.g. an older
 *  shell without the command) are swallowed. The Rust side both age-guards
 *  just-spawned workers and skips mid-prompt ones, so a momentarily empty set
 *  can't kill a live worker. */
export function useAgentWorkerReconcile(
  stateRef: MutableRefObject<Record<string, unknown>>,
  tabBucketsRef: MutableRefObject<Map<string, TabBucket>>,
): void {
  useEffect(() => {
    const reconcile = () => {
      const activeTabs = (stateRef.current.tabs as Tab[] | undefined) ?? [];
      invoke("reconcile_agent_workers", {
        liveTabIds: liveAgentTabIds(activeTabs, tabBucketsRef.current.values()),
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
  }, [stateRef, tabBucketsRef]);
}
