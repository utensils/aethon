import type { MutableRefObject } from "react";
import type { Tab } from "../../types/tab";
import { isLegacyAethonStateCwd } from "../../state/sessionUiSnapshot";
import { sessionLabel } from "./helpers";
import type { DiscoveredSession, NotificationInput } from "./types";

export interface AutoRestoreDeps {
  stateRef: MutableRefObject<Record<string, unknown>>;
  autoRestoredSessionIdsRef: MutableRefObject<Set<string>>;
  pushNotification: (n: NotificationInput) => void;
  /** agent-tab creator. Auto-restore opens up to 8 oldest-first so the
   *  most-recent session ends up active in the tab strip. */
  newTab: (
    restoreId: string,
    restoreLabel?: string,
    options?: { restoredSession?: boolean; cwd?: string },
  ) => void;
}

/** Build the boot-time auto-restore action for bridge-discovered sessions. */
export function useAutoRestoreDiscoveredSessions(deps: AutoRestoreDeps) {
  const { stateRef, autoRestoredSessionIdsRef, pushNotification, newTab } =
    deps;

  return function autoRestoreDiscoveredSessions(
    discovered: DiscoveredSession[],
    knownIds: Set<string>,
  ): void {
    if (discovered.length === 0) return;
    const liveIds = new Set([
      ...knownIds,
      ...((stateRef.current.tabs as Tab[] | undefined) ?? []).map((t) => t.id),
    ]);
    const closedSessionIds = new Set(
      Array.isArray(stateRef.current.closedSessionIds)
        ? (stateRef.current.closedSessionIds as string[])
        : [],
    );
    const toRestore = discovered
      .filter((d) => !liveIds.has(d.tabId))
      .filter((d) => !closedSessionIds.has(d.tabId))
      .filter((d) => !autoRestoredSessionIdsRef.current.has(d.tabId))
      .filter((d) => d.cwdExists !== false)
      .filter((d) => !d.cwd || !isLegacyAethonStateCwd(d.cwd))
      .slice(0, 8);
    if (toRestore.length === 0) return;
    // Open oldest first so the most recent session ends up active.
    for (const session of [...toRestore].reverse()) {
      autoRestoredSessionIdsRef.current.add(session.tabId);
      newTab(session.tabId, sessionLabel(session), {
        restoredSession: true,
        ...(session.cwd ? { cwd: session.cwd } : {}),
      });
    }
    pushNotification({
      id: "ae-auto-restore-tabs",
      title: `Restored ${toRestore.length} session${toRestore.length === 1 ? "" : "s"}`,
      kind: "success",
      durationMs: 3000,
    });
  };
}
