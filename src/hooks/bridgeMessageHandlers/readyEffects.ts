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

/** Restored background tabs are NOT opened at ready anymore — each holds
 *  a thunk here and opens on first interaction (activation, chat send,
 *  control request). This is what keeps an extension-toggle bridge
 *  reload at ONE cold boot instead of 1+N: background workers respawn
 *  lazily when their tab is actually used, mirroring the lazy
 *  spawn-on-first-write the workers already have. Module-level for the
 *  same reason as `replayedTabIds`. */
const deferredTabOpens = new Map<string, () => Promise<unknown>>();

/** Test-only: fresh-webview replay semantics. */
export function resetReplayedTabsForTest(): void {
  replayedTabIds.clear();
  deferredTabOpens.clear();
}

/** Open a deferred restored tab now (first interaction). Returns the
 *  in-flight open, or undefined when the tab isn't deferred — callers
 *  fall back to `pendingTabOpens` for an open already in flight. */
export function flushDeferredTabOpen(
  tabId: string,
): Promise<unknown> | undefined {
  const thunk = deferredTabOpens.get(tabId);
  if (!thunk) return undefined;
  deferredTabOpens.delete(tabId);
  return thunk();
}

/** Drop a deferred open without running it (tab closed before use). */
export function discardDeferredTabOpen(tabId: string): void {
  deferredTabOpens.delete(tabId);
}

/** Test-only visibility into the deferred set. */
export function hasDeferredTabOpen(tabId: string): boolean {
  return deferredTabOpens.has(tabId);
}

/** Test-only: seed a deferred open so consumers of
 *  `flushDeferredTabOpen` can be tested without a full ready fixture. */
export function seedDeferredTabOpenForTest(
  tabId: string,
  thunk: () => Promise<unknown>,
): void {
  deferredTabOpens.set(tabId, thunk);
}

function openRestoredTab(
  ctx: BridgeMessageContext,
  t: Tab,
  restoredCwd: string | undefined,
): Promise<unknown> {
  replayedTabIds.add(t.id);
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
  return opening;
}

function replayRestoredAgentTabs(
  ctx: BridgeMessageContext,
  bridgeTabIds: ReadonlySet<string>,
): void {
  const localTabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
  const activeTabId = ctx.stateRef.current.activeTabId;
  for (const t of localTabs) {
    if ((t.kind ?? "agent") !== "agent") continue;
    if (t.id === "default") continue;
    // A replay we already sent may not be reflected in the bridge
    // snapshot yet (ready can re-fire while the open is in flight) —
    // the pending gate covers that window.
    if (ctx.pendingTabOpens.current.has(t.id)) continue;
    if (replayedTabIds.has(t.id) && bridgeTabIds.has(t.id)) continue;
    const tabProject = t.projectId
      ? ctx.projectsRef.current.projects.find((p) => p.id === t.projectId)
      : null;
    const restoredCwd = t.cwd ?? tabProject?.path;
    if (restoredCwd && isLegacyAethonStateCwd(restoredCwd)) continue;
    if (t.id === activeTabId) {
      // The visible conversation opens eagerly so it's usable the
      // moment ready lands.
      openRestoredTab(ctx, t, restoredCwd);
    } else {
      // Background tabs defer; overwrite any earlier thunk so a
      // re-fired ready refreshes the captured cwd/project data.
      deferredTabOpens.set(t.id, () => {
        deferredTabOpens.delete(t.id);
        return openRestoredTab(ctx, t, restoredCwd);
      });
    }
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
