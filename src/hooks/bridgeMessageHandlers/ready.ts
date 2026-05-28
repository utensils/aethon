import { invoke } from "@tauri-apps/api/core";
import type { A2UIPayload } from "../../types/a2ui";
import { activeCwd, activeProject } from "../../projects";
import { TAB_MIRROR_KEYS } from "../useTabs";
import type { Tab } from "../../types/tab";
import {
  EMPTY_AUTH_PROFILES,
  type AuthProfilesSnapshot,
} from "../../auth-profiles";
import { deepMergeState, layoutPatch } from "../../utils/stateMutation";
import { deletePointer } from "../../utils/jsonPointer";
import { WORKSTATION_AREAS, workstationRows } from "../useFocus";
import type {
  DisabledExtensionRecord,
  ExtensionFailureSummary,
  ExtensionSummary,
  ExtensionTheme,
} from "../useExtensionsHydration";
import type {
  BridgeMessageHandler,
  DiscoveredSession,
  ModelDescriptor,
} from "./types";

function isWorkstationBootLayout(layout: A2UIPayload): boolean {
  const state = layout.state as
    | { layout?: { areas?: unknown; rows?: unknown } }
    | undefined;
  const areas = state?.layout?.areas;
  return (
    Array.isArray(areas) &&
    areas.some(
      (row) => typeof row === "string" && row.includes("files-sidebar"),
    )
  );
}

function terminalHeightFromState(state: Record<string, unknown>): number {
  const panel = state.terminalPanel as { height?: unknown } | undefined;
  const height = panel?.height;
  return typeof height === "number" && Number.isFinite(height) ? height : 240;
}

function normalizeWorkstationLayout(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const layout = (state.layout as Record<string, unknown> | undefined) ?? {};
  const terminal = state.terminal as { open?: boolean } | undefined;
  return {
    ...state,
    layout: {
      ...layout,
      rows: workstationRows(
        terminal?.open === true,
        terminalHeightFromState(state),
      ),
      areas: WORKSTATION_AREAS,
    },
  };
}

/** The biggest handler: extension hydration + session restore + model
 *  picker + tabs reconcile. Called whenever the bridge fires `ready` —
 *  on first boot, after a hot-reload, after an `report` request from
 *  the boot sequence. */
export const handleReady: BridgeMessageHandler = (data, ctx) => {
  const model = (data.model as string) || "";
  const projectRoot =
    typeof data.projectRoot === "string" && data.projectRoot.length > 0
      ? data.projectRoot
      : undefined;
  const userDir =
    typeof data.userDir === "string" && data.userDir.length > 0
      ? data.userDir
      : undefined;
  const currentProjectCwd =
    typeof data.currentProjectCwd === "string" &&
    data.currentProjectCwd.length > 0
      ? data.currentProjectCwd
      : null;
  const priorActiveTabId =
    (ctx.stateRef.current.activeTabId as string | undefined) ?? "default";
  const priorActiveTab = (
    (ctx.stateRef.current.tabs as Tab[] | undefined) ?? []
  ).find((t) => t.id === priorActiveTabId);
  const priorActiveTabCwd =
    priorActiveTab?.kind !== "shell" &&
    typeof priorActiveTab?.cwd === "string" &&
    priorActiveTab.cwd.length > 0
      ? priorActiveTab.cwd
      : null;
  // Cache pi's default model so new tabs created before `ready` fires
  // (or before a session's model initialises) can inherit it immediately
  // instead of showing blank "model ▼".
  if (model && !ctx.piDefaultModelRef.current) {
    ctx.piDefaultModelRef.current = model;
  }
  const fallbackModel = ctx.piDefaultModelRef.current || model;
  if (fallbackModel) {
    // Mirror to state so the header ModelPicker has something to render
    // even when there is no active tab (fresh boot lands on the
    // projects-dashboard, /model is undefined until a tab is opened).
    ctx.setState((prev) => ({
      ...prev,
      piDefaultModel: prev.piDefaultModel || fallbackModel,
    }));
  }
  const models = (data.models as ModelDescriptor[]) ?? [];
  // Hydrate any extension-registered component templates the bridge
  // discovered at boot. setTemplates is wholesale (bridge is the source
  // of truth) so reload-after-restart picks up the same set.
  const extComponents =
    (data.extensionComponents as Record<string, unknown> | undefined) ?? {};
  const extState =
    (data.extensionState as Record<string, unknown> | undefined) ?? {};
  const extLayout = data.extensionLayout as A2UIPayload | undefined;
  const extPatches =
    (data.extensionLayoutPatches as
      | { path: string; value: unknown }[]
      | undefined) ?? [];
  const extThemes =
    (data.extensionThemes as ExtensionTheme[] | undefined) ?? [];
  const extSlash =
    (data.extensionSlashCommands as
      | { name: string; description: string; usage?: string }[]
      | undefined) ?? [];
  const piCommands =
    (data.piSlashCommands as
      | { name: string; description: string; usage?: string }[]
      | undefined) ??
    (data.piSkills as
      | { name: string; description: string; usage?: string }[]
      | undefined) ??
    [];
  const extKeys =
    (data.extensionKeybindings as
      | { combo: string; action: string; description?: string }[]
      | undefined) ?? [];
  const extMenu =
    (data.extensionMenuItems as
      | {
          id: string;
          label: string;
          action: string;
          location: "app" | "tray";
          parent?: string;
        }[]
      | undefined) ?? [];
  const extEventRoutes =
    (data.extensionEventRoutes as
      | { componentId?: string; eventType?: string }[]
      | undefined) ?? [];
  const extEventRoutingMode =
    data.extensionEventRoutingMode === "extension" ? "extension" : "builtin";
  const extLayouts =
    (data.extensionLayouts as
      | {
          id: string;
          name: string;
          description?: string;
          payload: A2UIPayload;
        }[]
      | undefined) ?? [];
  const extFrontendModules =
    (data.extensionFrontendModules as
      | { name: string; code: string }[]
      | undefined) ?? [];
  const extStateKeys = (data.extensionStateKeys as string[] | undefined) ?? [];
  const discTabs =
    (data.discoveredTabs as DiscoveredSession[] | undefined) ?? [];
  const authProfiles =
    (data.authProfiles as AuthProfilesSnapshot | undefined) ??
    EMPTY_AUTH_PROFILES;
  ctx.allDiscoveredSessionsRef.current = discTabs;
  // Hydrate extension themes BEFORE the layout state merge below so
  // /sidebar/themes carries the full list (built-ins + extension) when
  // the merge runs. hydrateThemes also injects the CSS so a saved
  // choice has the rule available before data-theme is read.
  ctx.hydrateThemes(extThemes);
  // Set of known project basenames lets the sidebar's extension
  // filter scope `@<project>/<pkg>` npm packages to that project even
  // though they're installed globally — see
  // `disabledExtensionMatchesProject`.
  const knownProjectBasenames = new Set(
    ctx.projectsRef.current.projects
      .map((p) => p.path.split("/").filter(Boolean).pop() ?? "")
      .filter((b) => b.length > 0),
  );
  ctx.hydrateExtensions(
    (data.extensionsList as ExtensionSummary[] | undefined) ?? [],
    (data.failedExtensionsList as ExtensionFailureSummary[] | undefined) ?? [],
    (data.disabledExtensionsList as
      | ReadonlyArray<DisabledExtensionRecord | string>
      | undefined) ?? [],
    activeProject(ctx.projectsRef.current)?.path ?? null,
    knownProjectBasenames,
  );
  ctx.registry.setTemplates(extComponents);
  // Restore extension-registered slash commands so the picker shows them
  // on first paint (no need to wait for an extension_slash_commands
  // delta after reload). hydrateSlashCommands rewrites the merged
  // catalog (built-ins + extensions), updates the picker state ref, and
  // bumps /slashCommands so the picker re-resolves via $ref.
  ctx.hydrateSlashCommands(extSlash, piCommands);
  ctx.hydrateKeybindings(extKeys);
  ctx.hydrateEventRoutes(extEventRoutes, extEventRoutingMode);
  ctx.hydrateExtensionLayouts(extLayouts);
  ctx.hydrateFrontendModules(extFrontendModules);
  // Push the persisted menu list into Tauri so the native menu is
  // correct on first paint after webview reload. Errors are logged but
  // non-fatal — the menu falls back to built-ins-only.
  if (extMenu.length > 0) {
    invoke("set_extension_menu_items", { items: extMenu }).catch(
      (err: unknown) => {
        console.warn("[menu] set_extension_menu_items failed:", err);
      },
    );
  }
  // Surface discovered persistent sessions in the empty-state's
  // recent-sessions list. Filter out tabIds we already have local
  // records for so the same session isn't listed twice (open AND
  // restorable). Format the lastModified into a "10m ago"-style label
  // for the row's right-hand meta.
  const localKnownIds = ctx.knownTabIds();
  const bridgeKnownIds = ctx.knownTabIds(
    (data.tabs as { id: string }[] | undefined) ?? [],
  );
  const scopedDiscTabs = ctx.scopedDiscoveredSessions(discTabs);
  const recentSessions = ctx.recentSessionItems(scopedDiscTabs, localKnownIds);
  if (ctx.projectsLoadedRef.current) {
    ctx.autoRestoreDiscoveredSessions(scopedDiscTabs, bridgeKnownIds);
  }
  // Restore any extension-supplied layout, then replay queued patches.
  // Falls back to the boot layout when none is reported so a removed /
  // disabled extension stops bleeding stale chrome across agent reloads.
  // The layout's own `state` hydrates below alongside extensionState —
  // same semantics as the live `layout_set` path so replay matches.
  const baseLayout: A2UIPayload =
    extLayout &&
    typeof extLayout === "object" &&
    Array.isArray(extLayout.components)
      ? extLayout
      : ctx.bootLayout;
  const shouldNormalizeWorkstationLayout =
    baseLayout === ctx.bootLayout && isWorkstationBootLayout(baseLayout);
  const patchedLayout = extPatches.reduce<A2UIPayload>(
    (acc, p) => layoutPatch(acc, p.path, p.value),
    baseLayout,
  );
  ctx.setLayout(patchedLayout);
  // Snapshot the prune set BEFORE the setState callback so the side
  // effect of updating lastExtensionStateKeysRef can stay outside
  // setState — otherwise concurrent-mode re-runs of the callback would
  // update the ref multiple times and race with the next ready's read.
  // Compute willPrune (= prev set − new set) here and freeze it for the
  // duration of this handler.
  const willPruneKeys: string[] = [];
  for (const stale of ctx.lastExtensionStateKeysRef.current) {
    if (!extStateKeys.includes(stale)) willPruneKeys.push(stale);
  }
  // Update the ref BEFORE calling setState so the next ready (which may
  // arrive in the same React batch) sees the new "previous" set.
  ctx.lastExtensionStateKeysRef.current = new Set(extStateKeys);
  ctx.setState((prev) => {
    // Three-layer hydration in priority order (lowest → highest):
    //   1. extension layout state — TREATED AS BOOT DEFAULTS (only fills
    //      keys not already set; existing live state like `messages` /
    //      `canvas` wins to avoid wiping restored history when ready
    //      replays after a reload)
    //   2. extension setState patches (last-write-wins overrides)
    //   3. ready-owned runtime fields (model picker, status, etc.)
    //
    // Stale-key pruning: drop paths the previous ready tracked but this
    // ready dropped (an extension was uninstalled). Without this, `prev`
    // keeps the leftover slice forever (deepMerge doesn't remove keys,
    // only adds/updates). The willPruneKeys diff was captured outside
    // this callback so it's stable across concurrent-mode re-runs.
    let next: Record<string, unknown> = { ...prev };
    for (const stale of willPruneKeys) {
      next = deletePointer(next, stale);
    }
    const layoutDefaults =
      baseLayout && typeof baseLayout === "object" && "state" in baseLayout
        ? baseLayout.state
        : undefined;
    if (layoutDefaults) {
      // Defaults semantics: restore the active layout's baseline after
      // stale extension-owned paths are pruned. This is load-bearing for
      // project switches: a project extension may have owned
      // /layout/areas or /sidebar/extraSections, and deleting those paths
      // must fall back to the workstation defaults, not leave CSS Grid
      // without template areas.
      next = deepMergeState(layoutDefaults, next);
    }
    next = deepMergeState(next, extState);
    if (shouldNormalizeWorkstationLayout) {
      // Older persisted UI snapshots and project-owned layout state had
      // no dedicated tabs row. Because layout state uses default-merge
      // semantics, those stale /layout/areas values otherwise win over
      // the boot workstation payload on every bridge ready, leaving the
      // tab-strip to auto-place at the bottom of the grid.
      next = normalizeWorkstationLayout(next);
    }
    // Reconcile bridge data onto local tabs without creating visible
    // records from the bridge tab list. With project buckets, bridge
    // state is global but the visible UI bucket is project-scoped; if a
    // ready emitted during project switch backfilled every bridge tab,
    // tabs from other projects appeared in the current project. Session
    // UI snapshots and discoveredSessions handle reload restoration;
    // ready may only enrich local tabs that already exist.
    //
    // Also hydrate per-tab mirrored state from extensionTabState —
    // those values are the bridge's record of what extensions / agents
    // wrote to /canvas, /messages, etc. for each tab. On a webview
    // reload they're the only way to restore tab UI state that was
    // driven by the agent (React state didn't survive).
    {
      const localTabs = ((next.tabs as Tab[] | undefined) ?? []).slice();
      const bridgeTabs =
        (data.tabs as
          | { id: string; model: string; cwd?: string; authProfileId?: string }[]
          | undefined) ?? [];
      const tabReplay =
        (data.extensionTabState as
          | Record<string, Record<string, unknown>>
          | undefined) ?? {};
      const dIdx = localTabs.findIndex((t) => t.id === "default");
      if (dIdx >= 0 && !localTabs[dIdx].model && fallbackModel) {
        localTabs[dIdx] = { ...localTabs[dIdx], model: fallbackModel };
      }
      // Backfill any tab that has no model yet (e.g. opened before ready
      // fired) with pi's default so the picker is never blank.
      for (let i = 0; i < localTabs.length; i++) {
        if (!localTabs[i].model && fallbackModel) {
          localTabs[i] = { ...localTabs[i], model: fallbackModel };
        }
      }
      for (let i = 0; i < localTabs.length; i++) {
        const bt = bridgeTabs.find(
          (candidate) => candidate.id === localTabs[i].id,
        );
        if (bt?.model && !localTabs[i].model) {
          localTabs[i] = { ...localTabs[i], model: bt.model };
        }
        if (bt?.cwd && !localTabs[i].cwd) {
          localTabs[i] = { ...localTabs[i], cwd: bt.cwd };
        }
        if (bt?.authProfileId) {
          localTabs[i] = { ...localTabs[i], authProfileId: bt.authProfileId };
        }
      }
      // Apply the bridge's per-tab replay over each tab record. prev
      // wins for keys the React side already restored (e.g. local-only
      // message history) — agent-driven canvas / model fills the gaps.
      for (let i = 0; i < localTabs.length; i++) {
        const replay = tabReplay[localTabs[i].id];
        if (!replay) continue;
        const merged = { ...localTabs[i] } as unknown as Record<
          string,
          unknown
        >;
        for (const [k, v] of Object.entries(replay)) {
          // Only fill keys that aren't already populated locally, so a
          // real local update beats a possibly-stale replay.
          if (
            merged[k] === undefined ||
            merged[k] === null ||
            (Array.isArray(merged[k]) &&
              (merged[k] as unknown[]).length === 0) ||
            merged[k] === ""
          ) {
            merged[k] = v;
          }
        }
        localTabs[i] = merged as unknown as Tab;
      }
      next.tabs = localTabs;
    }
    // The model + sidebar mirror tracks the ACTIVE tab, not the default
    // — so a `ready` arriving while a non-default tab is active doesn't
    // clobber the visible selection. Look up the active tab's model in
    // the just-updated tabs array; fall back to data.model on first
    // boot when no tab record exists.
    const activeId = (next.activeTabId as string | undefined) ?? "default";
    const tabsList = (next.tabs as Tab[] | undefined) ?? [];
    const activeTab = tabsList.find((t) => t.id === activeId);
    const activeModel = activeTab?.model || fallbackModel;
    const activeTurnBusy =
      activeTab?.waiting === true ||
      (activeTab?.queueCount ?? 0) > 0 ||
      next.waiting === true ||
      ((next.queueCount as number | undefined) ?? 0) > 0;
    next = {
      ...next,
      ...(projectRoot ? { projectRoot } : {}),
      ...(userDir ? { aethonRoot: userDir } : {}),
      model: activeModel,
      status: activeTurnBusy ? "thinking…" : "ready",
      connection: "connected",
      recentSessions,
      authProfiles,
      sidebar: {
        ...(next.sidebar ?? {}),
        models: models.map((m) => ({
          id: m.id,
          label: m.label,
          active: m.id === activeModel,
        })),
      },
    };
    // Re-mirror the active tab's full state to the root keys. Without
    // this, ready-replayed values for /messages, /canvas, etc. live
    // only on the tab record but the layout binds via the root mirror,
    // so the user wouldn't see the restored state until they switched
    // tabs and back.
    if (activeTab) {
      const tabRec = activeTab as unknown as Record<string, unknown>;
      for (const key of TAB_MIRROR_KEYS) {
        next[key as string] = tabRec[key as string];
      }
    }
    return next;
  });
  // Re-establish bridge sessions for any non-default local tabs the
  // user created before the agent reloaded. The bridge starts fresh
  // each spawn — without this, prompts on those tabs would hit a tab
  // the bridge has never seen and fail. After the session is open,
  // also restore the tab's previously-selected model so the user
  // doesn't silently send the next prompt to pi's default.
  const localTabs = (ctx.stateRef.current.tabs as Tab[] | undefined) ?? [];
  const bridgeTabIds = new Set(
    ((data.tabs as { id: string }[] | undefined) ?? []).map((t) => t.id),
  );
  for (const t of localTabs) {
    if ((t.kind ?? "agent") !== "agent") continue;
    if (t.id === "default") continue;
    if (bridgeTabIds.has(t.id)) continue;
    // Pass `model` so the new bridge session boots with the same model
    // the user previously selected — no race window. Track in
    // pendingTabOpens so a fast first chat on the restored tab waits
    // for the bridge to register the session (otherwise send_message
    // would race tab_open and lazily create the tab without the
    // inherited model). Preserve the tab's original project bucket
    // instead of using the currently-active project: existing tabs keep
    // the cwd they were created with, and a hot reload should restore
    // that same scoped history.
    const tabProject = t.projectId
      ? ctx.projectsRef.current.projects.find((p) => p.id === t.projectId)
      : null;
    const restoredCwd = t.cwd ?? tabProject?.path;
    const opening = invoke("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: t.id,
        ...(t.model ? { model: t.model } : {}),
        ...(restoredCwd ? { cwd: restoredCwd } : {}),
        ...(t.authProfileId ? { authProfileId: t.authProfileId } : {}),
        restoreHistory: true,
      }),
    });
    ctx.pendingTabOpens.current.set(t.id, opening);
    opening
      .catch(() => {
        /* surfaced on next chat send */
      })
      .finally(() => {
        ctx.pendingTabOpens.current.delete(t.id);
      });
  }
  // Post-respawn project re-announce. The bridge boots with
  // process.cwd() — which is whatever directory bun was launched from,
  // NOT necessarily the user's active project. If we don't re-announce,
  // a hot-reload triggered while a non-cwd project is active leaves the
  // wrong project's extensions loaded. The loop above only sends
  // tab_open for non-default tabs, so when the active tab IS "default"
  // (common: single-tab session) nothing announces. Send an explicit
  // set_project for the active tab so the bridge swaps to the right
  // project. Ready can also be emitted *because* set_project loaded or
  // refreshed resources, so only announce when the bridge reports a
  // different cwd. Otherwise a ready -> set_project -> ready loop can
  // monopolize the release app and blank the webview.
  const projectActivePath = activeCwd(ctx.projectsRef.current);
  const activePath = ctx.projectsRef.current.activeWorktreeId
    ? projectActivePath
    : (priorActiveTabCwd ?? projectActivePath);
  if (activePath && currentProjectCwd !== activePath) {
    ctx.announceProjectToBridge(priorActiveTabId, activePath);
  }
};
