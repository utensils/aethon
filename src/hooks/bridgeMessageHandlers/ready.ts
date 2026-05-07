import { invoke } from "@tauri-apps/api/core";
import type { A2UIPayload } from "../../types/a2ui";
import { activeProject } from "../../projects";
import { TAB_MIRROR_KEYS } from "../useTabs";
import { makeEmptyTab, type Tab } from "../../types/tab";
import { deepMergeState, layoutPatch } from "../../utils/stateMutation";
import { deletePointer } from "../../utils/jsonPointer";
import type { ExtensionTheme } from "../useExtensionsHydration";
import type {
  BridgeMessageHandler,
  DiscoveredSession,
  ModelDescriptor,
} from "./types";

/** The biggest handler: extension hydration + session restore + model
 *  picker + tabs reconcile. Called whenever the bridge fires `ready` —
 *  on first boot, after a hot-reload, after an `report` request from
 *  the boot sequence. */
export const handleReady: BridgeMessageHandler = (data, ctx) => {
  const model = (data.model as string) || "";
  // Cache pi's default model so new tabs created before `ready` fires
  // (or before a session's model initialises) can inherit it immediately
  // instead of showing blank "model ▼".
  if (model) ctx.piDefaultModelRef.current = model;
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
  const discoveredById = new Map(discTabs.map((d) => [d.tabId, d]));
  const sessionLabel = (tabId: string, fallback: string): string => {
    const session = discoveredById.get(tabId);
    if (session?.customLabel) return session.customLabel;
    if (session?.firstUserMessage) {
      return session.firstUserMessage.replace(/\s+/g, " ").trim();
    }
    return fallback;
  };
  ctx.allDiscoveredSessionsRef.current = discTabs;
  // Hydrate extension themes BEFORE the layout state merge below so
  // /sidebar/themes carries the full list (built-ins + extension) when
  // the merge runs. hydrateThemes also injects the CSS so a saved
  // choice has the rule available before data-theme is read.
  ctx.hydrateThemes(extThemes);
  ctx.hydrateExtensions(
    (data.extensionsList as { name: string; source: string }[] | undefined) ??
      [],
    (data.failedExtensionsList as
      | { name: string; source: string; error?: string }[]
      | undefined) ?? [],
    (data.disabledExtensionsList as string[] | undefined) ?? [],
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
  const knownIds = ctx.knownTabIds(
    (data.tabs as { id: string }[] | undefined) ?? [],
  );
  const scopedDiscTabs = ctx.scopedDiscoveredSessions(discTabs);
  const recentSessions = ctx.recentSessionItems(scopedDiscTabs, knownIds);
  if (ctx.projectsLoadedRef.current) {
    ctx.autoRestoreDiscoveredSessions(scopedDiscTabs, knownIds);
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
    if (extLayout && extLayout.state) {
      // Defaults semantics: deep-merge layout into a fresh object and
      // let prev win for any overlapping keys.
      next = deepMergeState(extLayout.state, next);
    }
    next = deepMergeState(next, extState);
    // Reconcile our local tabs with the bridge's reported tabs.
    // Two cases:
    //   (a) webview reload while bridge is alive — bridge has tabs we
    //       don't know about; create local records for them so the user
    //       can re-access those sessions.
    //   (b) bridge restart — local has tabs the bridge doesn't; the
    //       post-ready replay below re-establishes them.
    //
    // Also hydrate per-tab mirrored state from extensionTabState —
    // those values are the bridge's record of what extensions / agents
    // wrote to /canvas, /messages, etc. for each tab. On a webview
    // reload they're the only way to restore tab UI state that was
    // driven by the agent (React state didn't survive).
    {
      const localTabs = ((next.tabs as Tab[] | undefined) ?? []).slice();
      const bridgeTabs =
        (data.tabs as { id: string; model: string }[] | undefined) ?? [];
      const tabReplay =
        (data.extensionTabState as
          | Record<string, Record<string, unknown>>
          | undefined) ?? {};
      const dIdx = localTabs.findIndex((t) => t.id === "default");
      if (dIdx >= 0) {
        localTabs[dIdx] = { ...localTabs[dIdx], model };
      }
      // Backfill any tab that has no model yet (e.g. opened before ready
      // fired) with pi's default so the picker is never blank.
      for (let i = 0; i < localTabs.length; i++) {
        if (!localTabs[i].model && model) {
          localTabs[i] = { ...localTabs[i], model };
        }
      }
      for (const bt of bridgeTabs) {
        if (bt.id === "default") continue;
        const exists = localTabs.find((t) => t.id === bt.id);
        if (exists) {
          if (!exists.model && bt.model) {
            const idx = localTabs.indexOf(exists);
            localTabs[idx] = { ...exists, model: bt.model };
          }
          continue;
        }
        const label = `Tab ${localTabs.length + 1}`;
        localTabs.push({
          ...makeEmptyTab(
            bt.id,
            sessionLabel(bt.id, label),
            ctx.projectsRef.current.activeId,
          ),
          model: bt.model,
        });
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
    const activeModel = activeTab?.model || model;
    next = {
      ...next,
      model: activeModel,
      status: "ready",
      connection: "connected",
      recentSessions,
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
  for (const t of localTabs) {
    if (t.id === "default") continue;
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
    const restoredCwd = tabProject?.path;
    const opening = invoke("agent_command", {
      payload: JSON.stringify({
        type: "tab_open",
        tabId: t.id,
        ...(t.model ? { model: t.model } : {}),
        ...(restoredCwd ? { cwd: restoredCwd } : {}),
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
  // project. The bridge short-circuits when cwd matches its
  // currentProjectCwd so this is harmless on a fresh boot where the
  // boot effect already announced.
  const activeProj = activeProject(ctx.projectsRef.current);
  if (activeProj) {
    const activeTabId =
      (ctx.stateRef.current.activeTabId as string | undefined) ?? "default";
    ctx.announceProjectToBridge(activeTabId, activeProj.path);
  }
};
