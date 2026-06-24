import { invoke } from "@tauri-apps/api/core";
import { activeCwd } from "../../projects";
import type { Tab } from "../../types/tab";
import type { BridgeMessageContext } from "./types";

export interface ReadyEffectsInput {
  currentProjectCwd: string | null;
  priorActiveTabCwd: string | null;
  priorActiveTabId: string;
}

function replayRestoredAgentTabs(ctx: BridgeMessageContext): void {
  const localTabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
  for (const t of localTabs) {
    if ((t.kind ?? "agent") !== "agent") continue;
    if (t.id === "default") continue;
    const tabProject = t.projectId
      ? ctx.projectsRef.current.projects.find((p) => p.id === t.projectId)
      : null;
    const restoredCwd = t.cwd ?? tabProject?.path;
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
  const activePath = ctx.projectsRef.current.activeWorkspaceId
    ? projectActivePath
    : (input.priorActiveTabCwd ?? projectActivePath);
  if (activePath && input.currentProjectCwd !== activePath) {
    ctx.announceProjectToBridge(input.priorActiveTabId, activePath);
    return;
  }
  ctx.markStartupChromeReady();
}

export function runReadyEffects(
  ctx: BridgeMessageContext,
  input: ReadyEffectsInput,
): void {
  replayRestoredAgentTabs(ctx);
  finishProjectAnnouncement(ctx, input);
}
