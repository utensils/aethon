import { invoke } from "@tauri-apps/api/core";
import { activeCwd } from "../../projects";
import { isLegacyAethonStateCwd } from "../../state/sessionUiSnapshot";
import type { Tab } from "../../types/tab";
import type { BridgeMessageContext } from "./types";

export interface ReadyEffectsInput {
  currentProjectCwd: string | null;
  priorActiveTabCwd: string | null;
  priorActiveTabId: string;
  /** Tab ids the bridge already has live sessions for (from the ready
   *  snapshot's `tabs`). A tab that was already replayed this webview
   *  lifetime is only replayed again if the bridge lost it. */
  bridgeTabIds: ReadonlySet<string>;
}

/** Tabs already replayed to the bridge in this webview's lifetime.
 *  `ready` is broadcast and re-fires on every project switch and every
 *  `report` from ANY connected client, so replay must not re-run each
 *  time: re-opening a live tab re-emits session_history (which can
 *  interleave with an in-flight stream) and, when the tab's cwd differs
 *  from the bridge's current project, flips the global project +
 *  extension surface per ready. The first replay after a webview
 *  reload (fresh module state) and any tab the bridge lost (missing
 *  from the ready snapshot — bridge respawn, failed open) still go
 *  through. */
const replayedTabIds = new Set<string>();

/** Test-only: fresh-webview replay semantics. */
export function resetReplayedTabsForTest(): void {
  replayedTabIds.clear();
}

function replayRestoredAgentTabs(
  ctx: BridgeMessageContext,
  bridgeTabIds: ReadonlySet<string>,
): void {
  const localTabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
  for (const t of localTabs) {
    if ((t.kind ?? "agent") !== "agent") continue;
    if (t.id === "default") continue;
    if (replayedTabIds.has(t.id) && bridgeTabIds.has(t.id)) continue;
    replayedTabIds.add(t.id);
    const tabProject = t.projectId
      ? ctx.projectsRef.current.projects.find((p) => p.id === t.projectId)
      : null;
    const restoredCwd = t.cwd ?? tabProject?.path;
    if (restoredCwd && isLegacyAethonStateCwd(restoredCwd)) continue;
    const opening = (async () => {
      if (restoredCwd && ctx.prepareWorkspaceStartup) {
        const ready = await ctx.prepareWorkspaceStartup(restoredCwd);
        if (!ready) return;
      }
      return await invoke("agent_command", {
        payload: JSON.stringify({
          type: "tab_open",
          tabId: t.id,
          ...(t.model ? { model: t.model } : {}),
          ...(t.thinkingLevel ? { thinkingLevel: t.thinkingLevel } : {}),
          ...(restoredCwd ? { cwd: restoredCwd } : {}),
          ...(t.authProfileId ? { authProfileId: t.authProfileId } : {}),
          restoreHistory: true,
        }),
      });
    })();
    ctx.pendingTabOpens.current.set(t.id, opening);
    opening
      .catch(() => {
        /* surfaced on next chat send */
      })
      .finally(() => {
        ctx.pendingTabOpens.current.delete(t.id);
      });
  }
}

function finishProjectAnnouncement(
  ctx: BridgeMessageContext,
  input: ReadyEffectsInput,
): void {
  const projectActivePath = activeCwd(ctx.projectsRef.current);
  const priorActiveTabCwd =
    input.priorActiveTabCwd && !isLegacyAethonStateCwd(input.priorActiveTabCwd)
      ? input.priorActiveTabCwd
      : null;
  const activePath = ctx.projectsRef.current.activeWorkspaceId
    ? projectActivePath
    : (priorActiveTabCwd ?? projectActivePath);
  if (activePath && input.currentProjectCwd !== activePath) {
    ctx.announceProjectToBridge(input.priorActiveTabId, activePath);
  }
  ctx.markStartupChromeReady();
}

export function runReadyEffects(
  ctx: BridgeMessageContext,
  input: ReadyEffectsInput,
): void {
  // The companion surface is a passive reader of bridge state: the
  // desktop webview is the single writer for tab lifecycle and the
  // global active project. `ready` is broadcast to every connected
  // client, so if each client re-announced its own local view here,
  // two clients with different active projects would livelock the
  // bridge in a set_project ping-pong — each flip is a 20-60s
  // extension unload/reload that re-emits ready and storms every
  // event consumer.
  if (import.meta.env.VITE_AETHON_SURFACE === "mobile") {
    ctx.markStartupChromeReady();
    return;
  }
  replayRestoredAgentTabs(ctx, input.bridgeTabIds);
  finishProjectAnnouncement(ctx, input);
}
